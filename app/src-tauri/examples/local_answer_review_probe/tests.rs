//! Source/binding and mocked callback checks; no tokenizer, model or meaning acceptance.

use super::*;

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).into()).collect()
}
fn valid_args() -> Vec<String> {
    args(&[
        "--model-id",
        GEMMA12B_CANDIDATE.id,
        "--model-dir",
        "/synthetic/models",
        "--reviewer-qualification-qa",
    ])
}

#[test]
fn closed_cli_requires_mode_pinned_model_and_absolute_directory() {
    assert_eq!(
        options(valid_args()).unwrap(),
        PathBuf::from("/synthetic/models")
    );
    for invalid in [
        args(&[]),
        args(&[
            "--model-id",
            GEMMA12B_CANDIDATE.id,
            "--model-dir",
            "/synthetic/models",
        ]),
        args(&[
            "--reviewer-qualification-qa",
            "--model-dir",
            "/synthetic/models",
        ]),
        args(&[
            "--reviewer-qualification-qa",
            "--model-id",
            GEMMA12B_CANDIDATE.id,
        ]),
        args(&[
            "--reviewer-qualification-qa",
            "--model-id",
            "other-model",
            "--model-dir",
            "/synthetic/models",
        ]),
        args(&[
            "--reviewer-qualification-qa",
            "--model-id",
            GEMMA12B_CANDIDATE.id,
            "--model-dir",
            "relative",
        ]),
        args(&[
            "--reviewer-qualification-qa",
            "--model-id",
            GEMMA12B_CANDIDATE.id,
            "--model-dir",
        ]),
    ] {
        assert!(options(invalid).is_err());
    }
    for extra in [
        args(&["--reviewer-qualification-qa"]),
        args(&["true"]),
        args(&["--reviewer-qualification-qa=true"]),
        args(&["--model-id", GEMMA12B_CANDIDATE.id]),
        args(&["--model-dir", "/synthetic/other"]),
        args(&["--retry", "1"]),
        args(&["--development-cases"]),
    ] {
        let mut invalid = valid_args();
        invalid.extend(extra);
        assert!(options(invalid).is_err());
    }
}

#[test]
fn native_prepared_schedule_has_sixteen_neutral_cases_and_unchanged_family_source_context() {
    let cases = qualification::prepare_all().unwrap();
    let inputs = contract::prepare_inputs(&cases).unwrap();
    assert_eq!(
        cases.iter().map(|case| case.id()).collect::<Vec<_>>(),
        contract::expected_ids()
    );
    assert_eq!(inputs.len(), 16);
    assert_eq!(
        cases
            .iter()
            .map(|case| case.original_count())
            .sum::<usize>(),
        52
    );
    for (index, case) in cases.iter().enumerate() {
        contract::check_wire(case, &inputs[index]).unwrap();
        let actual: Value = serde_json::from_str(&inputs[index].user).unwrap();
        assert_eq!(actual["originalSpans"], case.metadata()["originalSpans"]);
        assert_eq!(actual["answerInputRevision"], hash(case.raw_draft()));
        assert_eq!(
            actual["context"]["answerReviewQualificationQa"]["declaredRecordPeriodContext"],
            case.metadata()["declaredRecordPeriodContext"]
        );
        assert!(actual.get("caseId").is_none());
    }
    for pair in inputs.chunks_exact(2) {
        assert_eq!(pair[0].system, pair[1].system);
        assert_eq!(
            contract::common_payload(&pair[0]).unwrap(),
            contract::common_payload(&pair[1]).unwrap()
        );
    }
}

#[test]
fn captured_reviewer_input_rejects_dropped_tail_context_raw_revision_and_private_field_mutations() {
    let cases = qualification::prepare_all().unwrap();
    let inputs = contract::prepare_inputs(&cases).unwrap();
    let source = &inputs[0];
    let base: Value = serde_json::from_str(&source.user).unwrap();
    let reject = |payload: Value| {
        let wire = contract::Wire {
            system: source.system.clone(),
            user: payload.to_string(),
        };
        assert!(contract::check_wire(&cases[0], &wire).is_err());
    };
    let mut changed = base.clone();
    changed["originalSpans"].as_array_mut().unwrap().pop();
    reject(changed);
    let mut changed = base.clone();
    changed["contextRevision"] = json!("changed");
    reject(changed);
    let mut changed = base.clone();
    changed["context"]["answerReviewQualificationQa"]["declaredRecordPeriodContext"] = Value::Null;
    reject(changed);
    let mut changed = base.clone();
    changed["answerInputRevision"] = json!("different raw revision");
    reject(changed);
    let mut changed = base.clone();
    changed["answer"]["proseWithoutModelLinkLabels"] = json!("changed fixed answer");
    reject(changed);
    let mut changed = base.clone();
    changed["answer"]["modelAnswer"] = changed["answer"]["proseWithoutModelLinkLabels"].clone();
    changed["answer"]["inputRevision"] = changed["answerInputRevision"].clone();
    reject(changed);
    let mut changed = base.clone();
    changed["answer"]["rendered_body"] = json!("private rendered value");
    reject(changed);
    let mut changed = base;
    changed["caseId"] = json!("F01-P01");
    reject(changed);
}

#[test]
fn clean_telemetry_requires_existing_review_schema_profile_eog_and_no_pending_or_error() {
    let clean = json!({"profile":"gemma12BOrdinalQaV1","schema":"askAnswerReviewV1",
        "requestedOutputTokens":768,"requestedContextTokens":4096,"loopStop":"eog",
        "terminal":"returnedText","pendingUtf8Bytes":0,"errorCode":null});
    assert!(clean_telemetry(&clean));
    for (field, value) in [
        ("profile", json!("other")),
        ("schema", json!("askAnswerV1")),
        ("requestedOutputTokens", json!(769)),
        ("requestedContextTokens", json!(8192)),
        ("loopStop", json!("token_limit")),
        ("pendingUtf8Bytes", json!(1)),
        ("errorCode", json!("failed")),
    ] {
        let mut changed = clean.clone();
        changed[field] = value;
        assert!(!clean_telemetry(&changed));
    }
    let mut absent = clean;
    absent.as_object_mut().unwrap().remove("errorCode");
    assert!(!clean_telemetry(&absent));
}

#[test]
fn mocked_review_boundary_keeps_valid_negative_verdicts_as_observations_and_overflow_generation_zero(
) {
    let cases = qualification::prepare_all().unwrap();
    let case = &cases[0];
    // Mock counts/verdicts verify plumbing only; they prove neither token fit nor source meaning.
    for disposition in ["unsupported", "uncertain"] {
        let count_input = RefCell::new(None::<contract::Wire>);
        let count_calls = Cell::new(0);
        let generation_calls = Cell::new(0);
        let result = case
            .run(
                |system, user| {
                    count_calls.set(count_calls.get() + 1);
                    *count_input.borrow_mut() = Some(contract::Wire {
                        system: system.into(),
                        user: user.into(),
                    });
                    Ok(3320)
                },
                |system, user, output, context, schema| {
                    generation_calls.set(generation_calls.get() + 1);
                    assert_eq!(
                        count_input.borrow().as_ref(),
                        Some(&contract::Wire {
                            system: system.into(),
                            user: user.into()
                        })
                    );
                    assert_eq!(schema, GenerationSchema::AskAnswerReviewV1);
                    assert_eq!((output, context), (768, 4096));
                    Ok(
                        json!({"version":"AskAnswerReviewV1","answerDisposition":disposition,
                "taskResponse":"adequate","sourceCoverage":"covered","missingSpanIds":[],
                "reason":"Synthetic callback verdict, not a meaning judgment"})
                        .to_string(),
                    )
                },
            )
            .unwrap();
        assert_eq!(count_calls.get(), 1);
        assert_eq!(generation_calls.get(), 1);
        assert_eq!(result["automatedAccepted"], false);
        assert_eq!(result["writerGenerations"], 0);
        assert_eq!(result["maximumReviewGenerations"], 1);
    }
    let generated = Cell::new(false);
    let overflow = case.run(
        |_, _| Ok(3321),
        |_, _, _, _, _| {
            generated.set(true);
            Err("over-budget generation forbidden".into())
        },
    );
    assert_eq!(overflow.unwrap_err().code, "review_not_fit");
    assert!(!generated.get());
}
