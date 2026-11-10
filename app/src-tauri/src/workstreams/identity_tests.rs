use super::*;

fn seed_cwd(root: &Path, id: &str, cwd: Option<&str>, parent: Option<&str>) {
    let key = format!("claude-code:{id}");
    let fp = "0123456789abcdef";
    let mut record = serde_json::json!({"type":"user", "cwd":cwd,
        "message":{"role":"user", "content":"Synthetic identity task"}});
    if let Some(parent) = parent {
        record["teamName"] = format!("session-{parent}").into();
        record["agentName"] = "synthetic-child".into();
    }
    tests::seed(
        root,
        &key,
        fp,
        "created: 1793066400\nlast_activity: 1793070000",
        "Synthetic identity task",
        &[record],
    );
    let mut ledger = Ledger::load(root).unwrap();
    ledger.record(key, fp.into());
    ledger.save(root).unwrap();
}

fn legacy_facts(root: &Path) {
    let mut old = plan(root, &[]).unwrap().facts;
    old.version = 4;
    for conversation in old.conversations.values_mut() {
        conversation.key = Some("atlas".into());
    }
    old.workstreams.clear();
    old.workstreams.insert(
        "atlas".into(),
        WorkstreamFacts {
            page_refresh_pending: false,
            conversations: old.conversations.len(),
            first_epoch: 1793066400,
            last_epoch: 1793070000,
            open_items: vec![],
            page: "wiki/workstreams/atlas.md".into(),
            roots: old.conversations.len(),
            summary: None,
            title: "Atlas".into(),
            title_source: TitleSource::Key,
        },
    );
    std::fs::create_dir_all(crate::vault_dir::dir(root)).unwrap();
    std::fs::write(facts_path(root), serde_json::to_string(&old).unwrap()).unwrap();
}

#[test]
fn full_recorded_paths_do_not_collapse_basename_home_drive_or_case() {
    for (left, right) in [
        (
            "/Users/synthetic/projects/Atlas",
            "/Users/synthetic/work/Atlas",
        ),
        (
            "/home/synthetic-a/repos/Atlas",
            "/home/synthetic-b/repos/Atlas",
        ),
        (r"C:\Users\synthetic\Atlas", r"D:\Users\synthetic\Atlas"),
        ("/synthetic/Atlas", "/synthetic/atlas"),
        ("/synthetic/Atlas", "/synthetic/Atlas-worktree-independent"),
        ("/synthetic/Atlas", "/synthetic/Atlas/src"),
        (
            "/synthetic/Atlas",
            "/synthetic/Atlas/.claude/worktrees/task",
        ),
        ("/synthetic/café", "/synthetic/cafe\u{301}"),
    ] {
        let left_key = project_key(left).expect("absolute recorded cwd has an identity");
        let right_key = project_key(right).expect("absolute recorded cwd has an identity");
        assert_ne!(
            left_key, right_key,
            "distinct full paths must stay separate"
        );
        assert!(left_key.starts_with("p5-") && left_key.len() == 67);
        assert!(!left_key.contains("synthetic"));
    }
}

#[test]
fn relative_or_unresolved_paths_cannot_claim_a_project() {
    for cwd in [
        "",
        "~/Atlas",
        "Atlas",
        "C:Atlas",
        "/synthetic/../Atlas",
        "/synthetic/./Atlas",
        "/",
        "C:\\",
        "/synthetic/Atlas\n",
    ] {
        assert_eq!(project_key(cwd), None, "invalid or unresolved cwd");
    }
    assert_ne!(
        project_key(r"\\server\share\Atlas"),
        project_key("//server/share/Atlas")
    );
}

#[test]
fn migration_rereads_same_revision_and_preserves_legacy_pages_and_ambiguous_names() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    seed_cwd(root, "a", Some("/synthetic/projects/Atlas"), None);
    seed_cwd(root, "b", Some("/synthetic/work/Atlas"), None);
    legacy_facts(root);
    let old_page = root.join("wiki/workstreams/atlas.md");
    std::fs::create_dir_all(old_page.parent().unwrap()).unwrap();
    let human = "Human prefix\n<!-- myco:workstream:v1 {\"key\":\"atlas\"} -->\nHuman annotation\n<!-- /myco:workstream -->\nHuman suffix\n";
    std::fs::write(&old_page, human).unwrap();
    let names = crate::vault_dir::dir(root).join(NAMES_FILE);
    let names_bytes = "{\"atlas\":\"Human custom project name\"}\n";
    std::fs::write(&names, names_bytes).unwrap();
    let next = plan(root, &[]).unwrap();
    assert_eq!(
        next.recomputed, 2,
        "version migration must bypass unchanged fingerprints"
    );
    assert_eq!(next.facts.version, 5);
    assert_eq!(next.facts.workstreams.len(), 2);
    assert!(next
        .facts
        .workstreams
        .values()
        .all(|workstream| workstream.title != "Human custom project name"));
    apply(root, &next).unwrap();
    assert_eq!(std::fs::read_to_string(&old_page).unwrap(), human);
    assert_eq!(std::fs::read_to_string(&names).unwrap(), names_bytes);
}

#[test]
fn explicit_child_project_survives_parent_lineage_and_missing_child_inherits() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    seed_cwd(root, "parent", Some("/synthetic/projects/Atlas"), None);
    seed_cwd(
        root,
        "own-child",
        Some("/synthetic/work/Atlas"),
        Some("parent"),
    );
    seed_cwd(root, "missing-child", None, Some("parent"));
    let next = plan(root, &[]).unwrap();
    let parent = &next.facts.conversations["claude-code:parent"];
    let own = &next.facts.conversations["claude-code:own-child"];
    let missing = &next.facts.conversations["claude-code:missing-child"];
    assert!(parent.key.is_some());
    assert_ne!(parent.key, own.key);
    assert_eq!(missing.key, parent.key);
    assert_eq!(own.root, "claude-code:parent");
    assert_eq!(missing.root, own.root);
}

#[test]
fn existing_marked_page_is_preserved_when_new_facts_differ() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    seed_cwd(root, "a", Some("/Users/synthetic/projects/Atlas"), None);
    let first = plan(root, &[]).unwrap();
    apply(root, &first).unwrap();
    let workstream = first.facts.workstreams.values().next().unwrap();
    let path = root.join(&workstream.page);
    let human = format!(
        "{}\nHuman annotation retained.\n",
        std::fs::read_to_string(&path).unwrap()
    );
    std::fs::write(&path, &human).unwrap();
    let next = plan(root, &[]).unwrap();
    assert!(
        next.pages.is_empty(),
        "public markers are not native ownership authority"
    );
    assert_eq!(next.pages_pending, 1);
    assert!(next
        .facts
        .workstreams
        .values()
        .all(|workstream| workstream.page_refresh_pending));
    apply(root, &next).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), human);
}

#[test]
fn missing_legacy_members_block_name_adoption_across_repeated_rebuilds() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    seed_cwd(root, "a", Some("/Users/synthetic/projects/Atlas"), None);
    seed_cwd(root, "b", Some("/Users/synthetic/work/Atlas"), None);
    legacy_facts(root);
    std::fs::remove_file(root.join(raw_path("claude-code:b", "0123456789abcdef").unwrap()))
        .unwrap();
    std::fs::write(
        crate::vault_dir::dir(root).join(NAMES_FILE),
        "{\"atlas\":\"Legacy custom title\"}",
    )
    .unwrap();
    for _ in 0..2 {
        let next = plan(root, &[]).unwrap();
        assert_eq!(next.unread, 1);
        assert!(next
            .facts
            .workstreams
            .values()
            .all(|workstream| workstream.title != "Legacy custom title"));
        apply(root, &next).unwrap();
    }
}

#[test]
fn an_unambiguous_legacy_name_is_retained_until_a_distinct_identity_appears() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    seed_cwd(root, "a", Some("/Users/synthetic/projects/Atlas"), None);
    legacy_facts(root);
    let names = crate::vault_dir::dir(root).join(NAMES_FILE);
    let body = "{\"atlas\":\"Legacy custom title\"}";
    std::fs::write(&names, body).unwrap();
    for _ in 0..2 {
        let next = plan(root, &[]).unwrap();
        assert_eq!(
            next.facts.workstreams.values().next().unwrap().title,
            "Legacy custom title"
        );
        apply(root, &next).unwrap();
    }
    seed_cwd(root, "b", Some("/Users/synthetic/work/Atlas"), None);
    let next = plan(root, &[]).unwrap();
    assert_eq!(next.facts.workstreams.len(), 2);
    assert!(next
        .facts
        .workstreams
        .values()
        .all(|workstream| workstream.title != "Legacy custom title"));
    apply(root, &next).unwrap();
    assert_eq!(std::fs::read_to_string(names).unwrap(), body);
}

#[test]
fn ambiguous_own_cwd_does_not_vote_away_or_inherit_another_project() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    seed_cwd(root, "parent", Some("/synthetic/Atlas"), None);
    seed_cwd(root, "child", Some("/synthetic/Atlas"), Some("parent"));
    let path = root
        .join(raw_path("claude-code:child", "0123456789abcdef").unwrap())
        .with_extension("jsonl");
    let first = std::fs::read_to_string(&path).unwrap();
    let second = serde_json::json!({"type":"user", "cwd":"/synthetic/Other"});
    std::fs::write(path, format!("{first}\n{first}\n{second}")).unwrap();
    let next = plan(root, &[]).unwrap();
    let child = &next.facts.conversations["claude-code:child"];
    assert_eq!(child.key, None);
    assert_eq!(child.cwd_source, CwdSource::Sidecar);
    assert_eq!(child.root, "claude-code:parent");
}

#[test]
fn recorded_codex_cwd_is_read_from_immutable_sidecar_without_vendor_stores() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    let key = "codex:synthetic-source";
    tests::seed(
        root,
        key,
        "0123456789abcdef",
        "created: 1793066400\nlast_activity: 1793070000",
        "Synthetic task",
        &[serde_json::json!({"type":"session_meta", "payload":{"cwd":"/synthetic/Atlas"}})],
    );
    let mut ledger = Ledger::load(root).unwrap();
    ledger.record(key.into(), "0123456789abcdef".into());
    ledger.save(root).unwrap();
    let next = plan(root, &[]).unwrap();
    assert_eq!(
        next.facts.conversations[key].key,
        project_key("/synthetic/Atlas")
    );
    assert_eq!(next.facts.conversations[key].cwd_source, CwdSource::Sidecar);
    assert_eq!(next.store_failures, 0);
}

#[test]
fn admitted_codex_import_keeps_recorded_cwd_and_conflicts_without_live_lookup() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    set_test_codex_homes(Vec::new());
    let id = "00000000-0000-4000-8000-000000000088";
    let source = root.join("synthetic-codex.jsonl");
    let original = fixtures::codex_rollout(
        id,
        "/synthetic/Atlas",
        None,
        "Inspect the synthetic project",
        "Inspection reported",
    );
    std::fs::write(&source, &original).unwrap();
    tests::import(root, &source);
    let first = plan(root, &[]).unwrap();
    let conversation = &first.facts.conversations[&format!("codex:{id}")];
    assert_eq!(conversation.key, project_key("/synthetic/Atlas"));
    assert_eq!(conversation.cwd_source, CwdSource::Sidecar);
    let raw_path = root.join(&conversation.raw);
    let raw = std::fs::read(&raw_path).unwrap();
    let facts = serde_json::to_string(&first.facts).unwrap();
    assert!(!facts.contains("/synthetic/Atlas"));
    let conflict =
        serde_json::json!({"type":"session_meta", "payload":{"id":id, "cwd":"/synthetic/Other"}});
    std::fs::write(&source, format!("{original}\n{conflict}")).unwrap();
    tests::import(root, &source);
    let next = plan(root, &[]).unwrap();
    let changed = &next.facts.conversations[&format!("codex:{id}")];
    assert_ne!(
        changed.raw, conversation.raw,
        "new provenance creates a new immutable revision"
    );
    assert_eq!(
        changed.key, None,
        "conflicting source declarations cannot be majority-voted"
    );
    assert_eq!(changed.cwd_source, CwdSource::Sidecar);
    assert_eq!(std::fs::read(raw_path).unwrap(), raw);
}

#[test]
fn copied_parent_report_requires_positive_same_project_evidence_but_source_survives() {
    for parent_cwd in [Some("/synthetic/Child"), Some("/synthetic/Other"), None] {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        set_test_codex_homes(Vec::new());
        let parent = "00000000-0000-4000-8000-000000000091";
        let child = "00000000-0000-4000-8000-000000000092";
        if let Some(cwd) = parent_cwd {
            let source = root.join("synthetic-parent.jsonl");
            std::fs::write(
                &source,
                fixtures::codex_rollout(parent, cwd, None, "Inspect the synthetic project", ""),
            )
            .unwrap();
            tests::import(root, &source);
        }
        let copy = serde_json::json!({"type":"response_item", "timestamp":"2026-10-10T09:40:00Z",
            "payload":{"type":"message", "role":"assistant", "phase":"final_answer",
                "content":[{"type":"output_text", "text":"Copied parent report"}]},
            "metadata":{"inherited_user_message":true}});
        let source = root.join("synthetic-child.jsonl");
        std::fs::write(
            &source,
            format!(
                "{}\n{copy}",
                fixtures::codex_rollout(
                    child,
                    "/synthetic/Child",
                    Some(parent),
                    "Inspect the child project",
                    "Child project remains pending"
                )
            ),
        )
        .unwrap();
        tests::import(root, &source);
        let next = plan(root, &[]).unwrap();
        let record = &next.facts.conversations[&format!("codex:{child}")];
        assert_eq!(record.root, format!("codex:{parent}"));
        assert_eq!(
            record.parent_report.as_ref().unwrap().text,
            "Copied parent report"
        );
        let sidecar = root.join(&record.raw).with_extension("jsonl");
        assert!(std::fs::read_to_string(sidecar)
            .unwrap()
            .contains("Copied parent report"));
        let groups = sessions(record.key.as_deref().unwrap(), &next.facts.conversations);
        let report = session_report(&groups[0].2).unwrap().2;
        assert_eq!(
            report.text,
            if parent_cwd == Some("/synthetic/Child") {
                "Copied parent report"
            } else {
                "Child project remains pending"
            }
        );
    }
}
