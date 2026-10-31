//! Getting from "nothing" to "holds a certificate", over the panel's HTTP API —
//! the one exchange that happens before the node has anything to present.
//!
//! Two ways in, as in the Python agent:
//! - a one-time token (the panel's own node, provisioned without a human);
//! - an announce: the node asks to join, prints the fingerprint, and waits for
//!   an operator to compare it with the panel's and accept.

use std::fs;
use std::io;
use std::time::Duration;

use log::{error, info, warn};
use serde::Deserialize;
use serde_json::json;

use crate::config::Config;
use crate::enrol::Enrolment;
use crate::{Result, VERSION};

/// HTTP client for the panel API, trusting what `tls::panel_client_config`
/// trusts.
pub fn http_client(cfg: &Config) -> Result<reqwest::Client> {
    let tls = crate::tls::panel_client_config(cfg)?;
    Ok(reqwest::Client::builder()
        .use_preconfigured_tls((*tls).clone())
        .timeout(Duration::from_secs(30))
        .user_agent(format!("anemoi/{VERSION}"))
        .build()?)
}

#[derive(Deserialize)]
struct AnnounceReply {
    poll_token: String,
    node_name: String,
    fingerprint: String,
}

#[derive(Deserialize)]
struct PollReply {
    status: String,
    cert_pem: Option<String>,
    ca_pem: Option<String>,
    node_name: Option<String>,
}

#[derive(Deserialize)]
struct EnrollReply {
    cert_pem: String,
    ca_pem: String,
    node_name: String,
}

enum Call<T> {
    Ok(T),
    /// The panel answered and said no.
    Refused(u16, String),
    /// The panel could not be reached at all.
    Unreachable(String),
}

async fn call<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    cfg: &Config,
    path: &str,
    body: Option<serde_json::Value>,
) -> Call<T> {
    let url = format!("{}{}", cfg.panel_api.trim_end_matches('/'), path);
    let request = match &body {
        Some(body) => client.post(&url).json(body),
        None => client.get(&url),
    };
    let response = match request.send().await {
        Ok(response) => response,
        Err(err) => return Call::Unreachable(format!("{url}: {}", error_chain(&err))),
    };
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let text: String = text.chars().take(200).collect();
        return Call::Refused(status.as_u16(), text);
    }
    match response.json::<T>().await {
        Ok(value) => Call::Ok(value),
        Err(err) => Call::Unreachable(format!("{url}: unexpected reply: {err}")),
    }
}

/// reqwest hides the useful part ("certificate unknown", "connection
/// refused") a few sources down.
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(inner) = source {
        parts.push(inner.to_string());
        source = inner.source();
    }
    parts.join(": ")
}

pub fn hostname() -> String {
    fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|name| name.trim().to_string())
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "node".to_string())
}

/// One pass. True once the node holds a certificate.
pub async fn join(cfg: &mut Config, enrolment: &Enrolment, client: &reqwest::Client) -> bool {
    if !cfg.token.is_empty() || cfg.token_file.exists() {
        // A token means the panel provisioned this node itself.
        return enroll_with_token(cfg, enrolment, client).await;
    }

    let mut token = fs::read_to_string(&enrolment.announce_path)
        .map(|t| t.trim().to_string())
        .unwrap_or_default();
    if token.is_empty() {
        match announce(cfg, enrolment, client).await {
            Some(fresh) => token = fresh,
            None => return false,
        }
    }
    collect(enrolment, client, cfg, &token).await
}

async fn announce(cfg: &Config, enrolment: &Enrolment, client: &reqwest::Client) -> Option<String> {
    let host = hostname();
    let name = if cfg.node_name.is_empty() {
        host.clone()
    } else {
        cfg.node_name.clone()
    };
    let csr_pem = match enrolment.create_csr(&name) {
        Ok(csr) => csr,
        Err(err) => {
            error!("cannot build a CSR: {err}");
            return None;
        }
    };
    let body = json!({
        "csr_pem": csr_pem,
        "name": name,
        "hostname": host,
        "wan_iface": cfg.wan_iface,
        "subnets": cfg.subnets,
        "agent_version": VERSION,
    });
    match call::<AnnounceReply>(client, cfg, "/api/v1/agents/announce", Some(body)).await {
        Call::Ok(reply) => {
            if let Err(err) = fs::write(&enrolment.announce_path, &reply.poll_token) {
                error!("cannot keep the join request: {err}");
            }
            warn!(
                "join request sent as {:?}. Accept it in the panel; the fingerprint must read:\n    {}",
                reply.node_name, reply.fingerprint
            );
            Some(reply.poll_token)
        }
        Call::Refused(code, text) => {
            error!("announce refused: {code} {text}");
            None
        }
        Call::Unreachable(why) => {
            error!("cannot reach the panel API: {why}");
            None
        }
    }
}

async fn collect(
    enrolment: &Enrolment,
    client: &reqwest::Client,
    cfg: &Config,
    token: &str,
) -> bool {
    let path = format!("/api/v1/agents/announce/{token}");
    match call::<PollReply>(client, cfg, &path, None).await {
        Call::Ok(reply) => {
            let (Some(cert), Some(ca), Some(name)) =
                (&reply.cert_pem, &reply.ca_pem, &reply.node_name)
            else {
                info!("waiting to be accepted (state: {})", reply.status);
                return false;
            };
            if reply.status != "approved" || cert.is_empty() {
                info!("waiting to be accepted (state: {})", reply.status);
                return false;
            }
            match enrolment.save(cert, ca, name) {
                Ok(()) => {
                    warn!("accepted as node {name:?}");
                    true
                }
                Err(err) => {
                    error!("cannot store the certificate: {err}");
                    false
                }
            }
        }
        Call::Refused(code, _) => {
            if code == 404 {
                // The panel forgot the request; ask again next time.
                let _ = fs::remove_file(&enrolment.announce_path);
            }
            warn!("poll refused: {code}");
            false
        }
        Call::Unreachable(why) => {
            warn!("cannot reach the panel API: {why}");
            false
        }
    }
}

async fn enroll_with_token(
    cfg: &mut Config,
    enrolment: &Enrolment,
    client: &reqwest::Client,
) -> bool {
    if cfg.token.is_empty() {
        cfg.token = fs::read_to_string(&cfg.token_file)
            .map(|t| t.trim().to_string())
            .unwrap_or_default();
    }
    if cfg.token.is_empty() {
        return false;
    }
    let csr_pem = match enrolment.create_csr("pending") {
        Ok(csr) => csr,
        Err(err) => {
            error!("cannot build a CSR: {err}");
            return false;
        }
    };
    let body = json!({"token": cfg.token, "csr_pem": csr_pem, "agent_version": VERSION});
    match call::<EnrollReply>(client, cfg, "/api/v1/agents/enroll", Some(body)).await {
        Call::Ok(reply) => {
            if let Err(err) = enrolment.save(&reply.cert_pem, &reply.ca_pem, &reply.node_name) {
                error!("cannot store the certificate: {err}");
                return false;
            }
            // The token is spent; leaving it on disk only widens the window
            // for reuse.
            match fs::remove_file(&cfg.token_file) {
                Err(err) if err.kind() != io::ErrorKind::NotFound => {
                    warn!("cannot remove the spent token: {err}")
                }
                _ => {}
            }
            info!("enrolled as node {:?}", reply.node_name);
            true
        }
        Call::Refused(code, text) => {
            error!("enrolment refused: {code} {text}");
            false
        }
        Call::Unreachable(why) => {
            error!("cannot reach the panel API: {why}");
            false
        }
    }
}
