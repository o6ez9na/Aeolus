from datetime import datetime

from pydantic import BaseModel, Field


class MapPosition(BaseModel):
    x: float
    y: float


class MapLayout(BaseModel):
    # Keyed by the map's own node ids ("client:<uuid>", "node:<uuid>", ...), so
    # the backend does not need to know what kinds of cards the map draws.
    positions: dict[str, MapPosition] = Field(default_factory=dict, max_length=5000)


class MapLayoutRead(MapLayout):
    updated_at: datetime | None = None
