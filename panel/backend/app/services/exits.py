"""Which remote node clients leave through to the internet.

A client "exits through node X" when its internet goes hub → transit → X → X's
uplink. On the hub, policy routing sends that client's traffic into the
transit tunnel towards X; but the transit is one OpenVPN server, and OpenVPN
picks the peer for a packet by its destination alone, from the iroutes the
peers hold. For internet-bound traffic that takes an `iroute 0.0.0.0 0.0.0.0`
on X, without which OpenVPN drops the packets before they reach X.

Only one peer can hold that route: with two exit nodes, every client would
leave through whichever of them connected last, whatever the panel says. So
for now one remote node at a time may be an exit, and the panel refuses a
second rather than misroute silently. Exiting through the hub itself never
touches the transit and is not limited.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.node import ClientGroupGrant, ClientNodeGrant, Node


class ExitError(Exception):
    pass


async def remote_exit_nodes(session: AsyncSession) -> list[Node]:
    """Non-hub nodes some client or group uses as its exit."""
    ids: set[uuid.UUID] = set(
        await session.scalars(
            select(ClientNodeGrant.node_id).where(ClientNodeGrant.is_exit.is_(True))
        )
    )
    ids |= set(
        await session.scalars(
            select(ClientGroupGrant.node_id).where(ClientGroupGrant.is_exit.is_(True))
        )
    )
    if not ids:
        return []
    return list(
        await session.scalars(
            select(Node).where(Node.id.in_(ids), Node.is_hub.is_(False)).order_by(Node.name)
        )
    )


async def check_single_remote_exit(session: AsyncSession) -> None:
    """Raise when the pending changes would make two remote nodes exits."""
    nodes = await remote_exit_nodes(session)
    if len(nodes) > 1:
        names = ", ".join(node.name for node in nodes)
        raise ExitError(
            "выпускать клиентов в интернет можно только через одну удалённую "
            f"ноду за раз, а получилось бы через несколько: {names}. Сними выход "
            "с одной из них; выход через хаб не ограничен"
        )
