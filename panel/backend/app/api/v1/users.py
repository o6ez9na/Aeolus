import uuid

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import AdminUser, SessionDep
from app.core.security import hash_password
from app.models.user import User
from app.schemas.auth import UserCreate, UserRead
from app.services import audit
from app.services import auth as auth_service

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserRead])
async def list_users(session: SessionDep, _: AdminUser) -> list[User]:
    result = await session.scalars(select(User).order_by(User.created_at))
    return list(result)


@router.post("", response_model=UserRead, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate, request: Request, session: SessionDep, admin: AdminUser
) -> User:
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        role=body.role,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already taken") from None

    await audit.record(
        session,
        "user.create",
        actor=admin,
        request=request,
        target_type="user",
        target_id=user.id,
        target_label=user.username,
        detail={"role": user.role.value},
    )
    await session.commit()
    await session.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: uuid.UUID, request: Request, session: SessionDep, admin: AdminUser
) -> None:
    if user_id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot delete yourself")
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    await audit.record(
        session,
        "user.delete",
        actor=admin,
        request=request,
        target_type="user",
        target_id=user.id,
        target_label=user.username,
        detail={"role": user.role.value},
    )
    await session.delete(user)
    await session.commit()


@router.post("/{user_id}/disable", status_code=status.HTTP_204_NO_CONTENT)
async def disable_user(
    user_id: uuid.UUID, request: Request, session: SessionDep, admin: AdminUser
) -> None:
    if user_id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot disable yourself")
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    user.is_active = False
    await auth_service.revoke_all_for_user(session, user.id)
    await audit.record(
        session,
        "user.disable",
        actor=admin,
        request=request,
        target_type="user",
        target_id=user.id,
        target_label=user.username,
    )
    await session.commit()
