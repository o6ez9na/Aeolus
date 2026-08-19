import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError

from app.core.config import settings

_hasher = PasswordHasher()

TokenType = Literal["access", "refresh"]


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
    return True


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def create_token(
    subject: str | uuid.UUID,
    token_type: TokenType,
    *,
    extra_claims: dict[str, Any] | None = None,
) -> tuple[str, str, datetime]:
    """Return (encoded_jwt, jti, expires_at)."""
    now = datetime.now(UTC)
    if token_type == "access":
        expires_at = now + timedelta(minutes=settings.access_token_ttl_minutes)
    else:
        expires_at = now + timedelta(days=settings.refresh_token_ttl_days)

    jti = str(uuid.uuid4())
    payload: dict[str, Any] = {
        "sub": str(subject),
        "typ": token_type,
        "jti": jti,
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    if extra_claims:
        payload.update(extra_claims)

    encoded = jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)
    return encoded, jti, expires_at


def decode_token(token: str, expected_type: TokenType) -> dict[str, Any]:
    """Raise jwt.PyJWTError on any problem, including a token-type mismatch."""
    payload = jwt.decode(
        token,
        settings.secret_key,
        algorithms=[settings.jwt_algorithm],
        options={"require": ["exp", "sub", "jti", "typ"]},
    )
    if payload.get("typ") != expected_type:
        raise jwt.InvalidTokenError(f"expected {expected_type} token")
    return payload
