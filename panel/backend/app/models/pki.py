from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, String, Text
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

    # TLS identity of the panel's own gRPC endpoint, signed by this CA so agents
    # can verify the panel with the same trust root they already carry.
    grpc_cert_pem: Mapped[str | None] = mapped_column(Text)
    grpc_key_pem_encrypted: Mapped[str | None] = mapped_column(Text)

    # Certificate serials must never repeat for the same CA.
    next_serial: Mapped[int] = mapped_column(BigInteger, default=2)
    crl_number: Mapped[int] = mapped_column(BigInteger, default=1)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class RevokedCertificate(Base, UUIDMixin, TimestampMixin):
    """One entry of the CRL, kept independently of whatever it was issued to.

    The CRL used to be rebuilt from the client rows, so deleting a client
    silently un-revoked its certificate: the row was gone, the serial dropped
    out of the list, and the profile kept working until it expired. A revocation
    has to outlive the object it was issued for, so it lives here instead.
    """

    __tablename__ = "revoked_certificates"

    # Hex, lower case, matching Client.cert_serial.
    serial: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    common_name: Mapped[str] = mapped_column(String(64))
    revoked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    # Free-form note for the operator, e.g. "client deleted".
    reason: Mapped[str | None] = mapped_column(String(64))
