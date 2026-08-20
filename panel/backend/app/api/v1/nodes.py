import uuid

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, OperatorUser, SessionDep
from app.models.node import Client, ClientStatus, Node, NodeStatus
from app.schemas.node import (
    EnrollmentToken,
    NodeCreate,
    NodeRead,
    NodeSummary,
    NodeUpdate,
)
from app.services import agent, audit

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
async def create_node(
    body: NodeCreate, request: Request, session: SessionDep, user: OperatorUser
) -> Node:
    node = Node(**body.model_dump())
    session.add(node)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Node name already taken") from None

    await audit.record(
        session,
        "node.create",
        actor=user,
        request=request,
        target_type="node",
        target_id=node.id,
        target_label=node.name,
        detail={"address": node.address, "role": node.role.value},
    )
    await session.commit()
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
    node_id: uuid.UUID,
    body: NodeUpdate,
    request: Request,
    session: SessionDep,
    user: OperatorUser,
) -> Node:
    node = await _get_node(session, node_id)
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(node, field, value)

    await audit.record(
        session,
        "node.update",
        actor=user,
        request=request,
        target_type="node",
        target_id=node.id,
        target_label=node.name,
        detail=audit.changed_fields(changes),
    )
    await session.commit()
    await session.refresh(node)
    return node


@router.post("/{node_id}/enrollment-token", response_model=EnrollmentToken)
async def create_enrollment_token(
    node_id: uuid.UUID, request: Request, session: SessionDep, user: OperatorUser
) -> EnrollmentToken:
    """Mint a one-time token for this node's agent.

    Shown once: only its hash is stored, so it cannot be retrieved again.
    """
    node = await _get_node(session, node_id)
    token = await agent.issue_enrollment_token(session, node)
    await audit.record(
        session,
        "node.enrollment_token",
        actor=user,
        request=request,
        target_type="node",
        target_id=node.id,
        target_label=node.name,
        detail={"expires_at": node.enrollment_token_expires_at},
    )
    await session.commit()
    return EnrollmentToken(
        token=token,
        expires_at=node.enrollment_token_expires_at,
        node_name=node.name,
    )


@router.delete("/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_node(
    node_id: uuid.UUID, request: Request, session: SessionDep, user: OperatorUser
) -> None:
    node = await _get_node(session, node_id)
    await audit.record(
        session,
        "node.delete",
        actor=user,
        request=request,
        target_type="node",
        target_id=node.id,
        target_label=node.name,
        detail={"address": node.address},
    )
    await session.delete(node)
    await session.commit()
