"""Startup provisioning: the panel prepares its own PKI and node.

Aeolus treats the panel host as a node like any other, so an operator should
never have to create it by hand. Everything here is idempotent and only ever
fills in what is missing.
"""

import logging
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import hash_password
from app.models.node import Node, NodeApproval, NodeRole
from app.models.user import User, UserRole
from app.models.node import Client
from app.services import agent, openvpn, pki, routing

logger = logging.getLogger("aeolus.bootstrap")


async def ensure_admin(session: AsyncSession) -> None:
    if not settings.first_admin_password:
        return
    if await session.scalar(select(func.count()).select_from(User)):
        return

    session.add(
        User(
            username=settings.first_admin_username,
            password_hash=hash_password(settings.first_admin_password),
            role=UserRole.admin,
        )
    )
    logger.warning("Created bootstrap admin %r", settings.first_admin_username)


async def ensure_ca(session: AsyncSession) -> None:
    if await pki.get_active_ca(session) is not None:
        return
    await pki.init_ca(session, f"{settings.project_name} CA")
    logger.warning("Created certificate authority")


async def ensure_master_node(session: AsyncSession) -> None:
    """Register the panel host as a master node and give it a server certificate."""
    address = settings.master_node_address
    if not address:
        logger.warning(
            "AEOLUS_PUBLIC_HOST and AEOLUS_DOMAIN are both unset; "
            "skipping self-registration of the panel node"
        )
        return

    node = await session.scalar(
        select(Node).where(Node.name == settings.master_node_name)
    )
    if node is None:
        node = Node(
            name=settings.master_node_name,
            address=address,
            role=NodeRole.master,
            # The panel host is the hub and needs no operator to accept it: it
            # is the machine the operator is already logged in to.
            is_hub=True,
            approval=NodeApproval.approved,
            openvpn_port=settings.master_openvpn_port,
            openvpn_proto=settings.master_openvpn_proto,
            tcp_port=settings.master_tcp_port,
        )
        session.add(node)
        await session.flush()
        logger.warning("Registered panel node %r at %s", node.name, address)
    elif node.address != address:
        # The panel moved; its certificate names the old address.
        node.address = address
        node.server_cert_pem = None
        node.server_cert_serial = None
        node.server_cert_not_after = None
        logger.warning("Panel node address changed to %s, reissuing certificate", address)

    if node.tcp_port != settings.master_tcp_port:
        node.tcp_port = settings.master_tcp_port

    # Older deployments created this row before either flag existed.
    node.is_hub = True
    node.approval = NodeApproval.approved

    if node.server_cert_serial is None:
        await pki.issue_server_cert(session, node)
        logger.warning("Issued server certificate for panel node %r", node.name)

    await ensure_client_addresses(session)
    await write_master_bundle(session, node)
    await openvpn.sync_routing_plan(session)
    await _ensure_local_enrollment_token(session, node)


async def ensure_client_addresses(session: AsyncSession) -> None:
    """Give every client an address of its own.

    Clients created before the hub model have none, and without one there is
    nothing to write a firewall rule against.
    """
    for client in await session.scalars(select(Client).where(Client.tunnel_host.is_(None))):
        await routing.ensure_tunnel_host(session, client)
        logger.warning("Assigned %s tunnel host %s", client.common_name, client.tunnel_host)


async def _ensure_local_enrollment_token(session: AsyncSession, node: Node) -> None:
    """Leave a token where the panel's own agent will find it.

    Remote nodes get their token from an operator; the local one should not need
    a human in the loop at all.
    """
    # Keep a token available until the agent actually reports in. An agent that
    # lost its state directory needs to enrol again, and there is no operator in
    # the loop for the local node.
    if node.last_seen_at is not None:
        return

    token_path = Path(settings.openvpn_config_dir) / ".enrollment-token"
    if not token_path.parent.exists():
        return

    still_valid = (
        node.enrollment_token_expires_at is not None
        and node.enrollment_token_expires_at > datetime.now(UTC)
    )
    if token_path.exists() and still_valid:
        return

    token = await agent.issue_enrollment_token(session, node)
    token_path.write_text(token)
    token_path.chmod(0o600)
    logger.warning("Left an enrolment token for the local agent at %s", token_path)


async def write_master_bundle(session: AsyncSession, node: Node) -> None:
    """Materialise the local OpenVPN config so the openvpn container can start.

    Skipped when the directory is not mounted, which is the case for a plain
    local backend run without the VPN container.
    """
    if not Path(settings.openvpn_config_dir).parent.exists():
        logger.info(
            "%s is not mounted; skipping OpenVPN bundle for the panel node",
            settings.openvpn_config_dir,
        )
        return

    ca = await pki.require_ca(session)
    crl_pem = await pki.build_crl(session)
    openvpn.write_server_bundle(node, ca, crl_pem)


async def run(session: AsyncSession) -> None:
    """Provision what is missing, but never take the panel down trying.

    A PKI problem must not cost an operator the login page, which is where they
    would go to diagnose it.
    """
    try:
        await ensure_admin(session)
        await ensure_ca(session)
        await ensure_master_node(session)
        await session.commit()
    except Exception:
        await session.rollback()
        logger.exception("Startup provisioning failed; panel is starting anyway")
