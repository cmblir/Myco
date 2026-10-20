//! Presentation controls use synthetic values and issue no native source authority.

use super::*;
use serde_json::json;

fn flat_original() -> Value {
    json!({
        "id":"Q-SYNTHETIC", "speaker":"unknown",
        "text":"Yesterday was a plan, not execution.\r\n\t\"sourceContext\": 한글🙂 \\ untouched.",
        "turnId":"T-preamble", "turnTime":null, "sourcePhase":null, "recordTime":null,
        "sourceId":"S-SYNTHETIC", "sourcePath":"sessions/synthetic.md",
        "selectionPath":"sessions/synthetic.md", "sourceRevision":"a".repeat(64),
        "start":0, "end":77, "sha256":"b".repeat(64)
    })
}

#[test]
fn source_reading_preserves_null_day_offset_and_exact_text_values() {
    for time in [
        Value::Null,
        json!("2026-10-03"),
        json!("2026-10-03T08:00:00+09:00"),
    ] {
        let mut flat = flat_original();
        flat["turnTime"] = time;
        let encoded = serde_json::to_string(&original_input(&flat).unwrap()).unwrap();
        let reading: Value = serde_json::from_str(&encoded).unwrap();
        let mut restored = serde_json::Map::new();
        assert_eq!(reading.as_object().unwrap().len(), 5);
        for key in ["id", "speaker", "text"] {
            restored.insert(key.into(), reading[key].clone());
        }
        for group in ["sourceContext", "provenance"] {
            for (key, value) in reading[group].as_object().unwrap() {
                assert!(restored.insert(key.clone(), value.clone()).is_none());
            }
        }
        assert_eq!(Value::Object(restored), flat);
        assert!(encoded.starts_with(&format!(
            "{{\"id\":{},\"speaker\":{},\"text\":{},\"sourceContext\":",
            flat["id"], flat["speaker"], flat["text"]
        )));
    }
}

#[test]
fn source_reading_never_omits_new_missing_or_renamed_original_fields() {
    let flat = flat_original();
    let mut extra = flat.clone();
    extra["futureMetadata"] = json!("must not disappear");
    assert!(original_input(&extra).is_err());
    for key in flat.as_object().unwrap().keys() {
        let mut missing = flat.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(original_input(&missing).is_err(), "missing {key}");
        missing["renamedMetadata"] = flat[key].clone();
        assert!(original_input(&missing).is_err(), "renamed {key}");
    }
    for non_object in [Value::Null, json!([]), json!("not a captured original")] {
        assert!(original_input(&non_object).is_err());
    }
}
