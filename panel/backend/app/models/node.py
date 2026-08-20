import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDMixin


class NodeStatus(str, enum.Enum):
    unknown = "unknown"
    online = "online"
    offline = "offline"
    error = "error"
    disabled = "disabled"


class NodeRole(str, enum.Enum):
    master = "master"
    slave = "slave"


class Node(Base, UUIDMixin, TimestampMixin):
    """An `anemoi` agent host running OpenVPN, reachable over gRPC + mTLS."""

    __tablename__ = "nodes"

    name: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    address: Mapped[str] = mapped_column(String(255))  # hostname or IP clients dial
    country_code: Mapped[str | None] = mapped_column(String(2))
    agent_port: Mapped[int] = mapped_column(Integer, default=50051)

    # Agent enrolment. The token is stored hashed: it is a credential, and the
    # panel only ever needs to compare it.
    enrollment_token_hash: Mapped[str | None] = mapped_column(String(64), index=True)
    enrollment_token_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    agent_cert_serial: Mapped[str | None] = mapped_column(String(64))
    agent_cert_not_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    agent_version: Mapped[str | None] = mapped_column(String(32))
    config_revision: Mapped[str | None] = mapped_column(String(64))

    openvpn_port: Mapped[int] = mapped_column(Integer, default=1194)
    openvpn_proto: Mapped[str] = mapped_column(String(3), default="udp")

    # Second listener on TCP. Some mobile carriers pass an OpenVPN handshake and
    # then drop the UDP flow, which looks like a tunnel that connects and then
    # goes silent; TCP gives those clients a way through.
    tcp_port: Mapped[int | None] = mapped_column(Integer)

    role: Mapped[NodeRole] = mapped_column(
        Enum(NodeRole, name="node_role"), default=NodeRole.slave
    )

    status: Mapped[NodeStatus] = mapped_column(
        Enum(NodeStatus, name="node_status"), default=NodeStatus.unknown
    )
    status_message: Mapped[str | None] = mapped_column(Text)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    max_clients: Mapped[int | None] = mapped_column(Integer)

    # Last metrics reported by the anemoi agent. Stale until the agent lands.
    sessions: Mapped[int] = mapped_column(Integer, default=0)
    bandwidth_mbps: Mapped[int] = mapped_column(Integer, default=0)
    bandwidth_capacity_mbps: Mapped[int] = mapped_column(Integer, default=1000)
    rx_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    tx_bytes: Mapped[int] = mapped_column(BigInteger, default=0)

    # Server certificate expiry, so the UI can warn before OpenVPN starts refusing.
    server_cert_not_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    server_cert_pem: Mapped[str | None] = mapped_column(Text)
    server_key_pem_encrypted: Mapped[str | None] = mapped_column(Text)
    server_cert_serial: Mapped[str | None] = mapped_column(String(64))

    grants: Mapped[list["ClientNodeGrant"]] = relationship(
        back_populates="node", cascade="all, delete-orphan"
    )


class ClientStatus(str, enum.Enum):
    active = "active"
    disabled = "disabled"
    expired = "expired"
    revoked = "revoked"


class Client(Base, UUIDMixin, TimestampMixin):
    """A VPN subscriber. Owns exactly one issued OpenVPN client certificate."""

    __tablename__ = "clients"

    common_name: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    label: Mapped[str | None] = mapped_column(String(128))
    status: Mapped[ClientStatus] = mapped_column(
        Enum(ClientStatus, name="client_status"), default=ClientStatus.active
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    traffic_limit_bytes: Mapped[int | None] = mapped_column(BigInteger)
    traffic_used_bytes: Mapped[int] = mapped_column(BigInteger, default=0)

    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_node_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("nodes.id", ondelete="SET NULL")
    )

    # PKI. The key is kept encrypted so the .ovpn can be handed out again; anyone
    # who can read it can already mint new certificates from the CA next to it.
    cert_serial: Mapped[str | None] = mapped_column(String(64), unique=True)
    cert_pem: Mapped[str | None] = mapped_column(Text)
    key_pem_encrypted: Mapped[str | None] = mapped_column(Text)
    cert_not_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    grants: Mapped[list["ClientNodeGrant"]] = relationship(
        back_populates="client", cascade="all, delete-orphan"
    )


class ClientNodeGrant(Base, UUIDMixin, TimestampMixin):
    """Which nodes a client is allowed to exit through, and on what terms.

    This row is also the client-config-dir entry for that pair: OpenVPN reads
    one ccd file per common name per node, which is exactly this granularity.
    """

    __tablename__ = "client_node_grants"
    __table_args__ = (
        UniqueConstraint("client_id", "node_id", name="uq_client_node"),
        # Two clients cannot be pinned to the same tunnel address on one node.
        Index(
            "uq_node_static_host",
            "node_id",
            "static_host",
            unique=True,
            postgresql_where=text("static_host IS NOT NULL"),
        ),
    )

    client_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), index=True
    )
    node_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("nodes.id", ondelete="CASCADE"), index=True
    )

    # Host part of the fixed tunnel address, not the address itself: a node runs
    # a UDP and a TCP listener on two different subnets, and the same client has
    # to land on the same host number whichever one it reaches.
    static_host: Mapped[int | None] = mapped_column(Integer)

    # Networks pushed to this client, as CIDR strings.
    push_routes: Mapped[list[str] | None] = mapped_column(JSON)

    # Networks reachable *behind* this client, needed when it is a site gateway
    # rather than a laptop.
    iroutes: Mapped[list[str] | None] = mapped_column(JSON)

    # Extra push directives, validated against an allow list before they land in
    # a ccd file: a bad line there stops the client connecting at all.
    push_options: Mapped[list[str] | None] = mapped_column(JSON)

    client: Mapped[Client] = relationship(back_populates="grants")
    node: Mapped[Node] = relationship(back_populates="grants")
