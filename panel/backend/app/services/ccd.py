"""client-config-dir entries: what one client gets on one node.

A ccd file is read by OpenVPN at connect time and a broken line in it stops that
client connecting, so everything here is validated before it can be stored.
"""

import ipaddress

from app.core.config import settings
from app.models.node import ClientNodeGrant
from app.services.openvpn import static_address

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


def validate_host(host: int) -> int:
    low, high = settings.vpn_static_host_min, settings.vpn_static_host_max
    if not low <= host <= high:
        raise CcdError(
            f"фиксированный адрес должен быть в диапазоне {low}–{high}: "
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
            f"{network} слишком широкая: узел объявляет свои локальные сети, "
            "а не весь интернет. Выход в интернет выдаётся клиенту отдельно."
        )
    return str(network)


def validate_push(option: str) -> str:
    option = option.strip()
    if not option:
        raise CcdError("пустая push-опция")
    if '"' in option or "\n" in option:
        raise CcdError("в push-опции нельзя использовать кавычки и переводы строк")
    if option.split()[0] not in ALLOWED_PUSH:
        allowed = ", ".join(ALLOWED_PUSH)
        raise CcdError(f"опция {option.split()[0]!r} не разрешена. можно: {allowed}")
    return option


def _route_line(directive: str, network: str) -> str:
    net = ipaddress.ip_network(network)
    return f"{directive} {net.network_address} {net.netmask}"


def render(
    grant: ClientNodeGrant | None,
    common_name: str,
    *,
    proto: str,
    allowed: bool,
    tunnel_host: int | None = None,
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

    # The client's own address wins: on the hub every rule about this client is
    # written against it, so the ccd file has to hand out that one and no other.
    host = tunnel_host if tunnel_host is not None else (grant.static_host if grant else None)
    if host is not None:
        address = static_address(proto, host)
        # topology subnet: the second argument is the mask, not a peer address.
        lines.append(f"ifconfig-push {address} {settings.vpn_netmask}")

    # The default route is a per-client decision: only a client that exits
    # somewhere gets one, or the rest would send everything into a tunnel that
    # drops it.
    if default_route:
        lines.append('push "redirect-gateway def1 bypass-dhcp"')

    # What this client may reach, so it routes those networks into the tunnel
    # without taking the default route with them.
    for network in routes or []:
        lines.append(f'push "{_route_line("route", network)}"')

    for network in (grant.push_routes if grant else None) or []:
        lines.append(f'push "{_route_line("route", network)}"')

    for network in (grant.iroutes if grant else None) or []:
        lines.append(_route_line("iroute", network))

    for option in (grant.push_options if grant else None) or []:
        lines.append(f'push "{option}"')

    return "\n".join(lines) + "\n"
