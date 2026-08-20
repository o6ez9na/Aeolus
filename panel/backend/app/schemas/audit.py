import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AuditEventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    actor_user_id: uuid.UUID | None = None
    actor_username: str | None = None
    actor_role: str | None = None
    actor_ip: str | None = None
    action: str
    target_type: str | None = None
    target_id: str | None = None
    target_label: str | None = None
    detail: dict | None = None


class AuditPage(BaseModel):
    """A window into the log plus the total, so the UI can page through it."""

    items: list[AuditEventRead]
    total: int
    limit: int
    offset: int
