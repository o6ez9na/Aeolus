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


def validate_network(value: str) -> str:
    """Accept a CIDR network and return it normalised."""
    try:
        network = ipaddress.ip_network(value.strip(), strict=False)
    except ValueError as exc:
        raise CcdError(f"{value!r} — не сеть в формате CIDR: {exc}") from None
    if network.version != 4:
        raise CcdError("OpenVPN здесь работает только с IPv4")
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


def render(grant: ClientNodeGrant, common_name: str, *, proto: str, allowed: bool) -> str:
    """The ccd file for one client on one listener of one node.

    A client without a grant still gets a file: OpenVPN accepts any certificate
    the CA signed, so access is denied here rather than by omission.
    """
    if not allowed:
        return f"# {common_name}: доступ к этому узлу не выдан\ndisable\n"

    lines = [f"# {common_name} — сгенерировано Aeolus, править вручную бесполезно"]

    if grant.static_host is not None:
        address = static_address(proto, grant.static_host)
        # topology subnet: the second argument is the mask, not a peer address.
        lines.append(f"ifconfig-push {address} {settings.vpn_netmask}")

    for network in grant.push_routes or []:
        lines.append(f'push "{_route_line("route", network)}"')

    for network in grant.iroutes or []:
        lines.append(_route_line("iroute", network))

    for option in grant.push_options or []:
        lines.append(f'push "{option}"')

    return "\n".join(lines) + "\n"
