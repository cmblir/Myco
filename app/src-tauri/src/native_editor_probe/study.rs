//! Actual deck baseline and recorded CAS commands through real Wry IPC.
//! Caller-submitted bytes are synthetic; generated-card meaning is not evaluated.

use super::{disk, invoke, sha, Report};
use serde_json::{json, Value};
use std::path::Path;

const ORIGINAL: &str = "# Synthetic human study heading\r\n\r\nQuestion ?? Answer\r\n<!-- Synthetic unknown comment -->\r\n";
const PATCHED: &str = "# Synthetic human study heading\r\n\r\nQuestion ?? Answer\r\n<!-- Synthetic unknown comment -->\r\n\r\nNew question ?? New answer\r\n";

pub(super) async fn verify(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    root: &Path,
    report: &mut Report,
) -> Result<(), String> {
    let path = root.join("cards/synthetic-native-study.md");
    let origin = invoke(app, window, "agent_vault_session", json!({}), report).await??;
    let absent = invoke(
        app,
        window,
        "read_study_deck",
        json!({"path":path,"origin":origin}),
        report,
    )
    .await??;
    let first_write = invoke(
        app,
        window,
        "write_study_deck",
        json!({"context":absent["context"],"content":""}),
        report,
    )
    .await??;
    let empty = invoke(
        app,
        window,
        "read_study_deck",
        json!({"path":path,"origin":origin}),
        report,
    )
    .await??;
    report.gate(
        "native_study_absence_and_empty",
        absent["revision"].is_null()
            && absent["raw"] == ""
            && absent["context"]["origin"] == origin
            && absent["context"]["snapshotId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
            && first_write["state"] == "persisted"
            && first_write["revision"] == sha(b"")
            && empty["revision"] == sha(b"")
            && empty["raw"] == ""
            && empty.get("mockOnly").is_none(),
        json!({"absent":absent,"empty":empty,"receipt":first_write}),
    )?;

    let original_receipt = invoke(
        app,
        window,
        "write_study_deck",
        json!({"context":empty["context"],"content":ORIGINAL}),
        report,
    )
    .await??;
    let baseline = invoke(
        app,
        window,
        "read_study_deck",
        json!({"path":path,"origin":origin}),
        report,
    )
    .await??;
    let competitor = invoke(
        app,
        window,
        "read_study_deck",
        json!({"path":path,"origin":origin}),
        report,
    )
    .await??;
    let receipt = invoke(
        app,
        window,
        "write_study_deck",
        json!({"context":baseline["context"],"content":PATCHED}),
        report,
    )
    .await??;
    report.gate(
        "native_study_persisted_receipt",
        original_receipt["revision"] == sha(ORIGINAL.as_bytes())
            && baseline["raw"] == ORIGINAL
            && baseline["revision"] == sha(ORIGINAL.as_bytes())
            && receipt["path"] == path.to_string_lossy().as_ref()
            && receipt["origin"] == origin
            && receipt["state"] == "persisted"
            && receipt["error"].is_null()
            && receipt["revision"] == sha(PATCHED.as_bytes())
            && receipt.get("mockOnly").is_none()
            && disk(&path)?["raw"] == PATCHED,
        json!({"baseline":baseline,"receipt":receipt,"disk":disk(&path)?}),
    )?;
    let conflict = invoke(
        app,
        window,
        "write_study_deck",
        json!({"context":competitor["context"],"content":"Stale overwrite\n"}),
        report,
    )
    .await?;
    report.gate("native_study_competing_snapshot_conflict", conflict.is_err() && disk(&path)?["raw"] == PATCHED,
        json!({"nativeError":conflict.err(),"disk":disk(&path)?,"simultaneousWriter":"native_unit_tests_only"}))?;
    invoke(
        app,
        window,
        "discard_study_deck_snapshot",
        json!({"context":competitor["context"]}),
        report,
    )
    .await??;

    let before_replace = invoke(
        app,
        window,
        "read_study_deck",
        json!({"path":path,"origin":origin}),
        report,
    )
    .await??;
    let held_backup = root.join("cards/synthetic-native-held-backup.md");
    std::fs::rename(&path, &held_backup).map_err(|error| error.to_string())?;
    std::fs::write(&path, PATCHED).map_err(|error| error.to_string())?;
    let replaced = invoke(
        app,
        window,
        "write_study_deck",
        json!({"context":before_replace["context"],"content":"Replacement overwrite\n"}),
        report,
    )
    .await?;
    report.gate("native_study_same_bytes_replacement_refused",
        replaced.is_err() && disk(&path)?["raw"] == PATCHED && disk(&held_backup)?["raw"] == PATCHED,
        json!({"nativeError":replaced.err(),"sameSha256":sha(PATCHED.as_bytes()),"disk":disk(&path)?}))?;
    invoke(
        app,
        window,
        "discard_study_deck_snapshot",
        json!({"context":before_replace["context"]}),
        report,
    )
    .await??;

    let fresh = invoke(
        app,
        window,
        "read_study_deck",
        json!({"path":path,"origin":origin}),
        report,
    )
    .await??;
    let mut forged = fresh["context"].clone();
    forged["revision"] = json!(sha(PATCHED.as_bytes()));
    let closed = invoke(
        app,
        window,
        "write_study_deck",
        json!({"context":forged,"content":"Forged"}),
        report,
    )
    .await?;
    report.gate(
        "native_study_closed_context_refused",
        closed
            .as_ref()
            .is_err_and(|error| error.contains("unknown field"))
            && disk(&path)?["raw"] == PATCHED,
        json!({"nativeError":closed.err()}),
    )?;

    invoke(app, window, "open_vault", json!({"path":root}), report).await??;
    let reopened = invoke(app, window, "agent_vault_session", json!({}), report).await??;
    let stale_read = invoke(
        app,
        window,
        "read_study_deck",
        json!({"path":path,"origin":origin}),
        report,
    )
    .await?;
    let stale_write = invoke(
        app,
        window,
        "write_study_deck",
        json!({"context":fresh["context"],"content":"Stale opening"}),
        report,
    )
    .await?;
    report.gate("native_study_reopening_refuses_old_snapshot",
        origin["openingToken"] != reopened["openingToken"] && stale_read.is_err() && stale_write.is_err()
            && disk(&path)?["raw"] == PATCHED,
        json!({"first":origin,"reopened":reopened,"readError":stale_read.err(),"writeError":stale_write.err()}))?;
    invoke(
        app,
        window,
        "discard_study_deck_snapshot",
        json!({"context":fresh["context"]}),
        report,
    )
    .await??;
    let release = invoke(
        app,
        window,
        "read_study_deck",
        json!({"path":path,"origin":reopened}),
        report,
    )
    .await??;
    let discarded = invoke(
        app,
        window,
        "discard_study_deck_snapshot",
        json!({"context":release["context"]}),
        report,
    )
    .await??;
    let twice = invoke(
        app,
        window,
        "discard_study_deck_snapshot",
        json!({"context":release["context"]}),
        report,
    )
    .await??;
    let after_discard = invoke(
        app,
        window,
        "write_study_deck",
        json!({"context":release["context"],"content":"Discarded"}),
        report,
    )
    .await?;
    report.gate(
        "native_study_discard_exact_snapshot",
        discarded == Value::Bool(true)
            && twice == Value::Bool(false)
            && after_discard.is_err()
            && disk(&path)?["raw"] == PATCHED,
        json!({"firstRelease":discarded,"secondRelease":twice,"writeError":after_discard.err()}),
    )?;
    let outside = invoke(
        app,
        window,
        "read_study_deck",
        json!({"path":root.join("raw/synthetic-source.md"),"origin":reopened}),
        report,
    )
    .await?;
    report.gate(
        "native_study_direct_path_confined",
        outside.is_err() && disk(&path)?["raw"] == PATCHED,
        json!({"nativeError":outside.err()}),
    )
}
