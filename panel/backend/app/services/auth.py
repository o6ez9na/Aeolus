import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import create_token, hash_password, needs_rehash, verify_password
from app.models.user import RefreshToken, User
from app.schemas.auth import TokenPair


class AuthError(Exception):
    """Login or refresh was rejected. Message is safe to return to the client."""


async def authenticate(session: AsyncSession, username: str, password: str) -> User:
    user = await session.scalar(select(User).where(User.username == username))

    # Hash even when the user is missing, so response time doesn't leak existence.
    stored_hash = user.password_hash if user else hash_password("dummy")
    if not verify_password(password, stored_hash) or user is None:
        raise AuthError("Invalid username or password")
    if not user.is_active:
        raise AuthError("Account is disabled")

    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    user.last_login_at = datetime.now(UTC)
    return user


async def issue_token_pair(
    session: AsyncSession,
    user: User,
    *,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> TokenPair:
    access, _, _ = create_token(user.id, "access", extra_claims={"role": user.role.value})
    refresh, jti, expires_at = create_token(user.id, "refresh")

    session.add(
        RefreshToken(
            jti=uuid.UUID(jti),
            user_id=user.id,
            expires_at=expires_at,
            user_agent=user_agent[:255] if user_agent else None,
            ip_address=ip_address,
        )
    )
    return TokenPair(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.access_token_ttl_minutes * 60,
    )


async def rotate_refresh_token(
    session: AsyncSession,
    payload: dict,
    *,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> TokenPair:
    """Consume a refresh token and issue a fresh pair.

    Reuse of an already-revoked token means the token leaked, so every session for
    that user is dropped.
    """
    jti = uuid.UUID(payload["jti"])
    stored = await session.scalar(select(RefreshToken).where(RefreshToken.jti == jti))
    if stored is None:
        raise AuthError("Unknown refresh token")

    if stored.revoked_at is not None:
        await revoke_all_for_user(session, stored.user_id)
        raise AuthError("Refresh token already used")

    if stored.expires_at <= datetime.now(UTC):
        raise AuthError("Refresh token expired")

    user = await session.get(User, stored.user_id)
    if user is None or not user.is_active:
        raise AuthError("Account is disabled")

    stored.revoked_at = datetime.now(UTC)
    return await issue_token_pair(
        session, user, user_agent=user_agent, ip_address=ip_address
    )


async def revoke_refresh_token(session: AsyncSession, jti: uuid.UUID) -> None:
    stored = await session.scalar(select(RefreshToken).where(RefreshToken.jti == jti))
    if stored is not None and stored.revoked_at is None:
        stored.revoked_at = datetime.now(UTC)


async def revoke_all_for_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    tokens = await session.scalars(
        select(RefreshToken).where(
            RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None)
        )
    )
    now = datetime.now(UTC)
    for token in tokens:
        token.revoked_at = now
