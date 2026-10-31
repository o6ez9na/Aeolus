//! File writes that are safe on a router: atomic, with the final mode from the
//! start, and skipped when nothing changed — most routers keep /etc on flash,
//! and rewriting the same bundle every poll would wear it for nothing.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

/// Write `content` to `path` unless it already holds exactly that. The mode is
/// applied either way, so a file someone loosened by hand gets fixed. Returns
/// whether the content changed.
pub fn write_if_changed(path: &Path, content: &[u8], mode: u32) -> io::Result<bool> {
    if let Ok(existing) = fs::read(path) {
        if existing == content {
            set_mode(path, mode)?;
            return Ok(false);
        }
    }
    write_atomic(path, content, mode)?;
    Ok(true)
}

/// Write through a temporary file in the same directory and rename it over the
/// target: a reader sees the old file or the new one, never half of either,
/// and a secret is never readable with a wider mode than intended.
pub fn write_atomic(path: &Path, content: &[u8], mode: u32) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let tmp = dir.join(format!(".{}.tmp{}", name.to_string_lossy(), std::process::id()));

    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&tmp)?;
        file.write_all(content)?;
        file.sync_all()?;
        // The mode given to open() is filtered through the umask.
        set_mode(&tmp, mode)?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    let current = fs::metadata(path)?.permissions().mode() & 0o7777;
    if current != mode {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

#[cfg(test)]
pub mod testdir {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A scratch directory removed on drop. Enough for these tests without
    /// pulling in a crate.
    pub struct TestDir(PathBuf);

    impl TestDir {
        pub fn new(tag: &str) -> TestDir {
            static N: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "anemoi-test-{}-{}-{}",
                tag,
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            TestDir(path)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn writes_once_and_keeps_mode() {
        let dir = testdir::TestDir::new("fsutil");
        let path = dir.path().join("server.key");
        assert!(write_if_changed(&path, b"secret", 0o600).unwrap());
        assert!(!write_if_changed(&path, b"secret", 0o600).unwrap());
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!write_if_changed(&path, b"secret", 0o600).unwrap());
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);

        assert!(write_if_changed(&path, b"other", 0o600).unwrap());
        assert_eq!(fs::read(&path).unwrap(), b"other");
        // No temporary file left behind.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
