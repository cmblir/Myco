use super::*;

#[test]
fn cleanup_failures_keep_each_phase_and_underlying_cause() {
    let wake = cleanup_result(
        ReplyWait::Received(Ok(Err("wake refused".into()))),
        "cleanup_wake",
    );
    let drain = cleanup_result(ReplyWait::Expired, "original_drain");
    assert_eq!(wake.unwrap_err(), "cleanup_wake native error: wake refused");
    assert_eq!(drain.unwrap_err(), "original_drain watchdog expired");
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Value, String>>();
    drop(sender);
    let error = receiver.blocking_recv().unwrap_err();
    assert!(
        cleanup_result(ReplyWait::Received(Err(error)), "original_drain")
            .unwrap_err()
            .starts_with("original_drain reply dropped:")
    );
}

#[test]
fn received_payload_must_match_token_delay_and_all_fields() {
    assert!(grade_primary(ReplyWait::Received(Ok(Ok(expected_echo()))), 35.0).passed);
    for field in ["token", "echo", "delaySeconds", "unexpected"] {
        let mut payload = expected_echo();
        payload[field] = json!("different");
        assert!(!grade_primary(ReplyWait::Received(Ok(Ok(payload))), 35.0).passed);
    }
    assert!(
        !grade_primary(
            ReplyWait::Received(Ok(Err("native echo refused".into()))),
            35.0
        )
        .passed
    );
}

#[test]
fn completed_echo_after_deadline_or_before_native_delay_cannot_pass() {
    for elapsed in [0.0, 34.999, 50.001, f64::INFINITY, f64::NAN] {
        assert!(!grade_primary(ReplyWait::Received(Ok(Ok(expected_echo()))), elapsed).passed);
    }
}

#[test]
fn wrong_correlation_cannot_consume_the_owned_reply() {
    let state = ProbeState::default();
    let (sender, mut receiver) = tokio::sync::oneshot::channel();
    state.replies.lock().unwrap().insert(
        "owned-reply".into(),
        Reply {
            sender,
            call_ordinal: 1,
        },
    );
    assert!(accept_reply(
        &state,
        "wrong-reply".into(),
        Some(json!({"nativeValue":expected_echo()})),
        None
    )
    .is_err());
    assert_eq!(state.replies.lock().unwrap().len(), 1);
    assert!(receiver.try_recv().is_err());
    accept_reply(
        &state,
        "owned-reply".into(),
        Some(json!({"nativeValue":expected_echo()})),
        None,
    )
    .unwrap();
    assert_eq!(receiver.try_recv().unwrap().unwrap(), expected_echo());
}

#[test]
fn late_valid_reply_drains_without_changing_frozen_primary_failure() {
    let state = ProbeState::default();
    let (sender, mut receiver) = tokio::sync::oneshot::channel();
    state.replies.lock().unwrap().insert(
        "late-reply".into(),
        Reply {
            sender,
            call_ordinal: 1,
        },
    );
    let primary = grade_primary(ReplyWait::Expired, 50.0);
    accept_reply(
        &state,
        "late-reply".into(),
        Some(json!({"nativeValue":expected_echo()})),
        None,
    )
    .unwrap();
    assert_eq!(receiver.try_recv().unwrap().unwrap(), expected_echo());
    assert_eq!(state.replies.lock().unwrap().len(), 0);
    assert!(primary.watchdog_expired);
    assert!(!primary.passed);
    assert!(primary.reply.is_none());
}

#[test]
fn ambiguous_reply_envelope_returns_failure_and_drains_exact_slot() {
    let state = ProbeState::default();
    let (sender, mut receiver) = tokio::sync::oneshot::channel();
    state.replies.lock().unwrap().insert(
        "ambiguous-reply".into(),
        Reply {
            sender,
            call_ordinal: 1,
        },
    );
    accept_reply(
        &state,
        "ambiguous-reply".into(),
        Some(json!({"nativeValue":expected_echo()})),
        Some("simultaneous error".into()),
    )
    .unwrap();
    assert!(receiver.try_recv().unwrap().is_err());
    assert!(state.replies.lock().unwrap().is_empty());
}
