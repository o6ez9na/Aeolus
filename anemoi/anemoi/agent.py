"""anemoi — the node agent.

Runs next to OpenVPN on every node, including the panel's own. It dials the
panel, so a node needs no inbound port beyond OpenVPN itself.

Loop: pull configuration, write it to disk when the revision changed, restart
OpenVPN if the server config itself changed, then report what OpenVPN is doing.
"""

import hashlib
import json
import logging
import os
import urllib.error
import urllib.request
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import grpc
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from anemoi.grpc_gen import agent_pb2, agent_pb2_grpc
from anemoi import status as status_parser

VERSION = "0.1.0"

logging.basicConfig(
    level=os.environ.get("ANEMOI_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("anemoi")


@dataclass
class Config:
    panel: str = os.environ.get("ANEMOI_PANEL", "backend:50051")
    # HTTPS base URL of the panel API, used once, to enrol.
    panel_api: str = os.environ.get("ANEMOI_PANEL_API", "http://backend:8000")
    token: str = os.environ.get("ANEMOI_ENROLLMENT_TOKEN", "")
    # The panel drops a token here for its own node, so that node enrols without
    # an operator copying anything.
    token_file: Path = field(default_factory=lambda: Path(
        os.environ.get("ANEMOI_TOKEN_FILE", "/etc/openvpn/aeolus/.enrollment-token")
    ))
    # What the node calls itself in the join request. The panel sanitises it and
    # may rename on collision; the certificate carries the panel's choice.
    node_name: str = os.environ.get("ANEMOI_NODE_NAME", "")
    # LANs this node exposes to the mesh, comma separated CIDRs.
    subnets: str = os.environ.get("ANEMOI_SUBNETS", "")
    wan_iface: str = os.environ.get("ANEMOI_WAN_IFACE", "")
    state_dir: Path = Path(os.environ.get("ANEMOI_STATE_DIR", "/var/lib/anemoi"))
    config_dir: Path = Path(os.environ.get("ANEMOI_CONFIG_DIR", "/etc/openvpn/aeolus"))
    status_file: Path = Path(
        os.environ.get("ANEMOI_STATUS_FILE", "/run/openvpn/status.log")
    )
    # A node runs no client listener, so it has no status.log — what says it is
    # healthy there is the transit tunnel to the hub.
    transit_status_file: Path = Path(
        os.environ.get("ANEMOI_TRANSIT_STATUS_FILE", "/run/openvpn/status-transit.log")
    )
    interval: int = int(os.environ.get("ANEMOI_INTERVAL", "15"))
    # Written when server.conf changes so the OpenVPN supervisor can restart it.
    restart_flag: Path = field(default_factory=lambda: Path(
        os.environ.get("ANEMOI_RESTART_FLAG", "/etc/openvpn/aeolus/.restart")
    ))


class Enrolment:
    """The agent's own key and certificate, kept on disk between restarts."""

    def __init__(self, state_dir: Path):
        self.key_path = state_dir / "agent.key"
        self.cert_path = state_dir / "agent.crt"
        self.ca_path = state_dir / "ca.crt"
        self.name_path = state_dir / "node-name"
        # Written while a join request is waiting for an operator.
        self.announce_path = state_dir / "announce-token"

    @property
    def complete(self) -> bool:
        return all(
            p.exists() for p in (self.key_path, self.cert_path, self.ca_path)
        )

    def load(self) -> tuple[bytes, bytes, bytes]:
        return (
            self.key_path.read_bytes(),
            self.cert_path.read_bytes(),
            self.ca_path.read_bytes(),
        )

    def create_csr(self, common_name: str = "pending") -> str:
        """Build a CSR, reusing the key we already have.

        The key is this node's identity: the panel dedupes join requests by its
        fingerprint, and an operator may already be looking at that fingerprint
        on screen. Generating a fresh one on every retry would queue a new
        request each time and invalidate what they are comparing.
        """
        self.key_path.parent.mkdir(parents=True, exist_ok=True)
        if self.key_path.exists():
            key = serialization.load_pem_private_key(
                self.key_path.read_bytes(), password=None
            )
        else:
            key = ec.generate_private_key(ec.SECP256R1())
            self.key_path.write_bytes(
                key.private_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PrivateFormat.PKCS8,
                    encryption_algorithm=serialization.NoEncryption(),
                )
            )
            self.key_path.chmod(0o600)

        csr = (
            x509.CertificateSigningRequestBuilder()
            .subject_name(
                x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
            )
            .sign(key, hashes.SHA256())
        )
        return csr.public_bytes(serialization.Encoding.PEM).decode()

    def save(self, cert_pem: str, ca_pem: str, node_name: str) -> None:
        self.cert_path.write_text(cert_pem)
        self.ca_path.write_text(ca_pem)
        self.name_path.write_text(node_name)
        self.announce_path.unlink(missing_ok=True)

    def fingerprint(self) -> str:
        """SHA-256 of our public key, formatted the way the panel shows it.

        This is what an operator compares before accepting the node, so it is
        printed on every start while the request is pending.
        """
        key = serialization.load_pem_private_key(
            self.key_path.read_bytes(), password=None
        )
        der = key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        digest = hashlib.sha256(der).hexdigest()
        return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))


def _api(cfg: Config, path: str, body: dict | None = None) -> dict:
    """Call the panel's HTTPS API. Raises OSError / HTTPError on failure."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        f"{cfg.panel_api.rstrip('/')}{path}",
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data else "GET",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def _local_subnets(cfg: Config) -> list[str]:
    """LANs this node exposes. Explicit configuration wins over guessing."""
    if cfg.subnets:
        return [part.strip() for part in cfg.subnets.split(",") if part.strip()]
    return []


def announce(cfg: Config, enrolment: Enrolment) -> str | None:
    """Ask the panel to join. Returns the poll token, or None if it refused.

    Nothing here is authenticated — a fresh node has no credential to present.
    The request stays inert until an operator compares the fingerprint we print
    below with the one the panel shows, and accepts it.
    """
    csr_pem = enrolment.create_csr(cfg.node_name or os.uname().nodename)
    body = {
        "csr_pem": csr_pem,
        "name": cfg.node_name or os.uname().nodename,
        "hostname": os.uname().nodename,
        "wan_iface": cfg.wan_iface,
        "subnets": _local_subnets(cfg),
        "agent_version": VERSION,
    }
    try:
        payload = _api(cfg, "/api/v1/agents/announce", body)
    except urllib.error.HTTPError as exc:
        logger.error("announce refused: %s %s", exc.code, exc.read().decode()[:200])
        return None
    except OSError as exc:
        logger.error("cannot reach the panel API at %s: %s", cfg.panel_api, exc)
        return None

    enrolment.announce_path.write_text(payload["poll_token"])
    logger.warning(
        "join request sent as %r. Accept it in the panel; the fingerprint must read:\n    %s",
        payload["node_name"],
        payload["fingerprint"],
    )
    return payload["poll_token"]


def collect(cfg: Config, enrolment: Enrolment, token: str) -> bool:
    """Poll the panel for the decision. True once we hold a certificate."""
    try:
        payload = _api(cfg, f"/api/v1/agents/announce/{token}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            # The request was forgotten on the panel side; ask again.
            enrolment.announce_path.unlink(missing_ok=True)
        logger.warning("poll refused: %s", exc.code)
        return False
    except OSError as exc:
        logger.warning("cannot reach the panel API: %s", exc)
        return False

    if payload["status"] != "approved" or not payload.get("cert_pem"):
        logger.info("waiting to be accepted (state: %s)", payload["status"])
        return False

    enrolment.save(payload["cert_pem"], payload["ca_pem"], payload["node_name"])
    logger.warning("accepted as node %r", payload["node_name"])
    return True


def join(cfg: Config, enrolment: Enrolment) -> bool:
    """Get this node from "nothing" to "holds a certificate". One pass."""
    if cfg.token or cfg.token_file.exists():
        # A token means the panel provisioned this node itself, which is how the
        # panel's own agent starts without a human in the loop.
        return enroll_with_token(cfg, enrolment)

    token = ""
    if enrolment.announce_path.exists():
        token = enrolment.announce_path.read_text().strip()
    if not token:
        token = announce(cfg, enrolment) or ""
    if not token:
        return False
    return collect(cfg, enrolment, token)


def enroll_with_token(cfg: Config, enrolment: Enrolment) -> bool:
    """Trade a one-time token for a certificate.

    Kept for the panel's own node: the panel drops a token in the shared volume,
    so the machine the operator is already logged in to does not queue a request
    against itself.
    """
    if not cfg.token and cfg.token_file.exists():
        cfg.token = cfg.token_file.read_text().strip()
    if not cfg.token:
        return False

    csr_pem = enrolment.create_csr()
    try:
        payload = _api(
            cfg,
            "/api/v1/agents/enroll",
            {"token": cfg.token, "csr_pem": csr_pem, "agent_version": VERSION},
        )
    except urllib.error.HTTPError as exc:
        logger.error("enrolment refused: %s %s", exc.code, exc.read().decode()[:200])
        return False
    except OSError as exc:
        logger.error("cannot reach the panel API at %s: %s", cfg.panel_api, exc)
        return False

    enrolment.save(payload["cert_pem"], payload["ca_pem"], payload["node_name"])
    # The token is spent; leaving it on disk only widens the window for reuse.
    cfg.token_file.unlink(missing_ok=True)
    logger.info("enrolled as node %r", payload["node_name"])
    return True


def _target_name(panel: str) -> str:
    return panel.rsplit(":", 1)[0]


def make_channel(cfg: Config, enrolment: Enrolment) -> grpc.Channel:
    key, cert, ca = enrolment.load()
    credentials = grpc.ssl_channel_credentials(
        root_certificates=ca, private_key=key, certificate_chain=cert
    )
    return grpc.secure_channel(
        cfg.panel,
        credentials,
        options=(("grpc.ssl_target_name_override", _target_name(cfg.panel)),),
    )


def apply_config(cfg: Config, response) -> bool:
    """Write the bundle. Returns True when OpenVPN needs a restart."""
    cfg.config_dir.mkdir(parents=True, exist_ok=True)

    restart_needed = False
    for name, wanted in (
        ("server.conf", response.server_conf),
        ("server-tcp.conf", response.server_conf_tcp),
        ("transit.conf", response.transit_conf),
    ):
        path = cfg.config_dir / name
        if wanted:
            restart_needed |= not path.exists() or path.read_text() != wanted
        elif path.exists():
            # The listener was turned off; stop supervising it.
            path.unlink()
            restart_needed = True

    files = {
        "server.conf": response.server_conf,
        "ca.crt": response.ca_pem,
        "server.crt": response.server_cert_pem,
        "server.key": response.server_key_pem,
        "tls-crypt.key": response.tls_crypt_key,
        "crl.pem": response.crl_pem,
    }
    if response.server_conf_tcp:
        files["server-tcp.conf"] = response.server_conf_tcp
    if response.transit_conf:
        files["transit.conf"] = response.transit_conf
        if not response.is_hub:
            # A node dials the hub as an OpenVPN client, and authenticates with
            # the same certificate it uses for gRPC: one identity per node.
            state = Enrolment(cfg.state_dir)
            files["transit.crt"] = state.cert_path.read_text()
            files["transit.key"] = state.key_path.read_text()

    for name, content in files.items():
        # An empty payload means "this node does not run that", not "write an
        # empty file": an empty server.conf would still be started by the
        # supervisor. The loop above has already removed a file that went away.
        if not content:
            continue
        path = cfg.config_dir / name
        if path.exists() and path.read_text() == content:
            continue
        path.write_text(content)
        path.chmod(
            0o600
            if name in {"server.key", "tls-crypt.key", "transit.key"}
            else 0o644
        )

    # One directory per listener: a pinned client has a different address on the
    # UDP and the TCP subnet, so the entries are not interchangeable. The hub
    # additionally keeps one per node, holding its transit address and LANs.
    for dirname, entries in (
        ("ccd", response.ccd),
        ("ccd-tcp", response.ccd_tcp),
        ("ccd-transit", response.ccd_transit),
    ):
        ccd_dir = cfg.config_dir / dirname
        ccd_dir.mkdir(exist_ok=True)
        # A stale ccd entry would keep granting access after the panel took it
        # away.
        wanted = set(entries)
        for existing in ccd_dir.iterdir():
            if existing.is_file() and existing.name not in wanted:
                existing.unlink()
        for common_name, body in entries.items():
            (ccd_dir / common_name).write_text(body)

    (cfg.config_dir / ".revision").write_text(response.revision)
    return restart_needed


def request_openvpn_restart(cfg: Config) -> None:
    cfg.restart_flag.write_text(str(time.time()))
    logger.info("server config changed, asked the supervisor to restart OpenVPN")


def run() -> None:
    cfg = Config()
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    enrolment = Enrolment(cfg.state_dir)

    if not enrolment.complete:
        if not join(cfg, enrolment):
            # Nothing else can happen until an operator accepts this node, so
            # keep asking rather than exiting and losing the request.
            while not enrolment.complete:
                time.sleep(cfg.interval)
                if join(cfg, enrolment):
                    break

    running = True

    def stop(signum, _frame):
        nonlocal running
        logger.info("signal %s received, stopping", signum)
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    # Deliberately not seeded from the .revision file on disk. That file says
    # which revision was last applied, not what is actually there: an agent that
    # was upgraded since — or a file someone removed by hand — leaves the two
    # disagreeing, and claiming the revision would make the panel answer
    # "unchanged" forever. The first pull after a start is always a full one.
    revision = ""

    while running:
        try:
            with make_channel(cfg, enrolment) as channel:
                stub = agent_pb2_grpc.NodeAgentStub(channel)

                config = stub.GetConfig(
                    agent_pb2.ConfigRequest(known_revision=revision), timeout=30
                )
                if not config.unchanged:
                    if apply_config(cfg, config):
                        request_openvpn_restart(cfg)
                    revision = config.revision
                    logger.info("applied configuration revision %s", revision)

                # Whichever OpenVPN this machine actually runs: the hub serves
                # clients, every other node only holds the transit tunnel.
                snapshot = status_parser.read(
                    cfg.status_file
                    if cfg.status_file.exists()
                    else cfg.transit_status_file
                )
                stub.ReportStatus(
                    agent_pb2.StatusReport(
                        openvpn_running=snapshot.running,
                        message=snapshot.message,
                        rx_bytes=snapshot.rx_bytes,
                        tx_bytes=snapshot.tx_bytes,
                        bandwidth_mbps=snapshot.bandwidth_mbps,
                        agent_version=VERSION,
                        config_revision=revision,
                        sessions=[
                            agent_pb2.Session(**session) for session in snapshot.sessions
                        ],
                    ),
                    timeout=30,
                )
        except grpc.RpcError as exc:
            logger.warning("panel call failed: %s", exc.details() or exc.code())
        except Exception:  # noqa: BLE001 - the loop must survive anything
            logger.exception("unexpected error in the agent loop")

        for _ in range(cfg.interval):
            if not running:
                break
            time.sleep(1)


if __name__ == "__main__":
    run()
