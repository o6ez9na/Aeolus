//! The node's identity: its key, the certificate the panel signed for it, and
//! the panel's CA. Kept on disk between restarts in the same files, and the
//! same formats, as the Python agent — a node switched to this binary keeps
//! its identity.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, PublicKeyData};

use crate::fsutil::{write_atomic, write_if_changed};
use crate::Result;

pub struct Enrolment {
    pub key_path: PathBuf,
    pub cert_path: PathBuf,
    pub ca_path: PathBuf,
    pub name_path: PathBuf,
    /// Written while a join request waits for an operator.
    pub announce_path: PathBuf,
}

pub struct Identity {
    pub key_pem: String,
    pub cert_pem: String,
    pub ca_pem: String,
}

impl Enrolment {
    pub fn new(state_dir: &Path) -> Enrolment {
        Enrolment {
            key_path: state_dir.join("agent.key"),
            cert_path: state_dir.join("agent.crt"),
            ca_path: state_dir.join("ca.crt"),
            name_path: state_dir.join("node-name"),
            announce_path: state_dir.join("announce-token"),
        }
    }

    pub fn complete(&self) -> bool {
        self.key_path.exists() && self.cert_path.exists() && self.ca_path.exists()
    }

    pub fn load(&self) -> io::Result<Identity> {
        Ok(Identity {
            key_pem: fs::read_to_string(&self.key_path)?,
            cert_pem: fs::read_to_string(&self.cert_path)?,
            ca_pem: fs::read_to_string(&self.ca_path)?,
        })
    }

    /// The key we already have, or a new P-256 one.
    ///
    /// The key is this node's identity: the panel dedupes join requests by its
    /// fingerprint, and an operator may already be comparing that fingerprint
    /// on screen. A fresh key on every retry would queue a new request each
    /// time and invalidate what they are looking at.
    pub fn key_pair(&self) -> Result<KeyPair> {
        if let Ok(pem) = fs::read_to_string(&self.key_path) {
            return Ok(KeyPair::from_pem(&pem)?);
        }
        if let Some(parent) = self.key_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
        // PKCS#8, as the Python agent wrote it.
        write_atomic(&self.key_path, key.serialize_pem().as_bytes(), 0o600)?;
        Ok(key)
    }

    /// A CSR for our key. The panel sets the real subject from the node's name;
    /// the CN here is only a hint.
    pub fn create_csr(&self, common_name: &str) -> Result<String> {
        let key = self.key_pair()?;
        let mut params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, common_name);
        params.distinguished_name = dn;
        Ok(params.serialize_request(&key)?.pem()?)
    }

    /// SHA-256 of our SubjectPublicKeyInfo, as the panel shows it to the
    /// operator who accepts this node.
    pub fn fingerprint(&self) -> Result<String> {
        let key = self.key_pair()?;
        Ok(spki_fingerprint(&key.subject_public_key_info()))
    }

    pub fn save(&self, cert_pem: &str, ca_pem: &str, node_name: &str) -> io::Result<()> {
        write_if_changed(&self.cert_path, cert_pem.as_bytes(), 0o644)?;
        write_if_changed(&self.ca_path, ca_pem.as_bytes(), 0o644)?;
        write_if_changed(&self.name_path, node_name.as_bytes(), 0o644)?;
        match fs::remove_file(&self.announce_path) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        }
    }
}

pub fn spki_fingerprint(spki_der: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, spki_der);
    digest
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::testdir::TestDir;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn key_is_created_once_and_private() {
        let dir = TestDir::new("enrol");
        let enrolment = Enrolment::new(dir.path());
        let first = enrolment.fingerprint().unwrap();
        let second = enrolment.fingerprint().unwrap();
        assert_eq!(first, second, "the key must survive between calls");
        assert_eq!(first.len(), 32 * 3 - 1);
        let mode = fs::metadata(&enrolment.key_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let pem = fs::read_to_string(&enrolment.key_path).unwrap();
        assert!(pem.starts_with("-----BEGIN PRIVATE KEY-----"), "PKCS#8 like the Python agent");
    }

    #[test]
    fn csr_carries_the_name() {
        let dir = TestDir::new("csr");
        let enrolment = Enrolment::new(dir.path());
        let csr = enrolment.create_csr("home-router").unwrap();
        assert!(csr.starts_with("-----BEGIN CERTIFICATE REQUEST-----"));
    }

    #[test]
    fn save_completes_and_clears_the_request() {
        let dir = TestDir::new("save");
        let enrolment = Enrolment::new(dir.path());
        enrolment.key_pair().unwrap();
        fs::write(&enrolment.announce_path, "tok").unwrap();
        assert!(!enrolment.complete());
        enrolment.save("CERT", "CA", "home").unwrap();
        assert!(enrolment.complete());
        assert!(!enrolment.announce_path.exists());
        assert_eq!(fs::read_to_string(&enrolment.name_path).unwrap(), "home");
    }
}
