import uuid

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, OperatorUser, SessionDep
from app.core.config import settings
from app.models.node import Client, ClientStatus, Node, NodeApproval, NodeStatus
from app.schemas.node import (
    EnrollmentToken,
    NodeCreate,
    NodeRead,
    NodeSummary,
    NodeUpdate,
)
from app.services import agent, audit, openvpn, pki

router = APIRouter(prefix="/nodes", tags=["nodes"])


@router.get("", response_model=list[NodeRead])
async def list_nodes(session: SessionDep, _: CurrentUser) -> list[NodeRead]:
    result = await session.scalars(select(Node).order_by(Node.name))
    connected = openvpn.transit_sessions()
    nodes = []
    for node in result:
        data = NodeRead.model_validate(node)
        # The hub is not its own transit peer; it is always reachable to itself.
        data.transit_connected = node.is_hub or node.name in connected
        data.transit_transport = (
            ""
            if node.is_hub
            else "ws/443"
            if node.transit_obfuscated
            else f"{settings.vpn_transit_proto}/{settings.vpn_transit_port}"
        )
        nodes.append(data)
    return nodes


@router.get("/summary", response_model=NodeSummary)
async def node_summary(session: SessionDep, _: CurrentUser) -> NodeSummary:
    node_row = (
        await session.execute(
            select(
                func.count(Node.id),
                func.count(Node.id).filter(Node.status == NodeStatus.online),
                func.count(Node.id).filter(Node.status == NodeStatus.error),
                func.count(Node.id).filter(Node.approval == NodeApproval.pending),
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
        nodes_pending=node_row[3],
        sessions=node_row[4],
        rx_bytes=node_row[5],
        tx_bytes=node_row[6],
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


@router.post("/{node_id}/approve", response_model=NodeRead)
async def approve_node(
    node_id: uuid.UUID, request: Request, session: SessionDep, user: OperatorUser
) -> Node:
    """Accept a node into the mesh: sign its key and give it a transit address.

    The operator is expected to have compared the fingerprint shown here with
    the one the agent printed on the node itself. Nothing else authenticates the
    request, which is why it stays inert until this call.
    """
    node = await _get_node(session, node_id)
    try:
        await agent.approve(session, node, user.id)
    except (agent.AgentError, pki.PkiError) as exc:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None

    await audit.record(
        session,
        "node.approve",
        actor=user,
        request=request,
        target_type="node",
        target_id=node.id,
        target_label=node.name,
        detail={
            "fingerprint": node.key_fingerprint,
            "transit_host": node.transit_host,
            "subnets": node.subnets or [],
        },
    )
    await session.commit()
    await session.refresh(node)
    return node


@router.post("/{node_id}/reject", response_model=NodeRead)
async def reject_node(
    node_id: uuid.UUID, request: Request, session: SessionDep, user: OperatorUser
) -> Node:
    """Refuse a node. Its agent keeps asking, so this is not permanent."""
    node = await _get_node(session, node_id)
    if node.is_hub:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "the panel's own node cannot be rejected"
        )

    await agent.reject(session, node)
    await audit.record(
        session,
        "node.reject",
        actor=user,
        request=request,
        target_type="node",
        target_id=node.id,
        target_label=node.name,
        detail={"fingerprint": node.key_fingerprint},
    )
    await session.commit()
    await session.refresh(node)
    return node
