import uuid
from collections.abc import Callable, Coroutine
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.security import decode_token
from app.models.user import User, UserRole

bearer_scheme = HTTPBearer(auto_error=False)

SessionDep = Annotated[AsyncSession, Depends(get_session)]

_credentials_error = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


async def get_current_user(
    session: SessionDep,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> User:
    if creds is None:
        raise _credentials_error
    try:
        payload = decode_token(creds.credentials, "access")
        user_id = uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, ValueError, KeyError):
        raise _credentials_error from None

    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise _credentials_error
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]

_ROLE_RANK = {UserRole.viewer: 0, UserRole.operator: 1, UserRole.admin: 2}


def require_role(
    minimum: UserRole,
) -> Callable[[User], Coroutine[Any, Any, User]]:
    async def _guard(user: CurrentUser) -> User:
        if _ROLE_RANK[user.role] < _ROLE_RANK[minimum]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient privileges"
            )
        return user

    return _guard


AdminUser = Annotated[User, Depends(require_role(UserRole.admin))]
OperatorUser = Annotated[User, Depends(require_role(UserRole.operator))]
