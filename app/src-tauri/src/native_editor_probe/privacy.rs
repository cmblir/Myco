//! Actual completion and legacy custody checks in the isolated native QA profile.

use super::{disk, invoke, rejected, sha, Report, A, B, DRAFT};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub(super) struct Snapshot {
    primary: PathBuf,
    raw: String,
    directory: PathBuf,
}

fn isolated_settings(root: &Path, settings: &Path) -> bool {
    root.parent()
        .is_some_and(|sandbox| settings == sandbox.join("data"))
}

pub(super) fn capture(root: &Path, note: &Path, checkpoint: &Value) -> Result<Snapshot, String> {
    let settings = crate::settings::settings_dir()?;
    if !isolated_settings(root, &settings) {
        return Err("editor privacy probe requires isolated synthetic app-data".into());
    }
    let directory = settings.join("editor-recovery");
    let entries = std::fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if entries.len() != 1 {
        return Err("editor privacy probe requires exactly one native checkpoint".into());
    }
    let primary = entries[0].clone();
    let bytes = crate::index_publication::read_snapshot(&primary)?
        .ok_or("native checkpoint disappeared before capture")?
        .bytes;
    let journal: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if journal["version"] != 1
        || journal["canonicalVault"] != root.to_string_lossy().as_ref()
        || journal["recovery"] != *checkpoint
        || journal["recovery"]["path"] != note.to_string_lossy().as_ref()
    {
        return Err("editor privacy probe capture differs from native checkpoint".into());
    }
    Ok(Snapshot {
        primary,
        raw: String::from_utf8(bytes).map_err(|error| error.to_string())?,
        directory,
    })
}

fn contains_retired_raw(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains(A) || text.contains(DRAFT),
        Value::Array(values) => values.iter().any(contains_retired_raw),
        Value::Object(values) => values.values().any(contains_retired_raw),
        _ => false,
    }
}

fn raw_free(directory: &Path) -> Result<bool, String> {
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let bytes = crate::index_publication::read_snapshot(&path)?
            .ok_or("completion record disappeared during privacy check")?
            .bytes;
        let record: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if contains_retired_raw(&record) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) async fn verify(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    root: &Path,
    report: &mut Report,
    origin: &Value,
    checkpoint: &Value,
    captured: Snapshot,
) -> Result<(), String> {
    let note = root.join("wiki/synthetic-note.md");
    let nonce = checkpoint["revision"]
        .as_str()
        .ok_or("checkpoint nonce missing")?;
    let key = captured
        .primary
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("checkpoint key missing")?;
    let completed = captured
        .directory
        .join(format!("{key}.{nonce}.committed.json"));
    let current = crate::index_publication::read_snapshot(&completed)?
        .ok_or("completed native record missing")?;
    let receipt: Value =
        serde_json::from_slice(&current.bytes).map_err(|error| error.to_string())?;
    report.gate(
        "completed_draft_payload_removed",
        receipt["version"] == 2
            && receipt["revision"] == nonce
            && receipt["journalSha256"] == sha(captured.raw.as_bytes())
            && raw_free(&captured.directory)?
            && !captured.primary.exists()
            && disk(&note)?["raw"] == B,
        json!({"receipt":receipt,"actualPrivatePayloadRawFree":true,"disk":disk(&note)?}),
    )?;

    // Only this synthetic profile is changed. The old bytes came from actual stage IPC.
    crate::vault::write_file_if_unchanged_recorded(
        &completed.to_string_lossy(),
        &captured.raw,
        Some(&sha(&current.bytes)),
    )?;
    let destination = root.join("moved");
    let mutations = [
        (
            "rename_path",
            json!({"from":note,"toName":"synthetic-renamed.md"}),
        ),
        ("move_path", json!({"from":note,"toDir":destination})),
        ("delete_path", json!({"path":note,"expectedPermanent":null})),
        (
            "trash_paths",
            json!({"paths":[root.join("wiki")],"expectedPermanent":null}),
        ),
    ];
    let mut outcomes = Vec::new();
    for (command, arguments) in mutations {
        let reply = invoke(app, window, command, arguments, report).await?;
        let refused = rejected(&reply, "completed editor recovery");
        outcomes.push(json!({"command":command,"refused":refused,"nativeError":reply.err()}));
    }
    let retained = crate::index_publication::read_snapshot(&completed)?
        .ok_or("legacy completion disappeared during refusal")?;
    report.gate(
        "legacy_completed_raw_blocks_reader_path_mutations",
        outcomes.iter().all(|outcome| outcome["refused"] == true)
            && retained.bytes == captured.raw.as_bytes()
            && disk(&note)?["raw"] == B
            && destination
                .read_dir()
                .map_err(|error| error.to_string())?
                .next()
                .is_none(),
        json!({"mutations":outcomes,"legacyRecordSha256":sha(&retained.bytes),"disk":disk(&note)?}),
    )?;
    let repaired = invoke(
        app,
        window,
        "retire_editor_draft",
        json!({"path":note,"origin":origin,"expectedJournalRevision":nonce}),
        report,
    )
    .await??;
    let absent = invoke(
        app,
        window,
        "read_editor_draft",
        json!({"path":note,"origin":origin}),
        report,
    )
    .await??;
    let replay = invoke(
        app,
        window,
        "retire_editor_draft",
        json!({"path":note,"origin":origin,"expectedJournalRevision":nonce}),
        report,
    )
    .await??;
    report.gate(
        "legacy_completion_exact_nonce_repair",
        repaired.is_null()
            && replay.is_null()
            && absent.is_null()
            && raw_free(&captured.directory)?
            && disk(&note)?["raw"] == B,
        json!({"repair":repaired,"exactNonceReplay":replay,"discovery":absent,
            "actualPrivatePayloadRawFree":true,"legacyUi":"not_run","disk":disk(&note)?}),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::isolated_settings;
    use std::path::Path;

    #[test]
    fn accepts_only_the_sandbox_app_data_sibling() {
        let root = Path::new("/synthetic/editor-qa/vault");
        assert!(isolated_settings(
            root,
            Path::new("/synthetic/editor-qa/data")
        ));
    }

    #[test]
    fn rejects_nested_or_unrelated_app_data() {
        let root = Path::new("/synthetic/editor-qa/vault");
        for settings in [
            "/synthetic/editor-qa/vault/data",
            "/synthetic/editor-qa/data/child",
            "/synthetic/editor-qa/data-neighbor",
            "/synthetic/another-qa/data",
        ] {
            assert!(!isolated_settings(root, Path::new(settings)), "{settings}");
        }
        assert!(!isolated_settings(Path::new("/"), Path::new("/data")));
    }
}
