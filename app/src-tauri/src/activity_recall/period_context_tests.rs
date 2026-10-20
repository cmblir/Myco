use super::*;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use serde_json::json;

fn range() -> DateRange {
    DateRange {
        start: "2026-10-03".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    }
}
fn span(id: &str, record: Option<&str>, turn: Option<&str>) -> SourceSpan {
    let text = "Ordinary human Markdown: I requested a synthetic export, not a completion.";
    let set = SourceSet::new(
        AgentVaultSession {
            vault_path: "/synthetic/vault".into(),
            opening_token: "7".into(),
        },
        Scope::Wiki,
        vec![SourceDocument::bind(
            format!("S-{id}"),
            "wiki/synthetic.md".into(),
            "wiki/synthetic.md".into(),
            text,
            record.map(str::to_owned),
            vec![SpanInput {
                id: id.into(),
                start: 0,
                end: text.len(),
                turn_id: "T-preamble".into(),
                speaker: ActorRole::Unknown,
                turn_time: turn.map(str::to_owned),
            }],
        )
        .unwrap()],
        vec![],
    )
    .unwrap();
    let original = set.spans().next().unwrap().clone();
    original
}

#[test]
fn native_relation_uses_record_intervals_without_changing_original_meaning() {
    let spans = [
        span("Q-old", Some("2026-10-02"), None),
        span("Q-day", Some("2026-10-03"), None),
        span("Q-later", Some("2026-10-05"), None),
        span("Q-unknown", None, None),
        span("Q-turn", Some("2026-10-08"), Some("2026-10-04T08:00:00Z")),
    ];
    let before = serde_json::to_value(&spans).unwrap();
    let sidecar = serde_json::to_value(annotate(&range(), spans.iter()).unwrap()).unwrap();
    assert_eq!(sidecar["version"], VERSION);
    assert_eq!(
        sidecar["counts"],
        json!({"inPeriodSpans":2,"outsidePeriodSpans":2,"uncertainSpans":1})
    );
    assert_eq!(
        sidecar["spans"][0]["recordPeriodRelation"],
        "outside_period"
    );
    assert_eq!(sidecar["spans"][1]["recordTimeBasis"], "record");
    assert_eq!(sidecar["spans"][3]["recordTimeBasis"], "unknown");
    assert_eq!(sidecar["spans"][4]["recordTimeBasis"], "turn");
    assert_eq!(serde_json::to_value(&spans).unwrap(), before);
    assert!(spans.iter().all(|span| span.speaker() == ActorRole::Unknown
        && span.text().contains("Ordinary human Markdown")));
}

#[test]
fn local_epoch_day_partial_overlap_is_uncertain_and_instant_edges_are_half_open() {
    let start = crate::importers::parse_iso8601("2026-10-02T15:00:00Z").unwrap();
    let period = DateRange {
        start: "2026-10-03".into(),
        end: "2026-10-03".into(),
        start_epoch: Some(start),
        end_epoch: Some(start + 86_400),
    };
    let spans = [
        span("Q-utc-day", Some("2026-10-03"), None),
        span("Q-start", None, Some("2026-10-02T15:00:00Z")),
        span("Q-last", None, Some("2026-10-03T14:59:59Z")),
        span("Q-end", None, Some("2026-10-03T15:00:00Z")),
    ];
    let sidecar = serde_json::to_value(annotate(&period, spans.iter()).unwrap()).unwrap();
    assert_eq!(
        sidecar["counts"],
        json!({"inPeriodSpans":2,"outsidePeriodSpans":1,"uncertainSpans":1})
    );
    assert_eq!(sidecar["spans"][0]["recordPeriodRelation"], "uncertain");
    assert_eq!(record_interval(&spans[1]), Some((start, start + 1)));
}

#[test]
fn window_sidecar_uses_each_current_window_id_and_preserves_unknown_notes() {
    let original = span("Q-whole", None, None);
    let windows = [
        original.context_window(0, 9).unwrap(),
        original.context_window(9, original.text().len()).unwrap(),
    ];
    let sidecar = serde_json::to_value(annotate(&range(), windows.iter()).unwrap()).unwrap();
    assert_eq!(sidecar["counts"]["uncertainSpans"], 2);
    for (window, entry) in windows.iter().zip(sidecar["spans"].as_array().unwrap()) {
        assert_eq!(entry["spanId"], window.id());
        assert_ne!(entry["spanId"], original.id());
    }
    assert_eq!(
        windows.iter().map(|span| span.text()).collect::<String>(),
        original.text()
    );
}

#[test]
fn invalid_periods_and_duplicate_original_ids_fail_without_inventing_counts() {
    let original = span("Q-original", None, None);
    let mut period = range();
    period.start_epoch = Some(1);
    assert!(annotate(&period, [&original]).is_err());
    period.start_epoch = None;
    period.start = "2026-02-30".into();
    assert!(annotate(&period, [&original]).is_err());
    assert!(annotate(&range(), [&original, &original]).is_err());
}
