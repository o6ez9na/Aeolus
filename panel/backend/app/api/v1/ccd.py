import uuid

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, OperatorUser, SessionDep
from app.core.config import settings
from app.models.node import ClientGroupGrant, ClientNodeGrant
from app.schemas.ccd import CcdLimits, ExitUpdate, GrantRead, GrantUpdate
from app.services import audit, ccd, exits, groups, openvpn

router = APIRouter(prefix="/ccd", tags=["ccd"])


async def _load(session: SessionDep, grant_id: uuid.UUID) -> ClientNodeGrant:
    grant = await session.scalar(
        select(ClientNodeGrant)
        .where(ClientNodeGrant.id == grant_id)
        .options(selectinload(ClientNodeGrant.client), selectinload(ClientNodeGrant.node))
    )
    if grant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Grant not found")
    return grant


@router.get("/limits", response_model=CcdLimits)
async def limits(_: CurrentUser) -> CcdLimits:
    return CcdLimits(
        static_host_min=settings.vpn_static_host_min,
        static_host_max=settings.vpn_static_host_max,
        subnet=f"{settings.vpn_subnet}/{settings.vpn_netmask}",
        subnet_tcp=f"{settings.vpn_tcp_subnet}/{settings.vpn_netmask}",
        allowed_push_options=list(ccd.ALLOWED_PUSH),
    )


@router.patch("/{grant_id}", response_model=GrantRead)
async def update_entry(
    grant_id: uuid.UUID,
    body: GrantUpdate,
    request: Request,
    session: SessionDep,
    user: OperatorUser,
) -> GrantRead:
    grant = await _load(session, grant_id)
    payload = body.model_dump(exclude_unset=True)

    if "networks" in payload:
        if grant.group_id is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "этот доступ выдан группой: сети меняются в настройках группы",
            )
        try:
            grant.networks = groups.validate_scope(payload["networks"], grant.node)
        except groups.GroupError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None

    await audit.record(
        session,
        "ccd.update",
        actor=user,
        request=request,
        target_type="ccd",
        target_id=grant.id,
        target_label=f"{grant.client.common_name}@{grant.node.name}",
        detail=payload,
    )
    await session.flush()
    await openvpn.sync_routing_plan(session)
    await session.commit()
    return GrantRead.model_validate(await _load(session, grant_id))


@router.post("/{grant_id}/exit", response_model=GrantRead)
async def set_exit(
    grant_id: uuid.UUID,
    body: ExitUpdate,
    request: Request,
    session: SessionDep,
    user: OperatorUser,
) -> GrantRead:
    """Send this client's whole internet through this node.

    A machine has one default route, so a client may exit through one node at a
    time; asking for a second one is refused rather than silently reshuffled.
    """
    grant = await _load(session, grant_id)

    if grant.client.group_id is not None:
        group_exit = await session.scalar(
            select(ClientGroupGrant)
            .where(
                ClientGroupGrant.group_id == grant.client.group_id,
                ClientGroupGrant.is_exit.is_(True),
            )
            .options(selectinload(ClientGroupGrant.node))
        )
        if group_exit is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"выход этому клиенту задаёт группа: весь трафик идёт через "
                f"{group_exit.node.name}. Поменяй выход группе или выведи клиента из неё",
            )

    if body.is_exit:
        other = await session.scalar(
            select(ClientNodeGrant)
            .where(
                ClientNodeGrant.client_id == grant.client_id,
                ClientNodeGrant.id != grant.id,
                ClientNodeGrant.is_exit.is_(True),
            )
            .options(selectinload(ClientNodeGrant.node))
        )
        if other is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"весь трафик этого клиента уже идёт через {other.node.name}; "
                "клиент может выходить только через один узел",
            )

    grant.is_exit = body.is_exit
    if body.is_exit:
        await session.flush()
        try:
            await exits.check_single_remote_exit(session)
        except exits.ExitError as exc:
            await session.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    await audit.record(
        session,
        "ccd.exit",
        actor=user,
        request=request,
        target_type="ccd",
        target_id=grant.id,
        target_label=f"{grant.client.common_name}@{grant.node.name}",
        detail={"is_exit": body.is_exit},
    )
    await session.flush()
    await openvpn.sync_routing_plan(session)
    await session.commit()
    return GrantRead.model_validate(await _load(session, grant_id))
