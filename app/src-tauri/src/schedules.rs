// Recurring schedules (Feature 7). Persists per-vault digest schedules to
// `<vault>/.memex/schedules.json` and answers "is this due?" for the in-app
// timer. Digest *generation* runs in the TS layer (reuses the LLM stack); this
// module owns only the model + persistence + cadence math, so it stays pure and
// unit-testable without a Tauri runtime or a clock.
//
// v1 cadence is interval-based: `daily` = every 24h, `weekly[:dow]` = 7d,
// `monthly[:dom]` = 30d, `every:<n>h` = n hours. The optional day-of-week /
// day-of-month suffix is carried through for display but not yet used to pin the
// exact firing day (deferred — would need a date library); a schedule fires at
// or after its interval since `last_run`.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Schedule {
    pub id: String,
    pub title: String,
    /// "query" | "changed" | "stale" | "topic".
    pub kind: String,
    /// Free prompt (query) or topic string; unused for `changed`/`stale`.
    #[serde(default)]
    pub prompt: String,
    /// "daily" | "weekly[:dow]" | "monthly[:dom]" | "every:<n>h".
    pub cadence: String,
    /// Vault-relative output folder (default "digests").
    #[serde(default)]
    pub output_dir: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub notify: bool,
    /// Epoch seconds of the last successful run, or None if never run.
    #[serde(default)]
    pub last_run: Option<i64>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// The interval, in seconds, implied by a cadence string. Unknown → daily.
pub fn interval_secs(cadence: &str) -> i64 {
    let base = cadence.split(':').next().unwrap_or("daily");
    match base {
        "every" => {
            // every:<n>h
            let n = cadence
                .split(':')
                .nth(1)
                .and_then(|s| s.trim_end_matches('h').parse::<i64>().ok())
                .filter(|n| *n > 0)
                .unwrap_or(24);
            n * 3600
        }
        "weekly" => 7 * 86400,
        "monthly" => 30 * 86400,
        _ => 86400, // daily / unknown
    }
}

/// Whether a schedule is due at `now` (epoch seconds) given its `last_run`.
pub fn is_due(cadence: &str, last_run: Option<i64>, now: i64) -> bool {
    match last_run {
        None => true,
        Some(last) => now - last >= interval_secs(cadence),
    }
}

fn dir(root: &Path) -> PathBuf {
    root.join(".memex")
}

pub fn schedules_path(root: &Path) -> PathBuf {
    dir(root).join("schedules.json")
}

pub fn load(root: &Path) -> Vec<Schedule> {
    let path = schedules_path(root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Atomic write: stage to a temp file in the same dir, then rename over target.
pub fn save(root: &Path, schedules: &[Schedule]) -> Result<(), String> {
    let d = dir(root);
    std::fs::create_dir_all(&d).map_err(|e| format!("create .memex dir: {e}"))?;
    let raw = serde_json::to_string_pretty(schedules).map_err(|e| format!("serialize: {e}"))?;
    let target = schedules_path(root);
    let tmp = d.join(".schedules.json.tmp");
    std::fs::write(&tmp, raw.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Insert or replace a schedule by id, returning the new list.
pub fn upsert(root: &Path, schedule: Schedule) -> Result<Vec<Schedule>, String> {
    let mut list = load(root);
    match list.iter_mut().find(|s| s.id == schedule.id) {
        Some(existing) => *existing = schedule,
        None => list.push(schedule),
    }
    save(root, &list)?;
    Ok(list)
}

pub fn delete(root: &Path, id: &str) -> Result<Vec<Schedule>, String> {
    let mut list = load(root);
    list.retain(|s| s.id != id);
    save(root, &list)?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_secs_parses_cadences() {
        assert_eq!(interval_secs("daily"), 86400);
        assert_eq!(interval_secs("weekly:1"), 7 * 86400);
        assert_eq!(interval_secs("monthly:15"), 30 * 86400);
        assert_eq!(interval_secs("every:6h"), 6 * 3600);
        assert_eq!(interval_secs("every:bogus"), 24 * 3600); // fallback
        assert_eq!(interval_secs("nonsense"), 86400);
    }

    #[test]
    fn is_due_never_run_is_always_due() {
        assert!(is_due("daily", None, 1_000_000));
    }

    #[test]
    fn is_due_respects_interval() {
        let now = 1_000_000;
        // daily: due only after 24h.
        assert!(!is_due("daily", Some(now - 3600), now));
        assert!(is_due("daily", Some(now - 90_000), now));
        // every:6h.
        assert!(!is_due("every:6h", Some(now - 5 * 3600), now));
        assert!(is_due("every:6h", Some(now - 7 * 3600), now));
    }

    fn temp_root(tag: u64) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "memex-sched-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn sample(id: &str) -> Schedule {
        Schedule {
            id: id.into(),
            title: "Weekly review".into(),
            kind: "changed".into(),
            prompt: String::new(),
            cadence: "weekly:1".into(),
            output_dir: "digests".into(),
            provider: "anthropic-cli".into(),
            model: "sonnet".into(),
            notify: false,
            last_run: None,
            enabled: true,
        }
    }

    #[test]
    fn save_load_roundtrip() {
        let root = temp_root(1);
        assert!(load(&root).is_empty());
        save(&root, &[sample("a"), sample("b")]).unwrap();
        let back = load(&root);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].title, "Weekly review");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn upsert_replaces_and_delete_removes() {
        let root = temp_root(2);
        upsert(&root, sample("a")).unwrap();
        let mut s = sample("a");
        s.title = "Renamed".into();
        let list = upsert(&root, s).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "Renamed");
        let after = delete(&root, "a").unwrap();
        assert!(after.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
