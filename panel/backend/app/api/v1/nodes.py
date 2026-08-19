import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, OperatorUser, SessionDep
from app.models.node import Client, ClientStatus, Node, NodeStatus
from app.schemas.node import NodeCreate, NodeRead, NodeSummary, NodeUpdate

router = APIRouter(prefix="/nodes", tags=["nodes"])


@router.get("", response_model=list[NodeRead])
async def list_nodes(session: SessionDep, _: CurrentUser) -> list[Node]:
    result = await session.scalars(select(Node).order_by(Node.name))
    return list(result)


@router.get("/summary", response_model=NodeSummary)
async def node_summary(session: SessionDep, _: CurrentUser) -> NodeSummary:
    node_row = (
        await session.execute(
            select(
                func.count(Node.id),
                func.count(Node.id).filter(Node.status == NodeStatus.online),
                func.count(Node.id).filter(Node.status == NodeStatus.error),
                func.coalesce(func.sum(Node.sessions), 0),
                func.coalesce(func.sum(Node.rx_bytes), 0),
                func.coalesce(func.sum(Node.tx_bytes), 0),
            )
        )
    ).one()

    client_row = (
        await session.execute(
            select(
                func.count(Client.id),
                func.count(Client.id).filter(Client.status == ClientStatus.active),
            )
        )
    ).one()

    return NodeSummary(
        nodes_total=node_row[0],
        nodes_online=node_row[1],
        failed_nodes=node_row[2],
        sessions=node_row[3],
        rx_bytes=node_row[4],
        tx_bytes=node_row[5],
        clients_total=client_row[0],
        clients_active=client_row[1],
    )


@router.post("", response_model=NodeRead, status_code=status.HTTP_201_CREATED)
async def create_node(body: NodeCreate, session: SessionDep, _: OperatorUser) -> Node:
    node = Node(**body.model_dump())
    session.add(node)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Node name already taken") from None
    await session.refresh(node)
    return node


async def _get_node(session: SessionDep, node_id: uuid.UUID) -> Node:
    node = await session.get(Node, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    return node


@router.get("/{node_id}", response_model=NodeRead)
async def get_node(node_id: uuid.UUID, session: SessionDep, _: CurrentUser) -> Node:
    return await _get_node(session, node_id)


@router.patch("/{node_id}", response_model=NodeRead)
async def update_node(
    node_id: uuid.UUID, body: NodeUpdate, session: SessionDep, _: OperatorUser
) -> Node:
    node = await _get_node(session, node_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(node, field, value)
    await session.commit()
    await session.refresh(node)
    return node


@router.delete("/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_node(node_id: uuid.UUID, session: SessionDep, _: OperatorUser) -> None:
    node = await _get_node(session, node_id)
    await session.delete(node)
    await session.commit()
