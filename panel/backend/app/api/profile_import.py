"""Profile import the way OpenVPN Connect expects it from an Access Server.

Connect's "import from URL" takes a hostname, a username and a password, and
fetches the profile from the server's REST API with HTTP Basic auth. Answering
the same two methods lets a subscriber set themselves up from the app instead
of being sent a file.

Both methods return the autologin profile: certificate and key inline, no
password on connect. The password only guards the download, which makes it
exactly as sensitive as the .ovpn file itself — hence the throttle.
"""

import base64
import binascii
import logging
import secrets
import time
from collections import defaultdict, deque
from xml.sax.saxutils import escape

from fastapi import APIRouter, Request, Response
from sqlalchemy import select

from app.api.deps import SessionDep
from app.core.crypto import SecretUnreadableError
from app.core.security import hash_password, verify_password
from app.models.node import Client, ClientStatus
from app.services import audit, openvpn, pki

logger = logging.getLogger("aeolus.profile_import")

router = APIRouter(prefix="/rest", tags=["profile-import"])

# Per source address. The window is long enough that guessing a 14-character
# password is hopeless, short enough that a user who mistyped can try again.
_WINDOW_SECONDS = 15 * 60
_MAX_FAILURES = 10
_failures: dict[str, deque[float]] = defaultdict(deque)

# Checked against when the username does not exist, so a miss takes as long as
# a wrong password and the timing does not reveal which client names are real.
_DUMMY_HASH = hash_password(secrets.token_hex(16))


def _blocked(ip: str) -> bool:
    attempts = _failures[ip]
    now = time.monotonic()
    while attempts and now - attempts[0] > _WINDOW_SECONDS:
        attempts.popleft()
    if not attempts:
        del _failures[ip]
        return False
    return len(attempts) >= _MAX_FAILURES


def _basic_credentials(request: Request) -> tuple[str, str] | None:
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "basic" or not value:
        return None
    try:
        decoded = base64.b64decode(value.strip(), validate=True).decode()
    except (binascii.Error, UnicodeDecodeError):
        return None
    username, sep, password = decoded.partition(":")
    return (username, password) if sep else None


def _error(status_code: int, kind: str, message: str) -> Response:
    """An error in the XML shape Access Server uses, which Connect shows as is."""
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<Error>\n"
        f"  <Type>{escape(kind)}</Type>\n"
        "  <Synopsis>REST method failed</Synopsis>\n"
        f"  <Message>{escape(message)}</Message>\n"
        "</Error>\n"
    )
    headers = {"WWW-Authenticate": 'Basic realm="Aeolus"'} if status_code == 401 else None
    return Response(body, status_code=status_code, media_type="text/xml", headers=headers)


@router.api_route("/GetAutologin", methods=["GET", "POST"])
@router.api_route("/GetUserlogin", methods=["GET", "POST"])
async def get_profile(request: Request, session: SessionDep) -> Response:
    ip = audit.client_ip(request) or "unknown"
    if _blocked(ip):
        return _error(429, "Too Many Requests", "too many failed logins, try again later")

    credentials = _basic_credentials(request)
    if credentials is None:
        return _error(401, "Authorization Required", "AUTH_FAILED: username and password required")
    username, password = credentials

    client = await session.scalar(select(Client).where(Client.common_name == username))
    stored = client.import_password_hash if client is not None else None
    if not verify_password(password, stored or _DUMMY_HASH) or stored is None:
        _failures[ip].append(time.monotonic())
        await audit.record(
            session,
            "client.import_failed",
            actor_username=username[:64],
            request=request,
            detail={"method": request.url.path},
        )
        await session.commit()
        return _error(401, "Authorization Required", "AUTH_FAILED: wrong username or password")

    if client.status != ClientStatus.active:
        return _error(403, "Access Denied", f"AUTH_FAILED: client is {client.status.value}")
    try:
        node, profile = await openvpn.build_client_profile(session, client)
    except (openvpn.OpenVpnError, pki.PkiError) as exc:
        return _error(409, "Profile Unavailable", str(exc))
    except SecretUnreadableError:
        logger.exception("could not decrypt the profile of %s", client.common_name)
        return _error(500, "Internal Error", "profile could not be assembled")

    await audit.record(
        session,
        "client.import",
        actor_username=client.common_name,
        request=request,
        target_type="client",
        target_id=client.id,
        target_label=client.common_name,
        detail={"method": request.url.path, "user_agent": request.headers.get("user-agent")},
    )
    await session.commit()

    # The metadata Access Server puts at the top of its profiles; Connect reads
    # it to name the imported profile.
    header = (
        f"# OVPN_ACCESS_SERVER_USERNAME={client.common_name}\n"
        f"# OVPN_ACCESS_SERVER_AUTOLOGIN=1\n"
        f"# OVPN_ACCESS_SERVER_PROFILE={client.common_name}@{node.address}/AUTOLOGIN\n"
    )
    return Response(
        header + profile,
        media_type="application/x-openvpn-profile",
        headers={"Content-Disposition": f'attachment; filename="{client.common_name}.ovpn"'},
    )


@router.api_route("/{method:path}", methods=["GET", "POST", "PUT", "HEAD"])
async def unsupported(method: str, request: Request) -> Response:
    # Connect versions differ in what they ask an Access Server for. Whatever we
    # do not answer is logged, so the next one to support is easy to find.
    logger.warning(
        "profile import: unsupported %s /rest/%s from %s (%s)",
        request.method,
        method,
        audit.client_ip(request),
        request.headers.get("user-agent"),
    )
    return _error(404, "Not Found", f"unsupported REST method {method}")
