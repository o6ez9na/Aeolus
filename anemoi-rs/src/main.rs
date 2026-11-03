//! anemoi — the Aeolus node agent.
//!
//! Runs next to OpenVPN on every node. It dials the panel, so a node needs no
//! inbound port. Loop: pull the configuration, write it when the revision
//! changed, ask for an OpenVPN restart when a server config changed, report
//! what OpenVPN is doing.

mod apply;
mod config;
mod enrol;
mod firewall;
mod fsutil;
mod gost;
mod install;
mod join;
mod logger;
mod status;
mod supervisor;
mod tls;
mod wsbridge;

use std::collections::HashMap;
use std::time::Duration;

use log::{error, info, warn};
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Endpoint, Identity};

use crate::config::Config;
use crate::enrol::Enrolment;
use crate::pb::node_agent_client::NodeAgentClient;
use crate::supervisor::Supervisor;

pub mod pb {
    tonic::include_proto!("aeolus.anemoi.v1");
}

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, BoxError>;

const USAGE: &str = "usage: anemoi [run | install | uninstall | doctor | fingerprint | version]

  run          enrol if needed, then keep OpenVPN in sync with the panel (default)
  install      set this machine up as a node: packages, settings, service
                 --panel DOMAIN  --name NAME  --subnets CIDR,...  --panel-ca FILE
                 --grpc-port N  --sni NAME  --token TOKEN  --no-start
  uninstall    remove what install added (--purge: the node's key and settings too)
  doctor       check that everything a node needs is in place
  fingerprint  print this node's key fingerprint, as the panel shows it
  version      print the version

Settings come from ANEMOI_* environment variables, or from
/etc/anemoi/anemoi.env (ANEMOI_ENV_FILE to point elsewhere).";

fn main() {
    let command = std::env::args().nth(1).unwrap_or_else(|| "run".into());
    let env: HashMap<String, String> = std::env::vars().collect();
    let cfg = Config::load(&env);
    logger::init(&cfg.log_level);

    // One crypto backend for every TLS connection, chosen because it builds
    // for every router target.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let code = match command.as_str() {
        "run" => runtime().block_on(run(cfg)),
        "install" => install::install(&std::env::args().skip(2).collect::<Vec<_>>()),
        "uninstall" => install::uninstall(&std::env::args().skip(2).collect::<Vec<_>>()),
        "doctor" => install::doctor(),
        "firewall-apply" => firewall_apply(&cfg),
        "fingerprint" => match Enrolment::new(&cfg.state_dir).fingerprint() {
            Ok(fp) => {
                println!("{fp}");
                0
            }
            Err(err) => {
                eprintln!(
                    "cannot read or create the key in {}: {err}",
                    cfg.state_dir.display()
                );
                1
            }
        },
        "version" | "--version" | "-V" => {
            println!("anemoi {VERSION}");
            0
        }
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            0
        }
        other => {
            eprintln!("unknown command {other:?}\n\n{USAGE}");
            2
        }
    };
    std::process::exit(code);
}

/// Put the firewall rules back from what is on disk: for platforms that wipe
/// them behind our back (Keenetic's netfilter.d hook calls this).
fn firewall_apply(cfg: &Config) -> i32 {
    let plan = firewall::Plan::read(&cfg.config_dir, &cfg.subnets);
    if plan.is_empty() {
        return 0;
    }
    match firewall::detect().apply(&plan, &cfg.tun_dev) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("firewall: {err}");
            1
        }
    }
}

fn runtime() -> tokio::runtime::Runtime {
    // A single thread: the agent mostly sleeps, and a router has a core or two
    // that OpenVPN needs more.
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
}

/// Resolves on SIGTERM or SIGINT.
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => info!("SIGTERM received, stopping"),
        _ = int.recv() => info!("SIGINT received, stopping"),
    }
}

async fn run(mut cfg: Config) -> i32 {
    if let Err(err) = std::fs::create_dir_all(&cfg.state_dir) {
        error!(
            "cannot create the state directory {}: {err}",
            cfg.state_dir.display()
        );
        return 1;
    }
    let enrolment = Enrolment::new(&cfg.state_dir);
    let http = match join::http_client(&cfg) {
        Ok(client) => client,
        Err(err) => {
            error!("cannot set up HTTPS to the panel: {err}");
            return 1;
        }
    };
    info!(
        "anemoi {VERSION} starting, panel {} (TLS name {})",
        cfg.panel, cfg.panel_sni
    );

    let interval = Duration::from_secs(cfg.interval_secs);
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    // Nothing else can happen until an operator accepts this node, so keep
    // asking rather than exiting and losing the request.
    while !enrolment.complete() {
        if join::join(&mut cfg, &enrolment, &http).await {
            break;
        }
        tokio::select! {
            _ = &mut shutdown => return 0,
            _ = tokio::time::sleep(interval) => {}
        }
    }

    let mut client = None;
    // Deliberately not seeded from the .revision file: that says what was last
    // applied, not what is on disk now. The first pull after a start is always
    // a full one.
    let mut revision = String::new();
    let mut reader = status::Reader::default();
    let mut supervisor = cfg.supervise.then(|| Supervisor::new(cfg.clone()));

    loop {
        if client.is_none() {
            match connect(&cfg, &enrolment) {
                Ok(fresh) => client = Some(fresh),
                Err(err) => error!("cannot set up the channel to the panel: {err}"),
            }
        }

        let mut restart = false;
        if let Some(stub) = client.as_mut() {
            match pull_config(&cfg, stub, &mut revision).await {
                Ok(changed) => restart = changed,
                Err(err) => warn!("panel call failed: {err}"),
            }
        }
        match supervisor.as_mut() {
            // Also when the panel is unreachable: the tunnel runs on the
            // config already on disk, and a dead OpenVPN is restarted anyway.
            Some(supervisor) => supervisor.reconcile(restart).await,
            None if restart => {
                if let Err(err) = request_openvpn_restart(&cfg) {
                    error!("cannot ask for an OpenVPN restart: {err}");
                }
            }
            None => {}
        }
        if let Some(stub) = client.as_mut()
            && let Err(err) = report_status(&cfg, stub, &revision, &mut reader).await
        {
            warn!("status report failed: {err}");
        }

        tokio::select! {
            _ = &mut shutdown => break,
            _ = tokio::time::sleep(interval) => {}
        }
    }
    if let Some(supervisor) = supervisor.as_mut() {
        supervisor.shutdown().await;
    }
    0
}

/// A lazily connected channel: a panel that is down now is retried on every
/// call, and tonic reconnects by itself after a drop.
fn connect(cfg: &Config, enrolment: &Enrolment) -> Result<NodeAgentClient<Channel>> {
    let identity = enrolment.load()?;
    let tls = ClientTlsConfig::new()
        .ca_certificate(Certificate::from_pem(identity.ca_pem))
        .identity(Identity::from_pem(identity.cert_pem, identity.key_pem))
        .domain_name(cfg.panel_sni.clone());
    let channel = Endpoint::from_shared(format!("https://{}", cfg.panel))?
        .tls_config(tls)?
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .http2_keep_alive_interval(Duration::from_secs(60))
        .connect_lazy();
    Ok(NodeAgentClient::new(channel))
}

/// Fetch the configuration and write it. Returns whether OpenVPN has to be
/// restarted to pick it up.
async fn pull_config(
    cfg: &Config,
    stub: &mut NodeAgentClient<Channel>,
    revision: &mut String,
) -> Result<bool> {
    let config = stub
        .get_config(pb::ConfigRequest {
            known_revision: revision.clone(),
        })
        .await
        .map_err(describe_status)?
        .into_inner();
    if config.unchanged {
        return Ok(false);
    }
    let restart = apply::apply_config(&cfg.config_dir, &cfg.state_dir, &config)?;
    *revision = config.revision.clone();
    info!("applied configuration revision {revision}");
    Ok(restart)
}

async fn report_status(
    cfg: &Config,
    stub: &mut NodeAgentClient<Channel>,
    revision: &str,
    reader: &mut status::Reader,
) -> Result<()> {
    let snapshot = reader.read(cfg.status_path());
    stub.report_status(pb::StatusReport {
        openvpn_running: snapshot.running,
        message: snapshot.message,
        rx_bytes: snapshot.rx_bytes,
        tx_bytes: snapshot.tx_bytes,
        bandwidth_mbps: snapshot.bandwidth_mbps,
        sessions: snapshot.sessions,
        agent_version: VERSION.into(),
        config_revision: revision.to_string(),
        gost: gost::available(),
    })
    .await
    .map_err(describe_status)?;
    Ok(())
}

fn describe_status(status: tonic::Status) -> Box<dyn std::error::Error + Send + Sync> {
    let mut text = format!("{:?}: {}", status.code(), status.message());
    let mut source = std::error::Error::source(&status);
    while let Some(inner) = source {
        text.push_str(": ");
        text.push_str(&inner.to_string());
        source = inner.source();
    }
    text.into()
}

/// The OpenVPN supervisor next to us watches this flag; the time inside only
/// makes every write a change.
fn request_openvpn_restart(cfg: &Config) -> Result<()> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    std::fs::write(&cfg.restart_flag, stamp.to_string())?;
    info!("server config changed, asked the supervisor to restart OpenVPN");
    Ok(())
}
