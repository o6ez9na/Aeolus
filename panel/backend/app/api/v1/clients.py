import uuid

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, OperatorUser, SessionDep
from app.core.crypto import SecretUnreadableError
from app.models.node import Client, ClientNodeGrant, Node
from app.schemas.node import ClientCreate, ClientRead, ClientUpdate
from app.services import audit, openvpn, pki

router = APIRouter(prefix="/clients", tags=["clients"])


def _serialize(client: Client) -> ClientRead:
    data = ClientRead.model_validate(client)
    data.node_ids = [grant.node_id for grant in client.grants]
    return data


async def _load(session: SessionDep, client_id: uuid.UUID) -> Client:
    client = await session.scalar(
        select(Client).where(Client.id == client_id).options(selectinload(Client.grants))
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


@router.get("", response_model=list[ClientRead])
async def list_clients(session: SessionDep, _: CurrentUser) -> list[ClientRead]:
    result = await session.scalars(
        select(Client).options(selectinload(Client.grants)).order_by(Client.common_name)
    )
    return [_serialize(client) for client in result]


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
        detail={"node_ids": body.node_ids, "expires_at": body.expires_at},
    )
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
    for field, value in payload.items():
        setattr(client, field, value)

    if node_ids is not None:
        await _validate_nodes(session, node_ids)
        client.grants = [ClientNodeGrant(node_id=node_id) for node_id in node_ids]

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
    await session.commit()
    return _serialize(await _load(session, client_id))


@router.get("/{client_id}/config/{node_id}", response_class=PlainTextResponse)
async def download_client_config(
    client_id: uuid.UUID,
    node_id: uuid.UUID,
    request: Request,
    session: SessionDep,
    user: OperatorUser,
) -> str:
    """Build the .ovpn for this client on this node."""
    client = await _load(session, client_id)

    if node_id not in {grant.node_id for grant in client.grants}:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Client is not granted access to that node",
        )

    node = await session.get(Node, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")

    try:
        ca = await pki.require_ca(session)
        config = openvpn.render_client_config(client, node, ca)
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
        detail={"node": node.name},
    )
    await session.commit()
    return config


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
    await session.commit()
