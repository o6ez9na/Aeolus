from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.api.deps import SessionDep
from app.services import agent, audit, ccd, pki

router = APIRouter(prefix="/agents", tags=["agents"])


class EnrollRequest(BaseModel):
    token: str = Field(min_length=8, max_length=128)
    csr_pem: str = Field(min_length=1, max_length=8192)
    agent_version: str = Field(default="", max_length=32)


class AnnounceRequest(BaseModel):
    csr_pem: str = Field(min_length=1, max_length=8192)
    name: str = Field(default="", max_length=64)
    hostname: str = Field(default="", max_length=255)
    wan_iface: str = Field(default="", max_length=32)
    subnets: list[str] = Field(default_factory=list, max_length=16)
    agent_version: str = Field(default="", max_length=32)


class AnnounceResponse(BaseModel):
    node_name: str
    status: str
    poll_token: str
    # Printed by the agent as well, so the two can be compared before accepting.
    fingerprint: str


class DecisionResponse(BaseModel):
    node_name: str
    status: str
    cert_pem: str | None = None
    ca_pem: str | None = None


class EnrollResponse(BaseModel):
    node_id: str
    node_name: str
    cert_pem: str
    ca_pem: str


@router.post("/enroll", response_model=EnrollResponse)
async def enroll(
    body: EnrollRequest, request: Request, session: SessionDep
) -> EnrollResponse:
    """Exchange a one-time token for an agent client certificate.

    Deliberately unauthenticated: this is the call an agent makes before it has
    any credentials, and the token is the credential. It runs over the panel's
    HTTPS, which agents can verify with public trust, unlike the gRPC endpoint
    whose certificate comes from our own CA.
    """
    try:
        node, cert_pem, ca_pem = await agent.enroll(
            session, body.token, body.csr_pem, body.agent_version
        )
        await audit.record(
            session,
            "agent.enroll",
            actor_username="anemoi",
            request=request,
            target_type="node",
            target_id=node.id,
            target_label=node.name,
            detail={"agent_version": body.agent_version, "serial": node.agent_cert_serial},
        )
        await session.commit()
    except agent.AgentError as exc:
        await session.rollback()
        # A rejected enrolment means someone tried a bad or expired token.
        await audit.record(
            session,
            "agent.enroll_rejected",
            actor_username="anemoi",
            request=request,
            target_type="node",
            detail={"error": str(exc)},
        )
        await session.commit()
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from None
    except pki.PkiError as exc:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None

    return EnrollResponse(
        node_id=str(node.id),
        node_name=node.name,
        cert_pem=cert_pem,
        ca_pem=ca_pem,
    )


@router.post("/announce", response_model=AnnounceResponse)
async def announce(
    body: AnnounceRequest, request: Request, session: SessionDep
) -> AnnounceResponse:
    """A node asks to join. Unauthenticated, and inert until an operator agrees.

    This is how a node with no credentials introduces itself: it sends the key
    it generated and waits. Nothing is signed, no address is reserved and no
    traffic is routed until someone accepts the fingerprint in the panel.
    """
    subnets = []
    for raw in body.subnets:
        try:
            subnets.append(ccd.validate_network(raw))
        except ccd.CcdError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None

    try:
        node, token, fingerprint = await agent.announce(
            session,
            csr_pem=body.csr_pem,
            name=body.name,
            hostname=body.hostname or None,
            wan_iface=body.wan_iface or None,
            subnets=subnets,
            agent_version=body.agent_version,
            source_ip=audit.client_ip(request),
        )
        await audit.record(
            session,
            "node.announce",
            actor_username="anemoi",
            request=request,
            target_type="node",
            target_label=node.name,
            detail={"fingerprint": fingerprint, "subnets": subnets},
        )
        await session.commit()
    except agent.AgentError as exc:
        await session.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None

    return AnnounceResponse(
        node_name=node.name,
        status=node.approval.value,
        poll_token=token,
        fingerprint=fingerprint,
    )


@router.get("/announce/{token}", response_model=DecisionResponse)
async def announce_decision(token: str, session: SessionDep) -> DecisionResponse:
    """The agent polls here until an operator decides."""
    try:
        node, cert_pem, ca_pem = await agent.collect_decision(session, token)
    except agent.AgentError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None
    except pki.PkiError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None

    return DecisionResponse(
        node_name=node.name,
        status=node.approval.value,
        cert_pem=cert_pem,
        ca_pem=ca_pem,
    )
