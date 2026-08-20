"""Action log.

Early in development nodes and clients disappeared from the database and there
was no way to tell who had removed them. Every state-changing operation now
leaves a row, written inside the same transaction as the change itself.
"""

from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditEvent
from app.models.user import User


def client_ip(request: Request | None) -> str | None:
    if request is None or request.client is None:
        return None
    # Behind Caddy the socket address is the proxy, so trust its header first.
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()[:45]
    return request.client.host


async def record(
    session: AsyncSession,
    action: str,
    *,
    actor: User | None = None,
    actor_username: str | None = None,
    request: Request | None = None,
    target_type: str | None = None,
    target_id: Any = None,
    target_label: str | None = None,
    detail: dict | None = None,
) -> AuditEvent:
    """Add an entry. The caller commits it along with whatever it was doing."""
    event = AuditEvent(
        actor_user_id=actor.id if actor else None,
        actor_username=actor.username if actor else actor_username,
        actor_role=actor.role.value if actor else None,
        actor_ip=client_ip(request),
        action=action,
        target_type=target_type,
        target_id=None if target_id is None else str(target_id)[:64],
        target_label=None if target_label is None else target_label[:128],
        # UUIDs and datetimes are common in a detail dict and neither is JSON.
        detail=None if detail is None else jsonable_encoder(detail),
    )
    session.add(event)
    return event


def changed_fields(payload: dict) -> dict:
    """Strip secrets out of a PATCH body before it goes into the log."""
    hidden = {"password", "new_password", "current_password", "key_pem", "token"}
    return {k: v for k, v in payload.items() if k not in hidden}
