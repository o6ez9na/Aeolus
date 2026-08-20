"""What the hub does with a client's packets once they arrive.

The hub owns three decisions per client: which address it gets, which networks
it may reach, and where the rest of its traffic goes. All three are written by
address, which is why every client holds a tunnel host of its own.

Enforcement is a firewall, never a route. A pushed route is advice the client is
free to ignore; a DROP in FORWARD is not.

The panel does not program the kernel itself — the tunnels live in the openvpn
container's namespace. It writes a plan, and the supervisor there applies it,
the same way configuration already reaches a node.
"""

import hashlib
import ipaddress
import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.models.node import Client, ClientNodeGrant, ClientStatus, Node, NodeApproval


def client_address(proto: str, host: int) -> str:
    from app.services.openvpn import static_address

    return static_address(proto, host)


async def next_tunnel_host(session: AsyncSession) -> int:
    """Lowest free host number in the client pool.

    .1 is the hub itself, and the dynamic pool starts higher up, so a client's
    own address can never be handed to somebody else by OpenVPN.
    """
    used = set(
        await session.scalars(select(Client.tunnel_host).where(Client.tunnel_host.is_not(None)))
    )
    for host in range(settings.vpn_static_host_min, settings.vpn_static_host_max + 1):
        if host not in used:
            return host
    raise ValueError("no free address left in the client pool")


async def ensure_tunnel_host(session: AsyncSession, client: Client) -> Client:
    if client.tunnel_host is None:
        client.tunnel_host = await next_tunnel_host(session)
    return client


async def build_plan(session: AsyncSession) -> dict:
    """The whole routing and firewall state, as data.

    Only clients that can actually connect are in it: a revoked or disabled
    client has no business appearing in a rule, and a node nobody approved is
    not a place to send anyone.
    """
    hub = await session.scalar(select(Node).where(Node.is_hub.is_(True)))

    nodes = {
        node.id: node
        for node in await session.scalars(
            select(Node).where(
                Node.approval == NodeApproval.approved, Node.is_enabled.is_(True)
            )
        )
    }

    # Every LAN the mesh knows about. "Send my internet through this node" must
    # not quietly hand over the other sites as well, so the exit rule excludes
    # these and leaves them to the per-grant rules.
    mesh: list[str] = []
    for node in nodes.values():
        mesh.extend(node.subnets or [])

    clients = await session.scalars(
        select(Client)
        .options(selectinload(Client.grants))
        .where(
            Client.status == ClientStatus.active,
            Client.revoked_at.is_(None),
            Client.tunnel_host.is_not(None),
        )
        .order_by(Client.common_name)
    )

    entries = []
    for client in clients:
        allow: list[str] = []
        exit_via: str | None = None

        for grant in client.grants:
            node = nodes.get(grant.node_id)
            if node is None:
                continue

            # Reaching a node means reaching the networks behind it. The hub
            # itself has none: what a grant to the hub buys is the exit.
            allow.extend(node.subnets or [])

            if grant.is_exit:
                exit_via = (
                    "hub"
                    if node.is_hub
                    else transit_address(node.transit_host)
                    if node.transit_host is not None
                    else None
                )

        entries.append(
            {
                "name": client.common_name,
                "address": client_address("udp", client.tunnel_host),
                "address_tcp": client_address("tcp", client.tunnel_host),
                "allow": sorted(set(allow)),
                "exit_via": exit_via,
            }
        )

    plan = {
        "pool": _cidr(settings.vpn_subnet),
        "pool_tcp": _cidr(settings.vpn_tcp_subnet),
        "transit": _cidr(settings.vpn_transit_subnet),
        "hub_transit_address": transit_address(1),
        "mesh": sorted(set(mesh)),
        "clients": entries,
        "hub": hub.name if hub else None,
    }
    plan["revision"] = _digest(plan)
    return plan


def _cidr(network: str) -> str:
    return str(ipaddress.ip_network(f"{network}/{settings.vpn_netmask}"))


def transit_address(host: int) -> str:
    from app.services.openvpn import transit_address as address

    return address(host)


def _digest(plan: dict) -> str:
    payload = json.dumps(plan, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(payload).hexdigest()[:32]


def render(plan: dict) -> str:
    return json.dumps(plan, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def node_nat_subnets() -> list[str]:
    """What a node masquerades: the hub's client pools, arriving over transit."""
    return [
        str(ipaddress.ip_network(f"{settings.vpn_subnet}/{settings.vpn_netmask}")),
        str(ipaddress.ip_network(f"{settings.vpn_tcp_subnet}/{settings.vpn_netmask}")),
    ]
