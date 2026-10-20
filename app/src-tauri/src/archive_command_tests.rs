use super::{archive_origin_dispatch, AgentVaultSession, VaultRoot};
use crate::distill::{ArchiveContext, ArchivePublication};
use sha2::{Digest, Sha256};
use std::path::Path;

fn open(state: &VaultRoot, root: &Path) -> AgentVaultSession {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.to_path_buf(), || ())
        .unwrap();
    state.snapshot().unwrap()
}

#[test]
fn archive_native_bridge_rejects_same_path_reopen_and_wrong_vault_before_mutation() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let state = VaultRoot::default();
    let old = open(&state, &root);
    let current = open(&state, &root);
    std::fs::create_dir_all(root.join("sessions")).unwrap();
    std::fs::create_dir_all(root.join("daily")).unwrap();
    std::fs::write(root.join("sessions/source.md"), "original").unwrap();
    std::fs::write(root.join("daily/2026-08-10.md"), "digest").unwrap();
    let context = ArchiveContext {
        manifest_id: "llm-900".into(),
        publications: vec![ArchivePublication {
            path: "daily/2026-08-10.md".into(),
            revision: format!("{:x}", Sha256::digest(b"digest")),
            created: true,
        }],
    };
    let files = vec!["sessions/source.md".into()];
    let fingerprints = vec![crate::distill::content_fingerprint(b"original")];
    let dispatch = |root: &Path| {
        crate::distill::archive_digested_sessions_with_context(
            root,
            "2026-08-10",
            &files,
            Some(&fingerprints),
            Some(&context),
        )
    };
    assert!(archive_origin_dispatch(&state, &old.vault_path, &old, dispatch).is_err());
    assert!(archive_origin_dispatch(&state, "/synthetic/wrong-vault", &current, dispatch).is_err());
    assert_eq!(
        std::fs::read_to_string(root.join(&files[0])).unwrap(),
        "original"
    );
    assert!(!root.join("sessions/archive").exists());
    let completed =
        archive_origin_dispatch(&state, &current.vault_path, &current, dispatch).unwrap();
    assert_eq!(completed.moved.len(), 1);
    assert!(!root.join(&files[0]).exists());
    state.close().unwrap();
    assert!(archive_origin_dispatch(&state, &current.vault_path, &current, dispatch).is_err());
    assert_eq!(
        std::fs::read_to_string(root.join(&completed.moved[0].to)).unwrap(),
        "original"
    );
}
