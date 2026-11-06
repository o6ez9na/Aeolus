//! Running the transit tunnel on a machine without the docker supervisor —
//! a router, typically.
//!
//! In docker, an OpenVPN container watches the `.restart` flag and a wstunnel
//! container carries the tunnel over WebSocket. Here the agent does both:
//! it starts OpenVPN itself, restarts it when the panel changes its config or
//! when it dies, runs the WebSocket bridge, and keeps the firewall in step
//! with the subnets the hub sends over.
//!
//! The panel writes transit.conf for docker (`dev tun`, `remote wstunnel`,
//! status under /run/openvpn). A copy adjusted for this machine is what
//! OpenVPN actually runs, so the panel does not need to know where its node
//! lives.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use log::{error, info, warn};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpSocket;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

use crate::Result;
use crate::config::Config;
use crate::firewall::{self, Firewall};
use crate::fsutil::write_if_changed;
use crate::wsbridge::Bridge;

pub struct Supervisor {
    cfg: Config,
    firewall: Box<dyn Firewall>,
    child: Option<Child>,
    bridge: Option<(u16, JoinHandle<()>)>,
    applied_plan: Option<firewall::Plan>,
    next_start: Instant,
    backoff: Duration,
    /// Set by the log reader when OpenVPN's data channel offload fails.
    dco_failed: Arc<AtomicBool>,
    /// Once it has failed, OpenVPN runs without DCO for the rest of our life.
    dco_disabled: bool,
}

/// Whether an OpenVPN log line says DCO cannot work here. OpenVPN 2.7 turns
/// DCO on by itself where the kernel has it, and a container (or a kernel
/// that refuses the netlink calls) then fails on every connect without ever
/// exiting.
pub fn dco_failure(line: &str) -> bool {
    let line = line.to_ascii_lowercase();
    line.contains("dco")
        && (line.contains("operation not permitted")
            || line.contains("cannot add peer")
            || line.contains("failed to"))
}

/// How the panel's transit.conf has to change to run here.
#[derive(Debug, PartialEq)]
pub struct Patched {
    pub text: String,
    /// Local port OpenVPN dials when the tunnel goes over WebSocket.
    pub bridge_port: Option<u16>,
}

pub fn patch_transit(original: &str, dev: &str, status_file: &Path, ws_host: &str) -> Patched {
    let mut bridge_port = None;
    let mut lines = Vec::new();
    for line in original.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        match words.as_slice() {
            // A fixed name: the firewall zone is bound to it, and a router may
            // run other tunnels that took tun0 first.
            ["dev", ..] => {
                lines.push(format!("dev {dev}"));
                lines.push("dev-type tun".into());
            }
            ["status", _path, rest @ ..] => {
                lines.push(
                    format!("status {} {}", status_file.display(), rest.join(" "))
                        .trim_end()
                        .to_string(),
                );
            }
            // docker's wstunnel container: here the bridge listens on localhost.
            ["remote", host, port, rest @ ..] if *host == ws_host => {
                bridge_port = port.parse().ok();
                lines.push(
                    format!("remote 127.0.0.1 {port} {}", rest.join(" "))
                        .trim_end()
                        .to_string(),
                );
            }
            _ => lines.push(line.to_string()),
        }
    }
    Patched {
        text: lines.join("\n") + "\n",
        bridge_port,
    }
}

/// Entware first: a Keenetic with the firmware's OpenVPN component also has a
/// /usr/sbin/openvpn, patched to report to the router's core, and it exits with
/// "Unable to communicate with NDM core" when run by anything else.
const OPENVPN_PATHS: [&str; 4] = [
    "/opt/sbin/openvpn",
    "/usr/sbin/openvpn",
    "/usr/local/sbin/openvpn",
    "/sbin/openvpn",
];

pub fn find_openvpn(configured: &str) -> Option<PathBuf> {
    if !configured.is_empty() {
        return Some(PathBuf::from(configured));
    }
    OPENVPN_PATHS.iter().map(PathBuf::from).find(|p| p.exists())
}

impl Supervisor {
    pub fn new(cfg: Config) -> Supervisor {
        let firewall = firewall::detect();
        info!("supervising OpenVPN here; firewall via {}", firewall.name());
        Supervisor {
            cfg,
            firewall,
            child: None,
            bridge: None,
            applied_plan: None,
            next_start: Instant::now(),
            backoff: Duration::from_secs(2),
            dco_failed: Arc::new(AtomicBool::new(false)),
            dco_disabled: false,
        }
    }

    fn transit_conf(&self) -> PathBuf {
        self.cfg.config_dir.join("transit.conf")
    }

    fn run_conf(&self) -> PathBuf {
        self.cfg.config_dir.join("transit.run.conf")
    }

    /// Bring what runs in line with what is on disk. `restart` is set when the
    /// panel changed the tunnel's config.
    pub async fn reconcile(&mut self, mut restart: bool) {
        if let Err(err) = self.reconcile_inner(&mut restart).await {
            error!("supervisor: {err}");
        }
    }

    async fn reconcile_inner(&mut self, restart: &mut bool) -> Result<()> {
        let Ok(original) = std::fs::read_to_string(self.transit_conf()) else {
            // No tunnel for this node (yet, or any more).
            self.stop_openvpn().await;
            return Ok(());
        };

        let patched = patch_transit(
            &original,
            &self.cfg.tun_dev,
            &self.cfg.transit_status_file,
            &self.cfg.transit_ws_host,
        );
        if let Some(dir) = self.cfg.transit_status_file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        *restart |= write_if_changed(&self.run_conf(), patched.text.as_bytes(), 0o644)?;

        self.ensure_bridge(patched.bridge_port).await?;
        self.sync_firewall()?;

        if !self.dco_disabled && self.dco_failed.load(Ordering::Relaxed) {
            warn!("OpenVPN cannot use DCO here; running it without (--disable-dco)");
            self.dco_disabled = true;
            *restart = true;
        }

        if let Some(child) = self.child.as_mut() {
            if let Some(status) = child.try_wait()? {
                warn!("OpenVPN transit exited ({status}), restarting");
                self.child = None;
                self.next_start = Instant::now() + self.backoff;
                self.backoff = (self.backoff * 2).min(Duration::from_secs(60));
            } else if *restart {
                info!("transit config changed, restarting OpenVPN");
                self.stop_openvpn().await;
            }
        }
        if self.child.is_none() && Instant::now() >= self.next_start {
            self.start_openvpn()?;
        }
        Ok(())
    }

    fn start_openvpn(&mut self) -> Result<()> {
        let openvpn = find_openvpn(&self.cfg.openvpn_bin).ok_or(
            "openvpn is not installed (looked in /opt/sbin, /usr/sbin, /usr/local/sbin, /sbin)",
        )?;
        firewall::ensure_forwarding();
        let mut command = Command::new(&openvpn);
        command
            .arg("--config")
            .arg(self.run_conf())
            .arg("--cd")
            .arg(&self.cfg.config_dir);
        if self.dco_disabled {
            command.arg("--disable-dco");
        }
        let mut child = command
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| format!("cannot start {}: {err}", openvpn.display()))?;
        info!("started OpenVPN transit (pid {})", child.id().unwrap_or(0));

        // OpenVPN's log goes on to ours unchanged; on the way we watch for the
        // one failure it never recovers from by itself.
        if let Some(stdout) = child.stdout.take() {
            let dco_failed = self.dco_failed.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if dco_failure(&line) {
                        dco_failed.store(true, Ordering::Relaxed);
                    }
                    eprintln!("{line}");
                }
            });
        }
        self.child = Some(child);
        Ok(())
    }

    pub async fn stop_openvpn(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if let Some(pid) = child.id() {
            // SIGTERM, so OpenVPN takes its tun device and routes down cleanly.
            unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        }
        if tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .is_err()
        {
            warn!("OpenVPN did not stop in time, killing it");
            let _ = child.kill().await;
        }
        // A deliberate restart is not a crash: start again right away.
        self.next_start = Instant::now();
        self.backoff = Duration::from_secs(2);
    }

    async fn ensure_bridge(&mut self, port: Option<u16>) -> Result<()> {
        match (port, &self.bridge) {
            (Some(want), Some((have, _))) if want == *have => return Ok(()),
            (None, None) => return Ok(()),
            _ => {}
        }
        if let Some((_, handle)) = self.bridge.take() {
            handle.abort();
        }
        let Some(port) = port else { return Ok(()) };

        let url = &self.cfg.panel_api;
        let (host, panel_port) = split_https_url(url).ok_or_else(|| {
            format!(
                "ANEMOI_PANEL_API {url:?} is not an https:// URL; the WebSocket transit needs one"
            )
        })?;
        let (target_host, target_port) = self
            .cfg
            .transit_target
            .rsplit_once(':')
            .and_then(|(h, p)| Some((h.to_string(), p.parse().ok()?)))
            .ok_or("ANEMOI_TRANSIT_TARGET must be host:port")?;
        let bridge = Bridge {
            panel_host: host,
            panel_port,
            path_prefix: self.cfg.transit_path.clone(),
            target_host,
            target_port,
            tls: crate::tls::panel_client_config(&self.cfg)?,
        };
        // SO_REUSEADDR: connections from the previous run linger in TIME_WAIT
        // on this port for a minute, and the tunnel should not wait for them.
        let socket = TcpSocket::new_v4()?;
        socket.set_reuseaddr(true)?;
        socket.bind((std::net::Ipv4Addr::LOCALHOST, port).into())?;
        let listener = socket.listen(16)?;
        info!("transit goes over WebSocket: OpenVPN dials 127.0.0.1:{port}, carried to {url}");
        self.bridge = Some((port, tokio::spawn(bridge.serve(listener))));
        Ok(())
    }

    fn sync_firewall(&mut self) -> Result<()> {
        let plan = firewall::Plan::read(&self.cfg.config_dir, &self.cfg.subnets);
        if self.applied_plan.as_ref() == Some(&plan) {
            return Ok(());
        }
        if plan.is_empty() {
            self.firewall.clear()?;
        } else {
            self.firewall.apply(&plan, &self.cfg.tun_dev)?;
        }
        self.applied_plan = Some(plan);
        Ok(())
    }

    pub async fn shutdown(&mut self) {
        self.stop_openvpn().await;
        if let Some((_, handle)) = self.bridge.take() {
            handle.abort();
        }
    }
}

/// `https://host[:port][/...]` → (host, port).
fn split_https_url(url: &str) -> Option<(String, u16)> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split('/').next()?;
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.ends_with(']') || authority.starts_with('[') => Some((
            host.trim_matches(['[', ']']).to_string(),
            port.parse().ok()?,
        )),
        _ => Some((authority.to_string(), 443)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entware_openvpn_comes_before_the_firmware_one() {
        let at = |path| OPENVPN_PATHS.iter().position(|p| *p == path).unwrap();
        assert!(at("/opt/sbin/openvpn") < at("/usr/sbin/openvpn"));
    }

    const OBFUSCATED: &str = "# Aeolus transit · node home (через WebSocket)
client
dev tun
proto tcp-client
remote wstunnel 1195 tcp
resolv-retry infinite
status /run/openvpn/status-transit.log 5
verb 3
";

    #[test]
    fn websocket_transit_is_pointed_at_the_local_bridge() {
        let p = patch_transit(
            OBFUSCATED,
            "aeolus0",
            Path::new("/var/run/anemoi/status-transit.log"),
            "wstunnel",
        );
        assert_eq!(p.bridge_port, Some(1195));
        assert!(p.text.contains("\nremote 127.0.0.1 1195 tcp\n"));
        assert!(p.text.contains("\ndev aeolus0\ndev-type tun\n"));
        assert!(
            p.text
                .contains("\nstatus /var/run/anemoi/status-transit.log 5\n")
        );
        assert!(!p.text.contains("wstunnel 1195"));
    }

    #[test]
    fn direct_transit_keeps_its_remote() {
        let direct = OBFUSCATED.replace(
            "remote wstunnel 1195 tcp",
            "remote vpn.example.com 1195 udp",
        );
        let p = patch_transit(&direct, "aeolus0", Path::new("/tmp/s.log"), "wstunnel");
        assert_eq!(p.bridge_port, None);
        assert!(p.text.contains("\nremote vpn.example.com 1195 udp\n"));
    }

    #[test]
    fn dco_failures_are_recognised() {
        assert!(dco_failure(
            "2026-10-31 12:01:51 Cannot add peer to DCO: Operation not permitted (-1)"
        ));
        assert!(dco_failure(
            "dco_new_peer: netlink reports error (-28): Operation not permitted"
        ));
        assert!(!dco_failure("2026-10-31 12:01:51 DCO device tun0 opened"));
        assert!(!dco_failure("Initialization Sequence Completed"));
    }

    #[test]
    fn https_urls() {
        assert_eq!(
            split_https_url("https://panel.example.com"),
            Some(("panel.example.com".into(), 443))
        );
        assert_eq!(
            split_https_url("https://panel.example.com:8443/x"),
            Some(("panel.example.com".into(), 8443))
        );
        assert_eq!(split_https_url("http://panel"), None);
    }
}
