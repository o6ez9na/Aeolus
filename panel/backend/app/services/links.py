"""Site links: the networks of two nodes reaching each other over the transit.

Every node already dials the hub's transit listener, and the hub already holds
an iroute for each LAN behind it: that is how a client reaches a node. A link
uses the same tunnels for the node's own LAN. The hub pushes each side a route
to the other and forwards between the two tunnels, so nothing new is dialled
and no node needs an inbound port.

The hub is a node too. Its LAN is not in `subnets` (see Node.site_subnets), and
the devices on it route only to their own gateway, which knows nothing of the
sites behind the transit; so traffic into the hub's LAN is masqueraded behind
the hub, and that direction only. Between two nodes there is no NAT: each node
is the gateway of its LAN, and both ends know the way back.
"""

import ipaddress
import uuid
from collections.abc import Iterable

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.node import Node, NodeApproval, NodeLink


class LinkError(Exception):
    """A link that cannot work as asked."""


def site_networks(node: Node) -> list[str]:
    """What this site shares with the sites it is linked to."""
    if node.site_subnets is not None:
        return list(node.site_subnets)
    return [] if node.is_hub else list(node.subnets or [])


def ordered(a: uuid.UUID, b: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    """The order a link is stored in: the database checks node_a_id < node_b_id."""
    return (a, b) if a < b else (b, a)


def _reserved() -> list[ipaddress.IPv4Network]:
    """The panel's own address space, which no site may claim."""
    return [
        ipaddress.ip_network(f"{net}/{settings.vpn_netmask}", strict=False)
        for net in (settings.vpn_subnet, settings.vpn_tcp_subnet, settings.vpn_transit_subnet)
    ]


def _networks(values: Iterable[str]) -> list[ipaddress.IPv4Network]:
    return [ipaddress.ip_network(value, strict=False) for value in values]


def _overlap(left: Iterable[str], right: Iterable[str]) -> tuple[str, str] | None:
    for a in _networks(left):
        for b in _networks(right):
            if a.overlaps(b):
                return str(a), str(b)
    return None


def _usable(node: Node) -> bool:
    return node.approval == NodeApproval.approved and node.is_enabled


def check_networks(node: Node, networks: list[str]) -> None:
    """A site's networks must not take the panel's own address space."""
    for net in _networks(networks):
        for reserved in _reserved():
            if net.overlaps(reserved):
                raise LinkError(
                    f"{net} пересекается с адресами самой панели ({reserved}): "
                    "клиенты и транзит потеряют маршрут"
                )


async def load(session: AsyncSession) -> list[NodeLink]:
    return list(await session.scalars(select(NodeLink).order_by(NodeLink.created_at)))


async def of_node(session: AsyncSession, node_id: uuid.UUID) -> list[NodeLink]:
    return list(
        await session.scalars(
            select(NodeLink).where(
                or_(NodeLink.node_a_id == node_id, NodeLink.node_b_id == node_id)
            )
        )
    )


async def validate(
    session: AsyncSession, a: Node, b: Node, *, ignore: uuid.UUID | None = None
) -> None:
    """Refuse a link whose routes would be ambiguous or would break something.

    Overlapping networks are the classic way to lose a site: a route to the
    other side that covers your own LAN, or two peers claiming the same
    addresses, sends traffic somewhere nobody expects.
    """
    if a.id == b.id:
        raise LinkError("узел нельзя связать с самим собой")
    for node in (a, b):
        if not _usable(node):
            raise LinkError(f"{node.name}: узел не принят или выключен")
        if not site_networks(node):
            raise LinkError(
                f"{node.name}: у панели не задана её сеть для транзита сетей"
                if node.is_hub
                else f"{node.name}: узел не объявил ни одной сети"
            )
        check_networks(node, site_networks(node))

    clash = _overlap(site_networks(a), site_networks(b))
    if clash:
        raise LinkError(f"сети пересекаются: {clash[0]} ({a.name}) и {clash[1]} ({b.name})")

    # Each side ends up with one route per peer network, next to its own LAN:
    # none of them may overlap, or the kernel picks one and the rest go dark.
    for side, other in ((a, b), (b, a)):
        routes = list(site_networks(other))
        for link in await of_node(session, side.id):
            if link.id == ignore:
                continue
            peer = await session.get(Node, link.other(side.id))
            if peer is None or peer.id == other.id:
                continue
            clash = _overlap(routes, site_networks(peer))
            if clash:
                raise LinkError(
                    f"{side.name} уже связан с {peer.name}, и его сеть {clash[1]} "
                    f"пересекается с {clash[0]} ({other.name})"
                )
            routes.extend(site_networks(peer))


def remote_networks(
    node: Node, links: list[NodeLink], nodes: dict[uuid.UUID, Node]
) -> list[str]:
    """The other sides of this node's links: routes it gets, traffic it forwards."""
    remote: set[str] = set()
    for link in links:
        if node.id not in (link.node_a_id, link.node_b_id):
            continue
        peer = nodes.get(link.other(node.id))
        if peer is not None and _usable(peer) and _usable(node):
            remote.update(site_networks(peer))
    return sorted(remote, key=lambda net: ipaddress.ip_network(net, strict=False))


def hub_rules(links: list[NodeLink], nodes: dict[uuid.UUID, Node]) -> list[dict]:
    """What the hub forwards for links, one entry per direction a flow may start.

    A link to the hub opens the hub's LAN to the node, masqueraded: the LAN's
    devices could not answer an address from another site. The reverse, a
    device at home starting a connection to the node's LAN, would need a route
    on the home router and is left out.
    """
    rules: list[dict] = []
    for link in links:
        a, b = nodes.get(link.node_a_id), nodes.get(link.node_b_id)
        if a is None or b is None or not (_usable(a) and _usable(b)):
            continue
        if a.is_hub or b.is_hub:
            hub, node = (a, b) if a.is_hub else (b, a)
            rules.append(
                {"src": site_networks(node), "dst": site_networks(hub), "nat": True}
            )
        else:
            rules.append({"src": site_networks(a), "dst": site_networks(b), "nat": False})
            rules.append({"src": site_networks(b), "dst": site_networks(a), "nat": False})
    return sorted(rules, key=lambda rule: (rule["src"], rule["dst"]))
