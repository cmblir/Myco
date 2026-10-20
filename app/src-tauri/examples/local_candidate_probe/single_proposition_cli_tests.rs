use super::parse_arguments;

fn arguments() -> Vec<String> {
    [
        "--model-dir",
        "/synthetic/pinned-model",
        "--model-id",
        "qwen3.5-4b-q4_k_m",
        "--review-development-smoke",
        "/synthetic/frozen-manifest.json",
        "--review-source-audit",
        "/synthetic/source-audit.json",
        "--review-single-proposition",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

#[cfg(feature = "native-index-probe")]
#[test]
fn single_proposition_cli_accepts_explicit_single_span_only() {
    assert!(parse_arguments(arguments()).is_ok());
    assert!(
        !parse_arguments(arguments())
            .unwrap()
            .review_single_proposition_actor_contract
    );
    let mut preflight = arguments();
    preflight.push("--review-admission-only".into());
    assert!(parse_arguments(preflight).is_ok());
}

#[cfg(feature = "native-index-probe")]
#[test]
fn actor_contract_cli_accepts_only_explicit_single_proposition_in_either_order() {
    for admission_only in [false, true] {
        for prepend in [false, true] {
            let mut args = arguments();
            if prepend {
                args.insert(0, "--review-single-proposition-actor-contract".into());
            } else {
                args.push("--review-single-proposition-actor-contract".into());
            }
            if admission_only {
                args.push("--review-admission-only".into());
            }
            let parsed = parse_arguments(args);
            assert!(parsed.is_ok());
            assert!(parsed.unwrap().review_single_proposition_actor_contract);
        }
    }
}

#[cfg(feature = "native-index-probe")]
#[test]
fn bounded_thinking_cli_accepts_only_explicit_gemma_actor_propositions() {
    for admission_only in [false, true] {
        for prepend in [false, true] {
            let mut args = arguments();
            args[3] = "gemma-4-e4b-it-qat-q4_0".into();
            args.push("--review-single-proposition-actor-contract".into());
            if prepend {
                args.insert(0, "--review-single-proposition-bounded-thinking".into());
            } else {
                args.push("--review-single-proposition-bounded-thinking".into());
            }
            if admission_only {
                args.push("--review-admission-only".into());
            }
            assert!(parse_arguments(args).is_ok());
        }
    }
}

#[test]
fn bounded_thinking_cli_rejects_unbound_models_and_confounded_modes() {
    let mut base = arguments();
    base[3] = "gemma-4-e4b-it-qat-q4_0".into();
    base.push("--review-single-proposition-actor-contract".into());
    base.push("--review-single-proposition-bounded-thinking".into());
    for model in ["qwen3.5-4b-q4_k_m", "qwen3.5-9b-q4_k_m", "unregistered"] {
        let mut args = base.clone();
        args[3] = model.into();
        assert!(parse_arguments(args).is_err(), "model {model}");
    }
    for missing in [
        "--review-single-proposition",
        "--review-single-proposition-actor-contract",
    ] {
        let args = base.iter().filter(|arg| arg.as_str() != missing).cloned();
        assert!(parse_arguments(args).is_err(), "missing {missing}");
    }
    for extras in [
        vec!["--review-single-proposition-bounded-thinking"],
        vec!["--review-system", "/synthetic/system.txt"],
        vec!["--review-reason-first"],
        vec!["--review-source-ledger"],
        vec!["--activity-claim-output-tokens", "1536"],
        vec!["--template-only"],
        vec!["--ordinary-smoke"],
    ] {
        let mut args = base.clone();
        args.extend(extras.into_iter().map(str::to_owned));
        assert!(parse_arguments(args).is_err());
    }
}

#[test]
fn actor_contract_cli_rejects_missing_base_mode_duplicates_and_confounds() {
    for required in [
        "--model-dir",
        "--model-id",
        "--review-development-smoke",
        "--review-source-audit",
    ] {
        let mut args = arguments();
        let index = args.iter().position(|arg| arg == required).unwrap();
        args.drain(index..index + 2);
        args.push("--review-single-proposition-actor-contract".into());
        assert!(parse_arguments(args).is_err(), "missing {required}");
    }
    let mut missing_base = arguments();
    missing_base.retain(|arg| arg != "--review-single-proposition");
    missing_base.push("--review-single-proposition-actor-contract".into());
    assert!(parse_arguments(missing_base).is_err());
    for extras in [
        vec!["--review-single-proposition-actor-contract"],
        vec!["--review-system", "/synthetic/system.txt"],
        vec!["--review-reason-first"],
        vec!["--review-source-ledger"],
        vec!["--review-source-ledger-only"],
        vec!["--review-source-ledger-system", "/synthetic/system.txt"],
        vec!["--activity-smoke"],
        vec!["--activity-claim-output-tokens", "1536"],
        vec!["--template-only"],
        vec!["--ordinary-smoke"],
    ] {
        let mut args = arguments();
        args.push("--review-single-proposition-actor-contract".into());
        args.extend(extras.into_iter().map(str::to_owned));
        assert!(parse_arguments(args).is_err());
    }
    let mut whole_packet = arguments();
    let index = whole_packet
        .iter()
        .position(|arg| arg == "--review-development-smoke")
        .unwrap();
    whole_packet[index] = "--review-whole-packet-smoke".into();
    whole_packet.push("--review-single-proposition-actor-contract".into());
    assert!(parse_arguments(whole_packet).is_err());
}

#[test]
fn single_proposition_cli_rejects_unbound_or_confounded_modes() {
    for required in [
        "--model-dir",
        "--model-id",
        "--review-development-smoke",
        "--review-source-audit",
    ] {
        let mut args = arguments();
        let index = args.iter().position(|arg| arg == required).unwrap();
        args.drain(index..index + 2);
        assert!(parse_arguments(args).is_err(), "missing {required}");
    }
    for extras in [
        vec!["--review-single-proposition"],
        vec!["--review-system", "/synthetic/system.txt"],
        vec!["--review-reason-first"],
        vec!["--review-source-ledger"],
        vec!["--review-source-ledger-only"],
        vec!["--review-source-ledger-system", "/synthetic/system.txt"],
        vec!["--activity-smoke"],
        vec!["--activity-claim-output-tokens", "1536"],
    ] {
        let mut args = arguments();
        args.extend(extras.into_iter().map(str::to_owned));
        assert!(parse_arguments(args).is_err());
    }
    let mut args = arguments();
    let index = args
        .iter()
        .position(|arg| arg == "--review-development-smoke")
        .unwrap();
    args[index] = "--review-whole-packet-smoke".into();
    assert!(parse_arguments(args).is_err());
}

#[cfg(not(feature = "native-index-probe"))]
#[test]
fn single_proposition_cli_is_absent_from_default_build() {
    assert!(parse_arguments(arguments()).is_err());
    let mut args = arguments();
    args.push("--review-single-proposition-actor-contract".into());
    assert!(parse_arguments(args).is_err());
    let unsupported = [
        "--model-dir",
        "/synthetic/pinned-model",
        "--review-single-proposition-actor-contract",
    ];
    let error = parse_arguments(unsupported.into_iter().map(str::to_owned))
        .err()
        .unwrap();
    assert!(error.contains("native-index-probe"));
    let error = parse_arguments(
        [
            "--model-dir",
            "/synthetic/pinned-model",
            "--review-single-proposition-bounded-thinking",
        ]
        .into_iter()
        .map(str::to_owned),
    )
    .err()
    .unwrap();
    assert!(error.contains("native-index-probe"));
}
