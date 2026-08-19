"""gRPC endpoint the anemoi agents dial.

Every method requires a client certificate signed by the panel CA, enforced by
the transport, and the caller's identity is that certificate's common name —
never a field in the request. Enrolment lives in the HTTPS API instead, since it
happens before an agent has a certificate.
"""

import logging

import grpc
from grpc import aio

from app.core.config import settings
from app.core.crypto import decrypt_secret
from app.core.db import SessionLocal
from app.grpc_gen import agent_pb2, agent_pb2_grpc
from app.services import agent as agent_service
from app.services import pki

logger = logging.getLogger("aeolus.grpc")

def _peer_common_name(context: aio.ServicerContext) -> str | None:
    auth = context.auth_context()
    values = auth.get("x509_common_name") or []
    if not values:
        return None
    raw = values[0]
    return raw.decode() if isinstance(raw, bytes) else str(raw)


class NodeAgentServicer(agent_pb2_grpc.NodeAgentServicer):
    async def GetConfig(self, request, context):
        name = _peer_common_name(context)
        if not name:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "client certificate required")

        async with SessionLocal() as session:
            try:
                node = await agent_service.get_node_by_name(session, name)
                payload = await agent_service.build_config(session, node)
                await session.commit()
            except agent_service.AgentError as exc:
                await context.abort(grpc.StatusCode.PERMISSION_DENIED, str(exc))
            except pki.PkiError as exc:
                await context.abort(grpc.StatusCode.FAILED_PRECONDITION, str(exc))

            if request.known_revision and request.known_revision == payload["revision"]:
                return agent_pb2.ConfigResponse(unchanged=True, revision=payload["revision"])

            return agent_pb2.ConfigResponse(
                unchanged=False,
                revision=payload["revision"],
                server_conf=payload["server_conf"],
                server_conf_tcp=payload["server_conf_tcp"],
                ca_pem=payload["ca_pem"],
                server_cert_pem=payload["server_cert_pem"],
                server_key_pem=payload["server_key_pem"],
                tls_crypt_key=payload["tls_crypt_key"],
                crl_pem=payload["crl_pem"],
                ccd=payload["ccd"],
            )

    async def ReportStatus(self, request, context):
        name = _peer_common_name(context)
        if not name:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "client certificate required")

        report = {
            "openvpn_running": request.openvpn_running,
            "message": request.message,
            "rx_bytes": request.rx_bytes,
            "tx_bytes": request.tx_bytes,
            "bandwidth_mbps": request.bandwidth_mbps,
            "agent_version": request.agent_version,
            "config_revision": request.config_revision,
            "sessions": [
                {
                    "common_name": s.common_name,
                    "real_address": s.real_address,
                    "virtual_address": s.virtual_address,
                    "rx_bytes": s.rx_bytes,
                    "tx_bytes": s.tx_bytes,
                    "connected_since": s.connected_since,
                }
                for s in request.sessions
            ],
        }

        async with SessionLocal() as session:
            try:
                node = await agent_service.get_node_by_name(session, name)
                stale = await agent_service.record_status(session, node, report)
                await agent_service.mark_stale_nodes_offline(session)
                await session.commit()
            except agent_service.AgentError as exc:
                await session.rollback()
                await context.abort(grpc.StatusCode.PERMISSION_DENIED, str(exc))

            return agent_pb2.StatusAck(config_stale=stale)


async def build_server() -> aio.Server | None:
    """Create the gRPC server, or None when the CA is not ready yet."""
    hosts = [h for h in ([settings.master_node_address] + settings.grpc_san_hosts) if h]

    async with SessionLocal() as session:
        try:
            ca = await pki.ensure_grpc_cert(session, hosts)
            await session.commit()
        except pki.PkiError as exc:
            logger.warning("gRPC endpoint disabled: %s", exc)
            return None

        credentials = grpc.ssl_server_credentials(
            [
                (
                    decrypt_secret(ca.grpc_key_pem_encrypted).encode(),
                    ca.grpc_cert_pem.encode(),
                )
            ],
            root_certificates=ca.cert_pem.encode(),
            # Enrolment happens over the HTTPS API, so every gRPC caller already
            # has a certificate: demand and verify it at the transport level.
            require_client_auth=True,
        )

    server = aio.server()
    agent_pb2_grpc.add_NodeAgentServicer_to_server(NodeAgentServicer(), server)
    server.add_secure_port(f"{settings.grpc_host}:{settings.grpc_port}", credentials)
    return server
