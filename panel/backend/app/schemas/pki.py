from datetime import datetime

from pydantic import BaseModel, Field


class CaInit(BaseModel):
    common_name: str = Field(
        default="Aeolus CA", min_length=1, max_length=64, pattern=r"^[\w .\-]+$"
    )


class CaStatus(BaseModel):
    initialised: bool
    common_name: str | None = None
    created_at: datetime | None = None
    not_after: datetime | None = None
    issued_certificates: int = 0
    crl_number: int = 0
    revoked_clients: int = 0
    nodes_with_cert: int = 0
    clients_with_cert: int = 0
