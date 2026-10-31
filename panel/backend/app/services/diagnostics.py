"""What the panel can tell about one node without logging into it.

Every check here reads something the panel already has: the agent's last
report, the hub's own OpenVPN status files and the configuration it rendered.
A check the panel cannot answer from those is left out rather than guessed.
"""

import ipaddress
import json
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.models.node import ClientNodeGrant, ClientStatus, Node, NodeStatus
from app.services import exits, openvpn, routing

# Either form makes OpenVPN send everything to the node: the two halves are what
# redirect-gateway def1 style setups use, so they win over a plain default.
_DEFAULT_ROUTES = ({"0.0.0.0/0"}, {"0.0.0.0/1", "128.0.0.0/1"})


def _check(key: str, status: str, title: str, detail: str = "") -> dict:
    return {"key": key, "status": status, "title": title, "detail": detail}


def _ago(moment: datetime | None) -> str:
    if moment is None:
        return "никогда"
    seconds = int((datetime.now(UTC) - moment).total_seconds())
    if seconds < 60:
        return f"{seconds} с назад"
    if seconds < 3600:
        return f"{seconds // 60} мин назад"
    if seconds < 86400:
        return f"{seconds // 3600} ч назад"
    return f"{seconds // 86400} дн назад"


def _cert_check(key: str, title: str, not_after: datetime | None) -> dict:
    if not_after is None:
        return _check(key, "unknown", title, "сертификат ещё не выпущен")
    days = (not_after - datetime.now(UTC)).days
    stamp = not_after.strftime("%d.%m.%Y")
    if days < 0:
        return _check(key, "fail", title, f"истёк {stamp}")
    if days <= 30:
        return _check(key, "warn", title, f"истекает через {days} дн, {stamp}")
    return _check(key, "ok", title, f"действует до {stamp}")


def _normalise(network: str) -> str:
    # OpenVPN prints host routes without a prefix; everything else as a/len.
    try:
        return str(ipaddress.ip_network(network, strict=False))
    except ValueError:
        return network


def _read(path: Path) -> str | None:
    try:
        return path.read_text()
    except OSError:
        return None


async def _exit_clients(session: AsyncSession, node: Node) -> list[str]:
    grants = await session.scalars(
        select(ClientNodeGrant)
        .where(ClientNodeGrant.node_id == node.id, ClientNodeGrant.is_exit.is_(True))
        .options(selectinload(ClientNodeGrant.client))
    )
    return sorted(
        g.client.common_name
        for g in grants
        if g.client.status == ClientStatus.active and g.client.revoked_at is None
    )


async def build(session: AsyncSession, node: Node) -> dict:
    checks: list[dict] = []
    files: list[dict] = []
    exit_for = await _exit_clients(session, node)
    config_dir = Path(settings.openvpn_config_dir)

    fresh = (
        node.last_seen_at is not None
        and (datetime.now(UTC) - node.last_seen_at).total_seconds()
        < settings.node_offline_after_seconds
    )
    if node.last_seen_at is None:
        checks.append(_check("agent", "unknown", "Агент ещё не подключался"))
    elif fresh:
        checks.append(
            _check("agent", "ok", "Агент на связи", f"{_ago(node.last_seen_at)}, gRPC + mTLS")
        )
    else:
        checks.append(
            _check("agent", "fail", "Агент молчит", f"последний отчёт {_ago(node.last_seen_at)}")
        )

    if node.status == NodeStatus.error:
        checks.append(
            _check(
                "openvpn",
                "fail",
                "OpenVPN на узле не работает",
                node.status_message or "агент сообщил об ошибке без подробностей",
            )
        )
    elif fresh:
        checks.append(_check("openvpn", "ok", "OpenVPN на узле запущен"))

    if node.is_hub:
        sessions = openvpn.client_sessions()
        transit = openvpn.transit_sessions()
        checks.append(
            _check(
                "listeners",
                "ok" if node.status == NodeStatus.online else "unknown",
                "Входы для клиентов",
                f"сейчас сессий: {len(sessions)}, узлов на транзите: {len(transit)}",
            )
        )
        checks.append(_cert_check("server_cert", "Сертификат сервера", node.server_cert_not_after))
        for name in ("server.conf", "server-tcp.conf", "transit.conf"):
            content = _read(config_dir / name)
            if content is not None:
                files.append({"name": name, "content": content})
        plan = _read(config_dir / "routing.json")
        if plan is not None:
            files.append({"name": "routing.json", "content": plan})
        return {"checks": checks, "files": files, "exit_for": exit_for}

    connected = node.name in openvpn.transit_sessions()
    routes = {_normalise(r) for r in openvpn.transit_routes().get(node.name, [])}

    if connected:
        checks.append(
            _check(
                "transit",
                "ok",
                "Транзит поднят",
                "хаб видит сессию"
                + (
                    f" {openvpn.transit_address(node.transit_host)}"
                    if node.transit_host is not None
                    else ""
                ),
            )
        )
    else:
        checks.append(
            _check(
                "transit",
                "fail",
                "Транзита нет",
                "хаб не держит туннель с узлом"
                + ("" if node.transit_obfuscated else ", попробуй HTTPS-транзит"),
            )
        )

    subnets = [_normalise(s) for s in node.subnets or []]
    if not subnets:
        checks.append(
            _check("lan", "unknown", "Сети за узлом", "узел не объявил ни одной сети")
        )
    elif not connected:
        checks.append(
            _check("lan", "unknown", "Маршрут в сеть узла", "проверится, когда поднимется транзит")
        )
    else:
        missing = [s for s in subnets if s not in routes]
        if missing:
            checks.append(
                _check(
                    "lan",
                    "fail",
                    "Маршрут в сеть узла",
                    f"хаб не принял iroute на {', '.join(missing)}",
                )
            )
        else:
            checks.append(
                _check("lan", "ok", "Маршрут в сеть узла", "iroute " + ", ".join(subnets))
            )

    if exit_for:
        who = ", ".join(exit_for)
        if not connected:
            checks.append(
                _check("exit", "fail", "Выход в интернет", f"транзита нет, {who} без интернета")
            )
        elif any(default <= routes for default in _DEFAULT_ROUTES):
            checks.append(_check("exit", "ok", "Выход в интернет", f"маршрут по умолчанию ведёт сюда: {who}"))
        else:
            checks.append(
                _check(
                    "exit",
                    "fail",
                    "Выход в интернет не доедет",
                    f"узел — выход для {who}, но у хаба нет маршрута 0.0.0.0/0 "
                    "в этот туннель: пакеты выбрасываются раньше, чем дойдут до NAT узла",
                )
            )

    checks.append(_cert_check("agent_cert", "Сертификат агента", node.agent_cert_not_after))

    node_is_exit = any(n.id == node.id for n in await exits.remote_exit_nodes(session))
    ccd = _read(config_dir / "ccd-transit" / node.name)
    files.append(
        {
            "name": "ccd-transit (хаб)",
            "content": ccd
            if ccd is not None
            else openvpn.render_transit_ccd(node, is_exit=node_is_exit),
        }
    )
    hub = await session.scalar(select(Node).where(Node.is_hub.is_(True)))
    if hub is not None and hub.address:
        files.append(
            {
                "name": "transit.conf (узел)",
                "content": openvpn.render_transit_client_config(
                    node, hub.address, is_exit=node_is_exit
                ),
            }
        )

    table = openvpn.transit_routes().get(node.name, [])
    files.append(
        {
            "name": "маршруты транзита (хаб)",
            "content": "\n".join(table) + "\n"
            if table
            else "# хаб не держит для узла ни одного маршрута\n",
        }
    )

    plan = await routing.build_plan(session)
    address = (
        openvpn.transit_address(node.transit_host) if node.transit_host is not None else None
    )
    lans = [ipaddress.ip_network(s) for s in node.subnets or []]
    mine = [
        entry
        for entry in plan["clients"]
        if (address and entry["exit_via"] == address)
        or any(ipaddress.ip_network(a).overlaps(lan) for a in entry["allow"] for lan in lans)
    ]
    files.append(
        {
            "name": "routing.json (клиенты узла)",
            "content": json.dumps({"revision": plan["revision"], "clients": mine}, indent=2, ensure_ascii=False)
            + "\n",
        }
    )
    return {"checks": checks, "files": files, "exit_for": exit_for}

