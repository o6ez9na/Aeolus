import uuid

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, OperatorUser, SessionDep
from app.core.config import settings
from app.models.node import Client, ClientGroupGrant, ClientNodeGrant, Node
from app.schemas.ccd import CcdLimits, CcdRead, CcdUpdate, ExitUpdate
from app.services import agent, audit, ccd, groups, openvpn, routing

router = APIRouter(prefix="/ccd", tags=["ccd"])

# The preview is rendered from all of the client's grants, not just this one.
_GRANT_OPTIONS = (
    selectinload(ClientNodeGrant.client).selectinload(Client.grants),
    selectinload(ClientNodeGrant.node),
)


async def _serialize(
    session: SessionDep,
    grant: ClientNodeGrant,
    *,
    hub: Node | None = None,
    subnets_by_node: dict | None = None,
) -> CcdRead:
    return CcdRead(
        id=grant.id,
        client_id=grant.client_id,
        node_id=grant.node_id,
        client_name=grant.client.common_name,
        client_status=grant.client.status.value,
        node_name=grant.node.name,
        node_is_hub=grant.node.is_hub,
        is_exit=grant.is_exit,
        node_subnets=grant.node.subnets or [],
        tunnel_address=(
            openvpn.static_address("udp", grant.client.tunnel_host)
            if grant.client.tunnel_host is not None
            else None
        ),
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
        networks=grant.networks,
        group_id=grant.group_id,
        # The file the agent writes, built by the same code: clients dial only
        # the hub, so that is the one in force whichever node this grant is for.
        preview=await agent.preview_client_ccd(
            session, grant.client, hub=hub, subnets_by_node=subnets_by_node
        ),
    )


async def _load(session: SessionDep, grant_id: uuid.UUID) -> ClientNodeGrant:
    grant = await session.scalar(
        select(ClientNodeGrant)
        .where(ClientNodeGrant.id == grant_id)
        .options(*_GRANT_OPTIONS)
    )
    if grant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Grant not found")
    return grant


@router.get("", response_model=list[CcdRead])
async def list_entries(session: SessionDep, _: CurrentUser) -> list[CcdRead]:
    """Every client-node pair that has a grant, whether customised or not."""
    grants = (
        await session.scalars(select(ClientNodeGrant).options(*_GRANT_OPTIONS))
    ).all()
    hub = await session.scalar(select(Node).where(Node.is_hub.is_(True)))
    subnets_by_node = await agent.load_subnets_by_node(session)
    entries = [
        await _serialize(session, grant, hub=hub, subnets_by_node=subnets_by_node)
        for grant in grants
    ]
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
        if "networks" in payload:
            if grant.group_id is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "этот доступ выдан группой: сети меняются в настройках группы",
                )
            grant.networks = groups.validate_scope(payload["networks"], grant.node)
    except (ccd.CcdError, groups.GroupError) as exc:
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
        await session.flush()
        await openvpn.sync_routing_plan(session)
        await session.commit()
    except IntegrityError:
        await session.rollback()
        # The only unique rule here is one fixed address per node.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "этот адрес уже закреплён за другим клиентом на этом узле",
        ) from None

    return await _serialize(session, await _load(session, grant_id))


@router.post("/{grant_id}/exit", response_model=CcdRead)
async def set_exit(
    grant_id: uuid.UUID,
    body: ExitUpdate,
    request: Request,
    session: SessionDep,
    user: OperatorUser,
) -> CcdRead:
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
    return await _serialize(session, await _load(session, grant_id))
