//! 崩溃报告: a local crash report, never sent anywhere.
//!
//! Privacy rule for this app: nothing leaves the machine unless the reader asks a
//! provider for a translation. A crash is exactly the moment a product is tempted
//! to phone home, so this module deliberately has no network code at all: it
//! writes one text file under `<data>/logs/`, keeps the newest few, and stops.
//!
//! The report is built by a pure function so the format is testable without
//! making the process panic.

use std::path::{Path, PathBuf};

/// How many crash files are kept; older ones are deleted on the next crash.
pub const KEEP: usize = 10;

/// The directory crash reports are written to.
pub fn report_dir() -> PathBuf { mirror_pdf_desktop::model::data_directory().join("logs") }

/// One report, as text. Kept separate from the filesystem so it can be tested.
pub fn format_report(version: &str, when: u64, message: &str, location: &str, log_tail: &[String]) -> String {
    let mut out = String::new();
    out.push_str("Mirror PDF crashed\n");
    out.push_str("=================\n\n");
    out.push_str(&format!("version : {version}\n"));
    out.push_str(&format!("when    : {when} (unix seconds)\n"));
    out.push_str(&format!("os      : {} {}\n", std::env::consts::OS, std::env::consts::ARCH));
    out.push_str(&format!("location: {location}\n"));
    out.push_str(&format!("message : {message}\n"));
    out.push_str("\nThis file stays on this computer. The app never uploads it.\n");
    if !log_tail.is_empty() {
        out.push_str("\nLast log lines\n--------------\n");
        for line in log_tail { out.push_str(line); out.push('\n'); }
    }
    out
}

/// Newest `KEEP` crash files, oldest first.
pub fn prune(dir: &Path) -> std::io::Result<usize> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("crash-") && name.ends_with(".txt")))
        .collect();
    files.sort();
    let mut removed = 0;
    while files.len() > KEEP {
        if std::fs::remove_file(files.remove(0)).is_ok() { removed += 1; }
    }
    Ok(removed)
}

/// Read the tail of the rolling log, so a report shows what led to the crash.
fn log_tail(lines: usize) -> Vec<String> {
    let path = report_dir().join("pdf-workspace.log");
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].iter().map(|line| (*line).to_string()).collect()
}

/// Install the hook. Call once, as early as possible in `main`.
pub fn install() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = if let Some(text) = info.payload().downcast_ref::<&str>() {
            (*text).to_string()
        } else if let Some(text) = info.payload().downcast_ref::<String>() {
            text.clone()
        } else {
            "non-string panic payload".to_string()
        };
        let location = info.location().map(|place| format!("{}:{}:{}", place.file(), place.line(), place.column())).unwrap_or_else(|| "unknown".into());
        let report = format_report(crate::APP_VERSION, now(), &message, &location, &log_tail(40));
        let dir = report_dir();
        if std::fs::create_dir_all(&dir).is_ok() {
            let path = dir.join(format!("crash-{}.txt", now()));
            let _ = std::fs::write(&path, report);
            let _ = prune(&dir);
        }
        previous(info);
    }));
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_carries_the_facts_and_promises_local_only() {
        let text = format_report("0.1.7", 1_700_000_000, "index out of bounds", "src/pdf_reader.rs:120:9", &["[1] start".to_string()]);
        assert!(text.contains("0.1.7"));
        assert!(text.contains("index out of bounds"));
        assert!(text.contains("src/pdf_reader.rs:120:9"));
        assert!(text.contains("[1] start"), "the log tail explains what led to the crash");
        assert!(text.contains("never uploads it"), "the privacy promise is part of the report");
    }

    #[test]
    fn a_report_without_a_log_tail_has_no_empty_section() {
        let text = format_report("0.1.7", 1, "boom", "x:1:1", &[]);
        assert!(!text.contains("Last log lines"));
    }

    #[test]
    fn pruning_keeps_the_newest_reports_and_removes_the_rest() {
        let dir = std::env::temp_dir().join(format!("mirror-crash-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create dir");
        for n in 0..(KEEP + 4) {
            std::fs::write(dir.join(format!("crash-{:08}.txt", n)), "x").expect("write report");
        }
        std::fs::write(dir.join("not-a-crash.txt"), "keep me").expect("write other");
        let removed = prune(&dir).expect("prune");
        assert_eq!(removed, 4);
        let left: Vec<String> = std::fs::read_dir(&dir).expect("read").filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left.iter().filter(|name| name.starts_with("crash-")).count(), KEEP);
        assert!(left.iter().any(|name| name == "not-a-crash.txt"), "other files are never touched");
        let _ = std::fs::remove_dir_all(dir);
    }
}
