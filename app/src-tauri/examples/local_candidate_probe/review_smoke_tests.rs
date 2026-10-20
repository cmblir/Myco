use super::parse_arguments;

fn parse(arguments: &[&str]) -> Result<super::ProbeOptions, String> {
    parse_arguments(arguments.iter().map(|argument| (*argument).to_owned()))
}

#[cfg(feature = "native-index-probe")]
#[test]
fn reviewer_mode_accepts_explicit_reviewed_development_inputs() {
    for extra in [None, Some("/synthetic/candidate-system.txt")] {
        let mut arguments = vec![
            "--model-dir",
            "/synthetic/pinned-model",
            "--model-id",
            "qwen3.5-4b-q4_k_m",
            "--review-development-smoke",
            "/synthetic/review-pairs.manifest.json",
            "--review-source-audit",
            "/synthetic/original-source-audit.json",
        ];
        if let Some(path) = extra {
            arguments.extend(["--review-system", path]);
        }
        let result = parse(&arguments);
        assert!(
            result.is_ok(),
            "explicit reviewed-development QA mode must be supported: {:?}",
            result.err()
        );
    }
}

#[test]
fn reviewer_mode_rejects_incomplete_repeated_or_mixed_inputs() {
    let base = ["--model-dir", "/synthetic/pinned-model"];
    for invalid in [
        vec!["--review-development-smoke"],
        vec![
            "--review-development-smoke",
            "/synthetic/review-manifest.json",
        ],
        vec!["--review-source-audit", "/synthetic/source-audit.json"],
        vec!["--review-system", "/synthetic/system.txt"],
        vec!["--review-development-smoke", "--review-source-audit"],
    ] {
        let arguments: Vec<_> = base.iter().copied().chain(invalid).collect();
        assert!(parse(&arguments).is_err());
    }
    for conflicting in [
        vec!["--template-only"],
        vec!["--activity-smoke"],
        vec!["--activity-positive-smoke"],
        vec!["--activity-contract-experiment"],
        vec!["--ordinary-smoke"],
        vec![
            "--activity-development-smoke",
            "/synthetic/development.json",
        ],
        vec!["--activity-claim-output-tokens", "1536"],
        vec!["--review-development-smoke", "/synthetic/repeated.json"],
        vec!["--review-source-audit", "/synthetic/repeated-audit.json"],
        vec![
            "--review-system",
            "/synthetic/system.txt",
            "--review-system",
            "/synthetic/again.txt",
        ],
    ] {
        let arguments: Vec<_> = base
            .iter()
            .copied()
            .chain([
                "--review-development-smoke",
                "/synthetic/review-pairs.manifest.json",
                "--review-source-audit",
                "/synthetic/source-audit.json",
            ])
            .chain(conflicting)
            .collect();
        assert!(parse(&arguments).is_err());
    }
}

#[cfg(feature = "native-index-probe")]
#[test]
fn whole_packet_reviewer_mode_accepts_explicit_frozen_inputs_and_isolated_grammar() {
    for mode in ["--review-development-smoke", "--review-whole-packet-smoke"] {
        for reason_first in [false, true] {
            let mut arguments = vec![
                "--model-dir",
                "/synthetic/pinned-model",
                "--model-id",
                "qwen3.5-4b-q4_k_m",
                mode,
                "/synthetic/frozen-manifest.json",
                "--review-source-audit",
                "/synthetic/independent-source-audit.json",
            ];
            if reason_first {
                arguments.push("--review-reason-first");
            }
            assert!(parse(&arguments).is_ok(), "{arguments:?}");
        }
    }
}

#[test]
fn whole_packet_reviewer_mode_rejects_unbound_or_confounded_experiments() {
    let base = [
        "--model-dir",
        "/synthetic/pinned-model",
        "--model-id",
        "qwen3.5-4b-q4_k_m",
    ];
    for invalid in [
        vec!["--review-reason-first"],
        vec!["--review-whole-packet-smoke"],
        vec!["--review-whole-packet-smoke", "/synthetic/manifest.json"],
        vec!["--review-whole-packet-smoke", "--review-source-audit"],
    ] {
        assert!(parse(&base.iter().copied().chain(invalid).collect::<Vec<_>>()).is_err());
    }
    let complete = [
        "--review-whole-packet-smoke",
        "/synthetic/frozen-manifest.json",
        "--review-source-audit",
        "/synthetic/source-audit.json",
    ];
    for conflicting in [
        vec!["--template-only"],
        vec!["--activity-smoke"],
        vec!["--activity-positive-smoke"],
        vec!["--activity-contract-experiment"],
        vec!["--ordinary-smoke"],
        vec![
            "--activity-development-smoke",
            "/synthetic/development.json",
        ],
        vec!["--activity-claim-output-tokens", "1536"],
        vec!["--review-development-smoke", "/synthetic/pairs.json"],
        vec!["--review-whole-packet-smoke", "/synthetic/repeated.json"],
        vec!["--review-reason-first", "--review-reason-first"],
        vec![
            "--review-reason-first",
            "--review-system",
            "/synthetic/system.txt",
        ],
    ] {
        let arguments = base
            .iter()
            .copied()
            .chain(complete)
            .chain(conflicting)
            .collect::<Vec<_>>();
        assert!(parse(&arguments).is_err(), "{arguments:?}");
    }
    assert!(
        parse(&[
            "--model-dir",
            "/synthetic/pinned-model",
            "--review-whole-packet-smoke",
            "/synthetic/frozen-manifest.json",
            "--review-source-audit",
            "/synthetic/source-audit.json",
        ])
        .is_err(),
        "review QA must select its exact pinned model explicitly"
    );
}

#[cfg(feature = "native-index-probe")]
#[test]
fn review_admission_only_requires_bound_inputs_and_cannot_repeat() {
    let base = [
        "--model-dir",
        "/synthetic/pinned-model",
        "--model-id",
        "qwen3.5-4b-q4_k_m",
    ];
    assert!(parse(
        &base
            .iter()
            .copied()
            .chain(["--review-admission-only"])
            .collect::<Vec<_>>()
    )
    .is_err());
    for mode in ["--review-development-smoke", "--review-whole-packet-smoke"] {
        let arguments = base
            .iter()
            .copied()
            .chain([
                mode,
                "/synthetic/frozen-manifest.json",
                "--review-source-audit",
                "/synthetic/source-audit.json",
                "--review-admission-only",
            ])
            .collect::<Vec<_>>();
        assert!(parse(&arguments).unwrap().review_admission_only);
        let repeated = arguments
            .into_iter()
            .chain(["--review-admission-only"])
            .collect::<Vec<_>>();
        assert!(parse(&repeated).is_err());
    }
}
