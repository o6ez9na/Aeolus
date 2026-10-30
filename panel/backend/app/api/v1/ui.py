from fastapi import APIRouter

from app.api.deps import CurrentUser, OperatorUser, SessionDep
from app.models.ui import UiLayout
from app.schemas.ui import MapLayout, MapLayoutRead

router = APIRouter(prefix="/ui", tags=["ui"])

MAP_KEY = "map"


@router.get("/layout", response_model=MapLayoutRead)
async def get_layout(session: SessionDep, _: CurrentUser) -> MapLayoutRead:
    row = await session.get(UiLayout, MAP_KEY)
    if row is None:
        # A fresh panel has no layout: the map lays itself out.
        return MapLayoutRead()
    layout = MapLayoutRead.model_validate(row.data or {})
    layout.updated_at = row.updated_at
    return layout


@router.put("/layout", response_model=MapLayoutRead)
async def put_layout(body: MapLayout, session: SessionDep, user: OperatorUser) -> MapLayoutRead:
    # Positions only: who belongs to which group is access, and lives with it.
    row = await session.get(UiLayout, MAP_KEY)
    data = body.model_dump(mode="json")

    if row is None:
        row = UiLayout(key=MAP_KEY, data=data, updated_by_id=user.id)
        session.add(row)
    else:
        row.data = data
        row.updated_by_id = user.id

    await session.commit()
    await session.refresh(row)
    layout = MapLayoutRead.model_validate(row.data)
    layout.updated_at = row.updated_at
    return layout
