"""Panel-side logic for the anemoi agents.

Kept separate from the gRPC plumbing so it can be exercised without a channel.
"""

import hashlib
import logging
import re
import secrets
from datetime import UTC, datetime, timedelta

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.crypto import decrypt_secret
from app.models.node import (
    Client,
    ClientStatus,
    Node,
    NodeApproval,
    NodeRole,
    NodeStatus,
)
from app.services import ccd as ccd_service
from app.services import openvpn, pki, routing

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


def csr_fingerprint(csr_pem: str) -> str:
    """SHA-256 of the public key inside a CSR, in colon-separated hex.

    The agent derives the same value from its own key and prints it, so an
    operator accepting a request can compare two strings rather than trusting
    whatever name the request claimed.
    """
    try:
        csr = x509.load_pem_x509_csr(csr_pem.encode())
    except ValueError as exc:
        raise AgentError(f"malformed CSR: {exc}") from None
    if not csr.is_signature_valid:
        raise AgentError("CSR signature does not verify")

    der = csr.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    digest = hashlib.sha256(der).hexdigest()
    return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))


def _clean_name(raw: str) -> str:
    """A node name safe to use as a certificate CN and a ccd file name."""
    name = re.sub(r"[^a-z0-9_.-]+", "-", raw.strip().lower()).strip("-.")
    return name[:64] or "node"


async def _unique_name(session: AsyncSession, wanted: str) -> str:
    name = _clean_name(wanted)
    taken = set(
        await session.scalars(select(Node.name).where(Node.name.startswith(name)))
    )
    if name not in taken:
        return name
    for suffix in range(2, 100):
        candidate = f"{name}-{suffix}"
        if candidate not in taken:
            return candidate
    return f"{name}-{secrets.token_hex(3)}"


async def announce(
    session: AsyncSession,
    *,
    csr_pem: str,
    name: str,
    hostname: str | None,
    wan_iface: str | None,
    subnets: list[str],
    agent_version: str,
    source_ip: str | None,
) -> tuple[Node, str, str]:
    """Register or refresh a node's request to join. Returns (node, token, fp).

    Deliberately unauthenticated, like the enrolment it replaces: a fresh node
    has no credential to present. The request is inert — no certificate, no
    address, no routing — until an operator accepts the fingerprint.
    """
    fingerprint = csr_fingerprint(csr_pem)

    # Identity is the key, not the name: an agent that re-announces after a
    # restart must land on its own row instead of queueing a second request.
    node = await session.scalar(
        select(Node).where(Node.key_fingerprint == fingerprint)
    )
    if node is None:
        node = Node(
            name=await _unique_name(session, name or hostname or "node"),
            address=source_ip or (hostname or ""),
            key_fingerprint=fingerprint,
            approval=NodeApproval.pending,
            role=NodeRole.slave,
            transit_obfuscated=settings.transit_obfuscated_default,
        )
        session.add(node)
        logger.warning("Node %r announced itself from %s", node.name, source_ip)
    elif node.approval == NodeApproval.rejected:
        # A rejected node that comes back gets a fresh look rather than being
        # silently ignored; an operator may have rejected it by mistake.
        node.approval = NodeApproval.pending

    node.hostname = hostname or node.hostname
    node.announce_ip = source_ip or node.announce_ip
    node.wan_iface = wan_iface or node.wan_iface
    node.agent_version = agent_version or node.agent_version
    node.announce_csr_pem = csr_pem
    # The node is authoritative about its own LANs, so a corrected subnet
    # propagates. An empty announce never wipes a good set.
    if subnets:
        node.subnets = subnets
    if not node.address:
        node.address = source_ip or ""

    token = secrets.token_urlsafe(32)
    node.announce_token_hash = hash_token(token)
    return node, token, fingerprint


async def next_transit_host(session: AsyncSession) -> int:
    """Lowest free host number in the transit subnet.

    .1 belongs to the hub itself, so nodes start at .2.
    """
    used = set(await session.scalars(select(Node.transit_host).where(Node.transit_host.is_not(None))))
    for host in range(2, 250):
        if host not in used:
            return host
    raise AgentError("no free address left in the transit subnet")


async def approve(session: AsyncSession, node: Node, approver_id) -> Node:
    """Accept a node: give it a transit address and sign the key it announced."""
    if node.announce_csr_pem is None:
        raise AgentError("this node never announced a key, nothing to sign")

    if node.transit_host is None and not node.is_hub:
        node.transit_host = await next_transit_host(session)

    ca = await pki.require_ca(session)
    cert = pki.sign_agent_csr(ca, node.announce_csr_pem, node.name)
    node.agent_cert_pem = pki.cert_to_pem(cert)
    node.agent_cert_serial = f"{cert.serial_number:x}"
    node.agent_cert_not_after = cert.not_valid_after_utc

    node.approval = NodeApproval.approved
    node.approved_at = datetime.now(UTC)
    node.approved_by_id = approver_id
    logger.warning("Node %r approved", node.name)
    return node


async def reject(session: AsyncSession, node: Node) -> Node:
    """Refuse a node. Its papers are dropped, so an accept later re-signs them."""
    node.approval = NodeApproval.rejected
    node.agent_cert_pem = None
    node.agent_cert_serial = None
    node.agent_cert_not_after = None
    logger.warning("Node %r rejected", node.name)
    return node


async def collect_decision(
    session: AsyncSession, token: str
) -> tuple[Node, str | None, str | None]:
    """What the agent gets when it polls: its state, and its papers once accepted."""
    node = await session.scalar(
        select(Node).where(Node.announce_token_hash == hash_token(token))
    )
    if node is None:
        raise AgentError("unknown announcement")
    if node.approval != NodeApproval.approved or node.agent_cert_pem is None:
        return node, None, None

    ca = await pki.require_ca(session)
    return node, node.agent_cert_pem, ca.cert_pem


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
    # A certificate alone is not membership: a node an operator rejected must
    # stop receiving configuration even while its certificate is still valid.
    if node.approval != NodeApproval.approved:
        raise AgentError(f"node {name!r} is not approved")
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
    transit_conf, ccd_transit = await _build_transit(session, node)

    # Only the hub faces clients. A node used to run its own client listener,
    # which now serves no purpose and actively hurts: it would claim the client
    # pool's addresses and ports on a machine that may already be routing
    # something else.
    payload = {
        "server_conf": openvpn.render_server_config(node) if node.is_hub else "",
        "server_conf_tcp": (
            openvpn.render_server_config(node, proto="tcp", port=node.tcp_port)
            if node.is_hub and node.tcp_port
            else ""
        ),
        "ca_pem": ca.cert_pem,
        "server_cert_pem": node.server_cert_pem,
        "server_key_pem": decrypt_secret(node.server_key_pem_encrypted),
        "tls_crypt_key": decrypt_secret(ca.tls_crypt_key_encrypted),
        "crl_pem": crl_pem,
        "ccd": ccd,
        "ccd_tcp": ccd_tcp,
        "transit_conf": transit_conf,
        "ccd_transit": ccd_transit,
        "is_hub": node.is_hub,
        # A node NATs the hub's client pools out its own uplink: that is what
        # "this client's internet leaves through that node" means on the wire.
        "nat_subnets": [] if node.is_hub else routing.node_nat_subnets(),
    }

    # The CRL carries a timestamp, so hashing it would change the revision on
    # every poll. Hash the parts that describe intent instead.
    digest = hashlib.sha256()
    for key in (
        "server_conf",
        "server_conf_tcp",
        "ca_pem",
        "server_cert_pem",
        "tls_crypt_key",
        "transit_conf",
    ):
        digest.update(payload[key].encode())
    for subnet in payload["nat_subnets"]:
        digest.update(subnet.encode())
    for entries in (ccd, ccd_tcp, ccd_transit):
        for name in sorted(entries):
            digest.update(name.encode())
            digest.update(entries[name].encode())
    payload["revision"] = digest.hexdigest()[:32]
    return payload


async def _build_transit(
    session: AsyncSession, node: Node
) -> tuple[str, dict[str, str]]:
    """The transit tunnel, from this node's point of view.

    The hub runs the listener and one ccd entry per node; every other node runs
    a client that dials it. Nodes therefore need no inbound port at all, which
    is the same reason the agent dials the panel rather than the reverse.
    """
    if node.is_hub:
        nodes = list(
            await session.scalars(
                select(Node).where(
                    Node.is_hub.is_(False),
                    Node.approval == NodeApproval.approved,
                    Node.is_enabled.is_(True),
                )
            )
        )
        entries = {n.name: openvpn.render_transit_ccd(n) for n in nodes}
        return openvpn.render_transit_server_config(nodes), entries

    hub = await session.scalar(select(Node).where(Node.is_hub.is_(True)))
    if hub is None or not hub.address:
        # Nothing to dial yet; the node keeps serving whatever it already has.
        return "", {}
    return openvpn.render_transit_client_config(node, hub.address), {}


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

    # On the hub a client's file describes its whole world: the address it gets,
    # the networks it may reach, and whether its default route comes here.
    subnets_by_node: dict = {}
    if node.is_hub:
        subnets_by_node = {
            other.id: (other.subnets or [])
            for other in await session.scalars(
                select(Node).where(
                    Node.approval == NodeApproval.approved, Node.is_enabled.is_(True)
                )
            )
        }

    entries: dict[str, str] = {}
    for client in clients:
        grant = next((g for g in client.grants if g.node_id == node.id), None)
        if node.is_hub:
            # Every client dials the hub — that is the only door there is. Which
            # nodes it may then use is a routing decision, not a reason to
            # refuse the connection, and a client with no grants simply reaches
            # nothing once it is inside.
            allowed = client.status == ClientStatus.active
        else:
            allowed = grant is not None and client.status == ClientStatus.active

        default_route = False
        routes: list[str] = []
        if node.is_hub and allowed:
            for held in client.grants:
                if held.is_exit:
                    default_route = True
                routes.extend(subnets_by_node.get(held.node_id, []))

        entries[client.common_name] = ccd_service.render(
            grant,
            client.common_name,
            proto=proto,
            allowed=allowed,
            tunnel_host=client.tunnel_host if node.is_hub else None,
            default_route=default_route,
            routes=sorted(set(routes)),
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
