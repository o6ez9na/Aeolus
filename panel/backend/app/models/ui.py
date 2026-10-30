import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UiLayout(Base):
    """Where an operator put things on the network map, and how they grouped them.

    Positions and groups describe the picture, not the network: deleting this row
    loses a layout and nothing else. It is one shared document per key rather
    than per user, so two operators look at the same map.
    """

    __tablename__ = "ui_layouts"

    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
