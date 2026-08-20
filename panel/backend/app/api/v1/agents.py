from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.api.deps import SessionDep
from app.services import agent, audit, pki

router = APIRouter(prefix="/agents", tags=["agents"])


class EnrollRequest(BaseModel):
    token: str = Field(min_length=8, max_length=128)
    csr_pem: str = Field(min_length=1, max_length=8192)
    agent_version: str = Field(default="", max_length=32)


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
