//! GOST for the transit: Kuznyechik and Streebog from gost-engine's provider for
//! OpenSSL 3, `gostprov`.
//!
//! The panel can run the whole network on Kuznyechik, and then every transit
//! config asks OpenVPN for `providers default gostprov`. Without the module
//! OpenVPN does not start the tunnel at all, so the installer puts it in place
//! wherever it can and the agent tells the panel whether this node has it.
//!
//! Where it comes from:
//! - Debian 12 and Ubuntu 24.04 package it (`libengine-gost-openssl`).
//! - Keenetic's Entware does not, so the module is built for Entware (glibc
//!   2.27, OpenSSL 3.5) by `scripts/build-gostprov-entware.sh` and carried
//!   inside this binary for its own architecture.
//! - OpenWrt ships only the old engine (`libopenssl-gost_engine`), which the
//!   transit config does not use.

use std::fs;
use std::path::{Path, PathBuf};

pub const MODULE: &str = "gostprov.so";

/// Where Entware's OpenSSL looks for provider modules (its MODULESDIR).
pub const ENTWARE_MODULES_DIR: &str = "/opt/lib/ossl-modules";

/// Where OpenSSL looks for provider modules on the systems we install on.
fn module_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("OPENSSL_MODULES")
        && !dir.is_empty()
    {
        dirs.push(dir.into());
    }
    for dir in [
        ENTWARE_MODULES_DIR,
        "/usr/lib/ossl-modules",
        "/usr/lib64/ossl-modules",
    ] {
        dirs.push(dir.into());
    }
    // Debian and Ubuntu keep it under the multiarch triplet.
    if let Ok(entries) = fs::read_dir("/usr/lib") {
        for entry in entries.flatten() {
            let dir = entry.path().join("ossl-modules");
            if dir.is_dir() {
                dirs.push(dir);
            }
        }
    }
    dirs
}

/// Whether OpenVPN here can load the GOST provider.
pub fn available() -> bool {
    module_dirs().iter().any(|dir| dir.join(MODULE).is_file())
}

/// The module built for Keenetic's Entware, for the architecture of this binary.
pub fn entware_module() -> Option<&'static [u8]> {
    #[cfg(all(target_arch = "mips", target_endian = "little"))]
    return Some(include_bytes!("../gost/entware-mipsel/gostprov.so"));
    #[cfg(all(target_arch = "mips", target_endian = "big"))]
    return Some(include_bytes!("../gost/entware-mips/gostprov.so"));
    #[cfg(target_arch = "aarch64")]
    return Some(include_bytes!("../gost/entware-aarch64/gostprov.so"));
    #[cfg(not(any(target_arch = "mips", target_arch = "aarch64")))]
    return None;
}

/// Path of the Entware module once installed.
pub fn entware_target() -> PathBuf {
    Path::new(ENTWARE_MODULES_DIR).join(MODULE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_module_in_openssl_modules() {
        let dir = std::env::temp_dir().join(format!("anemoi-gost-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MODULE), b"x").unwrap();
        // SAFETY: tests in this module do not read the environment concurrently.
        unsafe { std::env::set_var("OPENSSL_MODULES", &dir) };
        assert!(module_dirs().contains(&dir));
        assert!(available());
        unsafe { std::env::remove_var("OPENSSL_MODULES") };
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn entware_module_matches_the_build_target() {
        let module = entware_module();
        if cfg!(any(target_arch = "mips", target_arch = "aarch64")) {
            // An ELF shared object, not an empty placeholder.
            let bytes = module.expect("module for this architecture");
            assert_eq!(&bytes[..4], b"\x7fELF");
        } else {
            assert!(module.is_none());
        }
    }
}
