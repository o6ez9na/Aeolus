import uuid

from pydantic import BaseModel, ConfigDict, Field


class ExitUpdate(BaseModel):
    """Route this client's whole internet through this node, or stop doing so."""

    is_exit: bool


class GrantUpdate(BaseModel):
    # Only part of the node's LAN; null for all of it.
    networks: list[str] | None = Field(default=None, max_length=64)


class GrantRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    client_id: uuid.UUID
    node_id: uuid.UUID
    is_exit: bool = False
    networks: list[str] | None = None
    group_id: uuid.UUID | None = None


class CcdLimits(BaseModel):
    """Bounds the UI shows instead of making the operator guess them."""

    static_host_min: int
    static_host_max: int
    subnet: str
    subnet_tcp: str
    allowed_push_options: list[str]
