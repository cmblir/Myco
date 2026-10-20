use super::{
    append_distill_manifest_dispatch, archive_publication_dispatch, undo_distill_run_dispatch,
    AgentVaultSession, VaultRoot,
};
use crate::distill::ArchivePublication;
use crate::distill_publication::{DistillPublicationRegistry, ManagedArtifact};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn open(state: &VaultRoot, root: &Path) -> AgentVaultSession {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.to_path_buf(), || ())
        .unwrap();
    state.snapshot().unwrap()
}

fn fixture() -> (tempfile::TempDir, PathBuf, VaultRoot, AgentVaultSession) {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("daily")).unwrap();
    let state = VaultRoot::default();
    let origin = open(&state, &root);
    (fixture, root, state, origin)
}

fn forged_created_claim(path: &str, bytes: &[u8]) -> ArchivePublication {
    ArchivePublication {
        path: path.into(),
        revision: format!("{:x}", Sha256::digest(bytes)),
        created: true,
    }
}

#[test]
fn publication_native_boundary_preserves_human_note_after_forged_created_claim() {
    let (_fixture, root, state, origin) = fixture();
    let path = "daily/2026-08-10.md";
    std::fs::write(root.join(path), "human note").unwrap();
    let result = append_distill_manifest_dispatch(
        &state,
        &DistillPublicationRegistry::default(),
        &origin.vault_path,
        &origin,
        "llm-901",
        vec![],
        vec![path.into()],
        vec![forged_created_claim(path, b"human note")],
        &[],
    );
    if result.is_ok() {
        crate::distill::undo(&root, "llm-901").unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(root.join(path)).ok().as_deref(),
        Some("human note")
    );
    assert!(
        result.is_err(),
        "frontend created=true cannot establish native ownership"
    );
}

#[cfg(unix)]
#[test]
fn publication_native_boundary_preserves_same_content_replacement_inode() {
    let (_fixture, root, state, origin) = fixture();
    let path = "daily/2026-08-10.md";
    std::fs::write(root.join(path), "same bytes").unwrap();
    let result = append_distill_manifest_dispatch(
        &state,
        &DistillPublicationRegistry::default(),
        &origin.vault_path,
        &origin,
        "llm-902",
        vec![],
        vec![path.into()],
        vec![forged_created_claim(path, b"same bytes")],
        &[],
    );
    let replacement = root.join("replacement.md");
    std::fs::write(&replacement, "same bytes").unwrap();
    std::fs::rename(&replacement, root.join(path)).unwrap();
    if result.is_ok() {
        crate::distill::undo(&root, "llm-902").unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(root.join(path)).ok().as_deref(),
        Some("same bytes")
    );
}

#[test]
fn publication_native_boundary_genuine_creation_appends_once_and_consumes_on_undo() {
    let (_fixture, root, state, origin) = fixture();
    let registry = DistillPublicationRegistry::default();
    let proof = crate::distill_publication::publish(
        &state,
        &registry,
        &origin,
        "llm-903",
        &ManagedArtifact::Daily {
            key: "2026-08-10".into(),
        },
        "native digest",
        None,
    )
    .unwrap();
    let claims = vec![forged_created_claim(&proof.path, b"native digest")];
    for _ in 0..2 {
        append_distill_manifest_dispatch(
            &state,
            &registry,
            &origin.vault_path,
            &origin,
            "llm-903",
            vec![],
            vec![proof.path.clone()],
            claims.clone(),
            std::slice::from_ref(&proof.publication_id),
        )
        .unwrap();
    }
    let history: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join(".myco/distill-runs/llm-903.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(history["created"].as_array().unwrap().len(), 1);
    assert_eq!(
        undo_distill_run_dispatch(&state, &registry, &origin.vault_path, &origin, "llm-903")
            .unwrap(),
        1
    );
    assert!(!root.join(&proof.path).exists());
    assert!(append_distill_manifest_dispatch(
        &state,
        &registry,
        &origin.vault_path,
        &origin,
        "llm-903",
        vec![],
        vec![proof.path],
        claims,
        &[proof.publication_id]
    )
    .is_err());
}

#[cfg(unix)]
#[test]
fn publication_native_boundary_genuine_receipt_preserves_replacement_inode() {
    let (_fixture, root, state, origin) = fixture();
    let registry = DistillPublicationRegistry::default();
    let proof = crate::distill_publication::publish(
        &state,
        &registry,
        &origin,
        "llm-904",
        &ManagedArtifact::Daily {
            key: "2026-08-10".into(),
        },
        "same bytes",
        None,
    )
    .unwrap();
    append_distill_manifest_dispatch(
        &state,
        &registry,
        &origin.vault_path,
        &origin,
        "llm-904",
        vec![],
        vec![proof.path.clone()],
        vec![forged_created_claim(&proof.path, b"same bytes")],
        &[proof.publication_id],
    )
    .unwrap();
    std::fs::write(root.join("replacement.md"), "same bytes").unwrap();
    std::fs::rename(root.join("replacement.md"), root.join(&proof.path)).unwrap();
    assert!(
        undo_distill_run_dispatch(&state, &registry, &origin.vault_path, &origin, "llm-904")
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(root.join(proof.path)).unwrap(),
        "same bytes"
    );
}

#[test]
fn publication_native_boundary_archive_requires_capability_and_defers_unknown_move_undo() {
    let (_fixture, root, state, origin) = fixture();
    let registry = DistillPublicationRegistry::default();
    std::fs::create_dir(root.join("sessions")).unwrap();
    std::fs::write(root.join("sessions/source.md"), "source original").unwrap();
    let proof = crate::distill_publication::publish(
        &state,
        &registry,
        &origin,
        "llm-905",
        &ManagedArtifact::Daily {
            key: "2026-08-10".into(),
        },
        "native digest",
        None,
    )
    .unwrap();
    let claims = vec![forged_created_claim(&proof.path, b"native digest")];
    let dispatch = |root: &Path, proven: Vec<ArchivePublication>| {
        crate::distill::archive_digested_sessions_with_context(
            root,
            "2026-08-10",
            &["sessions/source.md".into()],
            Some(&[crate::distill::content_fingerprint(b"source original")]),
            Some(&crate::distill::ArchiveContext {
                manifest_id: "llm-905".into(),
                publications: proven,
            }),
        )
    };
    assert!(archive_publication_dispatch(
        &state,
        &registry,
        &origin.vault_path,
        &origin,
        "llm-905",
        &[],
        &claims,
        dispatch
    )
    .is_err());
    assert!(root.join("sessions/source.md").exists());
    assert!(!root.join("sessions/archive").exists());
    let moved = archive_publication_dispatch(
        &state,
        &registry,
        &origin.vault_path,
        &origin,
        "llm-905",
        &[proof.publication_id],
        &claims,
        dispatch,
    )
    .unwrap();
    assert_eq!(moved.moved.len(), 1);
    assert!(
        undo_distill_run_dispatch(&state, &registry, &origin.vault_path, &origin, "llm-905")
            .unwrap_err()
            .contains("private native move receipts")
    );
    assert_eq!(
        std::fs::read_to_string(root.join(&moved.moved[0].to)).unwrap(),
        "source original"
    );
    assert_eq!(
        std::fs::read_to_string(root.join(proof.path)).unwrap(),
        "native digest"
    );
}

#[test]
fn publication_native_boundary_stale_opening_cannot_publish_append_or_undo() {
    let (_fixture, root, state, origin) = fixture();
    let registry = DistillPublicationRegistry::default();
    let proof = crate::distill_publication::publish(
        &state,
        &registry,
        &origin,
        "llm-906",
        &ManagedArtifact::Daily {
            key: "2026-08-10".into(),
        },
        "native digest",
        None,
    )
    .unwrap();
    let current = open(&state, &root);
    assert!(crate::distill_publication::publish(
        &state,
        &registry,
        &origin,
        "llm-906",
        &ManagedArtifact::Daily {
            key: "2026-08-10".into()
        },
        "native digest",
        None
    )
    .is_err());
    for source_origin in [&origin, &current] {
        assert!(append_distill_manifest_dispatch(
            &state,
            &registry,
            &source_origin.vault_path,
            source_origin,
            "llm-906",
            vec![],
            vec![proof.path.clone()],
            vec![forged_created_claim(&proof.path, b"native digest")],
            std::slice::from_ref(&proof.publication_id)
        )
        .is_err());
        assert!(undo_distill_run_dispatch(
            &state,
            &registry,
            &source_origin.vault_path,
            source_origin,
            "llm-906"
        )
        .is_err());
    }
    assert_eq!(
        std::fs::read_to_string(root.join(proof.path)).unwrap(),
        "native digest"
    );
    assert!(!root.join(".myco/distill-runs/llm-906.json").exists());
}

#[test]
fn publication_native_boundary_valid_human_update_token_cannot_forge_created_authority() {
    let (_fixture, root, state, origin) = fixture();
    let registry = DistillPublicationRegistry::default();
    std::fs::write(root.join("daily/2026-08-10.md"), "human original").unwrap();
    let expected = format!("{:x}", Sha256::digest(b"human original"));
    let proof = crate::distill_publication::publish(
        &state,
        &registry,
        &origin,
        "llm-907",
        &ManagedArtifact::Daily {
            key: "2026-08-10".into(),
        },
        "human update",
        Some(&expected),
    )
    .unwrap();
    assert!(!proof.native_created);
    assert!(append_distill_manifest_dispatch(
        &state,
        &registry,
        &origin.vault_path,
        &origin,
        "llm-907",
        vec![],
        vec![proof.path.clone()],
        vec![forged_created_claim(&proof.path, b"human update")],
        &[proof.publication_id]
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(root.join(proof.path)).unwrap(),
        "human update"
    );
    assert!(!root.join(".myco/distill-runs/llm-907.json").exists());
}
