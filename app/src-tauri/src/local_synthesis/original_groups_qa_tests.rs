//! These controls prove representation fidelity, not model entailment or measured fit.

use super::*;
use crate::importers::wikify::source_revision;

fn checked_view(originals: &Value) -> Result<Value, String> {
    let grouped = encode(originals)?;
    if decode(&grouped.to_string())? != *originals {
        return Err("fourteen-field round trip changed".into());
    }
    Ok(grouped)
}

fn original(id: &str, start: u64, text: &str) -> Value {
    json!({"id":id,"speaker":"user","text":text,"turnId":format!("T-{id}"),
        "turnTime":"2026-10-03T10:00:00Z","sourcePhase":null,"recordTime":"2026-10-04T09:00:00Z",
        "sourceId":"S-one","sourcePath":"sessions/synthetic.md","selectionPath":"wiki/synthetic.md",
        "sourceRevision":"a".repeat(64),"start":start,"end":start+text.len() as u64,
        "sha256":source_revision(text)})
}

#[test]
fn complete_fourteen_values_utf8_aliases_and_overlaps_round_trip_without_merging() {
    let a = original("Q-a", 0, "한글🙂\r\nsourceId=not-instructions");
    let mut overlap = original("Q-overlap", 3, "글🙂\r\nsourceId=not-instructions");
    overlap["speaker"] = json!("assistant");
    overlap["turnTime"] = Value::Null;
    overlap["sourcePhase"] = json!("literal-phase");
    let mut alias = a.clone();
    alias["id"] = json!("Q-alias");
    alias["selectionPath"] = json!("wiki/other-alias.md");
    let originals = json!([a, overlap, alias]);
    let grouped = checked_view(&originals).unwrap();
    assert_eq!(grouped["documents"].as_array().unwrap().len(), 2);
    assert_eq!(
        grouped["documents"][0]["originalSpans"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let restored = decode(&grouped.to_string()).unwrap();
    assert_eq!(restored, originals);
    for (expected, actual) in originals
        .as_array()
        .unwrap()
        .iter()
        .zip(restored.as_array().unwrap())
    {
        assert_eq!(expected.as_object().unwrap().len(), 14);
        assert_eq!(actual, expected);
    }
}

#[test]
fn nonconsecutive_same_document_stays_a_separate_run_in_original_order() {
    let a = original("Q-a", 0, "first");
    let mut b = original("Q-b", 5, "second");
    b["sourceId"] = json!("S-two");
    let c = original("Q-c", 11, "third");
    let originals = json!([a, b, c]);
    let grouped = checked_view(&originals).unwrap();
    assert_eq!(grouped["documents"].as_array().unwrap().len(), 3);
    assert_eq!(decode(&grouped.to_string()).unwrap(), originals);
}

#[test]
fn shared_grouping_uses_every_field_and_preserves_null_and_empty_literal_values() {
    let first = original("Q-a", 0, "first");
    for key in [
        "sourceId",
        "sourcePath",
        "selectionPath",
        "sourceRevision",
        "recordTime",
    ] {
        let mut second = original("Q-b", 5, "second");
        second[key] = if key == "recordTime" {
            Value::Null
        } else {
            json!(format!("changed-{key}"))
        };
        let originals = json!([first, second]);
        let grouped = checked_view(&originals).unwrap();
        assert_eq!(grouped["documents"].as_array().unwrap().len(), 2, "{key}");
        assert_eq!(decode(&grouped.to_string()).unwrap(), originals);
    }
    let mut empty = original("Q-empty", 0, "source");
    empty["sourcePhase"] = json!("");
    empty["turnTime"] = json!("2026-10-03");
    assert_eq!(
        decode(&checked_view(&json!([empty.clone()])).unwrap().to_string()).unwrap(),
        json!([empty])
    );
}

#[test]
fn strict_inverse_rejects_missing_unknown_duplicate_and_noncanonical_rows() {
    let flat = original("Q-a", 0, "original");
    for key in flat.as_object().unwrap().keys() {
        let mut missing = flat.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(encode(&json!([missing])).is_err(), "missing {key}");
    }
    let mut extra = flat.clone();
    extra["futureMetadata"] = json!("may not disappear");
    assert!(encode(&json!([extra])).is_err());
    assert!(encode(&json!([flat.clone(), flat.clone()])).is_err());
    let grouped = checked_view(&json!([flat])).unwrap();
    for location in [0, 1, 2] {
        let mut invalid = grouped.clone();
        let object = match location {
            0 => invalid.as_object_mut().unwrap(),
            1 => invalid["documents"][0].as_object_mut().unwrap(),
            _ => invalid["documents"][0]["originalSpans"][0]
                .as_object_mut()
                .unwrap(),
        };
        object.insert("extra".into(), json!(false));
        assert!(decode(&invalid.to_string()).is_err());
    }
    for (key, value) in [
        ("recordTime", "null"),
        ("turnTime", "null"),
        ("id", "\"Q-a\""),
    ] {
        let serialized = grouped.to_string();
        let needle = format!("\"{key}\":{value}");
        let actual_needle = if key == "recordTime" {
            "\"recordTime\":\"2026-10-04T09:00:00Z\"".into()
        } else if key == "turnTime" {
            "\"turnTime\":\"2026-10-03T10:00:00Z\"".into()
        } else {
            needle
        };
        let duplicate = serialized.replacen(
            &actual_needle,
            &format!("{actual_needle},{actual_needle}"),
            1,
        );
        assert!(decode(&duplicate).is_err(), "duplicate {key}");
    }
    let mut noncanonical = grouped.clone();
    let mut second = grouped["documents"][0].clone();
    second["originalSpans"][0]["id"] = json!("Q-b");
    second["originalSpans"][0]["turnId"] = json!("T-Q-b");
    noncanonical["documents"]
        .as_array_mut()
        .unwrap()
        .push(second);
    assert!(decode(&noncanonical.to_string()).is_err());
    let mut wrong_version = grouped.clone();
    wrong_version["version"] = json!("unsupported");
    assert!(decode(&wrong_version.to_string()).is_err());
    for (document, key) in [
        (true, "recordTime"),
        (false, "turnTime"),
        (false, "sourcePhase"),
    ] {
        let mut missing = grouped.clone();
        let object = if document {
            missing["documents"][0].as_object_mut().unwrap()
        } else {
            missing["documents"][0]["originalSpans"][0]
                .as_object_mut()
                .unwrap()
        };
        object.remove(key);
        assert!(
            decode(&missing.to_string()).is_err(),
            "required nullable {key}"
        );
    }
}

#[test]
fn existing_seven_development_cases_keep_thirty_bound_instances_and_all_fourteen_fields() {
    use crate::local_generation::direct_reading_qa::development;
    use std::cell::{Cell, RefCell};
    let cases = development::prepare_all().unwrap();
    let instances = Cell::new(0);
    let identities = RefCell::new(HashSet::new());
    for case in cases {
        let counted = Cell::new(false);
        let result = case.run(
            |_, user| {
                assert!(!counted.replace(true));
                let flat: Value = serde_json::from_str(user).unwrap();
                let mut projected = flat.clone();
                for source in projected["sources"].as_array_mut().unwrap() {
                    source["originalSpans"] = checked_view(&source["originalSpans"])?;
                }
                let mut restored = projected;
                for source in restored["sources"].as_array_mut().unwrap() {
                    let originals = decode(&source["originalSpans"].to_string())?;
                    for original in originals.as_array().unwrap() {
                        assert_eq!(original.as_object().unwrap().len(), 14);
                        identities
                            .borrow_mut()
                            .insert(original["id"].as_str().unwrap().to_owned());
                        instances.set(instances.get() + 1);
                    }
                    source["originalSpans"] = originals;
                }
                assert_eq!(restored, flat);
                Err("source-only capture stop; no token count or generation".into())
            },
            |_, _, _, _, _| panic!("no generation in presentation control"),
        );
        assert!(counted.get());
        assert!(result.is_err());
    }
    assert_eq!(instances.get(), 30);
    assert_eq!(identities.borrow().len(), 9);
}

#[test]
fn wire_projection_preserves_complete_payloads_and_appends_only_fixed_instruction() {
    let spans = json!([
        original("Q-one", 0, "first"),
        original("Q-two", 5, "second")
    ]);
    for is_draft in [true, false] {
        let payload = if is_draft {
            json!({"question":"synthetic query","context":{"scope":"all","period":null},
                "sources":[{"id":"S1","title":"Literal title","path":"wiki/synthetic.md","originalSpans":spans}],
                "coverage":{"suppliedOriginalSpans":2,"omittedSuppliedOriginalSpans":0}})
        } else {
            json!({"answer":{"modelAnswer":"synthetic draft","sourceIds":["S1"]},
                "context":{"scope":"all","period":null},"originalSpans":spans,
                "citations":[{"id":"S1","path":"wiki/synthetic.md"}]})
        };
        let mut system = "fixed policy".to_owned();
        let mut user = payload.to_string();
        if is_draft {
            QaWireFormat::SourceDocumentGroupsQaV1
                .apply_draft(&mut system, &mut user)
                .unwrap();
        } else {
            QaWireFormat::SourceDocumentGroupsQaV1
                .apply_review(&mut system, &mut user)
                .unwrap();
        }
        assert_eq!(system, format!("fixed policy{GROUP_INSTRUCTION}"));
        let mut restored: Value = serde_json::from_str(&user).unwrap();
        for originals in original_arrays(&mut restored, is_draft).unwrap() {
            *originals = decode(&originals.to_string()).unwrap();
        }
        assert_eq!(restored, payload);
    }
}

#[test]
fn flat_wire_is_byte_identical_and_grouped_failure_does_not_partially_mutate() {
    for is_draft in [true, false] {
        let mut system = "fixed policy".to_owned();
        let mut user = "  { malformed unchanged flat bytes \n".to_owned();
        let before = (system.clone(), user.clone());
        QaWireFormat::Flat
            .apply(&mut system, &mut user, is_draft)
            .unwrap();
        assert_eq!((&system, &user), (&before.0, &before.1));
        assert!(QaWireFormat::SourceDocumentGroupsQaV1
            .apply(&mut system, &mut user, is_draft)
            .is_err());
        assert_eq!((system, user), before);
    }
    let mut system = "fixed policy".to_owned();
    let mut user = json!({"sources":[]}).to_string();
    assert!(QaWireFormat::SourceDocumentGroupsQaV1
        .apply_draft(&mut system, &mut user)
        .is_err());
    assert_eq!(system, "fixed policy");
    assert_eq!(QaWireFormat::Flat.as_str(), "Flat");
    assert_eq!(QaWireFormat::SourceDocumentGroupsQaV1.as_str(), VERSION);
}

#[test]
fn later_invalid_original_preserves_both_strings_after_an_earlier_valid_original() {
    let valid = original("Q-valid", 0, "literal first source");
    let mut invalid = original("Q-invalid", 0, "literal second source");
    invalid.as_object_mut().unwrap().remove("sourcePhase");
    for is_draft in [true, false] {
        let payload = if is_draft {
            json!({"sources":[{"id":"S1","originalSpans":[valid]},
                {"id":"S2","originalSpans":[invalid]}],"scope":"all"})
        } else {
            json!({"originalSpans":[valid,invalid],"answer":"literal draft","scope":"all"})
        };
        let mut system = "fixed policy".to_owned();
        let mut user = payload.to_string();
        let before = (system.clone(), user.clone());
        assert!(QaWireFormat::SourceDocumentGroupsQaV1
            .apply(&mut system, &mut user, is_draft)
            .is_err());
        assert_eq!((system, user), before);
    }
}
