"""anemoi — the node agent.

Runs next to OpenVPN on every node, including the panel's own. It dials the
panel, so a node needs no inbound port beyond OpenVPN itself.

Loop: pull configuration, write it to disk when the revision changed, restart
OpenVPN if the server config itself changed, then report what OpenVPN is doing.
"""

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
    state_dir: Path = Path(os.environ.get("ANEMOI_STATE_DIR", "/var/lib/anemoi"))
    config_dir: Path = Path(os.environ.get("ANEMOI_CONFIG_DIR", "/etc/openvpn/aeolus"))
    status_file: Path = Path(
        os.environ.get("ANEMOI_STATUS_FILE", "/run/openvpn/status.log")
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
        key = ec.generate_private_key(ec.SECP256R1())
        self.key_path.parent.mkdir(parents=True, exist_ok=True)
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


def enroll(cfg: Config, enrolment: Enrolment) -> None:
    """Trade the one-time token for a certificate over the panel's HTTPS API.

    This is the only exchange that happens before the agent has credentials, so
    it deliberately does not use the gRPC endpoint: that one is signed by the
    Aeolus CA, which a fresh node has no way to verify yet.
    """
    if not cfg.token and cfg.token_file.exists():
        cfg.token = cfg.token_file.read_text().strip()

    if not cfg.token:
        logger.error(
            "no certificate yet and no enrolment token; issue one for this node "
            "in the panel and pass it as ANEMOI_ENROLLMENT_TOKEN"
        )
        sys.exit(1)

    csr_pem = enrolment.create_csr()
    body = json.dumps(
        {"token": cfg.token, "csr_pem": csr_pem, "agent_version": VERSION}
    ).encode()

    request = urllib.request.Request(
        f"{cfg.panel_api.rstrip('/')}/api/v1/agents/enroll",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        logger.error("enrolment refused: %s %s", exc.code, exc.read().decode()[:200])
        sys.exit(1)
    except OSError as exc:
        logger.error("cannot reach the panel API at %s: %s", cfg.panel_api, exc)
        sys.exit(1)

    enrolment.save(payload["cert_pem"], payload["ca_pem"], payload["node_name"])
    # The token is spent; leaving it on disk only widens the window for reuse.
    cfg.token_file.unlink(missing_ok=True)
    logger.info("enrolled as node %r", payload["node_name"])


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
    ccd_dir = cfg.config_dir / "ccd"
    ccd_dir.mkdir(exist_ok=True)

    server_conf = cfg.config_dir / "server.conf"
    restart_needed = (
        not server_conf.exists() or server_conf.read_text() != response.server_conf
    )

    files = {
        "server.conf": response.server_conf,
        "ca.crt": response.ca_pem,
        "server.crt": response.server_cert_pem,
        "server.key": response.server_key_pem,
        "tls-crypt.key": response.tls_crypt_key,
        "crl.pem": response.crl_pem,
    }
    for name, content in files.items():
        path = cfg.config_dir / name
        if path.exists() and path.read_text() == content:
            continue
        path.write_text(content)
        path.chmod(0o600 if name in {"server.key", "tls-crypt.key"} else 0o644)

    # A stale ccd entry would keep granting access after the panel took it away.
    wanted = set(response.ccd)
    for existing in ccd_dir.iterdir():
        if existing.is_file() and existing.name not in wanted:
            existing.unlink()
    for common_name, body in response.ccd.items():
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
        enroll(cfg, enrolment)

    running = True

    def stop(signum, _frame):
        nonlocal running
        logger.info("signal %s received, stopping", signum)
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    revision = ""
    revision_file = cfg.config_dir / ".revision"
    if revision_file.exists():
        revision = revision_file.read_text().strip()

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

                snapshot = status_parser.read(cfg.status_file)
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
