from sqlalchemy import BigInteger, Boolean, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class CertificateAuthority(Base, UUIDMixin, TimestampMixin):
    """The panel's own CA. One active row; older rows stay for audit.

    Private material is stored encrypted, see app.core.crypto.
    """

    __tablename__ = "certificate_authority"

    common_name: Mapped[str] = mapped_column(String(64))
    cert_pem: Mapped[str] = mapped_column(Text)
    key_pem_encrypted: Mapped[str] = mapped_column(Text)

    # OpenVPN tls-crypt static key, shared by every node and client. It hides the
    # TLS handshake, so a scanner cannot tell the port speaks OpenVPN.
    tls_crypt_key_encrypted: Mapped[str] = mapped_column(Text)

    # Certificate serials must never repeat for the same CA.
    next_serial: Mapped[int] = mapped_column(BigInteger, default=2)
    crl_number: Mapped[int] = mapped_column(BigInteger, default=1)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
