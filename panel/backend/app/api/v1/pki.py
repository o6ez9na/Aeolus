import uuid

from cryptography import x509
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import func, select

from app.api.deps import AdminUser, CurrentUser, OperatorUser, SessionDep
from app.core.crypto import SecretUnreadableError
from app.models.node import Client, Node
from app.schemas.node import ClientRead, NodeRead
from app.schemas.pki import CaInit, CaStatus
from app.services import openvpn, pki

router = APIRouter(prefix="/pki", tags=["pki"])


def _pki_error(exc: Exception) -> HTTPException:
    if isinstance(exc, SecretUnreadableError):
        return HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc))
    return HTTPException(status.HTTP_409_CONFLICT, str(exc))


@router.get("", response_model=CaStatus)
async def ca_status(session: SessionDep, _: CurrentUser) -> CaStatus:
    ca = await pki.get_active_ca(session)
    if ca is None:
        return CaStatus(initialised=False)

    cert = x509.load_pem_x509_certificate(ca.cert_pem.encode())
    revoked = await session.scalar(
        select(func.count(Client.id)).where(Client.revoked_at.is_not(None))
    )
    clients_with_cert = await session.scalar(
        select(func.count(Client.id)).where(Client.cert_serial.is_not(None))
    )
    nodes_with_cert = await session.scalar(
        select(func.count(Node.id)).where(Node.server_cert_serial.is_not(None))
    )

    return CaStatus(
        initialised=True,
        common_name=ca.common_name,
        created_at=ca.created_at,
        not_after=cert.not_valid_after_utc,
        # Serial 1 belongs to the CA itself, so subtract it from the counter.
        issued_certificates=ca.next_serial - 2,
        crl_number=ca.crl_number,
        revoked_clients=revoked or 0,
        clients_with_cert=clients_with_cert or 0,
        nodes_with_cert=nodes_with_cert or 0,
    )


@router.post("/init", response_model=CaStatus, status_code=status.HTTP_201_CREATED)
async def init_ca(body: CaInit, session: SessionDep, _: AdminUser) -> CaStatus:
    try:
        await pki.init_ca(session, body.common_name)
    except pki.PkiError as exc:
        raise _pki_error(exc) from None
    await session.commit()
    return await ca_status(session, _)


@router.get("/ca.crt", response_class=PlainTextResponse)
async def download_ca(session: SessionDep, _: CurrentUser) -> str:
    ca = await pki.get_active_ca(session)
    if ca is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "CA is not initialised yet")
    return ca.cert_pem


@router.get("/crl.pem", response_class=PlainTextResponse)
async def download_crl(session: SessionDep, _: CurrentUser) -> str:
    """Build the current CRL. Nodes must receive this before a revoke takes effect."""
    try:
        crl = await pki.build_crl(session)
    except (pki.PkiError, SecretUnreadableError) as exc:
        raise _pki_error(exc) from None
    await session.commit()
    return crl


@router.post("/clients/{client_id}/certificate", response_model=ClientRead)
async def issue_client_certificate(
    client_id: uuid.UUID, session: SessionDep, _: OperatorUser
) -> ClientRead:
    client = await session.get(Client, client_id)
    if client is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found")

    try:
        await pki.issue_client_cert(session, client)
    except (pki.PkiError, SecretUnreadableError) as exc:
        raise _pki_error(exc) from None

    await session.commit()
    await session.refresh(client, ["grants"])
    data = ClientRead.model_validate(client)
    data.node_ids = [grant.node_id for grant in client.grants]
    return data


@router.post("/clients/{client_id}/revoke", response_model=ClientRead)
async def revoke_client_certificate(
    client_id: uuid.UUID, session: SessionDep, _: OperatorUser
) -> ClientRead:
    client = await session.get(Client, client_id)
    if client is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found")

    try:
        await pki.revoke_client(session, client)
        # Push the new CRL to the local node immediately; a revoke that has not
        # reached a node has not actually revoked anything.
        await openvpn.sync_local_crl(session)
    except (pki.PkiError, SecretUnreadableError) as exc:
        raise _pki_error(exc) from None

    await session.commit()
    await session.refresh(client, ["grants"])
    data = ClientRead.model_validate(client)
    data.node_ids = [grant.node_id for grant in client.grants]
    return data


@router.post("/nodes/{node_id}/certificate", response_model=NodeRead)
async def issue_server_certificate(
    node_id: uuid.UUID, session: SessionDep, _: OperatorUser
) -> Node:
    node = await session.get(Node, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")

    try:
        await pki.issue_server_cert(session, node)
    except (pki.PkiError, SecretUnreadableError) as exc:
        raise _pki_error(exc) from None

    await session.commit()
    await session.refresh(node)
    return node
