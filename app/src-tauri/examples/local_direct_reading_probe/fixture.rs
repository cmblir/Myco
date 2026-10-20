//! Complete compiled synthetic D3 custody; these identities are not native-issued grants.

use myco_lib::local_generation::{direct_reading_qa::QUESTIONS, Request};
use myco_lib::local_model::GEMMA12B_CANDIDATE;
use myco_lib::local_synthesis::Evidence;
use myco_lib::retrieval::Scope;
use myco_lib::wiki_claims::quoted_qa::AgentVaultSession;
use myco_lib::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

const RAW: &str = include_str!("../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-actor-event-date.fixture");
pub(super) const RAW_SHA: &str = "7985e794a530d5700da9a976cc883639526749ae9c25f9cf467a2e08e66a78cb";
const PATH: &str = "sessions/2026-10/synthetic-native-synthetic-dev-actor-event-date.md";

pub(super) fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Turn {
    message_id: String,
    original_role: String,
    timestamp: String,
    phase: Option<String>,
}

pub(super) fn bind(index: usize) -> Result<(Request, Vec<Evidence>, SourceSet), String> {
    if index >= QUESTIONS.len() || hash(RAW) != RAW_SHA {
        return Err("compiled D3 complete container or question schedule changed".into());
    }
    let metadata = RAW
        .lines()
        .find_map(|line| line.strip_prefix("turn_metadata: "))
        .ok_or("compiled D3 turn metadata missing")?;
    let turns: Vec<Turn> = serde_json::from_str(metadata).map_err(|e| e.to_string())?;
    if turns.len() != 2
        || turns[0].original_role != "user"
        || turns[1].original_role != "assistant"
        || turns.iter().any(|turn| turn.phase.is_some())
    {
        return Err("compiled D3 speaker, phase or turn cardinality changed".into());
    }
    let created = RAW
        .lines()
        .find_map(|line| line.strip_prefix("created: "))
        .ok_or("compiled D3 record time missing")?;
    let record_time: String = serde_json::from_str(created).map_err(|e| e.to_string())?;
    let first_start =
        RAW.find("**User:**\n").ok_or("D3 User boundary missing")? + "**User:**\n".len();
    let second_header = RAW
        .find("**Assistant:**\n")
        .ok_or("D3 Assistant boundary missing")?;
    let second_start = second_header + "**Assistant:**\n".len();
    let origin = AgentVaultSession {
        vault_path: "/synthetic/direct-original-reading".into(),
        opening_token: "synthetic-rebound-custody-not-a-live-opening".into(),
    };
    let document = SourceDocument::bind(
        "S-direct-D3".into(),
        PATH.into(),
        PATH.into(),
        RAW,
        Some(record_time),
        vec![
            SpanInput {
                id: "Q-direct-D3A".into(),
                start: first_start,
                end: second_header,
                turn_id: turns[0].message_id.clone(),
                speaker: ActorRole::User,
                turn_time: Some(turns[0].timestamp.clone()),
            },
            SpanInput {
                id: "Q-direct-D3B".into(),
                start: second_start,
                end: RAW.len(),
                turn_id: turns[1].message_id.clone(),
                speaker: ActorRole::Assistant,
                turn_time: Some(turns[1].timestamp.clone()),
            },
        ],
    )?;
    let evidence = vec![Evidence {
        page: PATH.into(),
        stem: "Synthetic loom adapter attribution".into(),
        section: 0,
        text: RAW.into(),
        title: Some("Synthetic loom adapter attribution".into()),
        compiled: None,
    }];
    let captured = if index == 0 {
        1792173935_i64
    } else {
        1792174502_i64
    };
    let request: Request = serde_json::from_value(json!({
        "modelId":GEMMA12B_CANDIDATE.id,"requestId":format!("qa-direct-reading-{index}"),
        "question":QUESTIONS[index],"previousQuestion":null,"lang":"ko",
        "hits":evidence,"expectedVault":origin.vault_path,"origin":origin,
        "roleSnapshot":{"snapshotId":format!("synthetic-direct-role-{index}"),"origin":origin,
            "role":"ask","usage":"foreground","authorizationRevision":"synthetic-no-authority",
            "routeSignature":{"role":"ask","providerId":"builtin-local","modelId":GEMMA12B_CANDIDATE.id,
                "effort":"none","executionLocation":"in-process","artifactRevision":GEMMA12B_CANDIDATE.revision,
                "artifactSha256":GEMMA12B_CANDIDATE.sha256,"runtimeContract":"synthetic-direct-reading-diagnostic",
                "signature":"not-a-native-issued-grant"}},
        "scope":"all","range":{"start":"2026-10-01","end":"2026-10-04",
            "startEpoch":1790780400_i64,"endEpoch":1791126000_i64},
        "paths":[PATH],"maxTokens":768,"activityOverview":true,
        "resolution":{"mode":if index==0{"historical_as_of"}else{"current_state"},
            "asOfEpoch":if index==0{1791125999_i64}else{captured},"capturedQueryEpoch":captured}
    })).map_err(|e| e.to_string())?;
    let sources = SourceSet::new(origin, Scope::All, vec![document], vec![])?;
    Ok((request, evidence, sources))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_container_binds_complete_original_text_and_all_native_fields() {
        let (request, _, sources) = bind(0).unwrap();
        let spans = serde_json::to_value(sources.spans().collect::<Vec<_>>()).unwrap();
        let rows = spans.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0]["text"],
            &RAW[rows[0]["start"].as_u64().unwrap() as usize
                ..rows[0]["end"].as_u64().unwrap() as usize]
        );
        assert_eq!(
            rows[1]["text"],
            &RAW[rows[1]["start"].as_u64().unwrap() as usize
                ..rows[1]["end"].as_u64().unwrap() as usize]
        );
        assert!(rows.iter().all(|s| s["sourceRevision"] == RAW_SHA
            && s.as_object().unwrap().len() == 14
            && s["sourcePhase"].is_null()));
        assert_eq!(rows[0]["speaker"], "user");
        assert_eq!(rows[1]["speaker"], "assistant");
        assert_eq!(rows[0]["turnTime"], "2026-10-03T10:00:00Z");
        assert_eq!(rows[1]["turnTime"], "2026-10-04T08:00:00Z");
        assert_eq!(rows[0]["recordTime"], "2026-10-04T09:00:00Z");
        assert_eq!(request.question, QUESTIONS[0]);
        assert!(request.activity_overview);
        assert!(bind(2).is_err());
    }
}
