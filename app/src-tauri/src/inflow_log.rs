//! Append-only inflow ledger — the persistent answer to "how much came in,
//! per day, through which door". The in-memory MCP tool-call log
//! (`mcp_native::TOOL_CALLS`) only survives the process, so daily history
//! needs a file. One JSONL line per arrival (imports batch with `n`), four
//! producers (MCP write tools, clipper, voice capture, session import), one
//! reader (`inflow_daily`).
//!
//! Recording is strictly best-effort: the ledger is telemetry about an
//! ingest, never a participant in it — an append failure must not fail the
//! write it describes, so `record` swallows errors. The past before the
//! ledger existed is honestly blank; charts start where the file starts.

use serde::{Deserialize, Serialize};
use std::io::Write as _;
use std::path::Path;

pub const LOG_REL: &str = ".myco/inflow-log.jsonl";

#[derive(Serialize, Deserialize)]
struct Entry {
    at: u64,
    ch: String,
    kind: String,
    /// Batch size — a session sweep of 200 files is one line, not 200.
    #[serde(default = "one", skip_serializing_if = "is_one")]
    n: u32,
}

fn one() -> u32 {
    1
}
#[allow(clippy::trivially_copy_pass_by_ref)] // serde's skip_serializing_if contract
fn is_one(n: &u32) -> bool {
    *n == 1
}

/// Append one arrival. Best-effort by design (see module docs).
pub fn record(root: &Path, ch: &str, kind: &str) {
    record_n(root, ch, kind, 1);
}

pub fn record_n(root: &Path, ch: &str, kind: &str, n: u32) {
    if n == 0 {
        return;
    }
    let entry = Entry {
        at: now_secs(),
        ch: ch.to_string(),
        kind: kind.to_string(),
        n,
    };
    let Ok(line) = serde_json::to_string(&entry) else {
        return;
    };
    let path = root.join(LOG_REL);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{line}");
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One local day's arrivals by channel. `day` is `YYYY-MM-DD` in the
/// frontend's timezone (`tz_offset_min` = JS `Date.getTimezoneOffset()`,
/// same convention as `inflow_stats`).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InflowDay {
    pub day: String,
    pub mcp: u32,
    pub clipper: u32,
    pub voice: u32,
    pub import: u32,
}

/// The trailing `days` local days ending today, zero-filled — a quiet day is
/// a visible gap, not a missing bar. Unparseable lines are skipped: the
/// ledger is append-only across app versions and a bad line must never blank
/// the chart.
pub fn read_daily(root: &Path, days: u32, tz_offset_min: i32, now: u64) -> Vec<InflowDay> {
    let days = days.clamp(1, 400) as i64;
    // JS getTimezoneOffset is minutes to ADD to local to get UTC — subtract.
    let local = |secs: u64| secs as i64 - (tz_offset_min as i64) * 60;
    let today = local(now).div_euclid(86_400);
    let first = today - (days - 1);
    let mut out: Vec<InflowDay> = (0..days)
        .map(|i| InflowDay {
            day: ymd(first + i),
            mcp: 0,
            clipper: 0,
            voice: 0,
            import: 0,
        })
        .collect();
    let Ok(text) = std::fs::read_to_string(root.join(LOG_REL)) else {
        return out; // no ledger yet — an honestly empty chart
    };
    for line in text.lines() {
        let Ok(e) = serde_json::from_str::<Entry>(line) else {
            continue;
        };
        let idx = local(e.at).div_euclid(86_400) - first;
        if idx < 0 || idx >= days {
            continue;
        }
        let bucket = &mut out[idx as usize];
        match e.ch.as_str() {
            "mcp" => bucket.mcp += e.n,
            "clipper" => bucket.clipper += e.n,
            "voice" => bucket.voice += e.n,
            "import" => bucket.import += e.n,
            _ => {} // future channels render once the frontend knows them
        }
    }
    out
}

/// Civil date for a day number (days since epoch) — Hinnant's algorithm,
/// mirroring `distill::civil_from_days` (private there; 8 lines beat a
/// visibility change in the highest-risk module).
fn ymd(days_since_epoch: i64) -> String {
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_appends_and_read_buckets_by_local_day() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        record(root, "mcp", "add_raw_source");
        record(root, "clipper", "clip");
        record_n(root, "import", "session-sweep", 118);
        record_n(root, "import", "noop", 0); // 0 is never written

        let now = now_secs();
        let days = read_daily(root, 3, 0, now);
        assert_eq!(days.len(), 3);
        let today = &days[2];
        assert_eq!((today.mcp, today.clipper, today.import), (1, 1, 118));
        assert_eq!(days[0].mcp + days[0].clipper + days[0].import, 0);
    }

    #[test]
    fn timezone_offset_moves_the_day_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // 00:30 UTC on epoch day 20695 (2026-08-30).
        let at = 20_695_u64 * 86_400 + 1_800;
        std::fs::create_dir_all(root.join(".myco")).unwrap();
        std::fs::write(
            root.join(LOG_REL),
            format!("{{\"at\":{at},\"ch\":\"mcp\",\"kind\":\"x\"}}\n"),
        )
        .unwrap();
        // UTC reader anchored at the same instant: the entry is today.
        assert_eq!(read_daily(root, 1, 0, at)[0].mcp, 1);
        // KST (getTimezoneOffset -540): 09:30 local, still the same civil day.
        assert_eq!(read_daily(root, 1, -540, at)[0].mcp, 1);
        // UTC-2 (offset +120): the entry was 22:30 local on the PREVIOUS
        // civil day. A reader whose local clock has crossed midnight with a
        // 1-day window must NOT count it — yesterday's arrival.
        let later = 20_695_u64 * 86_400 + 2 * 3_600 + 600;
        assert_eq!(
            read_daily(root, 1, 120, later)[0].mcp,
            0,
            "22:30 local yesterday — not today"
        );
    }

    #[test]
    fn bad_lines_and_unknown_channels_never_blank_the_chart() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".myco")).unwrap();
        let now = now_secs();
        std::fs::write(
            root.join(LOG_REL),
            format!(
                "not json at all\n{{\"at\":{now},\"ch\":\"daemon\",\"kind\":\"x\"}}\n{{\"at\":{now},\"ch\":\"voice\",\"kind\":\"capture\"}}\n"
            ),
        )
        .unwrap();
        let days = read_daily(root, 1, 0, now);
        assert_eq!(days[0].voice, 1);
    }

    #[test]
    fn ymd_matches_known_dates() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(20_694), "2026-08-29");
        assert_eq!(ymd(20_696), "2026-08-31");
    }
}
