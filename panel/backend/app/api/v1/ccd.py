import uuid

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, OperatorUser, SessionDep
from app.core.config import settings
from app.models.node import ClientNodeGrant, ClientStatus
from app.schemas.ccd import CcdLimits, CcdRead, CcdUpdate
from app.services import audit, ccd, openvpn

router = APIRouter(prefix="/ccd", tags=["ccd"])


def _serialize(grant: ClientNodeGrant) -> CcdRead:
    allowed = grant.client.status == ClientStatus.active
    return CcdRead(
        id=grant.id,
        client_id=grant.client_id,
        node_id=grant.node_id,
        client_name=grant.client.common_name,
        client_status=grant.client.status.value,
        node_name=grant.node.name,
        static_host=grant.static_host,
        static_address=(
            openvpn.static_address("udp", grant.static_host)
            if grant.static_host is not None
            else None
        ),
        static_address_tcp=(
            openvpn.static_address("tcp", grant.static_host)
            if grant.static_host is not None
            else None
        ),
        push_routes=grant.push_routes or [],
        iroutes=grant.iroutes or [],
        push_options=grant.push_options or [],
        preview=ccd.render(
            grant, grant.client.common_name, proto="udp", allowed=allowed
        ),
    )


async def _load(session: SessionDep, grant_id: uuid.UUID) -> ClientNodeGrant:
    grant = await session.scalar(
        select(ClientNodeGrant)
        .where(ClientNodeGrant.id == grant_id)
        .options(
            selectinload(ClientNodeGrant.client), selectinload(ClientNodeGrant.node)
        )
    )
    if grant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Grant not found")
    return grant


@router.get("", response_model=list[CcdRead])
async def list_entries(session: SessionDep, _: CurrentUser) -> list[CcdRead]:
    """Every client-node pair that has a grant, whether customised or not."""
    grants = await session.scalars(
        select(ClientNodeGrant).options(
            selectinload(ClientNodeGrant.client), selectinload(ClientNodeGrant.node)
        )
    )
    entries = [_serialize(grant) for grant in grants]
    entries.sort(key=lambda entry: (entry.node_name, entry.client_name))
    return entries


@router.get("/limits", response_model=CcdLimits)
async def limits(_: CurrentUser) -> CcdLimits:
    return CcdLimits(
        static_host_min=settings.vpn_static_host_min,
        static_host_max=settings.vpn_static_host_max,
        subnet=f"{settings.vpn_subnet}/{settings.vpn_netmask}",
        subnet_tcp=f"{settings.vpn_tcp_subnet}/{settings.vpn_netmask}",
        allowed_push_options=list(ccd.ALLOWED_PUSH),
    )


@router.patch("/{grant_id}", response_model=CcdRead)
async def update_entry(
    grant_id: uuid.UUID,
    body: CcdUpdate,
    request: Request,
    session: SessionDep,
    user: OperatorUser,
) -> CcdRead:
    grant = await _load(session, grant_id)
    payload = body.model_dump(exclude_unset=True)

    try:
        if "static_host" in payload:
            host = payload["static_host"]
            grant.static_host = None if host is None else ccd.validate_host(host)
        for field in ("push_routes", "iroutes"):
            if field in payload:
                values = payload[field] or []
                setattr(grant, field, [ccd.validate_network(v) for v in values] or None)
        if "push_options" in payload:
            values = payload["push_options"] or []
            grant.push_options = [ccd.validate_push(v) for v in values] or None
    except ccd.CcdError as exc:
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

    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        # The only unique rule here is one fixed address per node.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "этот адрес уже закреплён за другим клиентом на этом узле",
        ) from None

    return _serialize(await _load(session, grant_id))
