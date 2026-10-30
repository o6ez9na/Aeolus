import uuid

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, OperatorUser, SessionDep
from app.models.node import ClientGroup, ClientGroupGrant, Node
from app.schemas.groups import (
    GroupCreate,
    GroupGrantRead,
    GroupGrantsUpdate,
    GroupRead,
    GroupUpdate,
)
from app.services import audit, groups, openvpn

router = APIRouter(prefix="/groups", tags=["groups"])


def _serialize(group: ClientGroup) -> GroupRead:
    return GroupRead(
        id=group.id,
        name=group.name,
        member_ids=sorted((m.id for m in group.members), key=str),
        grants=[
            GroupGrantRead(
                node_id=g.node_id,
                node_name=g.node.name,
                node_is_hub=g.node.is_hub,
                node_subnets=g.node.subnets or [],
                is_exit=g.is_exit,
                networks=g.networks,
            )
            for g in sorted(group.grants, key=lambda g: g.node.name)
        ],
    )


async def _get(session: SessionDep, group_id: uuid.UUID) -> ClientGroup:
    group = await groups.load_group(session, group_id)
    if group is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Группа не найдена")
    return group


async def _nodes(session: SessionDep, ids: list[uuid.UUID]) -> dict:
    found = await session.scalars(select(Node).where(Node.id.in_(ids))) if ids else []
    return {node.id: node for node in found}


@router.get("", response_model=list[GroupRead])
async def list_groups(session: SessionDep, _: CurrentUser) -> list[GroupRead]:
    rows = await session.scalars(
        select(ClientGroup)
        .options(
            selectinload(ClientGroup.grants).selectinload(ClientGroupGrant.node),
            selectinload(ClientGroup.members),
        )
        .order_by(ClientGroup.name)
    )
    return [_serialize(group) for group in rows]


@router.post("", response_model=GroupRead, status_code=status.HTTP_201_CREATED)
async def create_group(
    body: GroupCreate, request: Request, session: SessionDep, user: OperatorUser
) -> GroupRead:
    group = ClientGroup(name=body.name.strip())
    try:
        groups.set_group_grants(
            group,
            await _nodes(session, [g.node_id for g in body.grants]),
            [g.model_dump() for g in body.grants],
        )
    except groups.GroupError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    session.add(group)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Группа с таким именем уже есть") from None

    await audit.record(
        session,
        "group.create",
        actor=user,
        request=request,
        target_type="group",
        target_id=group.id,
        target_label=group.name,
        detail={"grants": len(body.grants)},
    )
    await session.commit()
    return _serialize(await _get(session, group.id))


@router.patch("/{group_id}", response_model=GroupRead)
async def rename_group(
    group_id: uuid.UUID,
    body: GroupUpdate,
    request: Request,
    session: SessionDep,
    user: OperatorUser,
) -> GroupRead:
    group = await _get(session, group_id)
    old = group.name
    group.name = body.name.strip()
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Группа с таким именем уже есть") from None
    await audit.record(
        session,
        "group.update",
        actor=user,
        request=request,
        target_type="group",
        target_id=group.id,
        target_label=group.name,
        detail={"renamed_from": old},
    )
    await session.commit()
    return _serialize(await _get(session, group_id))


@router.put("/{group_id}/grants", response_model=GroupRead)
async def set_grants(
    group_id: uuid.UUID,
    body: GroupGrantsUpdate,
    request: Request,
    session: SessionDep,
    user: OperatorUser,
) -> GroupRead:
    """Replace what the group gives, and hand it to every member at once."""
    group = await _get(session, group_id)
    old_exit = next((g.node_id for g in group.grants if g.is_exit), None)
    try:
        groups.set_group_grants(
            group,
            await _nodes(session, [g.node_id for g in body.grants]),
            [g.model_dump() for g in body.grants],
        )
    except groups.GroupError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None

    new_exit = next((g.node_id for g in group.grants if g.is_exit), None)
    if old_exit is not None and old_exit != new_exit:
        # The exit was the group's decision, so taking it back takes it from
        # every member, not only from those whose grant disappears.
        for member in group.members:
            for row in member.grants:
                if row.node_id == old_exit and row.group_id == group.id:
                    row.is_exit = False

    await groups.sync_members(session, group)
    await audit.record(
        session,
        "group.grants",
        actor=user,
        request=request,
        target_type="group",
        target_id=group.id,
        target_label=group.name,
        detail={
            "nodes": [g.node.name for g in group.grants],
            "exit": next((g.node.name for g in group.grants if g.is_exit), None),
            "members": len(group.members),
        },
    )
    await openvpn.sync_routing_plan(session)
    await session.commit()
    return _serialize(await _get(session, group_id))


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: uuid.UUID, request: Request, session: SessionDep, user: OperatorUser
) -> None:
    """Remove the group and the access it gave. Personal grants stay."""
    group = await _get(session, group_id)
    await audit.record(
        session,
        "group.delete",
        actor=user,
        request=request,
        target_type="group",
        target_id=group.id,
        target_label=group.name,
        detail={"members": len(group.members)},
    )
    for member in group.members:
        groups.sync_client(member, None)
        member.group_id = None
    await session.flush()
    await session.delete(group)
    await session.flush()
    await openvpn.sync_routing_plan(session)
    await session.commit()
