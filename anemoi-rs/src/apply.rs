//! Writing the configuration bundle the panel sends to disk, where OpenVPN
//! reads it. Same file names, modes and rules as the Python agent.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::Path;

use crate::enrol::Enrolment;
use crate::fsutil::write_if_changed;
use crate::pb::ConfigResponse;

const SECRET: &[&str] = &["server.key", "tls-crypt.key", "transit.key"];

/// Write the bundle. Returns whether OpenVPN needs a restart: it keeps its
/// options in memory, so a changed server or transit config only takes effect
/// after one. The CRL and ccd entries it re-reads on its own.
pub fn apply_config(
    config_dir: &Path,
    state_dir: &Path,
    response: &ConfigResponse,
) -> io::Result<bool> {
    fs::create_dir_all(config_dir)?;

    let mut restart_needed = false;
    for (name, wanted) in [
        ("server.conf", &response.server_conf),
        ("server-tcp.conf", &response.server_conf_tcp),
        ("transit.conf", &response.transit_conf),
    ] {
        let path = config_dir.join(name);
        if !wanted.is_empty() {
            restart_needed |= fs::read_to_string(&path).ok().as_deref() != Some(wanted.as_str());
        } else if path.exists() {
            // The listener was turned off; stop running it.
            fs::remove_file(&path)?;
            restart_needed = true;
        }
    }

    // Ordered so that server.conf lands last: the supervisor starts OpenVPN as
    // soon as it appears, and must find everything else already in place.
    let mut files: Vec<(&str, String)> = vec![
        ("ca.crt", response.ca_pem.clone()),
        ("server.crt", response.server_cert_pem.clone()),
        ("server.key", response.server_key_pem.clone()),
        ("tls-crypt.key", response.tls_crypt_key.clone()),
        ("crl.pem", response.crl_pem.clone()),
        // What to masquerade, one subnet per line; empty on the hub, which
        // NATs from its routing plan instead.
        (
            "nat-subnets",
            response
                .nat_subnets
                .iter()
                .map(|n| format!("{n}\n"))
                .collect(),
        ),
        // Networks of the sites this node is linked to: forwarded both ways
        // between the LAN and the transit, never masqueraded. Empty: no links.
        (
            "site-subnets",
            response
                .site_subnets
                .iter()
                .map(|n| format!("{n}\n"))
                .collect(),
        ),
    ];
    if !response.transit_conf.is_empty() && !response.is_hub {
        // A node dials the hub as an OpenVPN client with the same certificate
        // it uses for gRPC: one identity per node.
        let identity = Enrolment::new(state_dir).load()?;
        files.push(("transit.crt", identity.cert_pem));
        files.push(("transit.key", identity.key_pem));
    }
    files.push(("server-tcp.conf", response.server_conf_tcp.clone()));
    files.push(("transit.conf", response.transit_conf.clone()));
    files.push(("server.conf", response.server_conf.clone()));

    for (name, content) in files {
        // Empty means "this node does not run that", not "write an empty
        // file": an empty server.conf would still be started.
        if content.is_empty() && name != "nat-subnets" && name != "site-subnets" {
            continue;
        }
        let mode = if SECRET.contains(&name) { 0o600 } else { 0o644 };
        write_if_changed(&config_dir.join(name), content.as_bytes(), mode)?;
    }

    // One directory per listener: a pinned client has a different address on
    // the UDP and the TCP subnet. The hub keeps one more per node.
    for (dirname, entries) in [
        ("ccd", &response.ccd),
        ("ccd-tcp", &response.ccd_tcp),
        ("ccd-transit", &response.ccd_transit),
    ] {
        sync_ccd(&config_dir.join(dirname), entries)?;
    }

    write_if_changed(
        &config_dir.join(".revision"),
        response.revision.as_bytes(),
        0o644,
    )?;
    Ok(restart_needed)
}

/// Make `dir` hold exactly `entries`. A stale entry would keep granting access
/// after the panel took it away, so anything else is removed.
fn sync_ccd(dir: &Path, entries: &HashMap<String, String>) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    for existing in fs::read_dir(dir)? {
        let existing = existing?;
        let name = existing.file_name().to_string_lossy().into_owned();
        if existing.file_type()?.is_file() && !entries.contains_key(&name) {
            fs::remove_file(existing.path())?;
        }
    }
    // Sorted only so that runs are reproducible.
    let ordered: BTreeMap<_, _> = entries.iter().collect();
    for (common_name, body) in ordered {
        // A common name is a file name here; never let one climb out.
        if common_name.is_empty() || common_name.contains('/') || common_name.starts_with('.') {
            log::warn!("skipping ccd entry with an unsafe name: {common_name:?}");
            continue;
        }
        write_if_changed(&dir.join(common_name), body.as_bytes(), 0o644)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::testdir::TestDir;
    use std::os::unix::fs::PermissionsExt;

    fn hub_response() -> ConfigResponse {
        ConfigResponse {
            revision: "r1".into(),
            server_conf: "port 1194\n".into(),
            server_conf_tcp: "port 8443\n".into(),
            ca_pem: "CA".into(),
            server_cert_pem: "CRT".into(),
            server_key_pem: "KEY".into(),
            tls_crypt_key: "TLS".into(),
            crl_pem: "CRL".into(),
            ccd: HashMap::from([("alice".into(), "disable\n".into())]),
            ccd_tcp: HashMap::from([("alice".into(), "disable\n".into())]),
            transit_conf: "transit server\n".into(),
            ccd_transit: HashMap::from([(
                "home".into(),
                "iroute 192.168.5.0 255.255.255.0\n".into(),
            )]),
            is_hub: true,
            ..Default::default()
        }
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn hub_bundle_is_written_and_restart_only_on_change() {
        let dir = TestDir::new("apply-hub");
        let config = dir.path().join("cfg");
        let response = hub_response();

        assert!(apply_config(&config, dir.path(), &response).unwrap());
        assert_eq!(
            fs::read_to_string(config.join("server.conf")).unwrap(),
            "port 1194\n"
        );
        assert_eq!(mode(&config.join("server.key")), 0o600);
        assert_eq!(mode(&config.join("tls-crypt.key")), 0o600);
        assert_eq!(mode(&config.join("ca.crt")), 0o644);
        assert_eq!(fs::read_to_string(config.join("nat-subnets")).unwrap(), "");
        assert_eq!(fs::read_to_string(config.join("site-subnets")).unwrap(), "");
        assert_eq!(fs::read_to_string(config.join(".revision")).unwrap(), "r1");
        assert!(config.join("ccd-transit/home").exists());

        // Same bundle again: nothing to restart.
        assert!(!apply_config(&config, dir.path(), &response).unwrap());

        // Only a ccd change: OpenVPN re-reads those itself.
        let mut changed = response.clone();
        changed.ccd.insert(
            "bob".into(),
            "ifconfig-push 10.20.0.3 255.255.255.0\n".into(),
        );
        assert!(!apply_config(&config, dir.path(), &changed).unwrap());
        assert!(config.join("ccd/bob").exists());

        // A grant taken away disappears from disk.
        assert!(!apply_config(&config, dir.path(), &response).unwrap());
        assert!(!config.join("ccd/bob").exists());

        // The TCP listener turned off: its config goes and OpenVPN restarts.
        let mut no_tcp = response.clone();
        no_tcp.server_conf_tcp.clear();
        assert!(apply_config(&config, dir.path(), &no_tcp).unwrap());
        assert!(!config.join("server-tcp.conf").exists());
    }

    #[test]
    fn node_gets_transit_identity_and_nat() {
        let dir = TestDir::new("apply-node");
        let state = dir.path().join("state");
        let config = dir.path().join("cfg");
        let enrolment = Enrolment::new(&state);
        enrolment.key_pair().unwrap();
        enrolment.save("NODECERT", "CA", "home").unwrap();

        let response = ConfigResponse {
            revision: "n1".into(),
            ca_pem: "CA".into(),
            server_cert_pem: "CRT".into(),
            server_key_pem: "KEY".into(),
            tls_crypt_key: "TLS".into(),
            crl_pem: "CRL".into(),
            transit_conf: "client\nremote hub 1195\n".into(),
            nat_subnets: vec!["10.20.0.0/24".into(), "10.21.0.0/24".into()],
            site_subnets: vec!["192.168.1.0/24".into()],
            is_hub: false,
            ..Default::default()
        };
        assert!(apply_config(&config, &state, &response).unwrap());
        assert!(!config.join("server.conf").exists());
        assert_eq!(
            fs::read_to_string(config.join("transit.crt")).unwrap(),
            "NODECERT"
        );
        assert_eq!(mode(&config.join("transit.key")), 0o600);
        assert_eq!(
            fs::read_to_string(config.join("nat-subnets")).unwrap(),
            "10.20.0.0/24\n10.21.0.0/24\n"
        );
        assert_eq!(
            fs::read_to_string(config.join("site-subnets")).unwrap(),
            "192.168.1.0/24\n"
        );

        // The link removed: the file empties rather than going stale.
        let unlinked = ConfigResponse {
            revision: "n2".into(),
            site_subnets: vec![],
            ..response
        };
        apply_config(&config, &state, &unlinked).unwrap();
        assert_eq!(fs::read_to_string(config.join("site-subnets")).unwrap(), "");
    }

    #[test]
    fn ccd_names_cannot_escape() {
        let dir = TestDir::new("apply-escape");
        let entries = HashMap::from([
            ("../evil".to_string(), "x".to_string()),
            (".hidden".to_string(), "x".to_string()),
            ("ok".to_string(), "y".to_string()),
        ]);
        sync_ccd(&dir.path().join("ccd"), &entries).unwrap();
        assert!(dir.path().join("ccd/ok").exists());
        assert!(!dir.path().join("evil").exists());
        assert!(!dir.path().join("ccd/.hidden").exists());
    }
}
