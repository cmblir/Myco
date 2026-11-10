use super::*;
#[cfg(unix)]
use crate::role_authorization::{capture_role_at, RoleUsage};
#[cfg(unix)]
use crate::settings::test_support::with_isolated_data;
#[cfg(unix)]
use std::path::Path;

#[cfg(unix)]
fn open(vault: &VaultRoot, root: &Path) -> AgentVaultSession {
    let generation = vault.begin_open().unwrap();
    vault
        .finish_open(generation, root.to_path_buf(), || ())
        .unwrap();
    vault.snapshot().unwrap()
}
#[cfg(unix)]
fn paths() -> Vec<String> {
    vec!["wiki/a.md".into()]
}

#[test]
fn map_sources_reject_nonportable_and_ambiguous_members() {
    for invalid in [
        "../a.md",
        "/a.md",
        "wiki//a.md",
        "wiki/.a.md",
        "wiki/a\\b.md",
        "wiki/a#b.md",
        "wiki/a\0.md",
        "wiki/a|b.md",
        "C:/a.md",
        "wiki/a.txt",
        "wiki/CON.md",
        "wiki/LPT1.md",
        "wiki/folder /a.md",
        "wiki/folder./a.md",
        "wiki/a?.md",
        "wiki/a\".md",
    ] {
        assert!(validate_paths(&[invalid.into()]).is_err(), "{invalid:?}");
    }
    assert!(validate_paths(&[]).is_err());
    assert!(validate_paths(&(0..13).map(|i| format!("wiki/{i}.md")).collect::<Vec<_>>()).is_err());
    assert!(validate_paths(&["wiki/a.md".into(), "wiki/A.md".into()]).is_err());
    assert!(validate_paths(&["wiki/café.md".into(), "wiki/cafe\u{301}.md".into()]).is_err());
    validate_paths(&["wiki/a.md".into(), "wiki/nested/a.md".into()]).unwrap();
}

#[cfg(unix)]
#[test]
fn map_sources_bind_native_origin_exact_role_usage_and_release_after_revocation() {
    with_isolated_data("map-source-role", |data| {
        let root = data.join("vault");
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/a.md"), "Synthetic source.").unwrap();
        let vault = VaultRoot::default();
        let origin = open(&vault, &root);
        let role = capture_role_at(&origin, RoleId::Organization, RoleUsage::Foreground).unwrap();
        let registry = MapSourceRegistry::default();
        let captured = capture(&vault, &registry, &origin, &role, &paths()).unwrap();
        assert_eq!(captured.members[0].raw, "Synthetic source.");
        check(&vault, &registry, &origin, &role, &captured.snapshot_id).unwrap();
        let ask = capture_role_at(&origin, RoleId::Ask, RoleUsage::Foreground).unwrap();
        assert!(capture(&vault, &registry, &origin, &ask, &paths()).is_err());
        assert!(check(&vault, &registry, &origin, &ask, &captured.snapshot_id).is_err());
        let another =
            capture_role_at(&origin, RoleId::Organization, RoleUsage::Foreground).unwrap();
        assert!(check(&vault, &registry, &origin, &another, &captured.snapshot_id).is_err());
        let mut forged = role.clone();
        forged.usage = RoleUsage::Automatic;
        assert!(check(&vault, &registry, &origin, &forged, &captured.snapshot_id).is_err());
        forged = role.clone();
        forged.route_signature.model_id = "forged".into();
        assert!(capture(&vault, &registry, &origin, &forged, &paths()).is_err());
        let reopened = open(&vault, &root);
        assert!(check(&vault, &registry, &origin, &role, &captured.snapshot_id).is_err());
        assert!(release(&registry, &reopened, &captured.snapshot_id).is_err());
        vault.close().unwrap();
        release(&registry, &origin, &captured.snapshot_id).unwrap();
        release(&registry, &origin, &captured.snapshot_id).unwrap();
        assert!(registry.0.lock().unwrap().is_empty());
    });
}

#[cfg(unix)]
#[test]
fn map_sources_reject_revoked_role_but_allow_original_release() {
    with_isolated_data("map-source-revoke", |data| {
        let root = data.join("vault");
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/a.md"), "Synthetic source.").unwrap();
        let vault = VaultRoot::default();
        let origin = open(&vault, &root);
        let role = capture_role_at(&origin, RoleId::Organization, RoleUsage::Foreground).unwrap();
        let registry = MapSourceRegistry::default();
        let captured = capture(&vault, &registry, &origin, &role, &paths()).unwrap();
        let model = if role.route_signature.model_id == crate::local_model::SMALL_MODEL.id {
            crate::local_model::MODEL.id
        } else {
            crate::local_model::SMALL_MODEL.id
        };
        crate::role_authorization::select_role(crate::role_authorization::RoleSelectionRequest {
            role: RoleId::Organization,
            provider_id: "builtin-local".into(),
            model_id: model.into(),
            effort: "(default)".into(),
            expected_authorization_revision: crate::role_authorization::settings_snapshot()
                .unwrap()
                .role_authorization_revision,
        })
        .unwrap();
        assert!(check(&vault, &registry, &origin, &role, &captured.snapshot_id).is_err());
        assert!(capture(&vault, &registry, &origin, &role, &paths()).is_err());
        release(&registry, &origin, &captured.snapshot_id).unwrap();
        assert!(registry.0.lock().unwrap().is_empty());
    });
}

#[cfg(unix)]
#[test]
fn map_sources_registry_is_bounded_prunes_old_openings_and_never_issues_failed_capture() {
    with_isolated_data("map-source-limit", |data| {
        let root = data.join("vault");
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/a.md"), "Synthetic source.").unwrap();
        let vault = VaultRoot::default();
        let origin = open(&vault, &root);
        let role = capture_role_at(&origin, RoleId::Organization, RoleUsage::Foreground).unwrap();
        let registry = MapSourceRegistry::default();
        assert!(capture(
            &vault,
            &registry,
            &origin,
            &role,
            &["wiki/missing.md".into()]
        )
        .is_err());
        assert!(registry.0.lock().unwrap().is_empty());
        let mut ids = Vec::new();
        for _ in 0..SNAPSHOT_LIMIT {
            ids.push(
                capture(&vault, &registry, &origin, &role, &paths())
                    .unwrap()
                    .snapshot_id,
            );
        }
        assert!(capture(&vault, &registry, &origin, &role, &paths()).is_err());
        release(&registry, &origin, &ids[0]).unwrap();
        capture(&vault, &registry, &origin, &role, &paths()).unwrap();
        let current = open(&vault, &root);
        let current_role =
            capture_role_at(&current, RoleId::Organization, RoleUsage::Foreground).unwrap();
        capture(&vault, &registry, &current, &current_role, &paths()).unwrap();
        assert_eq!(registry.0.lock().unwrap().len(), 1);
        release(&registry, &origin, &ids[1]).unwrap();
    });
}

#[cfg(unix)]
#[test]
fn map_sources_publication_command_requires_exact_grant_and_preserves_update_boundary() {
    use crate::commands::publish_distill_note_dispatch;
    use crate::distill_publication::{DistillPublicationRegistry, ManagedArtifact};
    with_isolated_data("map-source-publication", |data| {
        let root = data.join("vault");
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/a.md"), "Synthetic source.").unwrap();
        let vault = VaultRoot::default();
        let origin = open(&vault, &root);
        let role = capture_role_at(&origin, RoleId::Organization, RoleUsage::Foreground).unwrap();
        let sources = MapSourceRegistry::default();
        let publications = DistillPublicationRegistry::default();
        let captured = capture(&vault, &sources, &origin, &role, &paths()).unwrap();
        let map = ManagedArtifact::Map {
            key: "synthetic".into(),
        };
        let map_body = "Synthetic map.\n";
        let content = format!(
            "---\nmap_generated: {{\"version\":1,\"bodyRevision\":\"{}\"}}\n---\n\n<!-- myco:map-generated:v1 -->\n{map_body}<!-- /myco:map-generated -->\n",
            crate::importers::wikify::source_revision(map_body)
        );
        for invalid in [
            "Synthetic map without generated boundaries.".to_string(),
            content.replace("Synthetic map.", "Edited without updating the hash."),
            format!("{content}Unmarked prose."),
        ] {
            let malformed = publish_distill_note_dispatch(
                &vault,
                &publications,
                &sources,
                &origin,
                "llm-invalid-map-section",
                &map,
                &invalid,
                None,
                Some(&role),
                Some(&captured.snapshot_id),
            );
            assert!(malformed
                .unwrap_err()
                .contains("map generated section is invalid"));
            assert!(!root.join("wiki/maps/synthetic.md").exists());
        }
        let publish = |artifact: &ManagedArtifact, expected: Option<&str>, id: Option<&str>| {
            publish_distill_note_dispatch(
                &vault,
                &publications,
                &sources,
                &origin,
                "llm-map-source",
                artifact,
                &content,
                expected,
                Some(&role),
                id,
            )
        };
        assert!(publish(&map, None, None).is_err());
        assert!(publish(&map, None, Some("forged-source-id")).is_err());
        assert!(publish(&map, Some(&"a".repeat(64)), Some(&captured.snapshot_id)).is_err());
        assert!(publish(
            &ManagedArtifact::Daily {
                key: "2026-11-10".into()
            },
            None,
            Some(&captured.snapshot_id)
        )
        .is_err());
        assert!(!root.join("wiki/maps/synthetic.md").exists());
        let receipt = publish(&map, None, Some(&captured.snapshot_id)).unwrap();
        assert!(receipt.native_created);
        assert_eq!(receipt.path, "wiki/maps/synthetic.md");
        assert_eq!(
            std::fs::read_to_string(root.join(&receipt.path)).unwrap(),
            content
        );
        release(&sources, &origin, &captured.snapshot_id).unwrap();
        assert!(publish(&map, None, Some(&captured.snapshot_id)).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join(&receipt.path)).unwrap(),
            content
        );
    });
}

#[cfg(unix)]
#[test]
fn map_sources_bound_utf8_regular_files_and_allow_single_readonly_hardlink() {
    use crate::map_source_io::SOURCE_BYTES;
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path();
    let path = root.join("a.md");
    for raw in [vec![b'a'; SOURCE_BYTES + 1], vec![0xff], vec![0]] {
        std::fs::write(&path, raw).unwrap();
        assert!(SourceSet::capture(root, &["a.md".into()]).is_err());
    }
    std::fs::write(&path, vec![b'a'; SOURCE_BYTES]).unwrap();
    let (_, members) = SourceSet::capture(root, &["a.md".into()]).unwrap();
    assert_eq!(members[0].raw.len(), SOURCE_BYTES);
    std::fs::hard_link(&path, root.join("b.md")).unwrap();
    let (held, _) = SourceSet::capture(root, &["a.md".into()]).unwrap();
    held.check(root).unwrap();
    assert!(SourceSet::capture(root, &["a.md".into(), "b.md".into()]).is_err());
    std::os::unix::fs::symlink(&path, root.join("link.md")).unwrap();
    assert!(SourceSet::capture(root, &["link.md".into()]).is_err());
    std::fs::create_dir(root.join("directory.md")).unwrap();
    assert!(SourceSet::capture(root, &["directory.md".into()]).is_err());
    let fifo = std::ffi::CString::new(root.join("pipe.md").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(SourceSet::capture(root, &["pipe.md".into()]).is_err());
}

#[cfg(unix)]
#[test]
fn map_sources_detect_file_parent_root_replacement_and_metadata_only_changes() {
    for change in [
        "file",
        "parent",
        "root",
        "metadata",
        "content",
        "parent-symlink",
    ] {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("vault");
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        let path = root.join("wiki/a.md");
        std::fs::write(&path, "Synthetic source.").unwrap();
        let (held, _) = SourceSet::capture(&root, &paths()).unwrap();
        match change {
            "file" => {
                std::fs::write(root.join("replacement"), "Synthetic source.").unwrap();
                std::fs::rename(root.join("replacement"), &path).unwrap();
            }
            "parent" | "parent-symlink" => {
                std::fs::rename(root.join("wiki"), root.join("old-wiki")).unwrap();
                if change == "parent-symlink" {
                    std::os::unix::fs::symlink(root.join("old-wiki"), root.join("wiki")).unwrap();
                } else {
                    std::fs::create_dir(root.join("wiki")).unwrap();
                    std::fs::hard_link(root.join("old-wiki/a.md"), &path).unwrap();
                }
            }
            "root" => {
                std::fs::rename(&root, fixture.path().join("old-vault")).unwrap();
                std::fs::create_dir(&root).unwrap();
            }
            "metadata" => {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
            }
            _ => {
                std::fs::write(&path, "Corrected source.").unwrap();
            }
        }
        assert!(held.check(&root).is_err(), "{change}");
    }
}
