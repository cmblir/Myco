// Recurring schedules (Feature 7). Persists per-vault digest schedules to
// `<vault>/.myco/schedules.json` and answers "is this due?" for the in-app
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
    crate::vault_dir::dir(root)
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
    std::fs::create_dir_all(&d).map_err(|e| format!("create {} dir: {e}", crate::vault_dir::DIR_NAME))?;
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

// ---- macOS launchd background install (Feature 7, opt-in) ----------------
//
// Installing a background schedule writes a LaunchAgent plist that runs the
// Python digest runner on the cadence interval, so digests fire even when the
// app is closed. Gated behind an explicit UI opt-in. macOS only for now.

/// Sanitize a schedule id into a reverse-DNS-safe label component.
fn safe_label_component(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The LaunchAgent label for a schedule (stable, so re-install replaces).
pub fn launch_label(id: &str) -> String {
    format!("dev.cmblir.myco.digest.{}", safe_label_component(id))
}

/// The label used before the myco rename. Only ever used to find and remove an
/// agent an existing install already has: renaming alone would leave the old
/// LaunchAgent loaded and firing forever, so the user would get every digest
/// twice — once from the old plist and once from the new one.
pub fn legacy_launch_label(id: &str) -> String {
    format!("dev.cmblir.memex.digest.{}", safe_label_component(id))
}

/// One step of the launchd migration, returned as data so the ordering is
/// unit-testable without invoking `launchctl`.
#[derive(Debug, PartialEq, Eq)]
pub enum LegacyAgentStep {
    /// `launchctl unload -w <plist>` — stop the old agent before its plist goes.
    Unload(PathBuf),
    /// Delete the old plist so it cannot be reloaded at the next login.
    Delete(PathBuf),
}

/// What must happen to a schedule's pre-rename LaunchAgent once the renamed one
/// is in place. Empty when the old plist is absent (fresh install, or the
/// migration already ran) — that is what makes this a no-op the second time.
pub fn legacy_agent_steps(
    agents_dir: &Path,
    id: &str,
    legacy_plist_exists: bool,
) -> Vec<LegacyAgentStep> {
    if !legacy_plist_exists {
        return Vec::new();
    }
    let plist = agents_dir.join(format!("{}.plist", legacy_launch_label(id)));
    vec![
        LegacyAgentStep::Unload(plist.clone()),
        LegacyAgentStep::Delete(plist),
    ]
}

/// One step of installing a schedule's renamed LaunchAgent, in the order they
/// must run. Returned as data so the I1 ordering invariant is unit-testable
/// without invoking `launchctl`.
#[derive(Debug, PartialEq, Eq)]
pub enum InstallStep {
    /// Write the renamed plist. Failing here aborts the install.
    WriteNew(PathBuf),
    /// `launchctl unload` (any prior copy) then `load -w`. Failing here aborts.
    LoadNew(PathBuf),
    /// Retire the pre-rename agent — only reached once the new one is loaded.
    RetireLegacy(LegacyAgentStep),
}

/// The ordered install plan for a schedule.
///
/// I1: the legacy agent is retired LAST, and only if every preceding step
/// succeeded. The previous order unloaded and deleted the legacy plist first,
/// so a failure to write or load the new one (disk full, LaunchAgents
/// permissions, an MDM policy) — or a crash in between — left the user with no
/// agent at all. And because `migrate_legacy_agents` keys off `legacy.exists()`,
/// which was by then false, the schedule was skipped on every later launch:
/// the background digest disappeared permanently with no UI signal and no
/// retry. Retiring last means a failed install leaves the OLD agent loaded and
/// firing, and leaves its plist on disk, so the next vault open tries again.
pub fn install_plan(agents_dir: &Path, id: &str, legacy_plist_exists: bool) -> Vec<InstallStep> {
    let plist = agents_dir.join(format!("{}.plist", launch_label(id)));
    let mut steps = vec![
        InstallStep::WriteNew(plist.clone()),
        InstallStep::LoadNew(plist),
    ];
    steps.extend(
        legacy_agent_steps(agents_dir, id, legacy_plist_exists)
            .into_iter()
            .map(InstallStep::RetireLegacy),
    );
    steps
}

/// Build a LaunchAgent plist XML. Pure, so its shape is unit-testable. When
/// `path_env` is non-empty it is set as the job's PATH — launchd gives a
/// stripped environment, so without this the runner can't find `claude`/tools.
pub fn plist_xml(
    label: &str,
    program_args: &[String],
    interval_secs: i64,
    log_path: &str,
    path_env: &str,
) -> String {
    let args: String = program_args
        .iter()
        .map(|a| format!("    <string>{}</string>\n", xml_escape(a)))
        .collect();
    let env_block = if path_env.is_empty() {
        String::new()
    } else {
        format!(
            "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key><string>{}</string>\n  </dict>\n",
            xml_escape(path_env)
        )
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{args}  </array>
  <key>StartInterval</key><integer>{interval_secs}</integer>
  <key>RunAtLoad</key><false/>
{env_block}  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
        label = xml_escape(label),
        args = args,
        interval_secs = interval_secs,
        env_block = env_block,
        log = xml_escape(log_path),
    )
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// PATH to hand the launchd job: common install dirs (where claude/python/git
/// live) prepended to the inherited PATH, since launchd strips it down.
#[cfg(target_os = "macos")]
fn path_env() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs = vec![
        format!("{home}/.local/bin"),
        format!("{home}/.claude/local"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ];
    if let Ok(p) = std::env::var("PATH") {
        dirs.push(p);
    }
    dirs.join(":")
}

#[cfg(target_os = "macos")]
fn launch_agents_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(std::path::PathBuf::from(home).join("Library/LaunchAgents"))
}

/// Install (or remove) the LaunchAgent for a schedule. `on=false` unloads +
/// deletes the plist. Returns a human-readable status line.
#[cfg(target_os = "macos")]
pub fn install_background(
    root: &Path,
    python: &str,
    script: &str,
    id: &str,
    interval_secs: i64,
    on: bool,
) -> Result<String, String> {
    use std::process::Command;
    let label = launch_label(id);
    let dir = launch_agents_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create LaunchAgents dir: {e}"))?;
    let plist = dir.join(format!("{label}.plist"));
    let legacy_exists = dir
        .join(format!("{}.plist", legacy_launch_label(id)))
        .exists();

    // The pre-rename plist is already installed on the user's machine and keeps
    // firing under its own label, so it has to go — but only ever as the LAST
    // step of a install that already worked. See `install_plan`.
    let retire_legacy = |steps: Vec<LegacyAgentStep>| {
        for step in steps {
            match step {
                LegacyAgentStep::Unload(p) => {
                    let _ = Command::new("launchctl")
                        .arg("unload")
                        .arg("-w")
                        .arg(&p)
                        .output();
                }
                LegacyAgentStep::Delete(p) => {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    };

    if !on {
        // Removal: nothing can be stranded, since the user asked for no agent.
        let _ = Command::new("launchctl")
            .arg("unload")
            .arg("-w")
            .arg(&plist)
            .output();
        let _ = std::fs::remove_file(&plist);
        retire_legacy(legacy_agent_steps(&dir, id, legacy_exists));
        return Ok(format!("background schedule removed ({label})"));
    }

    let log = crate::vault_dir::dir(root).join(format!("digest-{id}.log"));
    let args = vec![
        python.to_string(),
        script.to_string(),
        "--vault".to_string(),
        root.to_string_lossy().into_owned(),
        "--schedule".to_string(),
        id.to_string(),
    ];
    let xml = plist_xml(
        &label,
        &args,
        interval_secs,
        &log.to_string_lossy(),
        &path_env(),
    );

    let mut legacy_steps = Vec::new();
    for step in install_plan(&dir, id, legacy_exists) {
        match step {
            InstallStep::WriteNew(p) => {
                std::fs::write(&p, xml.as_bytes()).map_err(|e| format!("write plist: {e}"))?;
            }
            InstallStep::LoadNew(p) => {
                // Reload: unload any prior version, then load with -w (persist
                // across logins).
                let _ = Command::new("launchctl").arg("unload").arg(&p).output();
                let out = Command::new("launchctl")
                    .arg("load")
                    .arg("-w")
                    .arg(&p)
                    .output()
                    .map_err(|e| format!("launchctl load: {e}"))?;
                if !out.status.success() {
                    return Err(format!(
                        "launchctl load failed: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                }
            }
            // Collected, not run inline: `?` above must be able to return
            // without any legacy step having executed.
            InstallStep::RetireLegacy(s) => legacy_steps.push(s),
        }
    }
    retire_legacy(legacy_steps);
    Ok(format!(
        "background schedule installed ({label}, every {interval_secs}s)"
    ))
}

/// Retire every pre-rename LaunchAgent in this vault and re-install it under the
/// new label (M3). Called on vault open; a no-op once no legacy plist is left.
///
/// Only schedules that actually have an old plist are touched, and the old agent
/// is retired as the LAST step of an install that already succeeded (see
/// `install_plan`). So a failed install leaves the OLD agent loaded and its
/// plist on disk — the user keeps getting digests, and because this function
/// keys off exactly that plist, the next vault open retries. The caller must
/// still skip this entirely when it cannot resolve `python`/`script`.
///
/// DEFERRED (M3 sweep): this only runs for a vault the user actually re-opens.
/// A vault that is never opened again keeps its pre-rename agent forever —
/// harmless (the old runner still works) but it means the rename is not fully
/// complete until every vault has been visited. A later stage should sweep
/// `~/Library/LaunchAgents` for the legacy label prefix directly.
#[cfg(target_os = "macos")]
pub fn migrate_legacy_agents(root: &Path, python: &str, script: &str) -> Vec<String> {
    let Ok(dir) = launch_agents_dir() else {
        return Vec::new();
    };
    let mut warnings = Vec::new();
    for sched in load(root) {
        let legacy = dir.join(format!("{}.plist", legacy_launch_label(&sched.id)));
        if !legacy.exists() {
            continue;
        }
        // install_background writes and loads the renamed plist first, and only
        // then unloads + deletes the legacy one.
        if let Err(e) = install_background(
            root,
            python,
            script,
            &sched.id,
            interval_secs(&sched.cadence),
            true,
        ) {
            warnings.push(format!("schedule {}: {e}", sched.id));
        }
    }
    warnings
}

#[cfg(not(target_os = "macos"))]
pub fn migrate_legacy_agents(_root: &Path, _python: &str, _script: &str) -> Vec<String> {
    Vec::new()
}

#[cfg(not(target_os = "macos"))]
pub fn install_background(
    _root: &Path,
    _python: &str,
    _script: &str,
    _id: &str,
    _interval_secs: i64,
    _on: bool,
) -> Result<String, String> {
    Err("background schedules are only supported on macOS for now".into())
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
    fn launch_label_is_dns_safe() {
        assert_eq!(launch_label("sch-abc123"), "dev.cmblir.myco.digest.sch-abc123");
        assert_eq!(launch_label("a/b c"), "dev.cmblir.myco.digest.a-b-c");
    }

    #[test]
    fn legacy_label_matches_what_old_builds_installed() {
        // These labels name plists already on the user's machine — if this
        // string is wrong the old agent is never found and fires forever.
        assert_eq!(
            legacy_launch_label("sch-abc123"),
            "dev.cmblir.memex.digest.sch-abc123"
        );
        assert_eq!(legacy_launch_label("a/b c"), "dev.cmblir.memex.digest.a-b-c");
        assert_ne!(legacy_launch_label("x"), launch_label("x"));
    }

    #[test]
    fn legacy_agent_is_unloaded_before_its_plist_is_deleted() {
        let dir = PathBuf::from("/Users/u/Library/LaunchAgents");
        let steps = legacy_agent_steps(&dir, "s1", true);
        let plist = dir.join("dev.cmblir.memex.digest.s1.plist");
        // Order matters: deleting the plist first would leave the job loaded in
        // launchd with no file to boot it out by, so it keeps firing.
        assert_eq!(
            steps,
            vec![
                LegacyAgentStep::Unload(plist.clone()),
                LegacyAgentStep::Delete(plist)
            ]
        );
    }

    #[test]
    fn legacy_agent_is_retired_only_after_the_renamed_one_is_loaded() {
        // I1: retiring the legacy agent first meant a failed write/load left the
        // user with NO agent, and — since the legacy plist was already gone —
        // migrate_legacy_agents skipped that schedule forever. The new agent
        // must therefore be written and loaded before anything legacy is touched.
        let dir = PathBuf::from("/Users/u/Library/LaunchAgents");
        let plan = install_plan(&dir, "s1", true);
        let new_plist = dir.join("dev.cmblir.myco.digest.s1.plist");
        let old_plist = dir.join("dev.cmblir.memex.digest.s1.plist");
        assert_eq!(
            plan,
            vec![
                InstallStep::WriteNew(new_plist.clone()),
                InstallStep::LoadNew(new_plist),
                InstallStep::RetireLegacy(LegacyAgentStep::Unload(old_plist.clone())),
                InstallStep::RetireLegacy(LegacyAgentStep::Delete(old_plist)),
            ]
        );
    }

    #[test]
    fn install_plan_without_a_legacy_agent_is_just_write_then_load() {
        let dir = PathBuf::from("/Users/u/Library/LaunchAgents");
        let plan = install_plan(&dir, "s1", false);
        assert_eq!(plan.len(), 2);
        assert!(!plan
            .iter()
            .any(|s| matches!(s, InstallStep::RetireLegacy(_))));
    }

    #[test]
    fn legacy_agent_steps_are_empty_when_the_old_plist_is_absent() {
        // Fresh install, or the migration already ran — must be a no-op.
        let dir = PathBuf::from("/Users/u/Library/LaunchAgents");
        assert!(legacy_agent_steps(&dir, "s1", false).is_empty());
    }

    #[test]
    fn plist_xml_embeds_args_interval_and_escapes() {
        let args = vec![
            "/usr/bin/python3".to_string(),
            "/res/automation/digest.py".to_string(),
            "--vault".to_string(),
            "/v & co".to_string(),
        ];
        let xml = plist_xml("dev.cmblir.myco.digest.s1", &args, 86400, "/v/.memex/d.log", "/usr/bin:/bin");
        assert!(xml.contains("<key>PATH</key><string>/usr/bin:/bin</string>"));
        assert!(xml.contains("<key>Label</key><string>dev.cmblir.myco.digest.s1</string>"));
        assert!(xml.contains("<integer>86400</integer>"));
        assert!(xml.contains("<string>/res/automation/digest.py</string>"));
        // & in an arg must be XML-escaped, not raw.
        assert!(xml.contains("/v &amp; co"));
        assert!(xml.contains("<false/>")); // RunAtLoad off
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
