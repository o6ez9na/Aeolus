"""Site links: which sites' networks reach each other over the transit.

See services/links for how a link becomes routes and firewall rules.
"""

import uuid

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, OperatorUser, SessionDep
from app.models.node import Node, NodeLink
from app.schemas.node import NodeLinkCreate, NodeLinkRead
from app.services import audit, openvpn
from app.services import links as links_service

router = APIRouter(prefix="/links", tags=["links"])


def _read(link: NodeLink, nodes: dict[uuid.UUID, Node]) -> NodeLinkRead:
    a, b = nodes[link.node_a_id], nodes[link.node_b_id]
    return NodeLinkRead(
        id=link.id,
        node_a_id=a.id,
        node_b_id=b.id,
        node_a_name=a.name,
        node_b_name=b.name,
        networks_a=links_service.site_networks(a),
        networks_b=links_service.site_networks(b),
        nat=a.is_hub or b.is_hub,
        created_at=link.created_at,
    )


async def _nodes(session: SessionDep, links: list[NodeLink]) -> dict[uuid.UUID, Node]:
    nodes: dict[uuid.UUID, Node] = {}
    for link in links:
        for node_id in (link.node_a_id, link.node_b_id):
            if node_id not in nodes:
                node = await session.get(Node, node_id)
                if node is not None:
                    nodes[node_id] = node
    return nodes


@router.get("", response_model=list[NodeLinkRead])
async def list_links(session: SessionDep, _: CurrentUser) -> list[NodeLinkRead]:
    links = await links_service.load(session)
    nodes = await _nodes(session, links)
    return [_read(link, nodes) for link in links]


@router.post("", response_model=NodeLinkRead, status_code=status.HTTP_201_CREATED)
async def create_link(
    body: NodeLinkCreate, request: Request, session: SessionDep, user: OperatorUser
) -> NodeLinkRead:
    a = await session.get(Node, body.node_a_id)
    b = await session.get(Node, body.node_b_id)
    if a is None or b is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    try:
        await links_service.validate(session, a, b)
    except links_service.LinkError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None

    first, second = links_service.ordered(a.id, b.id)
    link = NodeLink(node_a_id=first, node_b_id=second)
    session.add(link)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "эти узлы уже связаны") from None

    nodes = {a.id: a, b.id: b}
    await audit.record(
        session,
        "link.create",
        actor=user,
        request=request,
        target_type="link",
        target_id=link.id,
        target_label=f"{nodes[first].name} ↔ {nodes[second].name}",
        detail={
            nodes[first].name: links_service.site_networks(nodes[first]),
            nodes[second].name: links_service.site_networks(nodes[second]),
        },
    )
    # The hub's firewall follows the plan; the routes follow the next config
    # each agent pulls, which this change makes stale.
    await openvpn.sync_routing_plan(session)
    await session.commit()
    await session.refresh(link)
    return _read(link, nodes)


@router.delete("/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_link(
    link_id: uuid.UUID, request: Request, session: SessionDep, user: OperatorUser
) -> None:
    link = await session.get(NodeLink, link_id)
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Link not found")
    nodes = await _nodes(session, [link])
    label = " ↔ ".join(
        nodes[node_id].name if node_id in nodes else str(node_id)
        for node_id in (link.node_a_id, link.node_b_id)
    )
    await audit.record(
        session,
        "link.delete",
        actor=user,
        request=request,
        target_type="link",
        target_id=link.id,
        target_label=label,
    )
    await session.delete(link)
    await session.flush()
    await openvpn.sync_routing_plan(session)
    await session.commit()
