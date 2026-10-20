//! Isolated native Ask QA. No artifact discovery, download, or private vault fallback.
fn main() {
    let config = parse_config(std::env::args_os().skip(1)).unwrap_or_else(|message| fail(message));
    std::process::exit(myco_lib::native_ask_probe::run(config));
}

fn parse_config(
    arguments: impl IntoIterator<Item = std::ffi::OsString>,
) -> Result<myco_lib::native_ask_probe::Config, &'static str> {
    let mut config = myco_lib::native_ask_probe::Config {
        control_artifact: None,
        watchdog_seconds: 900,
        visible_window: false,
        background_policy: None,
        activity_questions: false,
        activity_model_id: None,
        compact_claims: false,
        source_focus_claims: false,
        named_source_focus_claims: false,
        ordinal_activity: false,
        reviewed_activity_correction: false,
    };
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--control-artifact")=> {
                if config.control_artifact.is_some() { return Err("duplicate control artifact argument"); }
                config.control_artifact=Some(arguments.next().map(std::path::PathBuf::from).ok_or("control artifact path is required")?);
            }
            Some("--watchdog-seconds")=> {
                config.watchdog_seconds=arguments.next().and_then(|value|value.to_str().and_then(|value|value.parse().ok()))
                    .ok_or("positive watchdog seconds are required")?;
            }
            Some("--visible-window")=> {
                if config.visible_window { return Err("duplicate visible window argument"); }
                config.visible_window=true;
            }
            Some("--background-policy")=> {
                if config.background_policy.is_some() { return Err("duplicate background policy argument"); }
                config.background_policy=Some(match arguments.next().as_deref().and_then(|value|value.to_str()) {
                    Some("default")=>myco_lib::native_ask_probe::BackgroundPolicyQa::Default,
                    Some("disabled")=>myco_lib::native_ask_probe::BackgroundPolicyQa::Disabled,
                    _=>return Err("background policy must be default or disabled"),
                });
            }
            Some("--activity-questions")=> {
                if config.activity_questions { return Err("duplicate activity questions argument"); }
                config.activity_questions=true;
            }
            Some("--activity-model-id")=> {
                if config.activity_model_id.is_some() { return Err("duplicate activity model argument"); }
                config.activity_model_id=Some(arguments.next().and_then(|id|id.into_string().ok()).ok_or("activity model ID is required")?);
            }
            Some("--compact-extraction")=> {
                if config.compact_claims { return Err("duplicate compact extraction argument"); }
                config.compact_claims=true;
            }
            Some("--source-focus-claims")=> {
                if config.source_focus_claims { return Err("duplicate source focus claims argument"); }
                config.source_focus_claims=true;
            }
            Some("--named-source-focus-claims")=> {
                if config.named_source_focus_claims { return Err("duplicate named source focus claims argument"); }
                config.named_source_focus_claims=true;
            }
            Some("--ordinal-activity-claims")=> {
                if config.ordinal_activity { return Err("duplicate Ordinal activity argument"); }
                config.ordinal_activity=true;
            }
            Some("--reviewed-activity-correction")=> {
                if config.reviewed_activity_correction { return Err("duplicate reviewed activity correction argument"); }
                config.reviewed_activity_correction=true;
            }
            _=>return Err("supported arguments: --control-artifact <absolute prepared pinned model path> --watchdog-seconds <1..3600> --visible-window --background-policy <default|disabled> --activity-questions --activity-model-id <pinned QA model ID> --compact-extraction --source-focus-claims --named-source-focus-claims --ordinal-activity-claims --reviewed-activity-correction"),
        }
    }
    config.activity_manifest()?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(values: &[&str]) -> Vec<std::ffi::OsString> {
        values
            .iter()
            .map(|value| std::ffi::OsString::from(*value))
            .collect()
    }

    #[test]
    fn hidden_window_and_watchdog_are_unchanged_defaults() {
        let config = parse_config(arguments(&[])).unwrap();
        assert!(!config.visible_window);
        assert!(config.background_policy.is_none());
        assert!(!config.compact_claims);
        assert!(!config.source_focus_claims);
        assert!(!config.named_source_focus_claims);
        assert!(!config.reviewed_activity_correction);
        assert_eq!(config.watchdog_seconds, 900);
        assert!(config.control_artifact.is_none());
        assert_eq!(
            config.activity_manifest().unwrap().id,
            myco_lib::local_model::MODEL.id
        );
    }

    #[test]
    fn visible_window_only_changes_the_explicit_qa_window_option() {
        let config = parse_config(arguments(&["--visible-window"])).unwrap();
        assert!(config.visible_window);
        assert_eq!(config.watchdog_seconds, 900);
        assert!(config.control_artifact.is_none());
    }

    #[test]
    fn duplicate_and_unknown_visible_options_fail_closed() {
        assert!(parse_config(arguments(&["--visible-window", "--visible-window"])).is_err());
        assert!(parse_config(arguments(&["--visible-window=false"])).is_err());
        assert!(parse_config(arguments(&["--visible-window", "false"])).is_err());
    }

    #[test]
    fn background_policy_is_an_explicit_qa_option() {
        for (argument, expected) in [
            (
                "default",
                myco_lib::native_ask_probe::BackgroundPolicyQa::Default,
            ),
            (
                "disabled",
                myco_lib::native_ask_probe::BackgroundPolicyQa::Disabled,
            ),
        ] {
            let config = parse_config(arguments(&["--background-policy", argument])).unwrap();
            assert_eq!(config.background_policy, Some(expected));
            assert!(!config.visible_window);
            assert_eq!(config.watchdog_seconds, 900);
            assert!(!config.activity_questions);
            assert!(config.control_artifact.is_none());
            assert!(config.activity_model_id.is_none());
        }
    }

    #[test]
    fn background_policy_rejects_missing_unknown_and_duplicate_values() {
        for values in [
            vec!["--background-policy"],
            vec!["--background-policy", "automatic"],
            vec!["--background-policy=disabled"],
            vec![
                "--background-policy",
                "default",
                "--background-policy",
                "disabled",
            ],
            vec![
                "--background-policy",
                "disabled",
                "--background-policy",
                "disabled",
            ],
        ] {
            assert!(parse_config(arguments(&values)).is_err());
        }
    }

    #[test]
    fn exact_activity_questions_are_an_explicit_qa_mode() {
        assert!(
            parse_config(arguments(&["--activity-questions"]))
                .unwrap()
                .activity_questions
        );
        assert!(
            parse_config(arguments(&["--activity-questions", "--activity-questions"])).is_err()
        );
    }

    #[test]
    fn pinned_activity_candidates_require_an_explicit_activity_mode() {
        for model in [
            "qwen3.5-4b-q4_k_m",
            "gemma-4-e4b-it-qat-q4_0",
            "qwen3.5-9b-q4_k_m",
            "gemma-4-12b-it-qat-q4_0",
        ] {
            let config = parse_config(arguments(&[
                "--activity-model-id",
                model,
                "--activity-questions",
            ]))
            .unwrap();
            assert!(config.activity_questions);
            assert_eq!(config.activity_model_id.as_deref(), Some(model));
            assert_eq!(config.activity_manifest().unwrap().id, model);
            assert!(parse_config(arguments(&["--activity-model-id", model])).is_err());
        }
    }

    #[test]
    fn activity_model_arguments_reject_missing_unknown_or_duplicate_ids() {
        for values in [
            vec!["--activity-questions", "--activity-model-id"],
            vec!["--activity-questions", "--activity-model-id", "unknown"],
            vec!["--activity-questions", "--activity-model-id", "qwen9b"],
            vec!["--activity-questions", "--activity-model-id", "gemma12b"],
            vec![
                "--activity-questions",
                "--activity-model-id",
                "gemma-4-12b-it-qat-q4_0 ",
            ],
            vec![
                "--activity-questions",
                "--activity-model-id",
                "gemma-4-12b-it-qat-q4_0.gguf",
            ],
            vec![
                "--activity-questions",
                "--activity-model-id",
                "Qwen3.5-9B-Q4_K_M.gguf",
            ],
            vec![
                "--activity-questions",
                "--activity-model-id",
                "qwen3.5-9b-q4_k_m ",
            ],
            vec![
                "--activity-questions",
                "--activity-model-id",
                "qwen3.5-2b-q4_k_m",
            ],
            vec![
                "--activity-questions",
                "--activity-model-id",
                "qwen3.5-4b-q4_k_m",
                "--activity-model-id",
                "gemma-4-e4b-it-qat-q4_0",
            ],
        ] {
            assert!(parse_config(arguments(&values)).is_err());
        }
    }

    #[test]
    fn preparation_arguments_keep_their_existing_validation() {
        assert!(parse_config(arguments(&["--control-artifact"])).is_err());
        assert!(parse_config(arguments(&["--watchdog-seconds", "invalid"])).is_err());
        let config = parse_config(arguments(&[
            "--control-artifact",
            "/synthetic/control.gguf",
            "--watchdog-seconds",
            "120",
            "--visible-window",
        ]))
        .unwrap();
        assert_eq!(
            config.control_artifact,
            Some(std::path::PathBuf::from("/synthetic/control.gguf"))
        );
        assert_eq!(config.watchdog_seconds, 120);
        assert!(config.visible_window);
    }

    #[test]
    fn compact_claims_require_the_explicit_activity_qa_mode() {
        let config =
            parse_config(arguments(&["--activity-questions", "--compact-extraction"])).unwrap();
        assert!(config.compact_claims);
        assert!(!config.source_focus_claims);
        assert!(!config.visible_window);
        assert!(config.background_policy.is_none());
        assert_eq!(config.watchdog_seconds, 900);
        for values in [
            vec!["--compact-extraction"],
            vec![
                "--activity-questions",
                "--compact-extraction",
                "--compact-extraction",
            ],
            vec!["--activity-questions", "--compact-extraction=true"],
        ] {
            assert!(parse_config(arguments(&values)).is_err());
        }
    }

    #[test]
    fn source_focus_claims_are_explicit_activity_only_and_keep_other_defaults() {
        for values in [
            vec!["--activity-questions", "--source-focus-claims"],
            vec!["--source-focus-claims", "--activity-questions"],
        ] {
            let config = parse_config(arguments(&values)).unwrap();
            assert!(config.activity_questions && config.source_focus_claims);
            assert!(!config.compact_claims && !config.visible_window);
            assert!(config.background_policy.is_none());
            assert!(config.control_artifact.is_none());
            assert!(config.activity_model_id.is_none());
            assert_eq!(config.watchdog_seconds, 900);
            assert_eq!(
                config.activity_manifest().unwrap().id,
                myco_lib::local_model::MODEL.id
            );
        }
        assert!(parse_config(arguments(&["--source-focus-claims"])).is_err());
    }

    #[test]
    fn source_focus_rejects_duplicate_unknown_and_compact_combinations_in_both_orders() {
        for values in [
            vec![
                "--activity-questions",
                "--source-focus-claims",
                "--source-focus-claims",
            ],
            vec!["--activity-questions", "--source-focus-claims=true"],
            vec!["--activity-questions", "--source-focus-claims", "false"],
            vec![
                "--activity-questions",
                "--source-focus-claims",
                "--compact-extraction",
            ],
            vec![
                "--activity-questions",
                "--compact-extraction",
                "--source-focus-claims",
            ],
        ] {
            assert!(parse_config(arguments(&values)).is_err());
        }
    }

    #[test]
    fn reviewed_correction_requires_explicit_focus_activity_and_keeps_defaults() {
        for values in [
            vec![
                "--activity-questions",
                "--source-focus-claims",
                "--reviewed-activity-correction",
            ],
            vec![
                "--reviewed-activity-correction",
                "--source-focus-claims",
                "--activity-questions",
            ],
        ] {
            let config = parse_config(arguments(&values)).unwrap();
            assert!(config.reviewed_activity_correction);
            assert!(config.activity_questions && config.source_focus_claims);
            assert!(!config.compact_claims && !config.visible_window);
            assert!(config.background_policy.is_none());
            assert!(config.control_artifact.is_none() && config.activity_model_id.is_none());
            assert_eq!(config.watchdog_seconds, 900);
            assert_eq!(
                config.activity_manifest().unwrap().id,
                myco_lib::local_model::MODEL.id
            );
        }
        assert!(
            !parse_config(arguments(&[
                "--activity-questions",
                "--source-focus-claims"
            ]))
            .unwrap()
            .reviewed_activity_correction
        );
    }

    #[test]
    fn reviewed_correction_rejects_unselected_duplicate_value_and_compact_routes() {
        for values in [
            vec!["--reviewed-activity-correction"],
            vec!["--activity-questions", "--reviewed-activity-correction"],
            vec!["--source-focus-claims", "--reviewed-activity-correction"],
            vec![
                "--activity-questions",
                "--source-focus-claims",
                "--reviewed-activity-correction",
                "--reviewed-activity-correction",
            ],
            vec![
                "--activity-questions",
                "--source-focus-claims",
                "--reviewed-activity-correction=true",
            ],
            vec![
                "--activity-questions",
                "--source-focus-claims",
                "--reviewed-activity-correction",
                "false",
            ],
            vec![
                "--activity-questions",
                "--source-focus-claims",
                "--reviewed-activity-correction",
                "--compact-extraction",
            ],
            vec![
                "--activity-questions",
                "--compact-extraction",
                "--reviewed-activity-correction",
                "--source-focus-claims",
            ],
        ] {
            assert!(parse_config(arguments(&values)).is_err());
        }
    }

    #[test]
    fn qwen9b_selection_keeps_the_explicit_bounded_correction_contract() {
        let config = parse_config(arguments(&[
            "--activity-questions",
            "--activity-model-id",
            "qwen3.5-9b-q4_k_m",
            "--source-focus-claims",
            "--reviewed-activity-correction",
        ]))
        .unwrap();
        assert!(config.activity_questions && config.source_focus_claims);
        assert!(config.reviewed_activity_correction);
        assert!(!config.compact_claims && !config.visible_window);
        assert!(config.control_artifact.is_none() && config.background_policy.is_none());
        assert_eq!(config.watchdog_seconds, 900);
        assert_eq!(
            serde_json::to_value(config.activity_manifest().unwrap()).unwrap(),
            serde_json::to_value(myco_lib::local_model::QWEN9B_CANDIDATE).unwrap()
        );
        assert!(parse_config(arguments(&[
            "--activity-questions",
            "--activity-model-id",
            "qwen3.5-9b-q4_k_m",
            "--activity-model-id",
            "qwen3.5-9b-q4_k_m",
        ]))
        .is_err());
    }

    #[test]
    fn gemma12b_selection_keeps_the_explicit_ordinal_activity_contract() {
        let config = parse_config(arguments(&[
            "--activity-questions",
            "--activity-model-id",
            "gemma-4-12b-it-qat-q4_0",
            "--source-focus-claims",
            "--ordinal-activity-claims",
        ]))
        .unwrap();
        assert!(config.activity_questions && config.source_focus_claims && config.ordinal_activity);
        assert!(!config.reviewed_activity_correction && !config.compact_claims);
        assert!(!config.named_source_focus_claims && !config.visible_window);
        assert!(config.control_artifact.is_none() && config.background_policy.is_none());
        assert_eq!(config.watchdog_seconds, 900);
        assert_eq!(
            serde_json::to_value(config.activity_manifest().unwrap()).unwrap(),
            serde_json::to_value(myco_lib::local_model::GEMMA12B_CANDIDATE).unwrap()
        );
        assert!(parse_config(arguments(&[
            "--activity-questions",
            "--activity-model-id",
            "gemma-4-12b-it-qat-q4_0",
            "--activity-model-id",
            "gemma-4-12b-it-qat-q4_0",
        ]))
        .is_err());
    }
}

#[cfg(test)]
mod named_focus_tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<std::ffi::OsString> {
        values
            .iter()
            .map(|value| std::ffi::OsString::from(*value))
            .collect()
    }
    #[test]
    fn named_flag_is_explicit_and_keeps_model_and_correction_defaults() {
        let config = parse_config(args(&[
            "--named-source-focus-claims",
            "--activity-questions",
            "--source-focus-claims",
        ]))
        .unwrap();
        assert!(
            config.named_source_focus_claims
                && config.source_focus_claims
                && config.activity_questions
        );
        assert!(
            !config.reviewed_activity_correction
                && !config.compact_claims
                && !config.visible_window
        );
        assert_eq!(
            config.activity_manifest().unwrap().id,
            myco_lib::local_model::MODEL.id
        );
        assert_eq!(config.watchdog_seconds, 900);
    }
    #[test]
    fn named_flag_rejects_missing_prerequisites_duplicates_values_and_compact() {
        for values in [
            vec!["--named-source-focus-claims"],
            vec!["--activity-questions", "--named-source-focus-claims"],
            vec!["--source-focus-claims", "--named-source-focus-claims"],
            vec![
                "--activity-questions",
                "--source-focus-claims",
                "--named-source-focus-claims",
                "--named-source-focus-claims",
            ],
            vec![
                "--activity-questions",
                "--source-focus-claims",
                "--named-source-focus-claims",
                "--compact-extraction",
            ],
            vec![
                "--activity-questions",
                "--source-focus-claims",
                "--named-source-focus-claims=true",
            ],
            vec![
                "--activity-questions",
                "--source-focus-claims",
                "--named-source-focus-claims",
                "false",
            ],
        ] {
            assert!(parse_config(args(&values)).is_err(), "{values:?}");
        }
    }
}

fn fail(message: &str) -> ! {
    eprintln!("native Ask QA argument error: {message}");
    std::process::exit(1);
}

#[cfg(test)]
mod ordinal_cli_tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<std::ffi::OsString> {
        values.iter().map(std::ffi::OsString::from).collect()
    }
    #[test]
    fn ordinal_is_explicit_activity_only_without_wire_alias_or_initial_correction() {
        let base = [
            "--activity-questions",
            "--source-focus-claims",
            "--ordinal-activity-claims",
        ];
        let config = parse_config(args(&base)).unwrap();
        assert!(config.ordinal_activity);
        assert!(!config.named_source_focus_claims && !config.reviewed_activity_correction);
        assert!(!parse_config(args(&[])).unwrap().ordinal_activity);
        for extra in [
            "--ordinal-activity-claims",
            "--named-source-focus-claims",
            "--compact-extraction",
            "--reviewed-activity-correction",
        ] {
            let mut values = base.to_vec();
            values.push(extra);
            assert!(parse_config(args(&values)).is_err());
        }
        for values in [
            vec!["--ordinal-activity-claims"],
            vec!["--activity-questions", "--ordinal-activity-claims"],
            vec!["--ordinal-activity-claims=true"],
            vec!["--ordinal-activity-claims", "false"],
        ] {
            assert!(parse_config(args(&values)).is_err());
        }
    }
}
