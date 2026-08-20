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

    @field_validator("subnets", mode="before")
    @classmethod
    def _no_subnets_is_empty(cls, value: list[str] | None) -> list[str]:
        # NULL in the column means "never announced any", which the UI renders
        # the same way as an empty list.
        return value or []


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


class ClientCreate(BaseModel):
    common_name: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    label: str | None = Field(default=None, max_length=128)
    expires_at: datetime | None = None
    traffic_limit_bytes: int | None = Field(default=None, ge=0)
    node_ids: list[uuid.UUID] = []


class ClientUpdate(BaseModel):
    label: str | None = Field(default=None, max_length=128)
    status: ClientStatus | None = None
    expires_at: datetime | None = None
    traffic_limit_bytes: int | None = Field(default=None, ge=0)
    node_ids: list[uuid.UUID] | None = None
