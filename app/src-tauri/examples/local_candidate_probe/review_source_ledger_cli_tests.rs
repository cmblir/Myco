use super::parse_arguments;

fn base(mode: &str) -> Vec<String> {
    [
        "--model-dir",
        "/synthetic/pinned-model",
        "--model-id",
        "qwen3.5-4b-q4_k_m",
        mode,
        "/synthetic/frozen-manifest.json",
        "--review-source-audit",
        "/synthetic/source-audit.json",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

#[cfg(feature = "native-index-probe")]
#[test]
fn source_ledger_cli_accepts_both_frozen_packet_modes() {
    for mode in ["--review-development-smoke", "--review-whole-packet-smoke"] {
        let mut arguments = base(mode);
        arguments.push("--review-source-ledger".into());
        assert!(parse_arguments(arguments).is_ok());
    }
}

#[cfg(feature = "native-index-probe")]
#[test]
fn source_ledger_cli_admission_only_remains_a_separate_no_inference_mode() {
    for mode in ["--review-development-smoke", "--review-whole-packet-smoke"] {
        let mut arguments = base(mode);
        arguments.extend([
            "--review-source-ledger".into(),
            "--review-admission-only".into(),
        ]);
        let result = parse_arguments(arguments).unwrap();
        assert!(result.review_admission_only);
    }
}

#[test]
fn source_ledger_cli_requires_frozen_manifest_and_audit() {
    let arguments = [
        "--model-dir",
        "/synthetic/pinned-model",
        "--review-source-ledger",
    ];
    assert!(parse_arguments(arguments.into_iter().map(str::to_owned)).is_err());
}

#[test]
fn source_ledger_cli_rejects_confounded_or_repeated_interventions() {
    for extras in [
        vec!["--review-reason-first"],
        vec!["--review-system", "/synthetic/system.txt"],
        vec!["--review-source-ledger"],
        vec!["--activity-smoke"],
        vec!["--activity-claim-output-tokens", "1536"],
    ] {
        let mut arguments = base("--review-whole-packet-smoke");
        arguments.push("--review-source-ledger".into());
        arguments.extend(extras.into_iter().map(str::to_owned));
        assert!(parse_arguments(arguments).is_err());
    }
}

#[test]
fn source_ledger_cli_does_not_infer_a_pinned_model() {
    let mut arguments = base("--review-development-smoke");
    let offset = arguments
        .iter()
        .position(|argument| argument == "--model-id")
        .unwrap();
    arguments.drain(offset..offset + 2);
    arguments.push("--review-source-ledger".into());
    assert!(parse_arguments(arguments).is_err());
}

#[cfg(not(feature = "native-index-probe"))]
#[test]
fn source_ledger_cli_is_absent_from_default_build() {
    let mut arguments = base("--review-development-smoke");
    arguments.push("--review-source-ledger".into());
    assert!(parse_arguments(arguments).is_err());
}

#[cfg(feature = "native-index-probe")]
#[test]
fn source_ledger_system_cli_accepts_only_the_ledger_stage_override() {
    for mode in ["--review-development-smoke", "--review-whole-packet-smoke"] {
        for admission_only in [false, true] {
            for system_first in [false, true] {
                let mut arguments = base(mode);
                let override_arguments = [
                    "--review-source-ledger-system",
                    "/synthetic/source-only-system.txt",
                ];
                if system_first {
                    arguments.extend(override_arguments.into_iter().map(str::to_owned));
                }
                arguments.push("--review-source-ledger".into());
                if !system_first {
                    arguments.extend(override_arguments.into_iter().map(str::to_owned));
                }
                if admission_only {
                    arguments.push("--review-admission-only".into());
                }
                let result = parse_arguments(arguments);
                assert!(
                    result.is_ok(),
                    "source-only SYSTEM QA: {:?}",
                    result.as_ref().err()
                );
                let result = result.unwrap();
                assert!(result.review_source_ledger);
                assert!(result.review_system.is_none());
                assert!(!result.review_reason_first);
                assert_eq!(result.review_admission_only, admission_only);
                assert_eq!(result.model.manifest.id, "qwen3.5-4b-q4_k_m");
            }
        }
    }
}

#[test]
fn source_ledger_system_cli_requires_ledger_and_explicit_review_bindings() {
    let mut complete = base("--review-development-smoke");
    complete.extend([
        "--review-source-ledger".into(),
        "--review-source-ledger-system".into(),
        "/synthetic/source-only-system.txt".into(),
    ]);
    for missing in [
        "--review-source-ledger",
        "--review-development-smoke",
        "--review-source-audit",
        "--model-id",
    ] {
        let mut arguments = complete.clone();
        let offset = arguments.iter().position(|arg| arg == missing).unwrap();
        let count = if missing == "--review-source-ledger" {
            1
        } else {
            2
        };
        arguments.drain(offset..offset + count);
        assert!(parse_arguments(arguments).is_err(), "missing {missing}");
    }
}

#[test]
fn source_ledger_system_cli_rejects_confounded_repeated_or_missing_paths() {
    for extras in [
        vec!["--review-reason-first"],
        vec!["--review-system", "/synthetic/reviewer-system.txt"],
        vec!["--review-source-ledger-system", "/synthetic/repeated.txt"],
        vec!["--template-only"],
        vec!["--activity-smoke"],
        vec!["--activity-claim-output-tokens", "1536"],
    ] {
        let mut arguments = base("--review-whole-packet-smoke");
        arguments.extend([
            "--review-source-ledger".into(),
            "--review-source-ledger-system".into(),
            "/synthetic/source-only-system.txt".into(),
        ]);
        arguments.extend(extras.into_iter().map(str::to_owned));
        assert!(parse_arguments(arguments).is_err());
    }
    for missing_path in [vec![], vec![""], vec!["--review-admission-only"]] {
        let mut arguments = base("--review-development-smoke");
        arguments.extend([
            "--review-source-ledger".into(),
            "--review-source-ledger-system".into(),
        ]);
        arguments.extend(missing_path.into_iter().map(str::to_owned));
        assert!(parse_arguments(arguments).is_err());
    }
}

#[cfg(not(feature = "native-index-probe"))]
#[test]
fn source_ledger_system_cli_is_absent_from_default_build() {
    let mut arguments = base("--review-development-smoke");
    arguments.extend([
        "--review-source-ledger".into(),
        "--review-source-ledger-system".into(),
        "/synthetic/source-only-system.txt".into(),
    ]);
    assert!(parse_arguments(arguments).is_err());
}

#[cfg(feature = "native-index-probe")]
#[test]
fn source_ledger_only_cli_accepts_both_complete_source_packet_suites() {
    for mode in ["--review-development-smoke", "--review-whole-packet-smoke"] {
        for system_override in [false, true] {
            let mut arguments = base(mode);
            arguments.extend([
                "--review-source-ledger".into(),
                "--review-source-ledger-only".into(),
            ]);
            if system_override {
                arguments.extend([
                    "--review-source-ledger-system".into(),
                    "/synthetic/source-only-system.txt".into(),
                ]);
            }
            let result = parse_arguments(arguments);
            assert!(
                result.is_ok(),
                "source-only phase QA: {:?}",
                result.as_ref().err()
            );
            let result = result.unwrap();
            assert!(result.review_source_ledger);
            assert!(!result.review_admission_only);
            assert!(result.review_system.is_none());
            assert!(!result.review_reason_first);
        }
    }
}

#[test]
fn source_ledger_only_cli_requires_ledger_and_explicit_review_bindings() {
    let mut complete = base("--review-whole-packet-smoke");
    complete.extend([
        "--review-source-ledger".into(),
        "--review-source-ledger-only".into(),
    ]);
    for missing in [
        "--review-source-ledger",
        "--review-whole-packet-smoke",
        "--review-source-audit",
        "--model-id",
    ] {
        let mut arguments = complete.clone();
        let offset = arguments.iter().position(|arg| arg == missing).unwrap();
        let count = if missing == "--review-source-ledger" {
            1
        } else {
            2
        };
        arguments.drain(offset..offset + count);
        assert!(parse_arguments(arguments).is_err(), "missing {missing}");
    }
}

#[test]
fn source_ledger_only_cli_rejects_no_inference_and_confounded_modes() {
    for extras in [
        vec!["--review-admission-only"],
        vec!["--review-source-ledger-only"],
        vec!["--review-reason-first"],
        vec!["--review-system", "/synthetic/reviewer-system.txt"],
        vec!["--activity-smoke"],
        vec!["--activity-claim-output-tokens", "1536"],
    ] {
        let mut arguments = base("--review-development-smoke");
        arguments.extend([
            "--review-source-ledger".into(),
            "--review-source-ledger-only".into(),
        ]);
        arguments.extend(extras.into_iter().map(str::to_owned));
        assert!(parse_arguments(arguments).is_err());
    }
}

#[cfg(not(feature = "native-index-probe"))]
#[test]
fn source_ledger_only_cli_is_absent_from_default_build() {
    let mut arguments = base("--review-development-smoke");
    arguments.extend([
        "--review-source-ledger".into(),
        "--review-source-ledger-only".into(),
    ]);
    assert!(parse_arguments(arguments).is_err());
}

#[cfg(feature = "native-index-probe")]
#[test]
fn source_ledger_cli_retains_exact_system_path_and_source_only_option() {
    for mode in ["--review-development-smoke", "--review-whole-packet-smoke"] {
        for source_only in [false, true] {
            let mut arguments = base(mode);
            arguments.push("--review-source-ledger".into());
            let defaults = parse_arguments(arguments.clone()).unwrap();
            assert!(defaults.review_source_ledger_system.is_none());
            assert!(!defaults.review_source_ledger_only);
            arguments.extend([
                "--review-source-ledger-system".into(),
                "/synthetic/source-only-system.txt".into(),
            ]);
            if source_only {
                arguments.push("--review-source-ledger-only".into());
            }
            let options = parse_arguments(arguments).unwrap();
            assert_eq!(
                options.review_source_ledger_system.as_deref(),
                Some(std::path::Path::new("/synthetic/source-only-system.txt"))
            );
            assert_eq!(options.review_source_ledger_only, source_only);
            assert!(options.review_system.is_none());
            assert!(!options.review_reason_first);
        }
    }
}

#[cfg(feature = "native-index-probe")]
#[test]
fn source_ledger_system_loader_preserves_exact_utf8_and_size_boundary() {
    use super::review_decomposition_execution::load_source_ledger_system;

    assert_eq!(load_source_ledger_system(None).unwrap(), None);
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("system.txt");
    for text in [
        "Source-only schema. 한국어\r\n\n".to_owned(),
        "x".repeat(16 * 1024),
    ] {
        std::fs::write(&path, text.as_bytes()).unwrap();
        let selected = load_source_ledger_system(Some(&path)).unwrap().unwrap();
        assert_eq!(selected.as_bytes(), text.as_bytes());
        assert_eq!(
            super::review_smoke::hash(selected.as_bytes()),
            super::review_smoke::hash(text.as_bytes())
        );
    }
}

#[cfg(feature = "native-index-probe")]
#[test]
fn source_ledger_system_loader_rejects_unreadable_nontext_empty_and_oversize_files() {
    use super::review_decomposition_execution::load_source_ledger_system;

    let directory = tempfile::tempdir().unwrap();
    assert!(load_source_ledger_system(Some(directory.path())).is_err());
    assert!(load_source_ledger_system(Some(&directory.path().join("missing.txt"))).is_err());
    let path = directory.path().join("system.txt");
    for bytes in [
        vec![],
        b" \t\r\n".to_vec(),
        vec![0xff],
        vec![b'x'; 16 * 1024 + 1],
    ] {
        std::fs::write(&path, bytes).unwrap();
        assert!(load_source_ledger_system(Some(&path)).is_err());
    }
}

#[cfg(all(feature = "native-index-probe", unix))]
#[test]
fn source_ledger_system_loader_rejects_symlink_even_to_valid_system() {
    use super::review_decomposition_execution::load_source_ledger_system;

    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("target.txt");
    let link = directory.path().join("link.txt");
    std::fs::write(&target, "Source-only schema.").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(load_source_ledger_system(Some(&link)).is_err());
}
