//! TLS settings for talking to the panel's public side (the HTTP API and the
//! WebSocket transit). gRPC uses the panel's own CA instead and is set up in
//! main.rs.

use std::sync::Arc;

use rustls_pki_types::{CertificateDer, pem::PemObject};

use crate::Result;
use crate::config::Config;

/// Public roots are compiled in: plenty of routers ship no CA bundle at all,
/// and the node must still trust the panel's Let's Encrypt certificate.
/// `ANEMOI_PANEL_CA` adds a private CA for a panel without a public one.
pub fn panel_client_config(cfg: &Config) -> Result<Arc<rustls::ClientConfig>> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(path) = &cfg.panel_ca {
        for cert in CertificateDer::pem_file_iter(path)? {
            roots.add(cert?)?;
        }
    }
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(Arc::new(config))
}
