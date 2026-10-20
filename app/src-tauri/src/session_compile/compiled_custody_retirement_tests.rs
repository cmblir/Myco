//! Synthetic native accumulation/retention controls, not model meaning or crash QA.
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::MetadataExt;

const HUMAN: &str = "\nHuman postscript outside the native section remains.\n";

fn completed_with_fresh_reviews(
    vault: &VaultRoot,
    source: &session::SourceBinding,
) -> (SessionCompileContext, Vec<String>) {
    let origin = vault.snapshot().unwrap();
    let context = session::begin(vault, &origin, source.clone(), RoleUsage::Foreground).unwrap();
    let raw = session::checked_source(Path::new(&origin.vault_path), source).unwrap();
    let plan = session::sources::prepare(source, &raw, &origin, "en", |_, _| Ok(800)).unwrap();
    let mut reviews = Vec::new();
    for (index, _) in plan.windows.iter().enumerate() {
        let outcome = session::execution::step(
            vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                if schema == session::compiler::CompilerSchema::Review {
                    let input: Value = serde_json::from_str(user).unwrap();
                    assert_eq!(input["sourceRevision"], source.source_revision);
                    assert!(!input["originalSpans"].as_array().unwrap().is_empty());
                    reviews.push(source_revision(user));
                }
                session::compiler::fixture_model(schema, user, false)
            },
        )
        .unwrap();
        assert_eq!(outcome.next_packet, index + 1);
        assert!(outcome.step.as_ref().unwrap().review_accepted);
        if index + 1 == plan.windows.len() {
            assert_eq!(outcome.state, session::WorkState::Completed);
            assert!(outcome.publication.is_some());
        } else {
            assert_eq!(outcome.state, session::WorkState::Running);
        }
    }
    assert_eq!(reviews.len(), plan.windows.len());
    assert_eq!(reviews.iter().collect::<BTreeSet<_>>().len(), reviews.len());
    let pending = Pending::try_load(Path::new(&origin.vault_path)).unwrap();
    let job = pending
        .compile_jobs
        .iter()
        .find(|job| job.id == context.job_id)
        .unwrap();
    assert_eq!(job.state, session::WorkState::Completed);
    assert_eq!(job.receipts.len(), 1);
    assert!(job.attempts.last().unwrap().checks.completed_compilation());
    (context, reviews)
}

fn append_revision(
    root: &Path,
    previous: &session::SourceBinding,
    raw: &str,
    ordinal: usize,
) -> session::SourceBinding {
    let source = session::SourceBinding {
        key: previous.key.clone(),
        raw_path: format!("raw/conversations/codex/synthetic-custody-r{ordinal}.md"),
        source_revision: source_revision(raw),
    };
    append_raw(root, &source.raw_path, raw).unwrap();
    admit(root, &source);
    source
}

fn inventory() -> BTreeMap<String, (Vec<u8>, u64, u64)> {
    std::fs::read_dir(store_directory())
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            assert!(metadata.is_file() && !metadata.file_type().is_symlink());
            (
                entry.file_name().to_str().unwrap().to_string(),
                (
                    std::fs::read(&path).unwrap(),
                    metadata.dev(),
                    metadata.ino(),
                ),
            )
        })
        .collect()
}

#[test]
fn repeated_completed_revisions_retire_only_duplicate_generated_custody_to_current_four_files() {
    with_isolated_data("compiler-custody-bounded-generations", |_| {
        let (directory, vault, first_source) = fixture();
        let root = directory.path();
        let (first, first_reviews) = completed_with_fresh_reviews(&vault, &first_source);
        let canonical = root.join(&first.summary_path);
        let with_human = std::fs::read_to_string(&canonical).unwrap() + HUMAN;
        std::fs::write(&canonical, with_human).unwrap();
        let mut originals = BTreeMap::from([(first_source.raw_path.clone(), RAW.to_string())]);
        let mut source = first_source;
        let mut raw = RAW.to_string();
        let mut previous = first;
        let mut observed_reviews = vec![first_reviews.len()];
        for ordinal in 2..=9 {
            raw.push_str(&format!(
                "\n**User:**\nPlease request the synthetic report revision {ordinal}.\n"
            ));
            source = append_revision(root, &source, &raw, ordinal);
            originals.insert(source.raw_path.clone(), raw.clone());
            let (current, reviews) = completed_with_fresh_reviews(&vault, &source);
            assert_eq!(current.summary_path, previous.summary_path);
            assert_ne!(current.attempt_id, previous.attempt_id);
            assert_ne!(
                current.role_snapshot.snapshot_id,
                previous.role_snapshot.snapshot_id
            );
            let text = std::fs::read_to_string(&canonical).unwrap();
            assert!(text.ends_with(HUMAN));
            assert_eq!(text.matches(START).count(), 1);
            assert_eq!(text.matches(END).count(), 1);
            assert!(text.contains(&format!("synthetic report revision {ordinal}")));
            for (path, expected) in &originals {
                assert_eq!(std::fs::read_to_string(root.join(path)).unwrap(), *expected);
            }
            observed_reviews.push(reviews.len());
            previous = current;
        }
        assert_eq!(originals.len(), 9);
        let pending = Pending::try_load(root).unwrap();
        assert_eq!(pending.compile_jobs.len(), 9);
        assert!(pending
            .compile_jobs
            .iter()
            .all(|job| job.receipts.len() == 1));
        assert!(pending.pending.is_empty());
        let head_path = only_file(".head.json");
        let head: Value = serde_json::from_slice(&std::fs::read(&head_path).unwrap()).unwrap();
        let head_leaf = head_path.file_name().unwrap().to_str().unwrap();
        let key = head_leaf.strip_suffix(".head.json").unwrap();
        let generation = head["generation"].as_str().unwrap();
        let record_leaf = format!("{key}.{generation}.record.json");
        let baseline_leaf = format!("{key}.{generation}.baseline.txt");
        let anchor_leaf = format!("{key}.{generation}.anchor");
        let record_text = std::fs::read_to_string(store_directory().join(&record_leaf)).unwrap();
        assert_eq!(head["recordSha256"], source_revision(&record_text));
        let record: Value = serde_json::from_str(&record_text).unwrap();
        assert_eq!(record["source"]["sourceRevision"], source.source_revision);
        assert_eq!(record["ownership"]["path"], previous.summary_path);
        let current = std::fs::read(&canonical).unwrap();
        assert_eq!(
            std::fs::read(store_directory().join(&baseline_leaf)).unwrap(),
            current
        );
        assert_eq!(
            std::fs::read(store_directory().join(&anchor_leaf)).unwrap(),
            current
        );
        let canonical_metadata = std::fs::metadata(&canonical).unwrap();
        let anchor_metadata = std::fs::metadata(store_directory().join(&anchor_leaf)).unwrap();
        assert_eq!(
            (canonical_metadata.dev(), canonical_metadata.ino()),
            (anchor_metadata.dev(), anchor_metadata.ino())
        );
        assert_eq!(canonical_metadata.nlink(), 2);
        let expected = BTreeSet::from([
            head_leaf.to_string(),
            record_leaf,
            baseline_leaf,
            anchor_leaf,
        ]);
        let actual: BTreeSet<_> = inventory().into_keys().collect();
        println!(
            "SYNTHETIC_CUSTODY_RETIREMENT={}",
            json!({
            "completedRevisions":9,"immutableOriginals":originals.len(),"freshReviewCalls":observed_reviews,
            "expectedFiles":expected,"actualFiles":actual,"modelInference":false,
            "generationCallbacks":"synthetic","powerLossTested":false,"processRestartTested":false})
        );
        assert_eq!(actual, expected,
            "completed duplicate generations must retire while preserving current custody, all raw originals and the human postscript");
    });
}

#[test]
fn unique_human_bytes_added_to_old_anchor_after_real_successor_write_are_preserved() {
    with_isolated_data("compiler-custody-late-human-anchor", |_| {
        let (directory, vault, source) = fixture();
        let (first, _) = completed_with_fresh_reviews(&vault, &source);
        let old_anchor = only_file(".anchor");
        let old_bytes = std::fs::read(&old_anchor).unwrap();
        let old_identity = std::fs::metadata(&old_anchor).unwrap();
        let unique = b"\nUnique human bytes written after real successor publication.\n";
        let retained = [old_bytes.as_slice(), unique.as_slice()].concat();
        let anchor_for_hook = old_anchor.clone();
        let retained_for_hook = retained.clone();
        *custody::AFTER_ANCHORED_WRITE.lock().unwrap() = Some(Box::new(move |canonical| {
            assert_ne!(
                std::fs::metadata(canonical).unwrap().ino(),
                std::fs::metadata(&anchor_for_hook).unwrap().ino()
            );
            assert_eq!(std::fs::metadata(&anchor_for_hook).unwrap().nlink(), 1);
            std::fs::write(&anchor_for_hook, &retained_for_hook).unwrap();
            Ok(())
        }));
        let raw =
            RAW.to_string() + "\n**User:**\nPlease request the synthetic report revision 2.\n";
        let next = append_revision(directory.path(), &source, &raw, 2);
        let (second, _) = completed_with_fresh_reviews(&vault, &next);
        assert_eq!(second.summary_path, first.summary_path);
        assert_eq!(std::fs::read(&old_anchor).unwrap(), retained);
        let current_identity = std::fs::metadata(&old_anchor).unwrap();
        assert_eq!(
            (current_identity.dev(), current_identity.ino()),
            (old_identity.dev(), old_identity.ino())
        );
        let current = std::fs::read(directory.path().join(&second.summary_path)).unwrap();
        assert!(!current.windows(unique.len()).any(|window| window == unique));
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&source.raw_path)).unwrap(),
            RAW
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&next.raw_path)).unwrap(),
            raw
        );
    });
}

#[test]
fn other_scope_current_custody_and_unknown_private_files_are_not_retired() {
    with_isolated_data("compiler-custody-other-scope", |_| {
        let (directory, vault, source) = fixture();
        let other_raw = RAW.replace("synthetic-custody", "synthetic-other-custody");
        let other = session::SourceBinding {
            key: "codex:synthetic-other-custody".into(),
            raw_path: "raw/conversations/codex/synthetic-other-custody-r1.md".into(),
            source_revision: source_revision(&other_raw),
        };
        append_raw(directory.path(), &other.raw_path, &other_raw).unwrap();
        admit(directory.path(), &other);
        let (other_context, _) = completed_with_fresh_reviews(&vault, &other);
        let other_files = inventory();
        let other_canonical =
            std::fs::read(directory.path().join(&other_context.summary_path)).unwrap();
        let unknown = store_directory().join("unknown-private-material.txt");
        std::fs::write(&unknown, b"Unknown private bytes must remain.").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&unknown, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let unknown_metadata = std::fs::metadata(&unknown).unwrap();
        let (first, _) = completed_with_fresh_reviews(&vault, &source);
        let raw =
            RAW.to_string() + "\n**User:**\nPlease request the synthetic report revision 2.\n";
        let next = append_revision(directory.path(), &source, &raw, 2);
        let (second, _) = completed_with_fresh_reviews(&vault, &next);
        assert_eq!(second.summary_path, first.summary_path);
        let current_files = inventory();
        for (leaf, expected) in other_files {
            assert_eq!(current_files.get(&leaf), Some(&expected), "{leaf}");
        }
        assert_eq!(
            std::fs::read(directory.path().join(&other_context.summary_path)).unwrap(),
            other_canonical
        );
        assert_eq!(
            std::fs::read(&unknown).unwrap(),
            b"Unknown private bytes must remain."
        );
        let current_unknown = std::fs::metadata(&unknown).unwrap();
        assert_eq!(
            (unknown_metadata.dev(), unknown_metadata.ino()),
            (current_unknown.dev(), current_unknown.ino())
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&source.raw_path)).unwrap(),
            RAW
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&next.raw_path)).unwrap(),
            raw
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&other.raw_path)).unwrap(),
            other_raw
        );
    });
}
