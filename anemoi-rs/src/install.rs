//! `anemoi install | uninstall | doctor`: putting a node on a machine, the way
//! that machine expects things to be put on it.
//!
//! What is missing gets installed with the platform's own package manager,
//! settings go where the platform keeps them, the service is registered with
//! its own init system. Running install again repairs and updates without
//! duplicating anything; settings already written are kept unless a flag says
//! otherwise. What install added is recorded, so uninstall removes exactly
//! that and nothing else.
//!
//! The installer stops only where a script cannot help — a missing kernel
//! module on firmware with no packages for it, say — and then says exactly
//! what to do, so that running it again carries on from there.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::{Config, parse_env_file};
use crate::enrol::Enrolment;
use crate::firewall;
use crate::fsutil::write_if_changed;

type Result<T> = std::result::Result<T, String>;

// --- language ----------------------------------------------------------------

fn russian() -> bool {
    let lang = std::env::var("ANEMOI_LANG")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default();
    // The panel speaks Russian; a router usually has no locale at all.
    lang.is_empty() || lang.starts_with("ru") || lang == "C" || lang == "POSIX"
}

fn t(ru: &str, en: &str) -> String {
    if russian() { ru } else { en }.to_string()
}

fn step(text: String) {
    println!(":: {text}");
}
fn ok(text: String) {
    println!("ok {text}");
}
fn note(text: String) {
    println!("!! {text}");
}

// --- platform -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    OpenWrt,
    /// Keenetic and other firmware with Entware in /opt: the base system is
    /// read-only and not ours, everything lives under /opt.
    Entware,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Packages {
    /// OpenWrt 25+ and Alpine.
    Apk,
    Opkg,
    EntwareOpkg,
    Apt,
    Dnf,
    None,
}

#[derive(Debug, Clone)]
pub struct Platform {
    pub kind: Kind,
    packages: Packages,
    pub bin: PathBuf,
    pub etc: PathBuf,
    pub run: PathBuf,
    pub init_file: PathBuf,
}

impl Platform {
    pub fn detect() -> Platform {
        let exists = |p: &str| Path::new(p).exists();
        if exists("/etc/openwrt_release") {
            Platform {
                kind: Kind::OpenWrt,
                packages: if exists("/usr/bin/apk") && exists("/etc/apk") {
                    Packages::Apk
                } else {
                    Packages::Opkg
                },
                bin: "/usr/bin/anemoi".into(),
                etc: "/etc/anemoi".into(),
                // tmpfs: the bundle is fetched again on every start, and
                // rewriting it on flash would only wear the flash.
                run: "/var/run/anemoi".into(),
                init_file: "/etc/init.d/anemoi".into(),
            }
        } else if exists("/opt/bin/opkg")
            && (exists("/opt/etc/ndm") || !exists("/run/systemd/system"))
        {
            Platform {
                kind: Kind::Entware,
                packages: Packages::EntwareOpkg,
                bin: "/opt/bin/anemoi".into(),
                etc: "/opt/etc/anemoi".into(),
                run: "/opt/var/run/anemoi".into(),
                init_file: "/opt/etc/init.d/S99anemoi".into(),
            }
        } else {
            let packages = if exists("/usr/bin/apt-get") {
                Packages::Apt
            } else if exists("/usr/bin/dnf") {
                Packages::Dnf
            } else if exists("/sbin/apk") || exists("/usr/bin/apk") {
                Packages::Apk
            } else {
                Packages::None
            };
            Platform {
                kind: Kind::Linux,
                packages,
                bin: "/usr/local/bin/anemoi".into(),
                etc: "/etc/anemoi".into(),
                run: "/run/anemoi".into(),
                init_file: "/etc/systemd/system/anemoi.service".into(),
            }
        }
    }

    pub fn env_file(&self) -> PathBuf {
        self.etc.join("anemoi.env")
    }
    fn manifest(&self) -> PathBuf {
        self.etc.join("installed.json")
    }

    fn describe(&self) -> &'static str {
        match self.kind {
            Kind::OpenWrt => "OpenWrt",
            Kind::Entware => "Entware (Keenetic)",
            Kind::Linux => "Linux",
        }
    }

    /// Packages the transit tunnel needs here.
    fn needed(&self) -> &'static [&'static str] {
        match self.packages {
            Packages::Apk if self.kind == Kind::OpenWrt => &["openvpn-openssl", "kmod-tun"],
            Packages::Opkg => &["openvpn-openssl", "kmod-tun"],
            Packages::EntwareOpkg => &["openvpn-openssl"],
            Packages::Apk | Packages::Apt | Packages::Dnf => &["openvpn", "iptables"],
            Packages::None => &[],
        }
    }

    fn installed(&self, package: &str) -> bool {
        match self.packages {
            Packages::Apk => quiet("apk", &["info", "-e", package]),
            Packages::Opkg => opkg_installed("opkg", package),
            Packages::EntwareOpkg => opkg_installed("/opt/bin/opkg", package),
            Packages::Apt => Command::new("dpkg-query")
                .args(["-W", "-f=${Status}", package])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("install ok installed"))
                .unwrap_or(false),
            Packages::Dnf => quiet("rpm", &["-q", package]),
            Packages::None => true,
        }
    }

    fn install_packages(&self, packages: &[&str]) -> Result<()> {
        let (update, install): (Vec<&str>, Vec<&str>) = match self.packages {
            Packages::Apk => (vec!["apk", "update"], vec!["apk", "add"]),
            Packages::Opkg => (vec!["opkg", "update"], vec!["opkg", "install"]),
            Packages::EntwareOpkg => (
                vec!["/opt/bin/opkg", "update"],
                vec!["/opt/bin/opkg", "install"],
            ),
            Packages::Apt => (
                vec!["apt-get", "update", "-qq"],
                vec!["apt-get", "install", "-y", "-qq"],
            ),
            Packages::Dnf => (vec![], vec!["dnf", "install", "-y", "-q"]),
            Packages::None => {
                return Err(t(
                    "не знаю, чем здесь ставить пакеты; поставь вручную: openvpn",
                    "no package manager I know of here; install openvpn by hand",
                ));
            }
        };
        if !update.is_empty() {
            // A stale index reads as "no such package"; refresh first.
            let _ = run_visible(update[0], &update[1..]);
        }
        let mut args: Vec<&str> = install[1..].to_vec();
        args.extend_from_slice(packages);
        let env: &[(&str, &str)] = if self.packages == Packages::Apt {
            &[("DEBIAN_FRONTEND", "noninteractive")]
        } else {
            &[]
        };
        run_visible_env(install[0], &args, env).map_err(|err| {
            t(
                &format!("не удалось поставить {}: {err}", packages.join(" ")),
                &format!("could not install {}: {err}", packages.join(" ")),
            )
        })
    }
}

fn quiet(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn opkg_installed(opkg: &str, package: &str) -> bool {
    Command::new(opkg)
        .args(["status", package])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("installed"))
        .unwrap_or(false)
}

fn run_visible(program: &str, args: &[&str]) -> std::result::Result<(), String> {
    run_visible_env(program, args, &[])
}

fn run_visible_env(
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> std::result::Result<(), String> {
    let status = Command::new(program)
        .args(args)
        .envs(env.iter().copied())
        .status()
        .map_err(|err| format!("{program}: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} {}: {status}", args.join(" ")))
    }
}

// --- options ------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct Options {
    pub panel: Option<String>,
    pub name: Option<String>,
    pub subnets: Option<String>,
    pub panel_ca: Option<PathBuf>,
    pub grpc_port: Option<u16>,
    pub sni: Option<String>,
    pub token: Option<String>,
    pub no_start: bool,
    pub purge: bool,
}

pub fn parse_options(args: &[String]) -> Result<Options> {
    let mut opts = Options::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = || {
            it.next().cloned().ok_or_else(|| {
                t(
                    &format!("после {arg} нужно значение"),
                    &format!("{arg} needs a value"),
                )
            })
        };
        match arg.as_str() {
            "--panel" => opts.panel = Some(value()?),
            "--name" => opts.name = Some(value()?),
            "--subnets" => opts.subnets = Some(value()?),
            "--panel-ca" => opts.panel_ca = Some(PathBuf::from(value()?)),
            "--grpc-port" => {
                opts.grpc_port = Some(value()?.parse().map_err(|_| {
                    t(
                        "--grpc-port: нужен номер порта",
                        "--grpc-port: not a port number",
                    )
                })?)
            }
            "--sni" => opts.sni = Some(value()?),
            "--token" => opts.token = Some(value()?),
            "--no-start" => opts.no_start = true,
            "--purge" => opts.purge = true,
            other => {
                return Err(t(
                    &format!("неизвестный параметр {other}"),
                    &format!("unknown option {other}"),
                ));
            }
        }
    }
    Ok(opts)
}

fn ask(question: &str, default: &str) -> Option<String> {
    if !io::stdin().is_terminal() {
        return None;
    }
    if default.is_empty() {
        print!("{question}: ");
    } else {
        print!("{question} [{default}]: ");
    }
    let _ = io::stdout().flush();
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line).ok()?;
    let answer = line.trim();
    Some(if answer.is_empty() {
        default.to_string()
    } else {
        answer.to_string()
    })
}

// --- detection ----------------------------------------------------------------

fn default_route_iface() -> String {
    Command::new("ip")
        .args(["-4", "route", "show", "default"])
        .output()
        .ok()
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).into_owned();
            let words: Vec<&str> = text.split_whitespace().collect();
            words
                .iter()
                .position(|w| *w == "dev")
                .and_then(|i| words.get(i + 1))
                .map(|s| s.to_string())
        })
        .unwrap_or_default()
}

/// The LAN this node would offer to the mesh. A guess the operator confirms;
/// never a /0 or a /32, which would ask the panel to route the internet or a
/// single host here.
fn guess_lan(platform: &Platform, wan: &str) -> String {
    let iface = match platform.kind {
        Kind::OpenWrt => {
            let dev = Command::new("uci")
                .args(["-q", "get", "network.lan.device"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();
            if dev.is_empty() {
                "br-lan".to_string()
            } else {
                dev
            }
        }
        Kind::Entware => "br0".to_string(),
        Kind::Linux => wan.to_string(),
    };
    let routes = Command::new("ip")
        .args(["-4", "route", "show", "dev", &iface, "scope", "link"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    routes
        .split_whitespace()
        .next()
        .filter(|net| net.contains('/') && !net.ends_with("/0") && !net.ends_with("/32"))
        .unwrap_or_default()
        .to_string()
}

// --- install ------------------------------------------------------------------

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct Manifest {
    version: String,
    platform: String,
    files: Vec<String>,
    packages_installed: Vec<String>,
}

fn require_root() -> Result<()> {
    if unsafe { libc::geteuid() } != 0 {
        return Err(t("нужен root", "must run as root"));
    }
    Ok(())
}

pub fn install(args: &[String]) -> i32 {
    match install_inner(args) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("error {err}");
            1
        }
    }
}

fn install_inner(args: &[String]) -> Result<()> {
    require_root()?;
    let opts = parse_options(args)?;
    let platform = Platform::detect();
    step(t(
        &format!("платформа: {}", platform.describe()),
        &format!("platform: {}", platform.describe()),
    ));

    let mut manifest: Manifest = fs::read_to_string(platform.manifest())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    manifest.version = crate::VERSION.to_string();
    manifest.platform = platform.describe().to_string();

    // 1. Packages.
    let missing: Vec<&str> = platform
        .needed()
        .iter()
        .copied()
        .filter(|p| !platform.installed(p))
        .collect();
    if missing.is_empty() {
        ok(t(
            "нужные пакеты уже стоят",
            "required packages are present",
        ));
    } else {
        step(t(
            &format!("ставлю: {}", missing.join(" ")),
            &format!("installing: {}", missing.join(" ")),
        ));
        platform.install_packages(&missing)?;
        for package in &missing {
            if !manifest.packages_installed.iter().any(|p| p == package) {
                manifest.packages_installed.push(package.to_string());
            }
        }
        ok(t("пакеты поставлены", "packages installed"));
    }
    if crate::supervisor::find_openvpn("").is_none() {
        return Err(t(
            "openvpn так и не появился после установки пакетов",
            "openvpn is still missing after installing packages",
        ));
    }

    // 2. The tunnel device.
    ensure_tun(&platform)?;

    // 3. The binary, where this platform keeps binaries.
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut binary_changed = false;
    if me != platform.bin {
        if let Some(dir) = platform.bin.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let bytes = fs::read(&me).map_err(|e| format!("{}: {e}", me.display()))?;
        // Atomic: a running agent keeps its old binary until it restarts.
        binary_changed = write_if_changed(&platform.bin, &bytes, 0o755)
            .map_err(|e| format!("{}: {e}", platform.bin.display()))?;
        if binary_changed {
            ok(t(
                &format!("бинарь: {}", platform.bin.display()),
                &format!("binary: {}", platform.bin.display()),
            ));
        }
    }
    record(&mut manifest, &platform.bin);

    // 4. Settings: what is already there stays unless a flag says otherwise.
    fs::create_dir_all(&platform.etc).map_err(|e| e.to_string())?;
    let env_path = platform.env_file();
    let mut env: BTreeMap<String, String> = fs::read_to_string(&env_path)
        .map(|text| parse_env_file(&text).into_iter().collect())
        .unwrap_or_default();

    let existing_domain = env
        .get("ANEMOI_PANEL_API")
        .and_then(|url| url.strip_prefix("https://"))
        .map(|rest| {
            rest.split(['/', ':'])
                .next()
                .unwrap_or_default()
                .to_string()
        })
        .unwrap_or_default();
    let domain = match opts.panel.clone() {
        Some(domain) => domain,
        None if !existing_domain.is_empty() => existing_domain,
        None => ask(&t("адрес панели (домен)", "panel address (domain)"), "")
            .filter(|d| !d.is_empty())
            .ok_or_else(|| {
                t(
                    "нужен адрес панели: --panel vpn.example.com",
                    "the panel's address is required: --panel vpn.example.com",
                )
            })?,
    };
    let domain = domain
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string();

    let grpc_port = opts
        .grpc_port
        .or_else(|| {
            env.get("ANEMOI_PANEL")
                .and_then(|p| p.rsplit_once(':'))
                .and_then(|(_, p)| p.parse().ok())
        })
        .unwrap_or(50051);
    env.insert("ANEMOI_PANEL".into(), format!("{domain}:{grpc_port}"));
    env.insert("ANEMOI_PANEL_API".into(), format!("https://{domain}"));
    if let Some(sni) = &opts.sni {
        env.insert("ANEMOI_PANEL_SNI".into(), sni.clone());
    }

    if let Some(ca) = &opts.panel_ca {
        let pem = fs::read(ca).map_err(|e| format!("{}: {e}", ca.display()))?;
        let dest = platform.etc.join("panel-ca.pem");
        write_if_changed(&dest, &pem, 0o644).map_err(|e| e.to_string())?;
        record(&mut manifest, &dest);
        env.insert("ANEMOI_PANEL_CA".into(), dest.display().to_string());
    }

    let hostname = crate::join::hostname();
    let name = match opts.name.clone() {
        Some(name) => name,
        None => match env.get("ANEMOI_NODE_NAME") {
            Some(name) if !name.is_empty() => name.clone(),
            _ => ask(&t("имя ноды", "node name"), &hostname).unwrap_or(hostname),
        },
    };
    env.insert("ANEMOI_NODE_NAME".into(), name);

    let wan = env
        .get("ANEMOI_WAN_IFACE")
        .cloned()
        .filter(|w| !w.is_empty())
        .unwrap_or_else(default_route_iface);
    env.insert("ANEMOI_WAN_IFACE".into(), wan.clone());
    let subnets = match opts.subnets.clone() {
        Some(subnets) => subnets,
        None => match env.get("ANEMOI_SUBNETS") {
            Some(subnets) => subnets.clone(),
            None => {
                let guess = guess_lan(&platform, &wan);
                ask(
                    &t(
                        "какие сети за этой нодой открыть клиентам (CIDR через запятую, пусто — никакие)",
                        "LANs behind this node to offer clients (CIDRs, comma separated, empty for none)",
                    ),
                    &guess,
                )
                .unwrap_or(guess)
            }
        },
    };
    env.insert("ANEMOI_SUBNETS".into(), subnets);

    if let Some(token) = &opts.token {
        let token_file = platform.etc.join("enrollment-token");
        write_if_changed(&token_file, token.as_bytes(), 0o600).map_err(|e| e.to_string())?;
        env.insert("ANEMOI_TOKEN_FILE".into(), token_file.display().to_string());
    } else {
        env.entry("ANEMOI_TOKEN_FILE".into())
            .or_insert_with(|| platform.etc.join("enrollment-token").display().to_string());
    }

    let run = platform.run.display().to_string();
    for (key, value) in [
        (
            "ANEMOI_STATE_DIR",
            platform.etc.join("state").display().to_string(),
        ),
        ("ANEMOI_CONFIG_DIR", format!("{run}/openvpn")),
        ("ANEMOI_STATUS_FILE", format!("{run}/status.log")),
        (
            "ANEMOI_TRANSIT_STATUS_FILE",
            format!("{run}/status-transit.log"),
        ),
        ("ANEMOI_RESTART_FLAG", format!("{run}/openvpn/.restart")),
        ("ANEMOI_SUPERVISE", "1".to_string()),
    ] {
        env.entry(key.into()).or_insert(value);
    }

    let mut text = String::from(
        "# Aeolus node agent settings — written by `anemoi install`, kept on re-runs.\n",
    );
    for (key, value) in &env {
        text.push_str(&format!("{key}={value}\n"));
    }
    let changed = write_if_changed(&env_path, text.as_bytes(), 0o600).map_err(|e| e.to_string())?;
    record(&mut manifest, &env_path);
    ok(t(
        &format!("настройки: {}", env_path.display()),
        &format!("settings: {}", env_path.display()),
    ));

    // 5. Identity: the key is made now so its fingerprint can be shown now.
    let cfg = Config::load(
        &[(
            "ANEMOI_ENV_FILE".to_string(),
            env_path.display().to_string(),
        )]
        .into_iter()
        .collect(),
    );
    let fingerprint = Enrolment::new(&cfg.state_dir)
        .fingerprint()
        .map_err(|e| e.to_string())?;

    // 6. Forwarding, persistently where the platform keeps such settings.
    ensure_forwarding(&platform, &mut manifest)?;

    // 7. The service.
    let unit_changed = install_service(&platform, &mut manifest)?;
    save_manifest(&platform, &manifest)?;
    if !opts.no_start {
        restart_service(&platform, binary_changed || changed || unit_changed)?;
    }

    println!();
    println!(
        "{}",
        t(
            &format!("Нода попросится в панель {domain}. Прими её там, сверив отпечаток ключа:"),
            &format!(
                "The node will ask to join {domain}. Accept it there after comparing the key fingerprint:"
            ),
        )
    );
    println!("    {fingerprint}");
    println!();
    println!("{}", t("Проверка: anemoi doctor", "Check: anemoi doctor"));
    Ok(())
}

fn record(manifest: &mut Manifest, path: &Path) {
    let path = path.display().to_string();
    if !manifest.files.contains(&path) {
        manifest.files.push(path);
    }
}

fn save_manifest(platform: &Platform, manifest: &Manifest) -> Result<()> {
    let text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    write_if_changed(&platform.manifest(), text.as_bytes(), 0o644).map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_tun(platform: &Platform) -> Result<()> {
    if Path::new("/dev/net/tun").exists() {
        ok(t("/dev/net/tun на месте", "/dev/net/tun is present"));
        return Ok(());
    }
    let _ = quiet("modprobe", &["tun"]);
    if !Path::new("/dev/net/tun").exists() && Path::new("/sys/class/misc/tun").exists() {
        let _ = fs::create_dir_all("/dev/net");
        let _ = quiet("mknod", &["/dev/net/tun", "c", "10", "200"]);
    }
    if Path::new("/dev/net/tun").exists() {
        ok(t("/dev/net/tun создан", "/dev/net/tun created"));
        return Ok(());
    }
    Err(match platform.kind {
        Kind::Entware => t(
            "в прошивке нет модуля tun. В веб-интерфейсе Keenetic: Общие настройки → Изменить набор компонентов → включи «OpenVPN» (или «Модули ядра для туннелей»), обнови прошивку и запусти установку снова",
            "the firmware lacks the tun module. In the Keenetic web UI: General settings → Component options → enable “OpenVPN”, update, then run the installer again",
        ),
        _ => t(
            "нет /dev/net/tun и модуль tun не загружается; в контейнере его нужно пробросить с хоста",
            "no /dev/net/tun and the tun module does not load; in a container it must be passed through from the host",
        ),
    })
}

fn ensure_forwarding(platform: &Platform, manifest: &mut Manifest) -> Result<()> {
    firewall::ensure_forwarding();
    match platform.kind {
        // A router forwards already; OpenWrt and NDMS own that setting.
        Kind::OpenWrt | Kind::Entware => Ok(()),
        Kind::Linux => {
            let path = Path::new("/etc/sysctl.d/99-anemoi.conf");
            write_if_changed(path, b"net.ipv4.ip_forward=1\n", 0o644).map_err(|e| e.to_string())?;
            record(manifest, path);
            Ok(())
        }
    }
}

fn procd_script(platform: &Platform) -> String {
    format!(
        r#"#!/bin/sh /etc/rc.common
# Aeolus node agent. Installed by `anemoi install`; `anemoi uninstall` removes it.

START=95
STOP=10
USE_PROCD=1

start_service() {{
	procd_open_instance
	procd_set_param command {bin} run
	procd_set_param env ANEMOI_ENV_FILE={env}
	procd_set_param respawn 3600 5 0
	procd_set_param term_timeout 20
	procd_set_param stdout 1
	procd_set_param stderr 1
	procd_close_instance
}}
"#,
        bin = platform.bin.display(),
        env = platform.env_file().display(),
    )
}

fn systemd_unit(platform: &Platform) -> String {
    format!(
        "[Unit]\n\
         Description=Aeolus node agent (anemoi)\n\
         After=network-online.target\n\
         Wants=network-online.target\n\n\
         [Service]\n\
         Environment=ANEMOI_ENV_FILE={env}\n\
         ExecStart={bin} run\n\
         Restart=always\n\
         RestartSec=5\n\
         TimeoutStopSec=20\n\n\
         [Install]\n\
         WantedBy=multi-user.target\n",
        bin = platform.bin.display(),
        env = platform.env_file().display(),
    )
}

fn entware_script(platform: &Platform) -> String {
    format!(
        r#"#!/bin/sh
# Aeolus node agent. Installed by `anemoi install`; `anemoi uninstall` removes it.
PIDFILE={run}/anemoi.pid
LOG=/opt/var/log/anemoi.log
export ANEMOI_ENV_FILE={env}

running() {{ [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }}

case "$1" in
  start)
    running && exit 0
    mkdir -p {run} /opt/var/log
    # The agent restarts OpenVPN itself; this loop restarts the agent.
    ( while :; do {bin} run >>"$LOG" 2>&1; sleep 5; done ) &
    echo $! > "$PIDFILE"
    ;;
  stop)
    if running; then
      pid=$(cat "$PIDFILE")
      pkill -P "$pid" 2>/dev/null
      kill "$pid" 2>/dev/null
    fi
    rm -f "$PIDFILE"
    ;;
  restart) "$0" stop; sleep 1; "$0" start ;;
  status) if running; then echo running; else echo stopped; exit 1; fi ;;
  *) echo "usage: $0 start|stop|restart|status" ;;
esac
"#,
        bin = platform.bin.display(),
        env = platform.env_file().display(),
        run = platform.run.display(),
    )
}

/// Returns whether the service definition changed.
fn install_service(platform: &Platform, manifest: &mut Manifest) -> Result<bool> {
    let (content, mode) = match platform.kind {
        Kind::OpenWrt => (procd_script(platform), 0o755),
        Kind::Entware => (entware_script(platform), 0o755),
        Kind::Linux => (systemd_unit(platform), 0o644),
    };
    if let Some(dir) = platform.init_file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let changed = write_if_changed(&platform.init_file, content.as_bytes(), mode)
        .map_err(|e| e.to_string())?;
    record(manifest, &platform.init_file);
    match platform.kind {
        Kind::OpenWrt => {
            let _ = quiet(&platform.init_file.display().to_string(), &["enable"]);
        }
        Kind::Linux => {
            let _ = quiet("systemctl", &["daemon-reload"]);
            let _ = quiet("systemctl", &["enable", "anemoi.service"]);
        }
        // Entware starts every S?? script in /opt/etc/init.d at boot.
        Kind::Entware => {}
    }
    ok(t(
        &format!("автозапуск: {}", platform.init_file.display()),
        &format!("autostart: {}", platform.init_file.display()),
    ));
    Ok(changed)
}

fn service_running(platform: &Platform) -> bool {
    let init = platform.init_file.display().to_string();
    match platform.kind {
        Kind::OpenWrt => quiet(&init, &["running"]),
        Kind::Entware => quiet(&init, &["status"]),
        Kind::Linux => quiet("systemctl", &["is-active", "--quiet", "anemoi.service"]),
    }
}

/// Start the service, or restart it when something it runs on changed. A
/// re-run that changed nothing leaves a working tunnel alone.
fn restart_service(platform: &Platform, changed: bool) -> Result<()> {
    let running = service_running(platform);
    if running && !changed {
        ok(t(
            "служба уже работает, менять нечего",
            "service already running, nothing changed",
        ));
        return Ok(());
    }
    let action = if running { "restart" } else { "start" };
    let init = platform.init_file.display().to_string();
    let result = match platform.kind {
        Kind::OpenWrt | Kind::Entware => run_visible(&init, &[action]),
        Kind::Linux => run_visible("systemctl", &[action, "anemoi.service"]),
    };
    result.map_err(|err| {
        t(
            &format!("служба не запустилась: {err}"),
            &format!("the service did not start: {err}"),
        )
    })?;
    ok(if running {
        t("служба перезапущена", "service restarted")
    } else {
        t("служба запущена", "service started")
    });
    Ok(())
}

// --- uninstall ----------------------------------------------------------------

pub fn uninstall(args: &[String]) -> i32 {
    match uninstall_inner(args) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("error {err}");
            1
        }
    }
}

fn uninstall_inner(args: &[String]) -> Result<()> {
    require_root()?;
    let opts = parse_options(args)?;
    let platform = Platform::detect();
    let manifest: Manifest = fs::read_to_string(platform.manifest())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();

    step(t("останавливаю службу", "stopping the service"));
    match platform.kind {
        Kind::OpenWrt | Kind::Entware => {
            let init = platform.init_file.display().to_string();
            let _ = quiet(&init, &["stop"]);
            let _ = quiet(&init, &["disable"]);
        }
        Kind::Linux => {
            let _ = quiet("systemctl", &["disable", "--now", "anemoi.service"]);
        }
    }
    // The agent takes its OpenVPN down on SIGTERM; make sure nothing lingers.
    // Not `killall anemoi`: this process is an anemoi too.
    stop_other_agents();

    step(t("убираю правила фаервола", "removing firewall rules"));
    let mut fw = firewall::detect();
    if let Err(err) = fw.clear() {
        note(t(&format!("фаервол: {err}"), &format!("firewall: {err}")));
    }

    // What install wrote, except the identity and settings unless --purge:
    // a reinstall then comes back as the same node, without a new approval.
    let keep = |path: &str| {
        !opts.purge && (path.ends_with("anemoi.env") || path.ends_with("panel-ca.pem"))
    };
    for path in manifest.files.iter().filter(|p| !keep(p)) {
        match fs::remove_file(path) {
            Ok(()) => ok(t(&format!("удалён {path}"), &format!("removed {path}"))),
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => note(format!("{path}: {err}")),
        }
    }
    let _ = fs::remove_dir_all(&platform.run);
    if opts.purge {
        let _ = fs::remove_dir_all(&platform.etc);
        ok(t(
            "ключ и настройки ноды удалены (--purge)",
            "node key and settings removed (--purge)",
        ));
    } else {
        let _ = fs::remove_file(platform.manifest());
        note(t(
            &format!(
                "ключ и настройки оставлены в {} — повторная установка вернёт ту же ноду; --purge удалит и их",
                platform.etc.display()
            ),
            &format!(
                "key and settings kept in {}: reinstalling brings back the same node; --purge removes them too",
                platform.etc.display()
            ),
        ));
    }
    if !manifest.packages_installed.is_empty() {
        note(t(
            &format!(
                "пакеты, поставленные установщиком, не трогаю (ими может пользоваться что-то ещё): {}",
                manifest.packages_installed.join(" ")
            ),
            &format!(
                "packages the installer added are left in place (something else may use them): {}",
                manifest.packages_installed.join(" ")
            ),
        ));
    }
    Ok(())
}

/// SIGTERM to every running `anemoi` but this one, then wait for them to go.
fn stop_other_agents() {
    let me = std::process::id();
    let others = || -> Vec<i32> {
        fs::read_dir("/proc")
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| *pid != me)
            .filter(|pid| {
                fs::read_to_string(format!("/proc/{pid}/comm"))
                    .map(|c| c.trim() == "anemoi")
                    .unwrap_or(false)
            })
            .map(|pid| pid as i32)
            .collect()
    };
    for pid in others() {
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    for _ in 0..40 {
        if others().is_empty() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

// --- doctor -------------------------------------------------------------------

pub fn doctor() -> i32 {
    let platform = Platform::detect();
    let mut failed = 0;
    let mut check = |good: bool, what: String, hint: String| {
        if good {
            println!("ok   {what}");
        } else {
            failed += 1;
            println!("FAIL {what}");
            if !hint.is_empty() {
                println!("     → {hint}");
            }
        }
    };
    println!("{}: {}", t("платформа", "platform"), platform.describe());

    let env_path = platform.env_file();
    check(
        env_path.exists(),
        format!("{} {}", t("настройки", "settings"), env_path.display()),
        t("запусти anemoi install", "run anemoi install"),
    );
    let cfg = Config::load(
        &[(
            "ANEMOI_ENV_FILE".to_string(),
            env_path.display().to_string(),
        )]
        .into_iter()
        .collect(),
    );

    let openvpn = crate::supervisor::find_openvpn(&cfg.openvpn_bin);
    check(
        openvpn.is_some(),
        "openvpn".into(),
        t("anemoi install поставит его", "anemoi install installs it"),
    );
    check(
        Path::new("/dev/net/tun").exists(),
        "/dev/net/tun".into(),
        t(
            "anemoi install подскажет, как включить",
            "anemoi install explains how to enable it",
        ),
    );
    check(
        platform.init_file.exists(),
        format!(
            "{} {}",
            t("автозапуск", "autostart"),
            platform.init_file.display()
        ),
        t("anemoi install", "anemoi install"),
    );
    let running = quiet("pidof", &["anemoi"]);
    check(
        running,
        t("агент запущен", "agent running"),
        restart_hint(&platform),
    );

    let enrolment = Enrolment::new(&cfg.state_dir);
    check(
        enrolment.complete(),
        t(
            "нода принята панелью (есть сертификат)",
            "node accepted by the panel (certificate present)",
        ),
        match enrolment.fingerprint() {
            Ok(fp) => t(
                &format!("прими ноду в панели, отпечаток {fp}"),
                &format!("accept the node in the panel, fingerprint {fp}"),
            ),
            Err(_) => String::new(),
        },
    );
    let transit_up = fs::read_to_string(&cfg.transit_status_file)
        .map(|s| s.starts_with("OpenVPN STATISTICS"))
        .unwrap_or(false)
        && Path::new(&format!("/sys/class/net/{}", cfg.tun_dev)).exists();
    check(
        transit_up,
        format!(
            "{} ({})",
            t("транзит до хаба поднят", "transit to the hub is up"),
            cfg.tun_dev
        ),
        t(
            "смотри журнал агента: logread -e anemoi / journalctl -u anemoi",
            "see the agent's log: logread -e anemoi / journalctl -u anemoi",
        ),
    );
    if failed == 0 {
        println!("{}", t("всё в порядке", "all good"));
        0
    } else {
        1
    }
}

fn restart_hint(platform: &Platform) -> String {
    match platform.kind {
        Kind::Linux => "systemctl restart anemoi".into(),
        _ => format!("{} restart", platform.init_file.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_parse() {
        let args: Vec<String> = [
            "--panel",
            "vpn.example.com",
            "--name",
            "home",
            "--grpc-port",
            "443",
            "--no-start",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let opts = parse_options(&args).unwrap();
        assert_eq!(opts.panel.as_deref(), Some("vpn.example.com"));
        assert_eq!(opts.name.as_deref(), Some("home"));
        assert_eq!(opts.grpc_port, Some(443));
        assert!(opts.no_start);
        assert!(parse_options(&["--bogus".to_string()]).is_err());
        assert!(parse_options(&["--panel".to_string()]).is_err());
    }

    #[test]
    fn service_files_point_at_the_binary_and_settings() {
        let platform = Platform {
            kind: Kind::OpenWrt,
            packages: Packages::Apk,
            bin: "/usr/bin/anemoi".into(),
            etc: "/etc/anemoi".into(),
            run: "/var/run/anemoi".into(),
            init_file: "/etc/init.d/anemoi".into(),
        };
        let procd = procd_script(&platform);
        assert!(procd.starts_with("#!/bin/sh /etc/rc.common"));
        assert!(procd.contains("procd_set_param command /usr/bin/anemoi run"));
        assert!(procd.contains("ANEMOI_ENV_FILE=/etc/anemoi/anemoi.env"));
        assert!(systemd_unit(&platform).contains("ExecStart=/usr/bin/anemoi run"));
        assert!(entware_script(&platform).contains("/usr/bin/anemoi run"));
    }
}
