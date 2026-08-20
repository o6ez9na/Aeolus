from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from app.api.deps import AdminUser, SessionDep
from app.models.audit import AuditEvent
from app.schemas.audit import AuditEventRead, AuditPage

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("", response_model=AuditPage)
async def list_events(
    session: SessionDep,
    _: AdminUser,
    action: Annotated[str | None, Query(max_length=48)] = None,
    actor: Annotated[str | None, Query(max_length=64)] = None,
    target_type: Annotated[str | None, Query(max_length=32)] = None,
    since: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AuditPage:
    """Read the action log. Admin only — it names who did what and from where."""
    filters = []
    if action:
        # Prefix match so "client" pulls the whole client.* family.
        filters.append(AuditEvent.action.startswith(action))
    if actor:
        filters.append(AuditEvent.actor_username.ilike(f"%{actor}%"))
    if target_type:
        filters.append(AuditEvent.target_type == target_type)
    if since:
        filters.append(AuditEvent.created_at >= since)

    total = await session.scalar(select(func.count(AuditEvent.id)).where(*filters))
    rows = await session.scalars(
        select(AuditEvent)
        .where(*filters)
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .limit(limit)
        .offset(offset)
    )

    return AuditPage(
        items=[AuditEventRead.model_validate(row) for row in rows],
        total=total or 0,
        limit=limit,
        offset=offset,
    )


@router.get("/actions", response_model=list[str])
async def known_actions(session: SessionDep, _: AdminUser) -> list[str]:
    """Action names actually present in the log, for the filter dropdown."""
    rows = await session.scalars(select(AuditEvent.action).distinct().order_by(AuditEvent.action))
    return list(rows)
