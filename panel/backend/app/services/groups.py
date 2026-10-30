"""Groups: access defined once and carried by every member.

A member's effective access is the group's grants plus whatever was granted to
the client personally. The group's part is written into the client's own grant
rows, marked with the group, so nothing downstream — routing plan, ccd files,
the agent — needs to know groups exist. This module keeps those rows in step:
after any change to a group or to who is in it, `sync_client` makes a member's
rows say exactly what the group says, and leaves the personal ones alone.
"""

import ipaddress

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.node import Client, ClientGroup, ClientGroupGrant, ClientNodeGrant, Node


class GroupError(ValueError):
    """Refused change. The message is meant for the operator."""


def validate_scope(networks: list[str] | None, node: Node) -> list[str] | None:
    """Normalise "only this part of the node's LAN", or None for all of it.

    A single address is written as a /32. Everything has to sit inside what the
    node announces: the hub only routes those networks into the node's tunnel,
    so anything else would be a rule that can never match.
    """
    if networks is None:
        return None
    if not networks:
        raise GroupError("выбери хотя бы одну сеть или адрес — или сними доступ к узлу целиком")
    if node.is_hub or not node.subnets:
        raise GroupError(f"у {node.name} нет своих сетей, ограничивать нечего")

    announced = [ipaddress.ip_network(s) for s in node.subnets]
    result: list[str] = []
    for raw in networks:
        try:
            net = ipaddress.ip_network(raw.strip(), strict=False)
        except ValueError:
            raise GroupError(f"{raw!r} — не адрес и не сеть") from None
        if net.version != 4:
            raise GroupError("OpenVPN здесь работает только с IPv4")
        if not any(net.subnet_of(a) for a in announced):
            raise GroupError(
                f"{net} не входит в сети {node.name} ({', '.join(node.subnets)})"
            )
        result.append(str(net))
    # Whole announced networks only: that is just "all of it" spelled out.
    if sorted(set(result)) == sorted(str(a) for a in announced):
        return None
    return sorted(set(result), key=lambda n: ipaddress.ip_network(n))


def grant_networks(networks: list[str] | None, node_subnets: list[str]) -> list[str]:
    """What a grant actually opens: its own scope, or the node's whole LAN.

    A stored scope that the node no longer announces is dropped rather than
    trusted, so a renumbered LAN closes access instead of leaving a stray rule.
    """
    if networks is None:
        return list(node_subnets)
    announced = [ipaddress.ip_network(s) for s in node_subnets]
    kept = []
    for raw in networks:
        try:
            net = ipaddress.ip_network(raw, strict=False)
        except ValueError:
            continue
        if any(net.version == a.version and net.subnet_of(a) for a in announced):
            kept.append(str(net))
    return kept


async def load_group(session: AsyncSession, group_id) -> ClientGroup | None:
    return await session.scalar(
        select(ClientGroup)
        .where(ClientGroup.id == group_id)
        .options(
            selectinload(ClientGroup.grants).selectinload(ClientGroupGrant.node),
            selectinload(ClientGroup.members).selectinload(Client.grants),
        )
    )


def sync_client(client: Client, group: ClientGroup | None) -> None:
    """Make `client`'s grants carry exactly `group`'s access, keep its own.

    Joining a group turns a personal grant to the same node into the group's,
    so the group's scope is the one that applies; leaving takes every grant the
    group gave away again. When the group names an exit, it is the member's
    exit; otherwise the member's own choice stands.
    """
    wanted = {g.node_id: g for g in (group.grants if group else [])}
    rows = list(client.grants)

    kept: list[ClientNodeGrant] = []
    for row in rows:
        if row.group_id is not None and row.node_id not in wanted:
            continue  # no group gives this any more
        kept.append(row)

    # A row for a node the new group also gives is handed over rather than
    # deleted and recreated: (client, node) is unique, and the flush would try
    # the insert before the delete.
    by_node = {row.node_id: row for row in kept}
    for node_id, source in wanted.items():
        row = by_node.get(node_id)
        if row is None:
            row = ClientNodeGrant(node_id=node_id)
            kept.append(row)
            by_node[node_id] = row
        elif row.group_id is not None and row.group_id != group.id:
            # The previous group's exit does not come along.
            row.is_exit = False
        row.group_id = group.id
        row.networks = source.networks

    group_exit = next((g.node_id for g in wanted.values() if g.is_exit), None)
    if group_exit is not None:
        for row in kept:
            row.is_exit = row.node_id == group_exit

    client.grants = kept


async def sync_members(session: AsyncSession, group: ClientGroup) -> None:
    for member in group.members:
        sync_client(member, group)
    await session.flush()


def set_group_grants(group: ClientGroup, nodes: dict, items: list[dict]) -> None:
    """Replace the group's access with `items` (node_id, is_exit, networks)."""
    exits = [item for item in items if item.get("is_exit")]
    if len(exits) > 1:
        raise GroupError("у группы может быть только один выход в интернет")

    existing = {g.node_id: g for g in group.grants}
    result = []
    for item in items:
        node = nodes.get(item["node_id"])
        if node is None:
            raise GroupError("узел не найден")
        grant = existing.get(node.id) or ClientGroupGrant(node_id=node.id, node=node)
        grant.is_exit = bool(item.get("is_exit"))
        grant.networks = validate_scope(item.get("networks"), node)
        result.append(grant)
    group.grants = result
