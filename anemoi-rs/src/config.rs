//! Settings, read from the environment exactly as the Python agent did, so this
//! binary can replace it in the same container without touching the compose
//! file. On a router there is no compose file: the installer writes the same
//! variables to an env file, and anything set in the real environment wins.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Where the installer puts the settings on a router.
pub const DEFAULT_ENV_FILE: &str = "/etc/anemoi/anemoi.env";

#[derive(Debug, Clone)]
pub struct Config {
    /// gRPC endpoint of the panel, `host:port`.
    pub panel: String,
    /// TLS name presented to the panel's gRPC listener. Defaults to the host
    /// part of `panel`; set it when gRPC shares port 443 with the web panel and
    /// is told apart by SNI.
    pub panel_sni: String,
    /// Base URL of the panel's HTTP API, used to enrol.
    pub panel_api: String,
    /// Extra CA (PEM) trusted for the HTTP API, on top of the public roots
    /// built into the binary. For a panel without a public certificate.
    pub panel_ca: Option<PathBuf>,
    pub token: String,
    pub token_file: PathBuf,
    pub node_name: String,
    pub subnets: Vec<String>,
    pub wan_iface: String,
    pub state_dir: PathBuf,
    pub config_dir: PathBuf,
    pub status_file: PathBuf,
    pub transit_status_file: PathBuf,
    pub interval_secs: u64,
    pub restart_flag: PathBuf,
    pub log_level: String,

    /// Run the transit OpenVPN, the WebSocket bridge and the firewall rules
    /// ourselves (a router), instead of leaving them to the docker containers
    /// next to us.
    pub supervise: bool,
    /// openvpn binary; found in the usual places when empty.
    pub openvpn_bin: String,
    /// Name of the transit tunnel device; the firewall zone is bound to it.
    pub tun_dev: String,
    /// Host in transit.conf that means "the local wstunnel": docker's
    /// container name, replaced by our bridge on localhost.
    pub transit_ws_host: String,
    /// wstunnel's path prefix on the panel (Caddy routes /transit there).
    pub transit_path: String,
    /// Where wstunnel on the panel connects to: the hub's transit listener.
    pub transit_target: String,
}

impl Config {
    /// Settings from `env` (the process environment, normally), falling back to
    /// the env file, then to the defaults the Python agent used.
    pub fn load(env: &HashMap<String, String>) -> Config {
        let file_path = env
            .get("ANEMOI_ENV_FILE")
            .cloned()
            .unwrap_or_else(|| DEFAULT_ENV_FILE.to_string());
        let file = std::fs::read_to_string(&file_path)
            .map(|text| parse_env_file(&text))
            .unwrap_or_default();

        let get = |key: &str, default: &str| -> String {
            env.get(key)
                .or_else(|| file.get(key))
                .cloned()
                .unwrap_or_else(|| default.to_string())
        };

        let panel = get("ANEMOI_PANEL", "backend:50051");
        let panel_sni = match get("ANEMOI_PANEL_SNI", "") {
            sni if sni.is_empty() => host_part(&panel).to_string(),
            sni => sni,
        };
        let panel_ca = Some(get("ANEMOI_PANEL_CA", ""))
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);

        Config {
            panel_sni,
            panel_api: get("ANEMOI_PANEL_API", "http://backend:8000"),
            panel_ca,
            token: get("ANEMOI_ENROLLMENT_TOKEN", ""),
            token_file: get("ANEMOI_TOKEN_FILE", "/etc/openvpn/aeolus/.enrollment-token").into(),
            node_name: get("ANEMOI_NODE_NAME", ""),
            subnets: get("ANEMOI_SUBNETS", "")
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(String::from)
                .collect(),
            wan_iface: get("ANEMOI_WAN_IFACE", ""),
            state_dir: get("ANEMOI_STATE_DIR", "/var/lib/anemoi").into(),
            config_dir: get("ANEMOI_CONFIG_DIR", "/etc/openvpn/aeolus").into(),
            status_file: get("ANEMOI_STATUS_FILE", "/run/openvpn/status.log").into(),
            transit_status_file: get(
                "ANEMOI_TRANSIT_STATUS_FILE",
                "/run/openvpn/status-transit.log",
            )
            .into(),
            interval_secs: get("ANEMOI_INTERVAL", "15").parse().unwrap_or(15).max(1),
            restart_flag: get("ANEMOI_RESTART_FLAG", "/etc/openvpn/aeolus/.restart").into(),
            log_level: get("ANEMOI_LOG_LEVEL", "INFO"),
            supervise: matches!(
                get("ANEMOI_SUPERVISE", "").to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            ),
            openvpn_bin: get("ANEMOI_OPENVPN", ""),
            tun_dev: get("ANEMOI_TUN_DEV", "aeolus0"),
            transit_ws_host: get("ANEMOI_TRANSIT_WS_HOST", "wstunnel"),
            transit_path: get("ANEMOI_TRANSIT_PATH", "transit"),
            transit_target: get("ANEMOI_TRANSIT_TARGET", "openvpn:1195"),
            panel,
        }
    }

    pub fn status_path(&self) -> &Path {
        // The hub serves clients and writes status.log; every other node only
        // holds the transit tunnel, whose status lives in another file.
        if self.status_file.exists() {
            &self.status_file
        } else {
            &self.transit_status_file
        }
    }
}

/// `host` from `host:port`, keeping an IPv6 literal in brackets intact.
pub fn host_part(endpoint: &str) -> &str {
    match endpoint.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            host.trim_start_matches('[').trim_end_matches(']')
        }
        _ => endpoint,
    }
}

/// `KEY=value` lines; `#` comments, blank lines and optional quotes allowed.
pub fn parse_env_file(text: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        if let Some((key, value)) = line.split_once('=') {
            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value);
            values.insert(key.trim().to_string(), value.to_string());
        }
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_part_strips_port() {
        assert_eq!(host_part("panel.example.com:50051"), "panel.example.com");
        assert_eq!(host_part("[2001:db8::1]:443"), "2001:db8::1");
        assert_eq!(host_part("backend"), "backend");
    }

    #[test]
    fn env_file_parsing() {
        let parsed = parse_env_file(
            "# comment\nANEMOI_PANEL=a:1\nexport ANEMOI_NODE_NAME=\"home\"\n\nANEMOI_SUBNETS='192.168.1.0/24'\n",
        );
        assert_eq!(parsed["ANEMOI_PANEL"], "a:1");
        assert_eq!(parsed["ANEMOI_NODE_NAME"], "home");
        assert_eq!(parsed["ANEMOI_SUBNETS"], "192.168.1.0/24");
    }

    #[test]
    fn environment_wins_over_defaults() {
        let mut env = HashMap::new();
        env.insert("ANEMOI_ENV_FILE".into(), "/nonexistent".into());
        env.insert("ANEMOI_PANEL".into(), "vpn.example.com:443".into());
        env.insert(
            "ANEMOI_SUBNETS".into(),
            " 10.0.0.0/24, ,192.168.5.0/24".into(),
        );
        let cfg = Config::load(&env);
        assert_eq!(cfg.panel_sni, "vpn.example.com");
        assert_eq!(cfg.subnets, vec!["10.0.0.0/24", "192.168.5.0/24"]);
        assert_eq!(cfg.interval_secs, 15);
    }
}
