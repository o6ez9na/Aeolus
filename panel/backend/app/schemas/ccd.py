import uuid

from pydantic import BaseModel, ConfigDict, Field


class CcdUpdate(BaseModel):
    """Per-client settings on one node. Unset fields are left alone."""

    static_host: int | None = Field(default=None, ge=1, le=254)
    push_routes: list[str] | None = Field(default=None, max_length=32)
    iroutes: list[str] | None = Field(default=None, max_length=32)
    push_options: list[str] | None = Field(default=None, max_length=32)


class CcdRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    client_id: uuid.UUID
    node_id: uuid.UUID
    client_name: str
    client_status: str
    node_name: str
    static_host: int | None = None
    # The addresses that host number turns into, one per listener.
    static_address: str | None = None
    static_address_tcp: str | None = None
    push_routes: list[str] = []
    iroutes: list[str] = []
    push_options: list[str] = []
    # Rendered file, so an operator can see exactly what the node will read.
    preview: str = ""


class CcdLimits(BaseModel):
    """Bounds the UI shows instead of making the operator guess them."""

    static_host_min: int
    static_host_max: int
    subnet: str
    subnet_tcp: str
    allowed_push_options: list[str]
