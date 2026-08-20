from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_prefix="AEOLUS_", extra="ignore"
    )

    project_name: str = "Aeolus"
    api_prefix: str = "/api/v1"
    debug: bool = False

    database_url: str = "postgresql+asyncpg://aeolus:aeolus@localhost:5432/aeolus"

    # openssl rand -hex 32
    secret_key: str = Field(min_length=32)
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 30

    cors_origins: list[str] = ["http://localhost:5173"]

    # Encrypts CA and client private keys at rest. Falls back to secret_key when
    # unset; rotating either one makes existing stored keys unreadable.
    pki_secret: str | None = None
    ca_valid_days: int = 3650
    server_cert_valid_days: int = 825
    client_cert_valid_days: int = 365
    agent_cert_valid_days: int = 825

    # gRPC endpoint the anemoi agents dial.
    grpc_host: str = "0.0.0.0"
    grpc_port: int = 50051
    grpc_enabled: bool = True
    # Extra names the agents may use to reach the panel, on top of the domain.
    grpc_san_hosts: list[str] = ["localhost", "backend"]
    node_offline_after_seconds: int = 90

    # Bootstrap admin, created on first startup if no users exist.
    first_admin_username: str = "admin"
    first_admin_password: str | None = None

    # The panel host is a node too. It registers itself on startup so an operator
    # never has to add it by hand.
    master_node_name: str = "panel"
    # Address clients dial to reach the panel's own OpenVPN. Falls back to the
    # panel domain when unset.
    public_host: str | None = None
    domain: str | None = None
    master_openvpn_port: int = 1194
    master_openvpn_proto: str = "udp"

    # OpenVPN on the panel host. The directory is a volume shared with the
    # openvpn container.
    openvpn_config_dir: str = "/etc/openvpn/aeolus"
    # Deliberately not 10.8.0.0/24: that is the default of half the VPN stacks
    # out there, and a node running one of them would treat the panel's client
    # pool as its own local network and send the return path the wrong way.
    vpn_subnet: str = "10.20.0.0"
    vpn_netmask: str = "255.255.255.0"
    # The TCP listener needs a pool of its own; two OpenVPN instances cannot
    # hand out the same addresses.
    vpn_tcp_subnet: str = "10.21.0.0"
    # Not 443: the panel's own HTTPS already owns that port on the same host.
    master_tcp_port: int | None = 8443
    # Transit: the tunnel every node dials into. Clients never touch this
    # subnet; it exists so the hub can forward a client into a node's exit.
    vpn_transit_subnet: str = "10.10.0.0"
    vpn_transit_port: int = 1195
    # Some networks pass an OpenVPN handshake and then quietly police the UDP
    # flow that follows: the tunnel connects, goes silent, and restarts on the
    # inactivity timer forever. Nodes on such a network need the same escape
    # hatch clients already have.
    vpn_transit_proto: str = "udp"

    # Name of the wstunnel container a node runs beside OpenVPN, as its own
    # compose network resolves it.
    transit_wstunnel_host: str = "wstunnel"
    # New nodes carry the transit inside a WebSocket from the start. A node that
    # cannot hold a tunnel is useless, and the networks that break one do it
    # silently — a working node an operator can speed up beats a dead node they
    # have to diagnose. Turned off per node once it is known to be unnecessary.
    transit_obfuscated_default: bool = True

    vpn_dns: str = "1.1.1.1"
    # Fixed addresses are handed out below the dynamic pool, so a pinned client
    # can never collide with one OpenVPN assigns on its own.
    vpn_static_host_min: int = 2
    vpn_static_host_max: int = 99
    vpn_pool_host_min: int = 100
    vpn_pool_host_max: int = 250
    # Conservative enough for mobile carriers, which commonly cap the path at
    # ~1400 bytes and drop anything larger instead of fragmenting.
    vpn_tun_mtu: int = 1360
    vpn_mssfix: int = 1300

    @property
    def master_node_address(self) -> str | None:
        return self.public_host or self.domain


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
