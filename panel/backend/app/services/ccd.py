"""client-config-dir entries: what one client gets when it connects.

A ccd file is read by OpenVPN at connect time and a broken line in it stops that
client connecting, so everything here is validated before it can be stored.
"""

import ipaddress
from collections.abc import Iterable
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.node import Client, Node
from app.services import links as links_service
from app.services.openvpn import dns_push_lines, static_address

# Directives an operator may push. Anything outside this list is refused: a ccd
# file can otherwise change routing, authentication or the tunnel itself, and a
# typo there is only discovered by the client that can no longer connect.
ALLOWED_PUSH = (
    "dhcp-option",
    "redirect-gateway",
    "route-gateway",
    "route-metric",
    "inactive",
    "ping",
    "ping-restart",
    "block-outside-dns",
    "register-dns",
)


class CcdError(ValueError):
    """Refused ccd setting. The message is meant for the operator."""


@dataclass(frozen=True)
class ClientNetwork:
    """A client's own network settings: the saved ones, or a draft being previewed."""

    tunnel_host: int | None = None
    push_routes: list[str] = field(default_factory=list)
    iroutes: list[str] = field(default_factory=list)
    push_options: list[str] = field(default_factory=list)
    # Empty means the client takes what the hub pushes to everyone.
    dns_servers: list[str] = field(default_factory=list)

    @classmethod
    def of(cls, client: Client) -> "ClientNetwork":
        return cls(
            tunnel_host=client.tunnel_host,
            push_routes=client.push_routes or [],
            iroutes=client.iroutes or [],
            push_options=client.push_options or [],
            dns_servers=client.dns_servers or [],
        )

    @property
    def reachable(self) -> list[str]:
        """Networks this client routes into the tunnel and the hub lets it reach.

        A private resolver of its own is one of them: without a route and a rule
        the client could not ask it anything, and would have no names at all.
        """
        resolvers = [
            f"{server}/32"
            for server in self.dns_servers
            if ":" not in server and ipaddress.ip_address(server).is_private
        ]
        return [*self.push_routes, *resolvers]


def validate_host(host: int) -> int:
    low, high = settings.vpn_static_host_min, settings.vpn_static_host_max
    if not low <= host <= high:
        raise CcdError(
            f"номер адреса должен быть в диапазоне {low}–{high}: "
            f"выше начинается пул, который OpenVPN раздаёт сам"
        )
    return host


def validate_network(value: str, *, allow_default: bool = False) -> str:
    """Accept a CIDR network and return it normalised."""
    try:
        network = ipaddress.ip_network(value.strip(), strict=False)
    except ValueError as exc:
        raise CcdError(f"{value!r} — не сеть в формате CIDR: {exc}") from None
    if network.version != 4:
        raise CcdError("OpenVPN здесь работает только с IPv4")
    if not allow_default and network.prefixlen < 8:
        # A node announcing 0.0.0.0/0 as its LAN would have the panel route every
        # client's traffic into that one tunnel. Sending all traffic through a
        # node is a separate decision an operator makes per client, not something
        # the node gets to claim about itself.
        raise CcdError(
            f"{network} слишком широкая: это локальные сети, а не весь интернет. "
            "Выход в интернет выдаётся клиенту отдельно."
        )
    return str(network)


def validate_push(option: str) -> str:
    option = option.strip()
    if not option:
        raise CcdError("пустая опция OpenVPN")
    if '"' in option or "\n" in option:
        raise CcdError("в опции OpenVPN нельзя использовать кавычки и переводы строк")
    if option.split()[0] not in ALLOWED_PUSH:
        allowed = ", ".join(ALLOWED_PUSH)
        raise CcdError(f"опция {option.split()[0]!r} не разрешена. можно: {allowed}")
    return option


def validate_dns(value: str) -> str:
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        raise CcdError(f"{value!r} — не IP-адрес DNS-сервера") from None


def _unique(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _taken(net: ipaddress.IPv4Network, networks: Iterable[str]) -> bool:
    return any(net.overlaps(ipaddress.ip_network(other, strict=False)) for other in networks)


async def _check_behind(session: AsyncSession, client: Client, iroutes: list[str]) -> None:
    """A network behind a client has one way in: nobody else may claim it."""
    if not iroutes:
        return
    nodes = (await session.execute(select(Node.name, Node.subnets, Node.site_subnets))).all()
    others = (
        await session.execute(
            select(Client.common_name, Client.iroutes).where(Client.id != client.id)
        )
    ).all()
    for raw in iroutes:
        net = ipaddress.ip_network(raw)
        for name, subnets, site_subnets in nodes:
            if _taken(net, [*(subnets or []), *(site_subnets or [])]):
                raise CcdError(f"{net} пересекается с сетью узла {name}")
        for name, networks in others:
            if _taken(net, networks or []):
                raise CcdError(f"{net} уже указана как сеть за клиентом {name}")


async def resolve_network(session: AsyncSession, client: Client, changes: dict) -> ClientNetwork:
    """Check a change to a client's settings and return the result, storing nothing.

    Saving and previewing a draft both come through here, so a preview never
    shows a file the save would then refuse.
    """
    current = ClientNetwork.of(client)

    host = current.tunnel_host
    if "tunnel_host" in changes:
        if changes["tunnel_host"] is None:
            raise CcdError("у клиента должен быть свой адрес: по нему написаны все правила")
        host = validate_host(changes["tunnel_host"])
        holder = await session.scalar(
            select(Client.common_name).where(Client.tunnel_host == host, Client.id != client.id)
        )
        if holder is not None:
            raise CcdError(f"этот адрес уже занят клиентом {holder}")

    push_routes = _unique(
        validate_network(value) for value in changes.get("push_routes", current.push_routes) or []
    )
    iroutes = _unique(
        validate_network(value) for value in changes.get("iroutes", current.iroutes) or []
    )
    push_options = _unique(
        validate_push(value) for value in changes.get("push_options", current.push_options) or []
    )
    dns_servers = _unique(
        validate_dns(value) for value in changes.get("dns_servers", current.dns_servers) or []
    )

    for raw in [*push_routes, *iroutes]:
        net = ipaddress.ip_network(raw)
        for reserved in links_service.reserved_networks():
            if net.overlaps(reserved):
                raise CcdError(f"{net} пересекается с адресами самой панели ({reserved})")
    for raw in iroutes:
        if _taken(ipaddress.ip_network(raw), push_routes):
            raise CcdError(f"{raw} не может быть сразу и за клиентом, и маршрутом к нему в туннель")
    await _check_behind(session, client, iroutes)

    return ClientNetwork(
        tunnel_host=host,
        push_routes=push_routes,
        iroutes=iroutes,
        push_options=push_options,
        dns_servers=dns_servers,
    )


def _route_line(directive: str, network: str) -> str:
    net = ipaddress.ip_network(network)
    return f"{directive} {net.network_address} {net.netmask}"


def render(
    common_name: str,
    *,
    proto: str,
    allowed: bool,
    network: ClientNetwork | None = None,
    default_route: bool = False,
    routes: list[str] | None = None,
) -> str:
    """The ccd file for one client on one listener of one node.

    A client without a grant still gets a file: OpenVPN accepts any certificate
    the CA signed, so access is denied here rather than by omission.
    """
    if not allowed:
        return f"# {common_name}: доступ к этому узлу не выдан\ndisable\n"

    # Reaching the hub is not the same as being allowed anywhere: what a client
    # may touch once it is in is decided by the firewall, from its address.

    lines = [f"# {common_name} — сгенерировано Aeolus, править вручную бесполезно"]
    network = network or ClientNetwork()

    # The client's own address wins: on the hub every rule about this client is
    # written against it, so the ccd file has to hand out that one and no other.
    if network.tunnel_host is not None:
        address = static_address(proto, network.tunnel_host)
        # topology subnet: the second argument is the mask, not a peer address.
        lines.append(f"ifconfig-push {address} {settings.vpn_netmask}")

    # The default route is a per-client decision: only a client that exits
    # somewhere gets one, or the rest would send everything into a tunnel that
    # drops it.
    if default_route:
        lines.append('push "redirect-gateway def1 bypass-dhcp"')

    # What this client may reach, so it routes those networks into the tunnel
    # without taking the default route with them.
    for route in sorted({*(routes or []), *network.reachable}):
        lines.append(f'push "{_route_line("route", route)}"')

    for route in network.iroutes:
        lines.append(_route_line("iroute", route))

    # server.conf pushes the hub's resolvers to everyone; a client with its own
    # would otherwise be handed both and ask whichever it likes.
    if network.dns_servers:
        lines.append("push-remove dhcp-option")
        lines.append(dns_push_lines(network.dns_servers))

    for option in network.push_options:
        lines.append(f'push "{option}"')

    return "\n".join(lines) + "\n"
