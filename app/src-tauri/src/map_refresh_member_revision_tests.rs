use super::*;

#[test]
fn added_member_and_fresh_revision_update_one_map_without_losing_human_content() {
    with_isolated_data("map-member-revisions", |data| {
        let root = data.join("vault");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let (baseline, _) = create(&root);
        let target = root.join("wiki/maps/synthetic.md");
        let human = format!(
            "{}\nHuman annotation.\n",
            baseline.replace("Map: Synthetic topic", "Human title")
        );
        std::fs::write(&target, &human).unwrap();
        std::fs::write(root.join("wiki/added.md"), "Synthetic added source v1.").unwrap();
        let state = VaultRoot::default();
        let generation = state.begin_open().unwrap();
        state.finish_open(generation, root.clone(), || ()).unwrap();
        let origin = state.snapshot().unwrap();
        let role = capture_role_at(&origin, RoleId::Organization, RoleUsage::Foreground).unwrap();
        let sources = crate::map_sources::MapSourceRegistry::default();
        let paths = vec!["wiki/synthetic.md".into(), "wiki/added.md".into()];
        let mut previous_revision = None;
        for version in [1, 2] {
            let snapshot =
                crate::map_sources::capture(&state, &sources, &origin, &role, &paths).unwrap();
            let added_revision = snapshot.members[1].revision.clone();
            if let Some(previous) = previous_revision.replace(added_revision.clone()) {
                assert_ne!(previous, added_revision);
            }
            let metadata = serde_json::json!({"version": 1, "members": snapshot.members.iter().map(|member| {
                serde_json::json!({"path": member.path, "revision": member.revision,
                    "sourceChars": member.raw.chars().count(), "excerptChars": member.raw.chars().count(), "truncated": false})
            }).collect::<Vec<_>>()});
            let body = format!(
                "Synthetic relationship v{version} [[wiki/synthetic.md]] [[wiki/added.md]].\n"
            );
            let proposed = candidate(&baseline, &body)
                .lines()
                .map(|line| {
                    if line.starts_with("map_evidence: ") {
                        format!("map_evidence: {metadata}")
                    } else {
                        line.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            let review = preview(
                &state,
                &sources,
                &origin,
                &role,
                "synthetic",
                &proposed,
                &snapshot.snapshot_id,
            )
            .unwrap();
            let applied = apply(
                &state,
                &sources,
                &origin,
                &role,
                "synthetic",
                &proposed,
                &snapshot.snapshot_id,
                &review.current_revision,
            )
            .unwrap();
            let stored = std::fs::read_to_string(&target).unwrap();
            assert_eq!(stored, review.content);
            assert!(stored.contains("Human title"));
            assert!(stored.ends_with("Human annotation.\n"));
            assert!(stored.contains(&added_revision));
            assert!(stored.contains(&body));
            assert_eq!(
                std::fs::read_dir(root.join("wiki/maps")).unwrap().count(),
                1
            );
            let repeat = apply(
                &state,
                &sources,
                &origin,
                &role,
                "synthetic",
                &proposed,
                &snapshot.snapshot_id,
                &applied.revision,
            )
            .unwrap();
            assert!(!repeat.changed);
            if version == 1 {
                std::fs::write(root.join("wiki/added.md"), "Synthetic added source v2.").unwrap();
                assert!(apply(
                    &state,
                    &sources,
                    &origin,
                    &role,
                    "synthetic",
                    &proposed,
                    &snapshot.snapshot_id,
                    &applied.revision
                )
                .is_err());
                assert_eq!(std::fs::read_to_string(&target).unwrap(), stored);
            }
            crate::map_sources::release(&sources, &origin, &snapshot.snapshot_id).unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(root.join("wiki/synthetic.md")).unwrap(),
            "Synthetic source."
        );
        assert_eq!(
            std::fs::read_to_string(root.join("wiki/added.md")).unwrap(),
            "Synthetic added source v2."
        );
    });
}
