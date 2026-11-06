//! Reading OpenVPN's status file (status-version 1), as the Python agent did.
//!
//! A server writes a CLIENT LIST, a ROUTING TABLE mapping virtual addresses to
//! common names, then global stats. A client-mode instance — what a node runs
//! for the transit tunnel — writes a short "OpenVPN STATISTICS" block instead.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::pb;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Snapshot {
    pub running: bool,
    pub message: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub bandwidth_mbps: u32,
    pub sessions: Vec<pb::Session>,
}

/// Counters are cumulative, so throughput is derived between two reads.
#[derive(Default)]
pub struct Reader {
    previous: Option<(Instant, u64)>,
}

impl Reader {
    pub fn read(&mut self, path: &Path) -> Snapshot {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Snapshot {
                    message: "OpenVPN не пишет status.log".into(),
                    ..Default::default()
                };
            }
            Err(err) => {
                return Snapshot {
                    message: format!("не читается status.log: {err}"),
                    ..Default::default()
                };
            }
        };
        let mut snapshot = parse(&text);
        snapshot.bandwidth_mbps =
            self.throughput(snapshot.rx_bytes + snapshot.tx_bytes, Instant::now());
        snapshot
    }

    fn throughput(&mut self, total: u64, now: Instant) -> u32 {
        let previous = self.previous.replace((now, total));
        let Some((then, before)) = previous else {
            return 0;
        };
        let elapsed = now.duration_since(then).as_secs_f64();
        if elapsed <= 0.0 {
            return 0;
        }
        // A restart resets the counters; a decrease is a fresh start.
        let delta = total.saturating_sub(before) as f64;
        (delta * 8.0 / elapsed / 1_000_000.0) as u32
    }
}

/// OpenVPN rewrites its status file every 5 seconds while it runs (see
/// `patch_transit`), so anything much older means it stopped or is pausing
/// between reconnects.
const TRANSIT_STATUS_MAX_AGE: Duration = Duration::from_secs(30);

/// Whether the transit really carries data. The tun device proves nothing, since
/// persist-tun keeps it through an outage. "Auth read bytes" counts what passed
/// the data channel's authentication since the last restart, and the hub's
/// keepalives alone move it within seconds.
pub fn transit_alive(path: &Path) -> bool {
    let age = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok());
    match (std::fs::read_to_string(path), age) {
        (Ok(text), Some(age)) => stats_show_traffic(&text, age),
        _ => false,
    }
}

fn stats_show_traffic(text: &str, age: Duration) -> bool {
    age <= TRANSIT_STATUS_MAX_AGE
        && text.starts_with("OpenVPN STATISTICS")
        && text
            .lines()
            .find_map(|line| line.strip_prefix("Auth read bytes,"))
            .and_then(|bytes| bytes.trim().parse::<u64>().ok())
            .is_some_and(|bytes| bytes > 0)
}

pub fn parse(text: &str) -> Snapshot {
    let lines: Vec<&str> = text.lines().collect();
    if lines
        .first()
        .is_some_and(|l| l.starts_with("OpenVPN STATISTICS"))
    {
        return parse_client_stats(&lines);
    }

    let mut sessions: Vec<pb::Session> = Vec::new();
    let mut routes: HashMap<&str, &str> = HashMap::new();
    let mut section = "";

    for line in &lines {
        if line.starts_with("OpenVPN CLIENT LIST") {
            section = "clients";
            continue;
        }
        if line.starts_with("ROUTING TABLE") {
            section = "routes";
            continue;
        }
        if line.starts_with("GLOBAL STATS") || *line == "END" {
            section = "";
            continue;
        }
        let parts: Vec<&str> = line.split(',').collect();
        match section {
            "clients" if parts.len() >= 5 && parts[0] != "Common Name" => {
                sessions.push(pb::Session {
                    common_name: parts[0].into(),
                    real_address: parts[1].into(),
                    virtual_address: String::new(),
                    rx_bytes: parts[2].parse().unwrap_or(0),
                    tx_bytes: parts[3].parse().unwrap_or(0),
                    connected_since: parts[4].into(),
                })
            }
            "routes" if parts.len() >= 2 && parts[0] != "Virtual Address" => {
                routes.insert(parts[1], parts[0]);
            }
            _ => {}
        }
    }

    for session in &mut sessions {
        if let Some(address) = routes.get(session.common_name.as_str()) {
            session.virtual_address = address.to_string();
        }
    }

    Snapshot {
        running: true,
        rx_bytes: sessions.iter().map(|s| s.rx_bytes).sum(),
        tx_bytes: sessions.iter().map(|s| s.tx_bytes).sum(),
        sessions,
        ..Default::default()
    }
}

fn parse_client_stats(lines: &[&str]) -> Snapshot {
    let mut counters: HashMap<&str, u64> = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(',')
            && let Ok(value) = value.trim().parse()
        {
            counters.insert(name.trim(), value);
        }
    }
    Snapshot {
        running: true,
        rx_bytes: counters.get("TCP/UDP read bytes").copied().unwrap_or(0),
        tx_bytes: counters.get("TCP/UDP write bytes").copied().unwrap_or(0),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn transit_stats(auth_read: u64) -> String {
        format!(
            "OpenVPN STATISTICS\nUpdated,2026-11-06 19:33:50\nTUN/TAP read bytes,0\n\
             TCP/UDP read bytes,900\nAuth read bytes,{auth_read}\nEND\n"
        )
    }

    #[test]
    fn a_transit_is_alive_only_with_fresh_authenticated_traffic() {
        let fresh = Duration::from_secs(5);
        assert!(stats_show_traffic(&transit_stats(11820), fresh));
        // Connected to the bridge, but the data channel never came up.
        assert!(!stats_show_traffic(&transit_stats(0), fresh));
        // OpenVPN stopped or is pausing before a reconnect.
        assert!(!stats_show_traffic(
            &transit_stats(11820),
            Duration::from_secs(300)
        ));
        assert!(!stats_show_traffic("OpenVPN CLIENT LIST\nEND\n", fresh));
    }

    #[test]
    fn a_missing_status_file_is_not_a_live_transit() {
        assert!(!transit_alive(Path::new("/nonexistent/status.log")));
    }

    const SERVER: &str = "OpenVPN CLIENT LIST
Updated,2026-10-31 11:00:00
Common Name,Real Address,Bytes Received,Bytes Sent,Connected Since
st4v3r,188.64.1.2:51234,1000,5000,2026-10-31 10:00:00
masha,10.0.0.9:1194,200,300,2026-10-31 10:30:00
ROUTING TABLE
Virtual Address,Common Name,Real Address,Last Ref
10.20.0.2,st4v3r,188.64.1.2:51234,2026-10-31 11:00:00
10.20.0.7,masha,10.0.0.9:1194,2026-10-31 11:00:00
GLOBAL STATS
Max bcast/mcast queue length,0
END
";

    const CLIENT: &str = "OpenVPN STATISTICS
Updated,2026-10-31 11:00:00
TUN/TAP read bytes,123
TUN/TAP write bytes,456
TCP/UDP read bytes,7890
TCP/UDP write bytes,1234
Auth read bytes,456
END
";

    #[test]
    fn server_sessions_with_addresses() {
        let snapshot = parse(SERVER);
        assert!(snapshot.running);
        assert_eq!(snapshot.sessions.len(), 2);
        assert_eq!(snapshot.sessions[0].common_name, "st4v3r");
        assert_eq!(snapshot.sessions[0].virtual_address, "10.20.0.2");
        assert_eq!(snapshot.sessions[1].virtual_address, "10.20.0.7");
        assert_eq!(snapshot.rx_bytes, 1200);
        assert_eq!(snapshot.tx_bytes, 5300);
    }

    #[test]
    fn client_mode_counters() {
        let snapshot = parse(CLIENT);
        assert!(snapshot.running);
        assert!(snapshot.sessions.is_empty());
        assert_eq!(snapshot.rx_bytes, 7890);
        assert_eq!(snapshot.tx_bytes, 1234);
    }

    #[test]
    fn throughput_between_reads() {
        let mut reader = Reader::default();
        let start = Instant::now();
        assert_eq!(reader.throughput(0, start), 0);
        // 12.5 MB in one second is 100 Mbit/s.
        assert_eq!(
            reader.throughput(12_500_000, start + Duration::from_secs(1)),
            100
        );
        // Counters reset by a restart: no negative throughput.
        assert_eq!(reader.throughput(10, start + Duration::from_secs(2)), 0);
    }

    #[test]
    fn missing_file_is_not_running() {
        let snapshot = Reader::default().read(Path::new("/nonexistent/status.log"));
        assert!(!snapshot.running);
        assert!(!snapshot.message.is_empty());
    }
}
