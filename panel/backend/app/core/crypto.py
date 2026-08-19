import base64
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import settings


class SecretUnreadableError(RuntimeError):
    """Stored material could not be decrypted with the configured key."""


@lru_cache
def _fernet() -> Fernet:
    """Derive the at-rest key from AEOLUS_PKI_SECRET, or the app secret if unset.

    Changing whichever key is in use makes every stored private key unreadable;
    the CA then has to be re-initialised and certificates re-issued.
    """
    material = (settings.pki_secret or settings.secret_key).encode()
    derived = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=b"aeolus-pki-at-rest-v1",
    ).derive(material)
    return Fernet(base64.urlsafe_b64encode(derived))


def encrypt_secret(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_secret(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken as exc:
        raise SecretUnreadableError(
            "Stored key cannot be decrypted; AEOLUS_PKI_SECRET likely changed"
        ) from exc
