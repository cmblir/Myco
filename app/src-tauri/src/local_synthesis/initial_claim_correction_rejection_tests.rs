//! Non-semantic failure and private receipt mutation controls.

use super::*;

#[test]
fn uncertain_invalid_unavailable_stop_and_not_fit_do_not_trigger_correction() {
    for failure in [
        "uncertain",
        "invalid",
        "unavailable",
        "stopped",
        "not_fit",
        "generation_invalid",
        "generation_stopped",
    ] {
        let calls = Cell::new(0);
        let result = extract(
            &sources(2),
            &context(true),
            |_, user| {
                let packet: Value = serde_json::from_str(user).unwrap();
                Ok(
                    if failure == "not_fit" && packet.get("requiredClaimIds").is_some() {
                        5000
                    } else {
                        1400
                    },
                )
            },
            |_, user, _, _, schema| {
                calls.set(calls.get() + 1);
                let packet: Value = serde_json::from_str(user).unwrap();
                assert!(packet.get("initialExtractionCorrection").is_none());
                if matches!(schema, GenerationSchema::WikiClaimReviewV1(_)) {
                    return match failure {
                        "uncertain" => Ok(negative(user, "supported", "uncertain")),
                        "invalid" => Ok("{}".into()),
                        "unavailable" => Err("synthetic model unavailable".into()),
                        "stopped" => Err("stopped".into()),
                        _ => panic!("unexpected review generation"),
                    };
                }
                match failure {
                    "generation_invalid" => Ok("{}".into()),
                    "generation_stopped" => Err("synthetic cancelled".into()),
                    _ => Ok(output(&packet, vec![])),
                }
            },
        );
        let error = result.err().unwrap();
        assert!(!error.is_empty());
        assert_eq!(
            calls.get(),
            if matches!(
                failure,
                "not_fit" | "generation_invalid" | "generation_stopped"
            ) {
                1
            } else {
                2
            },
            "{failure}"
        );
    }
}

fn attempt_fixture() -> (
    SourceSet,
    AskReviewContext,
    PreparedFocusQa,
    String,
    FocusProjectionQa,
    CheckedClaims,
    NativeFocusClaimReviewQa,
) {
    let packet = sources(2);
    let context = context(true);
    let user = claim_prompt::payload(
        QUESTION,
        "en",
        &period(),
        &packet.spans().collect::<Vec<_>>(),
    )
    .unwrap();
    let prepared = PreparedFocusQa::prepare(&user).unwrap();
    let raw = output(&serde_json::from_str(prepared.user()).unwrap(), vec![]);
    let projection = prepared.expand(&raw).unwrap();
    let claims = packet
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    let review = wiki_claim_review::focus_qa::run(
        &context,
        &packet,
        &claims,
        &projection,
        |_, _| Ok(1400),
        |_, user, _, _, _| Ok(negative(user, "supported", "missing")),
    )
    .unwrap();
    (packet, context, prepared, raw, projection, claims, review)
}

#[test]
fn fit_and_previous_result_errors_do_not_consume_a_generation_allowance() {
    let (packet, context, prepared, raw, projection, claims, review) = attempt_fixture();
    for changed_raw in [false, true] {
        let mut used = false;
        let calls = Cell::new(0);
        let changed = raw.clone() + " ";
        let result = correct(
            InitialAttemptQa {
                prepared: &prepared,
                raw: if changed_raw { &changed } else { &raw },
                projection: &projection,
                claims: &claims,
                review: &review,
            },
            &context,
            &packet,
            &origin(),
            Scope::Sessions,
            768,
            &mut used,
            &mut |_, _| Ok(5000),
            &mut |_, _, _, _, _| {
                calls.set(calls.get() + 1);
                Ok("{}".into())
            },
        );
        let error = result.err().unwrap();
        if changed_raw {
            assert!(error.contains("previous raw model output changed"));
        } else {
            assert!(error.starts_with("review_not_fit:"));
        }
        assert!(!used);
        assert_eq!(calls.get(), 0);
    }
    let mut used = false;
    let calls = Cell::new(0);
    let mut wrong_raw: Value = serde_json::from_str(&raw).unwrap();
    wrong_raw["packetSha256"] = json!("0".repeat(64));
    let wrong_raw = wrong_raw.to_string();
    assert!(correct(
        InitialAttemptQa {
            prepared: &prepared,
            raw: &wrong_raw,
            projection: &projection,
            claims: &claims,
            review: &review
        },
        &context,
        &packet,
        &origin(),
        Scope::Sessions,
        768,
        &mut used,
        &mut |_, _| Ok(1400),
        &mut |_, _, _, _, _| {
            calls.set(calls.get() + 1);
            Ok("{}".into())
        }
    )
    .is_err());
    assert!(!used);
    assert_eq!(calls.get(), 0);
}

#[test]
fn consumed_generation_and_cancellation_never_restore_the_initial_allowance() {
    let (packet, context, prepared, raw, projection, claims, review) = attempt_fixture();
    let mut used = false;
    let calls = Cell::new(0);
    let error = correct(
        InitialAttemptQa {
            prepared: &prepared,
            raw: &raw,
            projection: &projection,
            claims: &claims,
            review: &review,
        },
        &context,
        &packet,
        &origin(),
        Scope::Sessions,
        768,
        &mut used,
        &mut |_, _| Ok(1400),
        &mut |_, _, _, _, _| {
            calls.set(calls.get() + 1);
            Err("synthetic cancelled".into())
        },
    )
    .err()
    .unwrap();
    assert_eq!(error, "synthetic cancelled");
    assert!(used);
    assert_eq!(calls.get(), 1);
    assert!(correct(
        InitialAttemptQa {
            prepared: &prepared,
            raw: &raw,
            projection: &projection,
            claims: &claims,
            review: &review
        },
        &context,
        &packet,
        &origin(),
        Scope::Sessions,
        768,
        &mut used,
        &mut |_, _| Ok(1400),
        &mut |_, _, _, _, _| {
            calls.set(calls.get() + 1);
            Ok("{}".into())
        }
    )
    .is_err());
    assert_eq!(calls.get(), 1);
}

#[test]
fn changed_origin_scope_and_cancelled_tokenization_never_generate() {
    let (packet, context, prepared, raw, projection, claims, review) = attempt_fixture();
    for mutation in 0..3 {
        let mut changed_origin = origin();
        if mutation == 0 {
            changed_origin.opening_token.push('!');
        }
        let scope = if mutation == 1 {
            Scope::All
        } else {
            Scope::Sessions
        };
        let mut used = false;
        let calls = Cell::new(0);
        let result = correct(
            InitialAttemptQa {
                prepared: &prepared,
                raw: &raw,
                projection: &projection,
                claims: &claims,
                review: &review,
            },
            &context,
            &packet,
            &changed_origin,
            scope,
            768,
            &mut used,
            &mut |_, _| {
                if mutation == 2 {
                    Err("stopped".into())
                } else {
                    Ok(1400)
                }
            },
            &mut |_, _, _, _, _| {
                calls.set(calls.get() + 1);
                Ok("{}".into())
            },
        );
        let error = result.err().unwrap();
        if mutation == 2 {
            assert!(error.starts_with("review_stopped:"));
        }
        assert!(!used);
        assert_eq!(calls.get(), 0);
    }
}
