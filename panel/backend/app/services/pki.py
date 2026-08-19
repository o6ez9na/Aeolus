"""OpenVPN PKI: the panel is its own certificate authority.

Certificates are EC P-256, which OpenVPN has supported since 2.4 and which keeps
handshakes cheap on small nodes. Everything private is encrypted before it
reaches the database.
"""

import ipaddress
import secrets
from datetime import UTC, datetime, timedelta

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.crypto import decrypt_secret, encrypt_secret
from app.models.node import Client, ClientStatus, Node
from app.models.pki import CertificateAuthority

CURVE = ec.SECP256R1()


class PkiError(Exception):
    """PKI operation refused. The message is safe to show to an operator."""


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _new_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(CURVE)


def _key_to_pem(key: ec.EllipticCurvePrivateKey) -> str:
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


def _key_from_pem(pem: str) -> ec.EllipticCurvePrivateKey:
    return serialization.load_pem_private_key(pem.encode(), password=None)


def cert_to_pem(cert: x509.Certificate) -> str:
    return cert.public_bytes(serialization.Encoding.PEM).decode()


# Internal alias kept for the private helpers below.
_cert_to_pem = cert_to_pem


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


def generate_tls_crypt_key() -> str:
    """Build an OpenVPN static key file (2048 bits of hex in 16 lines)."""
    body = secrets.token_hex(256)
    lines = [body[i : i + 32] for i in range(0, len(body), 32)]
    return (
        "#\n"
        "# 2048 bit OpenVPN static key\n"
        "#\n"
        "-----BEGIN OpenVPN Static key V1-----\n"
        + "\n".join(lines)
        + "\n-----END OpenVPN Static key V1-----\n"
    )


async def get_active_ca(session: AsyncSession) -> CertificateAuthority | None:
    return await session.scalar(
        select(CertificateAuthority).where(CertificateAuthority.is_active.is_(True))
    )


async def require_ca(session: AsyncSession) -> CertificateAuthority:
    ca = await get_active_ca(session)
    if ca is None:
        raise PkiError("CA is not initialised yet")
    return ca


def _take_serial(ca: CertificateAuthority) -> int:
    serial = ca.next_serial
    ca.next_serial = serial + 1
    return serial


# --------------------------------------------------------------------------- #
# CA
# --------------------------------------------------------------------------- #


async def init_ca(session: AsyncSession, common_name: str) -> CertificateAuthority:
    if await get_active_ca(session) is not None:
        raise PkiError("CA already exists")

    key = _new_key()
    now = datetime.now(UTC)
    subject = _name(common_name)

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(1)
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=settings.ca_valid_days))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False
        )
        .sign(key, hashes.SHA256())
    )

    ca = CertificateAuthority(
        common_name=common_name,
        cert_pem=_cert_to_pem(cert),
        key_pem_encrypted=encrypt_secret(_key_to_pem(key)),
        tls_crypt_key_encrypted=encrypt_secret(generate_tls_crypt_key()),
    )
    session.add(ca)
    return ca


def _ca_material(
    ca: CertificateAuthority,
) -> tuple[x509.Certificate, ec.EllipticCurvePrivateKey]:
    cert = x509.load_pem_x509_certificate(ca.cert_pem.encode())
    key = _key_from_pem(decrypt_secret(ca.key_pem_encrypted))
    return cert, key


# --------------------------------------------------------------------------- #
# leaf certificates
# --------------------------------------------------------------------------- #


def _sign_leaf(
    ca: CertificateAuthority,
    common_name: str,
    *,
    valid_days: int,
    server: bool,
    san_hosts: list[str] | None = None,
) -> tuple[str, str, x509.Certificate]:
    ca_cert, ca_key = _ca_material(ca)
    key = _new_key()
    now = datetime.now(UTC)

    usage = x509.ExtendedKeyUsage(
        [x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]
        if server
        else [x509.oid.ExtendedKeyUsageOID.CLIENT_AUTH]
    )

    builder = (
        x509.CertificateBuilder()
        .subject_name(_name(common_name))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(_take_serial(ca))
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=valid_days))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(usage, critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                # ECDHE needs key agreement on the server side.
                key_agreement=server,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_cert.public_key()),
            critical=False,
        )
    )

    if san_hosts:
        alt: list[x509.GeneralName] = []
        for host in san_hosts:
            try:
                alt.append(x509.IPAddress(ipaddress.ip_address(host)))
            except ValueError:
                alt.append(x509.DNSName(host))
        builder = builder.add_extension(x509.SubjectAlternativeName(alt), critical=False)

    cert = builder.sign(ca_key, hashes.SHA256())
    return _cert_to_pem(cert), _key_to_pem(key), cert


async def issue_client_cert(session: AsyncSession, client: Client) -> Client:
    ca = await require_ca(session)
    if client.status == ClientStatus.revoked:
        raise PkiError("Client is revoked; create a new client instead")

    valid_days = settings.client_cert_valid_days
    if client.expires_at is not None:
        remaining = (client.expires_at - datetime.now(UTC)).days
        if remaining <= 0:
            raise PkiError("Client expiry is in the past")
        valid_days = min(valid_days, remaining)

    cert_pem, key_pem, cert = _sign_leaf(
        ca, client.common_name, valid_days=valid_days, server=False
    )

    client.cert_pem = cert_pem
    client.key_pem_encrypted = encrypt_secret(key_pem)
    client.cert_serial = f"{cert.serial_number:x}"
    client.cert_not_after = cert.not_valid_after_utc
    return client


def sign_agent_csr(ca: CertificateAuthority, csr_pem: str, expected_cn: str) -> x509.Certificate:
    """Sign an agent CSR as a client certificate.

    The subject is taken from the node, not from the request: a CSR is an
    unauthenticated blob, and letting it name itself would let one node enrol as
    another.
    """
    try:
        csr = x509.load_pem_x509_csr(csr_pem.encode())
    except ValueError as exc:
        raise PkiError(f"malformed CSR: {exc}") from None

    if not csr.is_signature_valid:
        raise PkiError("CSR signature does not verify")

    ca_cert, ca_key = _ca_material(ca)
    now = datetime.now(UTC)

    return (
        x509.CertificateBuilder()
        .subject_name(_name(expected_cn))
        .issuer_name(ca_cert.subject)
        .public_key(csr.public_key())
        .serial_number(_take_serial(ca))
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=settings.agent_cert_valid_days))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.CLIENT_AUTH]),
            critical=False,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_cert.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )


async def ensure_grpc_cert(session: AsyncSession, hosts: list[str]) -> CertificateAuthority:
    """Give the panel's gRPC endpoint a server certificate from our own CA."""
    ca = await require_ca(session)
    if ca.grpc_cert_pem is not None:
        cert = x509.load_pem_x509_certificate(ca.grpc_cert_pem.encode())
        try:
            existing = {
                str(name.value)
                for name in cert.extensions.get_extension_for_class(
                    x509.SubjectAlternativeName
                ).value
            }
        except x509.ExtensionNotFound:
            existing = set()
        if set(hosts) <= existing and cert.not_valid_after_utc > datetime.now(UTC):
            return ca

    cert_pem, key_pem, _ = _sign_leaf(
        ca,
        "aeolus-panel-grpc",
        valid_days=settings.server_cert_valid_days,
        server=True,
        san_hosts=hosts,
    )
    ca.grpc_cert_pem = cert_pem
    ca.grpc_key_pem_encrypted = encrypt_secret(key_pem)
    return ca


async def issue_server_cert(session: AsyncSession, node: Node) -> Node:
    ca = await require_ca(session)

    cert_pem, key_pem, cert = _sign_leaf(
        ca,
        node.name,
        valid_days=settings.server_cert_valid_days,
        server=True,
        san_hosts=[node.address],
    )

    node.server_cert_pem = cert_pem
    node.server_key_pem_encrypted = encrypt_secret(key_pem)
    node.server_cert_serial = f"{cert.serial_number:x}"
    node.server_cert_not_after = cert.not_valid_after_utc
    return node


# --------------------------------------------------------------------------- #
# revocation
# --------------------------------------------------------------------------- #


async def revoke_client(session: AsyncSession, client: Client) -> Client:
    if client.cert_serial is None:
        raise PkiError("Client has no certificate to revoke")
    if client.revoked_at is None:
        client.revoked_at = datetime.now(UTC)
    client.status = ClientStatus.revoked
    return client


async def build_crl(session: AsyncSession) -> str:
    """Rebuild the CRL from every revoked client.

    Nodes only stop honouring a certificate once they have this file, so a revoke
    is not complete until the CRL reaches them.
    """
    ca = await require_ca(session)
    ca_cert, ca_key = _ca_material(ca)
    now = datetime.now(UTC)

    builder = (
        x509.CertificateRevocationListBuilder()
        .issuer_name(ca_cert.subject)
        .last_update(now - timedelta(minutes=5))
        # OpenVPN rejects an expired CRL, so keep the window generous.
        .next_update(now + timedelta(days=30))
        .add_extension(x509.CRLNumber(ca.crl_number), critical=False)
    )

    revoked = await session.scalars(
        select(Client).where(
            Client.revoked_at.is_not(None), Client.cert_serial.is_not(None)
        )
    )
    for client in revoked:
        builder = builder.add_revoked_certificate(
            x509.RevokedCertificateBuilder()
            .serial_number(int(client.cert_serial, 16))
            .revocation_date(client.revoked_at)
            .build()
        )

    ca.crl_number += 1
    crl = builder.sign(ca_key, hashes.SHA256())
    return crl.public_bytes(serialization.Encoding.PEM).decode()
