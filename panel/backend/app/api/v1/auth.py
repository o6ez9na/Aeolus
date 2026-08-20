import uuid

import jwt
from fastapi import APIRouter, HTTPException, Request, status

from app.api.deps import CurrentUser, SessionDep
from app.core.security import decode_token
from app.schemas.auth import (
    LoginRequest,
    PasswordChange,
    RefreshRequest,
    TokenPair,
    UserRead,
)
from app.services import audit
from app.services import auth as auth_service
from app.core.security import hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_meta(request: Request) -> tuple[str | None, str | None]:
    return request.headers.get("user-agent"), request.client.host if request.client else None


@router.post("/login", response_model=TokenPair)
async def login(body: LoginRequest, request: Request, session: SessionDep) -> TokenPair:
    try:
        user = await auth_service.authenticate(session, body.username, body.password)
    except auth_service.AuthError as exc:
        # Failed attempts are the interesting half of a login log.
        await audit.record(
            session,
            "auth.login_failed",
            actor_username=body.username,
            request=request,
            detail={"reason": str(exc)},
        )
        await session.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from None

    user_agent, ip = _client_meta(request)
    tokens = await auth_service.issue_token_pair(
        session, user, user_agent=user_agent, ip_address=ip
    )
    await audit.record(
        session,
        "auth.login",
        actor=user,
        request=request,
        detail={"user_agent": user_agent},
    )
    await session.commit()
    return tokens


@router.post("/refresh", response_model=TokenPair)
async def refresh(body: RefreshRequest, request: Request, session: SessionDep) -> TokenPair:
    try:
        payload = decode_token(body.refresh_token, "refresh")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token") from None

    user_agent, ip = _client_meta(request)
    try:
        tokens = await auth_service.rotate_refresh_token(
            session, payload, user_agent=user_agent, ip_address=ip
        )
    except auth_service.AuthError as exc:
        # A spent refresh token being replayed revokes every session of that
        # user, which the operator has to be able to see afterwards.
        await audit.record(
            session,
            "auth.refresh_rejected",
            request=request,
            target_type="user",
            target_id=payload.get("sub"),
            detail={"reason": str(exc)},
        )
        await session.commit()  # persist the mass-revoke done on reuse detection
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from None

    await session.commit()
    return tokens


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(body: RefreshRequest, request: Request, session: SessionDep) -> None:
    try:
        payload = decode_token(body.refresh_token, "refresh")
    except jwt.PyJWTError:
        return  # already unusable; nothing to revoke
    await auth_service.revoke_refresh_token(session, uuid.UUID(payload["jti"]))
    await audit.record(
        session,
        "auth.logout",
        request=request,
        target_type="user",
        target_id=payload.get("sub"),
    )
    await session.commit()


@router.get("/me", response_model=UserRead)
async def me(user: CurrentUser) -> UserRead:
    return UserRead.model_validate(user)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: PasswordChange, request: Request, user: CurrentUser, session: SessionDep
) -> None:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    user.password_hash = hash_password(body.new_password)
    await auth_service.revoke_all_for_user(session, user.id)
    await audit.record(
        session,
        "auth.password_changed",
        actor=user,
        request=request,
        target_type="user",
        target_id=user.id,
        target_label=user.username,
    )
    await session.commit()
