import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDMixin


class AuditEvent(Base, UUIDMixin):
    """One recorded action. Append-only: nothing edits or deletes these rows.

    Written in the same transaction as the change it describes, so a rolled back
    request leaves no trace of having happened and a committed one always has
    its line in the log.
    """

    __tablename__ = "audit_events"

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    # Who. The user may be deleted later, so the name and role are copied here:
    # the whole point of the log is to answer "who did this" afterwards.
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    actor_username: Mapped[str | None] = mapped_column(String(64), index=True)
    actor_role: Mapped[str | None] = mapped_column(String(16))
    actor_ip: Mapped[str | None] = mapped_column(String(45))

    # What, as "<object>.<verb>": client.delete, node.create, pki.revoke, ...
    action: Mapped[str] = mapped_column(String(48), index=True)

    # On what. The id is kept as text because it also holds node names and
    # certificate serials, and the row must survive the target's deletion.
    target_type: Mapped[str | None] = mapped_column(String(32), index=True)
    target_id: Mapped[str | None] = mapped_column(String(64))
    target_label: Mapped[str | None] = mapped_column(String(128))

    # Anything worth keeping: changed fields, refusal reason, counters.
    detail: Mapped[dict | None] = mapped_column(JSON)
