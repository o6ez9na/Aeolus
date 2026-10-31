//! A logger to stderr, small on purpose: on a router every dependency is flash.
//! procd, Entware's init and docker all capture stderr; the timestamp is ours
//! so a log copied out of context still says when.

use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use log::{Level, LevelFilter, Log, Metadata, Record};

struct Stderr;

impl Log for Stderr {
    fn enabled(&self, metadata: &Metadata) -> bool {
        // Our own messages only; dependencies stay quiet unless they warn.
        metadata.target().starts_with("anemoi") || metadata.level() <= Level::Warn
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!("{} {} {}\n", utc_now(), record.level(), record.args());
        let _ = std::io::stderr().lock().write_all(line.as_bytes());
    }

    fn flush(&self) {}
}

pub fn init(level: &str) {
    let filter = match level.to_ascii_uppercase().as_str() {
        "DEBUG" => LevelFilter::Debug,
        "WARNING" | "WARN" => LevelFilter::Warn,
        "ERROR" => LevelFilter::Error,
        "TRACE" => LevelFilter::Trace,
        _ => LevelFilter::Info,
    };
    if log::set_logger(&Stderr).is_ok() {
        log::set_max_level(filter);
    }
}

/// `YYYY-MM-DD HH:MM:SS` in UTC, without a date crate.
fn utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_utc(secs)
}

fn format_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn utc_format() {
        assert_eq!(super::format_utc(0), "1970-01-01 00:00:00");
        assert_eq!(super::format_utc(1_793_444_400), "2026-10-31 11:00:00");
        assert_eq!(super::format_utc(951_782_400), "2000-02-29 00:00:00");
    }
}
