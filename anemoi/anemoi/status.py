"""Read OpenVPN's status file.

Format (status-version 1): a CLIENT LIST section, a ROUTING TABLE that maps
virtual addresses to common names, then global stats.
"""

import time
from dataclasses import dataclass, field
from pathlib import Path

# Counters are cumulative per session, so throughput is derived between reads.
_previous: dict[str, tuple[float, int, int]] = {}


@dataclass
class Snapshot:
    running: bool = False
    message: str = ""
    rx_bytes: int = 0
    tx_bytes: int = 0
    bandwidth_mbps: int = 0
    sessions: list[dict] = field(default_factory=list)


def read(path: Path) -> Snapshot:
    if not path.exists():
        return Snapshot(running=False, message="OpenVPN не пишет status.log")

    try:
        lines = path.read_text().splitlines()
    except OSError as exc:
        return Snapshot(running=False, message=f"не читается status.log: {exc}")

    sessions: list[dict] = []
    routes: dict[str, str] = {}
    section = ""

    for line in lines:
        if line.startswith("OpenVPN CLIENT LIST"):
            section = "clients"
            continue
        if line.startswith("ROUTING TABLE"):
            section = "routes"
            continue
        if line.startswith("GLOBAL STATS") or line == "END":
            section = ""
            continue

        parts = line.split(",")
        if section == "clients" and len(parts) >= 5 and parts[0] != "Common Name":
            sessions.append(
                {
                    "common_name": parts[0],
                    "real_address": parts[1],
                    "virtual_address": "",
                    "rx_bytes": int(parts[2]) if parts[2].isdigit() else 0,
                    "tx_bytes": int(parts[3]) if parts[3].isdigit() else 0,
                    "connected_since": parts[4],
                }
            )
        elif section == "routes" and len(parts) >= 2 and parts[0] != "Virtual Address":
            routes[parts[1]] = parts[0]

    for session in sessions:
        session["virtual_address"] = routes.get(session["common_name"], "")

    rx = sum(s["rx_bytes"] for s in sessions)
    tx = sum(s["tx_bytes"] for s in sessions)

    return Snapshot(
        running=True,
        rx_bytes=rx,
        tx_bytes=tx,
        bandwidth_mbps=_throughput_mbps(rx, tx),
        sessions=sessions,
    )


def _throughput_mbps(rx: int, tx: int) -> int:
    """Bits per second between two reads, as megabits."""
    now = time.monotonic()
    previous = _previous.get("total")
    _previous["total"] = (now, rx, tx)

    if previous is None:
        return 0

    elapsed = now - previous[0]
    if elapsed <= 0:
        return 0

    # A restart resets the counters; treat a decrease as a fresh start.
    delta = max(0, (rx + tx) - (previous[1] + previous[2]))
    return int(delta * 8 / elapsed / 1_000_000)
