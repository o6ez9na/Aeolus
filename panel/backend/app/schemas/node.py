import ipaddress
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.node import ClientStatus, NodeApproval, NodeRole, NodeStatus


class NodeBase(BaseModel):
    name: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9_.-]*$")
    address: str = Field(min_length=1, max_length=255)
    country_code: str | None = Field(default=None, min_length=2, max_length=2)
    role: NodeRole = NodeRole.slave
    agent_port: int = Field(default=50051, ge=1, le=65535)
    openvpn_port: int = Field(default=1194, ge=1, le=65535)
    openvpn_proto: str = Field(default="udp", pattern=r"^(udp|tcp)$")
    tcp_port: int | None = Field(default=None, ge=1, le=65535)
    max_clients: int | None = Field(default=None, ge=1)
    bandwidth_capacity_mbps: int = Field(default=1000, ge=1)


class NodeCreate(NodeBase):
    pass


class NodeUpdate(BaseModel):
    address: str | None = Field(default=None, min_length=1, max_length=255)
    country_code: str | None = Field(default=None, min_length=2, max_length=2)
    role: NodeRole | None = None
    agent_port: int | None = Field(default=None, ge=1, le=65535)
    openvpn_port: int | None = Field(default=None, ge=1, le=65535)
    openvpn_proto: str | None = Field(default=None, pattern=r"^(udp|tcp)$")
    tcp_port: int | None = Field(default=None, ge=1, le=65535)
    max_clients: int | None = Field(default=None, ge=1)
    bandwidth_capacity_mbps: int | None = Field(default=None, ge=1)
    is_enabled: bool | None = None
    transit_obfuscated: bool | None = None
    # Hub only. Sent as null or [] to go back to the panel-wide default.
    client_dns: list[str] | None = Field(default=None, max_length=4)

    @field_validator("client_dns")
    @classmethod
    def _dns_are_addresses(cls, value: list[str] | None) -> list[str] | None:
        if not value:
            return None
        servers: list[str] = []
        for raw in value:
            try:
                address = str(ipaddress.ip_address(raw.strip()))
            except ValueError:
                raise ValueError(f"{raw!r} is not an IP address") from None
            if address not in servers:
                servers.append(address)
        return servers


class NodeRead(NodeBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: NodeStatus
    status_message: str | None
    last_seen_at: datetime | None
    is_enabled: bool
    sessions: int
    bandwidth_mbps: int
    rx_bytes: int
    tx_bytes: int
    server_cert_not_after: datetime | None
    server_cert_serial: str | None
    agent_version: str | None
    agent_cert_serial: str | None
    config_revision: str | None
    created_at: datetime

    # Membership, as opposed to reachability: a node can be online and still be
    # waiting for someone to accept it.
    approval: NodeApproval
    approved_at: datetime | None = None
    is_hub: bool = False
    hostname: str | None = None
    announce_ip: str | None = None
    wan_iface: str | None = None
    subnets: list[str] = []
    key_fingerprint: str | None = None
    transit_host: int | None = None
    # Whether the hub currently holds a tunnel with this node, as opposed to
    # whether its agent is answering.
    transit_connected: bool = False
    transit_obfuscated: bool = False
    # How this node reaches the hub, as opposed to the client listener fields
    # above, which only the hub itself still uses.
    transit_transport: str = ""
    # Empty means the hub pushes client_dns_default instead.
    client_dns: list[str] = []
    client_dns_default: list[str] = []

    @field_validator("subnets", "client_dns", mode="before")
    @classmethod
    def _null_list_is_empty(cls, value: list[str] | None) -> list[str]:
        # NULL in the column means "never set", which the UI renders the same
        # way as an empty list.
        return value or []


class NodeCheck(BaseModel):
    key: str
    # ok | warn | fail | unknown — unknown when the panel has nothing to judge by.
    status: str
    title: str
    detail: str = ""


class NodeFile(BaseModel):
    name: str
    content: str


class NodeDiagnostics(BaseModel):
    """Checks and read-only configuration for one node's page."""

    checks: list[NodeCheck]
    files: list[NodeFile]
    # Clients whose whole internet leaves through this node.
    exit_for: list[str] = []


class EnrollmentToken(BaseModel):
    """Returned once, at creation time."""

    token: str
    node_name: str
    expires_at: datetime | None


class NodeSummary(BaseModel):
    """Numbers for the header strip above the node table."""

    nodes_pending: int = 0
    nodes_total: int
    nodes_online: int
    sessions: int
    rx_bytes: int
    tx_bytes: int
    failed_nodes: int
    clients_total: int
    clients_active: int


class ClientGrantRead(BaseModel):
    """One node a client may use, and on what terms."""

    grant_id: uuid.UUID
    node_id: uuid.UUID
    node_name: str
    node_is_hub: bool
    node_subnets: list[str] = []
    is_exit: bool = False
    # Only part of the node's LAN; None means all of it.
    networks: list[str] | None = None
    # The group this grant comes from; None for a personal grant.
    group_id: uuid.UUID | None = None


class ClientSessionRead(BaseModel):
    """A live session on the hub, straight from OpenVPN's status file."""

    proto: str
    real_address: str
    virtual_address: str = ""
    rx_bytes: int = 0
    tx_bytes: int = 0
    connected_since: str = ""


class ClientRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    common_name: str
    label: str | None
    status: ClientStatus
    expires_at: datetime | None
    traffic_limit_bytes: int | None
    traffic_used_bytes: int
    tunnel_host: int | None = None
    tunnel_address: str | None = None
    exit_node_id: uuid.UUID | None = None
    cert_serial: str | None
    cert_not_after: datetime | None
    last_seen_at: datetime | None
    last_node_id: uuid.UUID | None
    created_at: datetime
    node_ids: list[uuid.UUID] = []
    # Not called `grants`: that name belongs to the ORM relationship, and
    # validating the model would try to read the rows through it.
    access: list[ClientGrantRead] = []
    # None while the client is not connected to the hub right now.
    session: ClientSessionRead | None = None
    group_id: uuid.UUID | None = None
    group_name: str | None = None
    # Whether the profile can be pulled into OpenVPN Connect with a password.
    import_enabled: bool = False


class ClientImportPassword(BaseModel):
    """Omit the password to have the panel generate one."""

    password: str | None = Field(default=None, min_length=8, max_length=128)


class ClientImportCredentials(BaseModel):
    """Returned once: the panel keeps only a hash of the password."""

    username: str
    password: str


class ClientCreate(BaseModel):
    common_name: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    label: str | None = Field(default=None, max_length=128)
    expires_at: datetime | None = None
    traffic_limit_bytes: int | None = Field(default=None, ge=0)
    node_ids: list[uuid.UUID] = []
    group_id: uuid.UUID | None = None
    # Lets the subscriber import the profile into OpenVPN Connect from the start;
    # the form generates it, so the operator has it before the client exists.
    import_password: str | None = Field(default=None, min_length=8, max_length=128)


class ClientUpdate(BaseModel):
    label: str | None = Field(default=None, max_length=128)
    status: ClientStatus | None = None
    expires_at: datetime | None = None
    traffic_limit_bytes: int | None = Field(default=None, ge=0)
    node_ids: list[uuid.UUID] | None = None
    # Sent as null to take the client out of its group.
    group_id: uuid.UUID | None = None
