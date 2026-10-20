use super::*;

const ORIGINAL: &str = "Synthetic unreviewed scratch text.\n";
const NEWER: &str = "Synthetic human revision: retain this useful note.\n";
const RAW: &str = "Synthetic immutable original evidence.\n";

struct Fixture {
    directory: tempfile::TempDir,
    content: PathBuf,
    sidecar: PathBuf,
    sidecar_bytes: String,
}

impl Fixture {
    fn new(source_revision: Option<&str>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("_inbox/quarantine")).unwrap();
        std::fs::create_dir(root.join("raw")).unwrap();
        std::fs::write(root.join("raw/original.md"), RAW).unwrap();
        let content = root.join("_inbox/quarantine/note.md");
        let sidecar = root.join("_inbox/quarantine/note.verdict.json");
        std::fs::write(&content, ORIGINAL).unwrap();
        let mut value = serde_json::json!({
            "tier": "quarantine",
            "reason": "synthetic scratch",
            "from": "_inbox/note.md",
            "expires": now_secs() - 1000,
            "vector": [],
        });
        if let Some(revision) = source_revision {
            value["source_sha256"] = revision.into();
        }
        let sidecar_bytes = value.to_string();
        std::fs::write(&sidecar, &sidecar_bytes).unwrap();
        Self {
            directory,
            content,
            sidecar,
            sidecar_bytes,
        }
    }

    fn run(&self) -> Result<RunReport, String> {
        run_without_embeddings(self.directory.path(), &DistillConfig::default())
    }

    fn assert_retained(&self, result: Result<RunReport, String>, content: &str, sidecar: &str) {
        assert_eq!(
            std::fs::read_to_string(&self.content).ok().as_deref(),
            Some(content),
            "automatic expiry must preserve the current content"
        );
        assert_eq!(
            std::fs::read_to_string(&self.sidecar).ok().as_deref(),
            Some(sidecar),
            "automatic expiry must preserve the current sidecar"
        );
        let error = result.expect_err("unverified expiry must not report a completed run");
        assert!(error.contains("retained"), "{error}");
        assert_eq!(
            std::fs::read_to_string(self.directory.path().join("raw/original.md")).unwrap(),
            RAW
        );
        for entry in std::fs::read_dir(self.directory.path().join(".myco/distill-runs")).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            let manifest: RunManifest = serde_json::from_slice(&bytes).unwrap();
            assert!(
                manifest.deleted.is_empty(),
                "refused expiry must not record deletion"
            );
        }
    }
}

struct ResetHook;
impl Drop for ResetHook {
    fn drop(&mut self) {
        PREPARED_HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}

fn with_permanent_policy(name: &str, test: impl FnOnce()) {
    crate::settings::test_support::with_isolated_data(name, |_| {
        let settings = crate::settings::Settings {
            permanent_delete: true,
            ..crate::settings::Settings::default()
        };
        crate::settings::save(&settings).unwrap();
        let _reset = ResetHook;
        test();
    });
}

fn prepared(hook: impl Fn() -> Result<(), String> + 'static) {
    PREPARED_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[test]
fn modified_source_before_expiry_keeps_content_and_verdict() {
    with_permanent_policy("ttl-modified-before", || {
        let fixture = Fixture::new(Some(&admission::sha256(ORIGINAL.as_bytes())));
        crate::vault::write_file_if_unchanged(
            &fixture.content.to_string_lossy(),
            NEWER,
            Some(&admission::sha256(ORIGINAL.as_bytes())),
        )
        .unwrap();
        fixture.assert_retained(fixture.run(), NEWER, &fixture.sidecar_bytes);
    });
}

#[test]
fn legacy_verdict_without_source_revision_is_not_automatic_delete_authority() {
    with_permanent_policy("ttl-legacy-revision", || {
        let fixture = Fixture::new(None);
        fixture.assert_retained(fixture.run(), ORIGINAL, &fixture.sidecar_bytes);
    });
}

#[test]
fn malformed_source_revision_is_not_automatic_delete_authority() {
    with_permanent_policy("ttl-malformed-revision", || {
        let fixture = Fixture::new(Some("not-a-sha256"));
        fixture.assert_retained(fixture.run(), ORIGINAL, &fixture.sidecar_bytes);
    });
}

#[test]
fn orphan_verdict_is_retained_without_proven_cleanup_authority() {
    with_permanent_policy("ttl-orphan-verdict", || {
        let fixture = Fixture::new(Some(&admission::sha256(ORIGINAL.as_bytes())));
        std::fs::remove_file(&fixture.content).unwrap();
        let result = fixture.run();
        assert_eq!(
            std::fs::read_to_string(&fixture.sidecar).ok().as_deref(),
            Some(fixture.sidecar_bytes.as_str()),
            "absence does not authorize deletion of the remaining decision record"
        );
        let error = result.expect_err("unproven orphan cleanup must not report completion");
        assert!(error.contains("retained"), "{error}");
        assert_eq!(
            std::fs::read_to_string(fixture.directory.path().join("raw/original.md")).unwrap(),
            RAW
        );
    });
}

#[test]
fn raw_origin_does_not_authorize_automatic_expiry_deletion() {
    with_permanent_policy("ttl-raw-origin", || {
        let mut fixture = Fixture::new(Some(&admission::sha256(ORIGINAL.as_bytes())));
        let mut value: serde_json::Value = serde_json::from_str(&fixture.sidecar_bytes).unwrap();
        value["from"] = "raw/original.md".into();
        fixture.sidecar_bytes = value.to_string();
        std::fs::write(&fixture.sidecar, &fixture.sidecar_bytes).unwrap();
        fixture.assert_retained(fixture.run(), ORIGINAL, &fixture.sidecar_bytes);
    });
}

#[test]
fn cooperating_save_after_expiry_preparation_keeps_newer_revision() {
    with_permanent_policy("ttl-cooperating-save", || {
        let fixture = Fixture::new(Some(&admission::sha256(ORIGINAL.as_bytes())));
        let content = fixture.content.clone();
        prepared(move || {
            let guard =
                crate::vault::try_lock_file_mutation()?.expect("preparation must release writer");
            drop(guard);
            crate::vault::write_file_if_unchanged(
                &content.to_string_lossy(),
                NEWER,
                Some(&admission::sha256(ORIGINAL.as_bytes())),
            )
        });
        fixture.assert_retained(fixture.run(), NEWER, &fixture.sidecar_bytes);
    });
}

#[test]
fn extended_verdict_after_expiry_preparation_keeps_current_pair() {
    with_permanent_policy("ttl-cooperating-extension", || {
        let fixture = Fixture::new(Some(&admission::sha256(ORIGINAL.as_bytes())));
        let mut value: serde_json::Value = serde_json::from_str(&fixture.sidecar_bytes).unwrap();
        value["expires"] = (now_secs() + 86_400).into();
        let extended = value.to_string();
        let saved = extended.clone();
        let sidecar = fixture.sidecar.clone();
        let previous = admission::sha256(fixture.sidecar_bytes.as_bytes());
        prepared(move || {
            crate::vault::write_file_if_unchanged(
                &sidecar.to_string_lossy(),
                &saved,
                Some(&previous),
            )
        });
        fixture.assert_retained(fixture.run(), ORIGINAL, &extended);
    });
}

#[cfg(unix)]
#[test]
fn same_bytes_replacement_after_preparation_is_not_the_observed_file() {
    with_permanent_policy("ttl-identical-replacement", || {
        let fixture = Fixture::new(Some(&admission::sha256(ORIGINAL.as_bytes())));
        let content = fixture.content.clone();
        prepared(move || {
            crate::vault::write_file_if_unchanged(
                &content.to_string_lossy(),
                ORIGINAL,
                Some(&admission::sha256(ORIGINAL.as_bytes())),
            )
        });
        fixture.assert_retained(fixture.run(), ORIGINAL, &fixture.sidecar_bytes);
    });
}

#[test]
fn unchanged_expired_pair_is_deleted_and_exact_paths_are_recorded() {
    with_permanent_policy("ttl-unchanged-control", || {
        let fixture = Fixture::new(Some(&admission::sha256(ORIGINAL.as_bytes())));
        let report = fixture.run().unwrap();
        assert_eq!(report.deleted, 1);
        assert!(!fixture.content.exists());
        assert!(!fixture.sidecar.exists());
        let recorded: RunManifest = serde_json::from_slice(
            &std::fs::read(manifest_path(fixture.directory.path(), &report.id)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            recorded.deleted,
            vec![
                "_inbox/quarantine/note.md",
                "_inbox/quarantine/note.verdict.json"
            ]
        );
        assert!(recorded.trashed.is_empty());
        assert_eq!(
            std::fs::read_to_string(fixture.directory.path().join("raw/original.md")).unwrap(),
            RAW
        );
    });
}
