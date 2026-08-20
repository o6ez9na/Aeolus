"""Panel-side logic for the anemoi agents.

Kept separate from the gRPC plumbing so it can be exercised without a channel.
"""

import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.crypto import decrypt_secret
from app.models.node import Client, ClientStatus, Node, NodeStatus
from app.services import ccd as ccd_service
from app.services import openvpn, pki

logger = logging.getLogger("aeolus.agent")

TOKEN_TTL = timedelta(hours=24)


class AgentError(Exception):
    """Agent request refused."""


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def issue_enrollment_token(session: AsyncSession, node: Node) -> str:
    """Mint a one-time token for a node. Only the hash is kept."""
    token = secrets.token_urlsafe(32)
    node.enrollment_token_hash = hash_token(token)
    node.enrollment_token_expires_at = datetime.now(UTC) + TOKEN_TTL
    return token


async def enroll(
    session: AsyncSession, token: str, csr_pem: str, agent_version: str
) -> tuple[Node, str, str]:
    """Exchange a valid token for a client certificate. Returns (node, cert, ca)."""
    node = await session.scalar(
        select(Node).where(Node.enrollment_token_hash == hash_token(token))
    )
    if node is None:
        raise AgentError("unknown enrolment token")
    if (
        node.enrollment_token_expires_at is None
        or node.enrollment_token_expires_at <= datetime.now(UTC)
    ):
        raise AgentError("enrolment token expired")

    ca = await pki.require_ca(session)
    cert = pki.sign_agent_csr(ca, csr_pem, node.name)

    # The token is single-use: a replay would hand a second party the same
    # identity.
    node.enrollment_token_hash = None
    node.enrollment_token_expires_at = None
    node.agent_cert_serial = f"{cert.serial_number:x}"
    node.agent_cert_not_after = cert.not_valid_after_utc
    node.agent_version = agent_version or None

    logger.warning("Node %r enrolled its agent", node.name)
    return node, pki.cert_to_pem(cert), ca.cert_pem


async def get_node_by_name(session: AsyncSession, name: str) -> Node:
    node = await session.scalar(select(Node).where(Node.name == name))
    if node is None:
        raise AgentError(f"unknown node {name!r}")
    if not node.is_enabled:
        raise AgentError(f"node {name!r} is disabled")
    return node


async def build_config(session: AsyncSession, node: Node) -> dict:
    """Everything the node needs to run OpenVPN, plus a revision to compare."""
    if node.server_cert_pem is None:
        await pki.issue_server_cert(session, node)

    ca = await pki.require_ca(session)
    crl_pem = await pki.build_crl(session)

    ccd = await _build_ccd(session, node, proto="udp")
    ccd_tcp = await _build_ccd(session, node, proto="tcp") if node.tcp_port else {}

    payload = {
        "server_conf": openvpn.render_server_config(node),
        "server_conf_tcp": (
            openvpn.render_server_config(node, proto="tcp", port=node.tcp_port)
            if node.tcp_port
            else ""
        ),
        "ca_pem": ca.cert_pem,
        "server_cert_pem": node.server_cert_pem,
        "server_key_pem": decrypt_secret(node.server_key_pem_encrypted),
        "tls_crypt_key": decrypt_secret(ca.tls_crypt_key_encrypted),
        "crl_pem": crl_pem,
        "ccd": ccd,
        "ccd_tcp": ccd_tcp,
    }

    # The CRL carries a timestamp, so hashing it would change the revision on
    # every poll. Hash the parts that describe intent instead.
    digest = hashlib.sha256()
    for key in ("server_conf", "server_conf_tcp", "ca_pem", "server_cert_pem", "tls_crypt_key"):
        digest.update(payload[key].encode())
    for entries in (ccd, ccd_tcp):
        for name in sorted(entries):
            digest.update(name.encode())
            digest.update(entries[name].encode())
    payload["revision"] = digest.hexdigest()[:32]
    return payload


async def _build_ccd(session: AsyncSession, node: Node, *, proto: str) -> dict[str, str]:
    """One client-config-dir entry per client, denying those without a grant.

    OpenVPN accepts any certificate the CA signed, so a client granted only
    node A would otherwise be able to use node B as well.

    Built once per listener: the fixed addresses differ between the UDP and the
    TCP subnet, so the two directories are not copies of each other.
    """
    clients = await session.scalars(
        select(Client).options(selectinload(Client.grants)).where(
            Client.cert_serial.is_not(None)
        )
    )

    entries: dict[str, str] = {}
    for client in clients:
        grant = next((g for g in client.grants if g.node_id == node.id), None)
        allowed = grant is not None and client.status == ClientStatus.active
        entries[client.common_name] = ccd_service.render(
            grant, client.common_name, proto=proto, allowed=allowed
        )
    return entries


async def record_status(session: AsyncSession, node: Node, report: dict) -> bool:
    """Store what an agent reported. Returns True when the panel has newer config."""
    node.last_seen_at = datetime.now(UTC)
    node.status = NodeStatus.online if report["openvpn_running"] else NodeStatus.error
    node.status_message = report.get("message") or None
    node.sessions = len(report.get("sessions", []))
    node.rx_bytes = report.get("rx_bytes", 0)
    node.tx_bytes = report.get("tx_bytes", 0)
    node.bandwidth_mbps = report.get("bandwidth_mbps", 0)
    node.agent_version = report.get("agent_version") or node.agent_version

    await _record_client_sessions(session, node, report.get("sessions", []))

    current = await build_config(session, node)
    node.config_revision = report.get("config_revision") or None
    return node.config_revision != current["revision"]


async def _record_client_sessions(
    session: AsyncSession, node: Node, sessions: list[dict]
) -> None:
    if not sessions:
        return

    by_name = {entry["common_name"]: entry for entry in sessions}
    clients = await session.scalars(
        select(Client).where(Client.common_name.in_(list(by_name)))
    )
    now = datetime.now(UTC)
    for client in clients:
        entry = by_name[client.common_name]
        client.last_seen_at = now
        client.last_node_id = node.id
        # Counters restart when OpenVPN restarts, so this is the live session's
        # usage rather than a lifetime total.
        client.traffic_used_bytes = entry.get("rx_bytes", 0) + entry.get("tx_bytes", 0)


async def mark_stale_nodes_offline(session: AsyncSession) -> int:
    """Nodes stop being online when their agent stops reporting."""
    cutoff = datetime.now(UTC) - timedelta(seconds=settings.node_offline_after_seconds)
    stale = await session.scalars(
        select(Node).where(
            Node.status == NodeStatus.online,
            Node.last_seen_at.is_not(None),
            Node.last_seen_at < cutoff,
        )
    )
    count = 0
    for node in stale:
        node.status = NodeStatus.offline
        node.status_message = "агент перестал отвечать"
        node.sessions = 0
        node.bandwidth_mbps = 0
        count += 1
    return count
