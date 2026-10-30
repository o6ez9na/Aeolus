import uuid

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, OperatorUser, SessionDep
from app.core.crypto import SecretUnreadableError
from app.core.security import generate_password, hash_password
from app.models.node import (
    Client,
    ClientGroup,
    ClientNodeGrant,
    ClientStatus,
    Node,
    NodeApproval,
)
from app.schemas.node import (
    ClientCreate,
    ClientGrantRead,
    ClientImportCredentials,
    ClientImportPassword,
    ClientRead,
    ClientSessionRead,
    ClientUpdate,
)
from app.services import audit, ccd, groups, openvpn, pki, routing

router = APIRouter(prefix="/clients", tags=["clients"])


def _serialize(client: Client, sessions: dict[str, dict] | None = None) -> ClientRead:
    data = ClientRead.model_validate(client)
    if sessions is None:
        sessions = openvpn.client_sessions()
    live = sessions.get(client.common_name)
    data.session = ClientSessionRead(**live) if live else None
    data.node_ids = [grant.node_id for grant in client.grants]
    data.access = [
        ClientGrantRead(
            grant_id=grant.id,
            node_id=grant.node_id,
            node_name=grant.node.name,
            node_is_hub=grant.node.is_hub,
            node_subnets=grant.node.subnets or [],
            is_exit=grant.is_exit,
            networks=grant.networks,
            group_id=grant.group_id,
        )
        for grant in client.grants
        if grant.node is not None
    ]
    data.group_id = client.group_id
    data.group_name = client.group.name if client.group is not None else None
    if client.tunnel_host is not None:
        data.tunnel_address = openvpn.static_address("udp", client.tunnel_host)
    exit_grant = next((g for g in client.grants if g.is_exit), None)
    data.exit_node_id = exit_grant.node_id if exit_grant else None
    data.import_enabled = client.import_password_hash is not None
    return data


async def _load(session: SessionDep, client_id: uuid.UUID) -> Client:
    client = await session.scalar(
        select(Client)
        .where(Client.id == client_id)
        .options(
            selectinload(Client.grants).selectinload(ClientNodeGrant.node),
            selectinload(Client.group),
        )
    )
    if client is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found")
    return client


async def _validate_nodes(session: SessionDep, node_ids: list[uuid.UUID]) -> None:
    if not node_ids:
        return
    found = await session.scalars(select(Node.id).where(Node.id.in_(node_ids)))
    missing = set(node_ids) - set(found)
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown node ids: {', '.join(str(m) for m in sorted(missing, key=str))}",
        )


async def _group(session: SessionDep, group_id: uuid.UUID | None) -> ClientGroup | None:
    if group_id is None:
        return None
    group = await groups.load_group(session, group_id)
    if group is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Группа не найдена")
    return group


@router.get("", response_model=list[ClientRead])
async def list_clients(session: SessionDep, _: CurrentUser) -> list[ClientRead]:
    result = await session.scalars(
        select(Client)
        .options(
            selectinload(Client.grants).selectinload(ClientNodeGrant.node),
            selectinload(Client.group),
        )
        .order_by(Client.common_name)
    )
    sessions = openvpn.client_sessions()
    return [_serialize(client, sessions) for client in result]


@router.post("", response_model=ClientRead, status_code=status.HTTP_201_CREATED)
async def create_client(
    body: ClientCreate, request: Request, session: SessionDep, user: OperatorUser
) -> ClientRead:
    await _validate_nodes(session, body.node_ids)

    client = Client(
        common_name=body.common_name,
        label=body.label,
        expires_at=body.expires_at,
        traffic_limit_bytes=body.traffic_limit_bytes,
        created_by_id=user.id,
    )
    client.grants = [ClientNodeGrant(node_id=node_id) for node_id in body.node_ids]
    group = await _group(session, body.group_id)
    if group is not None:
        client.group = group
        groups.sync_client(client, group)
    # An address is part of being a client: the hub writes every rule about it
    # by address, so one is reserved now rather than when it first connects.
    await routing.ensure_tunnel_host(session, client)
    session.add(client)
    try:
        # Flush first: the id is generated here, and the audit entry needs it.
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Common name already taken"
        ) from None

    await audit.record(
        session,
        "client.create",
        actor=user,
        request=request,
        target_type="client",
        target_id=client.id,
        target_label=client.common_name,
        detail={
            "node_ids": body.node_ids,
            "group": group.name if group else None,
            "expires_at": body.expires_at,
        },
    )
    await openvpn.sync_routing_plan(session)
    await session.commit()

    return _serialize(await _load(session, client.id))


@router.patch("/{client_id}", response_model=ClientRead)
async def update_client(
    client_id: uuid.UUID,
    body: ClientUpdate,
    request: Request,
    session: SessionDep,
    user: OperatorUser,
) -> ClientRead:
    client = await _load(session, client_id)
    payload = body.model_dump(exclude_unset=True)

    node_ids = payload.pop("node_ids", None)
    group_change = "group_id" in payload
    new_group_id = payload.pop("group_id", None)
    for field, value in payload.items():
        setattr(client, field, value)

    if node_ids is not None:
        await _validate_nodes(session, node_ids)
        # Keep the existing grant rows for nodes that stay: they carry the ccd
        # settings, and rebuilding the list from scratch would silently drop a
        # client's fixed address and routes. What the group gives is not the
        # client's to drop one node at a time, so those rows stay as well.
        from_group = [grant for grant in client.grants if grant.group_id is not None]
        covered = {grant.node_id for grant in from_group}
        existing = {grant.node_id: grant for grant in client.grants}
        client.grants = from_group + [
            existing.get(node_id) or ClientNodeGrant(node_id=node_id)
            for node_id in node_ids
            if node_id not in covered
        ]

    group = await _group(session, new_group_id if group_change else client.group_id)
    if group_change:
        client.group = group
    groups.sync_client(client, group)

    await audit.record(
        session,
        "client.update",
        actor=user,
        request=request,
        target_type="client",
        target_id=client.id,
        target_label=client.common_name,
        detail=audit.changed_fields(body.model_dump(exclude_unset=True)),
    )
    await openvpn.sync_routing_plan(session)
    await session.commit()
    return _serialize(await _load(session, client_id))


@router.get("/{client_id}/ccd", response_class=PlainTextResponse)
async def client_ccd(
    client_id: uuid.UUID,
    session: SessionDep,
    _: CurrentUser,
    proto: str = "udp",
) -> str:
    """The file the hub hands this client at connect time, as it is written.

    Built the way the agent builds it for the hub: every network the client's
    grants open, its exit, its address.
    """
    client = await _load(session, client_id)
    hub = await session.scalar(select(Node).where(Node.is_hub.is_(True)))
    subnets = {
        node.id: node.subnets or []
        for node in await session.scalars(
            select(Node).where(Node.approval == NodeApproval.approved, Node.is_enabled.is_(True))
        )
    }
    allowed = client.status == ClientStatus.active
    routes: list[str] = []
    default_route = False
    if allowed:
        for held in client.grants:
            default_route = default_route or held.is_exit
            routes.extend(groups.grant_networks(held.networks, subnets.get(held.node_id, [])))
    own = next((g for g in client.grants if hub and g.node_id == hub.id), None)
    return ccd.render(
        own,
        client.common_name,
        proto="tcp" if proto == "tcp" else "udp",
        allowed=allowed,
        tunnel_host=client.tunnel_host,
        default_route=default_route,
        routes=sorted(set(routes)),
    )


@router.get("/{client_id}/config", response_class=PlainTextResponse)
async def download_client_config(
    client_id: uuid.UUID,
    request: Request,
    session: SessionDep,
    user: OperatorUser,
) -> str:
    """The client's .ovpn. There is one, and it points at the hub.

    A client no longer dials a node: it dials the panel, which forwards it into
    whichever node it was granted. So the profile carries no node address at
    all, and changing a client's exit does not mean reissuing it.
    """
    client = await _load(session, client_id)

    try:
        node, config = await openvpn.build_client_profile(session, client)
    except (openvpn.OpenVpnError, pki.PkiError) as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    except SecretUnreadableError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from None

    # Handing out a profile is handing out working credentials, so it is logged
    # like any other change.
    await audit.record(
        session,
        "client.config_download",
        actor=user,
        request=request,
        target_type="client",
        target_id=client.id,
        target_label=client.common_name,
        detail={"via": node.name},
    )
    await session.commit()
    return config


@router.post("/{client_id}/import-password", response_model=ClientImportCredentials)
async def set_import_password(
    client_id: uuid.UUID,
    body: ClientImportPassword,
    request: Request,
    session: SessionDep,
    user: OperatorUser,
) -> ClientImportCredentials:
    """Let the subscriber import the profile into OpenVPN Connect by password.

    Setting a new one replaces the old, so this is also how a leaked password
    is changed. The password is shown once; only its hash is stored.
    """
    client = await _load(session, client_id)
    if client.cert_pem is None or client.revoked_at is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "у клиента нет действующего сертификата, профиль не собрать"
        )
    password = body.password or generate_password()
    client.import_password_hash = hash_password(password)
    await audit.record(
        session,
        "client.import_enabled",
        actor=user,
        request=request,
        target_type="client",
        target_id=client.id,
        target_label=client.common_name,
        detail={"generated": body.password is None},
    )
    await session.commit()
    return ClientImportCredentials(username=client.common_name, password=password)


@router.delete("/{client_id}/import-password", status_code=status.HTTP_204_NO_CONTENT)
async def disable_import(
    client_id: uuid.UUID, request: Request, session: SessionDep, user: OperatorUser
) -> None:
    client = await _load(session, client_id)
    client.import_password_hash = None
    await audit.record(
        session,
        "client.import_disabled",
        actor=user,
        request=request,
        target_type="client",
        target_id=client.id,
        target_label=client.common_name,
    )
    await session.commit()


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client(
    client_id: uuid.UUID, request: Request, session: SessionDep, user: OperatorUser
) -> None:
    """Delete a client, revoking its certificate on the way out.

    Deleting the row is not enough: the certificate it was handed is valid until
    it expires, and OpenVPN accepts anything our CA signed. So the serial goes
    into the revocation log first and the refreshed CRL is pushed to the local
    node before the row disappears.
    """
    client = await _load(session, client_id)

    if client.cert_serial is not None:
        try:
            await pki.revoke_client(session, client, reason="client deleted")
            await openvpn.sync_local_crl(session)
        except (pki.PkiError, SecretUnreadableError) as exc:
            # Refuse rather than delete: a client whose certificate we could not
            # revoke must stay visible, otherwise the profile keeps working and
            # nobody knows it exists.
            await session.rollback()
            await audit.record(
                session,
                "client.delete_refused",
                actor=user,
                request=request,
                target_type="client",
                target_id=client_id,
                detail={"error": str(exc)},
            )
            await session.commit()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Cannot revoke this client's certificate, refusing to delete: {exc}",
            ) from None

    await audit.record(
        session,
        "client.delete",
        actor=user,
        request=request,
        target_type="client",
        target_id=client.id,
        target_label=client.common_name,
        detail={"cert_serial": client.cert_serial, "revoked": client.cert_serial is not None},
    )
    await session.delete(client)
    await session.flush()
    await openvpn.sync_routing_plan(session)
    await session.commit()
