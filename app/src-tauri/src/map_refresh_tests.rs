use super::*;
use crate::role_authorization::{capture_role_at, RoleUsage};
use crate::settings::test_support::with_isolated_data;

#[test]
fn preview_preserves_human_bytes_and_rejects_stale_sources_origin_and_owned_edits() {
    with_isolated_data("map-refresh-preview", |data| {
        let root = data.join("vault");
        std::fs::create_dir_all(root.join("wiki/maps")).unwrap();
        let root = root.canonicalize().unwrap();
        std::fs::write(root.join("wiki/synthetic.md"), "Synthetic source.").unwrap();
        let state = VaultRoot::default();
        let generation = state.begin_open().unwrap();
        state.finish_open(generation, root.clone(), || ()).unwrap();
        let origin = state.snapshot().unwrap();
        let role = capture_role_at(&origin, RoleId::Organization, RoleUsage::Foreground).unwrap();
        let sources = crate::map_sources::MapSourceRegistry::default();
        let snapshot = crate::map_sources::capture(
            &state,
            &sources,
            &origin,
            &role,
            &["wiki/synthetic.md".into()],
        )
        .unwrap();
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../src/lib/mapContent.fixture.json")).unwrap();
        let baseline = fixture["content"].as_str().unwrap();
        let store =
            crate::map_custody::MapCreationStore::open(&root, "wiki/maps/synthetic.md").unwrap();
        crate::vault::with_root_mutation(&root, |_, guard| {
            let written = store.write(
                guard,
                root.join("wiki/maps/synthetic.md").to_str().unwrap(),
                baseline,
            )?;
            store.record(guard, &written, baseline)?;
            Ok(())
        })
        .unwrap();
        drop(store);
        let current = format!(
            "{}\nSynthetic human annotation.\n",
            baseline.replace("Map: Synthetic topic", "Human title")
        );
        let target = root.join("wiki/maps/synthetic.md");
        std::fs::write(&target, &current).unwrap();
        let next_body = "Synthetic updated relationship [[wiki/synthetic.md]].\n";
        let candidate = baseline
            .replace(fixture["body"].as_str().unwrap(), next_body)
            .replace(
                &crate::importers::wikify::source_revision(fixture["body"].as_str().unwrap()),
                &crate::importers::wikify::source_revision(next_body),
            );
        let result = preview(
            &state,
            &sources,
            &origin,
            &role,
            "synthetic",
            &candidate,
            &snapshot.snapshot_id,
        )
        .unwrap();
        assert_eq!(result.path, "wiki/maps/synthetic.md");
        assert_eq!(
            result.current_revision,
            crate::importers::wikify::source_revision(&current)
        );
        assert!(result.content.contains("Human title"));
        assert!(result.content.contains(next_body));
        assert!(result.content.ends_with("Synthetic human annotation.\n"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), current);
        assert!(preview(
            &state,
            &sources,
            &origin,
            &role,
            "synthetic",
            &candidate,
            "unknown-source-grant"
        )
        .is_err());
        let ask = capture_role_at(&origin, RoleId::Ask, RoleUsage::Foreground).unwrap();
        assert!(preview(
            &state,
            &sources,
            &origin,
            &ask,
            "synthetic",
            &candidate,
            &snapshot.snapshot_id
        )
        .is_err());
        std::fs::write(root.join("wiki/maps/human.md"), baseline).unwrap();
        assert!(preview(
            &state,
            &sources,
            &origin,
            &role,
            "human",
            &candidate,
            &snapshot.snapshot_id
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("wiki/maps/human.md")).unwrap(),
            baseline
        );
        assert!(preview(
            &state,
            &sources,
            &origin,
            &role,
            "../synthetic",
            &candidate,
            &snapshot.snapshot_id
        )
        .is_err());
        let edited = current.replace("Synthetic relationship", "Human edited relationship");
        std::fs::write(&target, &edited).unwrap();
        assert!(preview(
            &state,
            &sources,
            &origin,
            &role,
            "synthetic",
            &candidate,
            &snapshot.snapshot_id
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), edited);
        std::fs::write(&target, &current).unwrap();
        std::fs::write(root.join("wiki/synthetic.md"), "Changed synthetic source.").unwrap();
        assert!(preview(
            &state,
            &sources,
            &origin,
            &role,
            "synthetic",
            &candidate,
            &snapshot.snapshot_id
        )
        .is_err());
        state.close().unwrap();
        assert!(preview(
            &state,
            &sources,
            &origin,
            &role,
            "synthetic",
            &candidate,
            &snapshot.snapshot_id
        )
        .is_err());
    });
}
