"""Startup provisioning: the panel prepares its own PKI and node.

Aeolus treats the panel host as a node like any other, so an operator should
never have to create it by hand. Everything here is idempotent and only ever
fills in what is missing.
"""

import logging

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import hash_password
from app.models.node import Node, NodeRole
from app.models.user import User, UserRole
from app.services import pki

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
            openvpn_port=settings.master_openvpn_port,
            openvpn_proto=settings.master_openvpn_proto,
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

    if node.server_cert_serial is None:
        await pki.issue_server_cert(session, node)
        logger.warning("Issued server certificate for panel node %r", node.name)


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
