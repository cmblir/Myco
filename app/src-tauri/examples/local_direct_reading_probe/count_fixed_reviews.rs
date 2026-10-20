//! Count current whole-original reviews of seven sealed drafts; never generate model output.

use super::*;
use myco_lib::local_synthesis::original_groups_qa::decode;
use std::cell::Cell;
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;

const LOG_BYTES: u64 = 213024;
const LOG_SHA: &str = "a70a75141761a8ba00d4f0f40f89b3d653946dc2c6c9c0fc76a728b97dc096cd";
const DRAFT_GRAMMAR_SHA: &str = "924174ca8f00e348868c89f43fd622b5508dc940cd898366e2476b05e9bdd043";
const STOP: &str = "fixed_review_count_only_complete";

struct ReplayPin<'a> {
    id: &'a str,
    raw: &'a str,
    system: &'a str,
    user: &'a str,
}
const PINS: [ReplayPin<'static>; 7] = [
    ReplayPin {
        id: "FUTURE-R-ALL",
        raw: "30ff63c3de8080bbb8bdba8ac9bc99ed5fd30bf3bb3114ab25f60ce05d5cc47b",
        system: "640b2bb6a86792102b5a4ddbaac4ef97bb4a36fdd43e93d7c0c1361f32b81525",
        user: "82556026a470ed525c9f079c6cfa1658b415f4f0d5bf9016101024c108fa8ed3",
    },
    ReplayPin {
        id: "FUTURE-A-ALL",
        raw: "836f93ff4bdd6091d95725999ba85725d3f6a20e70355b29528c6852c657435e",
        system: "c7d8a12e687ffcccbf1b04854ad12c829c144544b3d24b4e4acd10f2b4635fb6",
        user: "cae0bcdd44ca09e93cab1deb0a9752276956ded0eb5306b4275b435b64be445f",
    },
    ReplayPin {
        id: "FUTURE-R-D2",
        raw: "2dbe74bff63c93fd4dd7b32acd2e6738b2cd46dc543eb9e4ed29a851a3094ce1",
        system: "640b2bb6a86792102b5a4ddbaac4ef97bb4a36fdd43e93d7c0c1361f32b81525",
        user: "b2cbe3c8b2081d995331f922155863f12b0159d022ef0e10a18ea185f781189a",
    },
    ReplayPin {
        id: "FUTURE-R-D4",
        raw: "8bb9852e1e99a6ad4143fd5afb775dae5334f5d5d75afd5d81cca3947a1866b1",
        system: "640b2bb6a86792102b5a4ddbaac4ef97bb4a36fdd43e93d7c0c1361f32b81525",
        user: "7dad2e5c12ad82484b856efe76a5a3e22824dcfbf0e2fae94f337e2a3c64fb72",
    },
    ReplayPin {
        id: "FUTURE-A-D2",
        raw: "2321c4fa3d03d502275d7309c6bab215dac488eb20c6a26c5974614110273edc",
        system: "c7d8a12e687ffcccbf1b04854ad12c829c144544b3d24b4e4acd10f2b4635fb6",
        user: "0ae3f1bc6762269ef6d4659f41eea7920209a112fec158da49ed4eb92c9bcc37",
    },
    ReplayPin {
        id: "FUTURE-A-D4",
        raw: "3567c231f7eeb25c3409352d8ee5dcef1837847268ab71de5e749b015504c964",
        system: "c7d8a12e687ffcccbf1b04854ad12c829c144544b3d24b4e4acd10f2b4635fb6",
        user: "a7a85042c6b74d55cf468b6b353c62b4ed349ca013c3c6e60c6b9b865a082d1e",
    },
    ReplayPin {
        id: "FUTURE-A-D3",
        raw: "9edb49164196c76eab1483176974646feef295abd543e587d30655a86e4ec7ef",
        system: "c7d8a12e687ffcccbf1b04854ad12c829c144544b3d24b4e4acd10f2b4635fb6",
        user: "0a0cffbce8d944f791dd1577dfa6157601267e2a5baaa3cd1a8e35b03ff18e2f",
    },
];

struct ReplayCase {
    id: String,
    system: String,
    user: String,
    raw: String,
    review_system: String,
    review_user: Value,
}

fn pinned_text(text: &str) -> Result<(), String> {
    if text.len() as u64 != LOG_BYTES || fixture::hash(text) != LOG_SHA {
        return Err("sealed grouped stdout bytes or SHA changed".into());
    }
    Ok(())
}

fn read_log(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("absolute sealed grouped stdout path required".into());
    }
    let before = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !before.is_file() || before.len() != LOG_BYTES {
        return Err("sealed grouped stdout must be the bounded regular text file".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|error| error.to_string())?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    if !opened.is_file() || opened.len() != LOG_BYTES {
        return Err("opened sealed grouped stdout is not the expected regular file".into());
    }
    let mut text = String::new();
    file.take(LOG_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| error.to_string())?;
    pinned_text(&text)?;
    Ok(text)
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .ok_or_else(|| format!("sealed stdout field absent: {field}"))
}

fn extract(rows: &[Value], pins: &[ReplayPin<'_>]) -> Result<Vec<ReplayCase>, String> {
    let mut drafts = Vec::new();
    let mut reviews = Vec::new();
    for row in rows {
        if row["phase"] == "development_reading_generation"
            && (row["call"] == 1 || row["telemetry"]["schema"] == "askAnswerV1")
        {
            drafts.push(row);
        }
        if row["phase"] == "development_reading_count" {
            let user: Value =
                serde_json::from_str(string(row, "user")?).map_err(|error| error.to_string())?;
            if user.get("answer").is_some() {
                reviews.push((row, user));
            }
        }
    }
    if drafts.len() != pins.len() || reviews.len() != pins.len() {
        return Err("sealed draft/review-count cardinality changed".into());
    }
    let mut cases = Vec::new();
    for ((draft, (review, review_user)), pin) in drafts.into_iter().zip(reviews).zip(pins) {
        let raw = string(draft, "rawOutput")?;
        let system = string(draft, "system")?;
        let user = string(draft, "user")?;
        let review_system = string(review, "system")?;
        if draft["caseId"] != pin.id
            || review["caseId"] != pin.id
            || draft["call"] != 1
            || draft["telemetry"]["schema"] != "askAnswerV1"
            || draft["wireFormat"] != "SourceDocumentGroupsQaV1"
            || review["wireFormat"] != "SourceDocumentGroupsQaV1"
            || draft["cleanObservedDecode"] != true
            || draft.get("error") != Some(&Value::Null)
            || draft.get("telemetryError") != Some(&Value::Null)
            || review.get("error") != Some(&Value::Null)
            || draft["grammarSha256"] != DRAFT_GRAMMAR_SHA
            || fixture::hash(raw) != pin.raw
            || draft["rawOutputSha256"] != pin.raw
            || fixture::hash(system) != pin.system
            || draft["systemSha256"] != pin.system
            || fixture::hash(user) != pin.user
            || draft["userSha256"] != pin.user
            || fixture::hash(review_system) != string(review, "systemSha256")?
            || fixture::hash(string(review, "user")?) != string(review, "userSha256")?
            || review_user["answerInputRevision"] != pin.raw
            || review_user["answer"]["inputRevision"] != pin.raw
        {
            return Err(format!(
                "sealed case order, draft identity or error changed: {}",
                pin.id
            ));
        }
        cases.push(ReplayCase {
            id: pin.id.into(),
            system: system.into(),
            user: user.into(),
            raw: raw.into(),
            review_system: review_system.into(),
            review_user,
        });
    }
    Ok(cases)
}

fn check_draft(case: &ReplayCase, system: &str, user: &str) -> Result<(), String> {
    if system != case.system || user != case.user {
        return Err(format!(
            "current draft SYS/USER differs from sealed input: {}",
            case.id
        ));
    }
    Ok(())
}

fn check_review(case: &ReplayCase, system: &str, user: &str) -> Result<usize, String> {
    if system != case.review_system {
        return Err("current review SYSTEM differs from sealed SYSTEM".into());
    }
    let current: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
    let mut expected = case.review_user.clone();
    let outer = expected["answerInputRevision"].clone();
    let answer = expected["answer"]
        .as_object_mut()
        .ok_or("sealed answer object absent")?;
    if answer.get("inputRevision") != Some(&outer) {
        return Err("sealed duplicate raw revision differs".into());
    }
    let model = answer
        .get("modelAnswer")
        .and_then(Value::as_str)
        .ok_or("sealed model prose absent")?;
    let prose = answer
        .get("proseWithoutModelLinkLabels")
        .and_then(Value::as_str)
        .ok_or("sealed review prose absent")?;
    if model != prose || model.contains("[[") || model.contains("]]") {
        return Err("fixed seven replay requires equal link-free prose".into());
    }
    answer.remove("modelAnswer");
    answer.remove("inputRevision");
    if current != expected {
        return Err("current whole review differs beyond permitted duplicate factoring".into());
    }
    let mut restored = current.clone();
    let current_outer = restored["answerInputRevision"].clone();
    let answer = restored["answer"]
        .as_object_mut()
        .ok_or("current answer object absent")?;
    let prose = answer
        .get("proseWithoutModelLinkLabels")
        .ok_or("current review prose absent")?
        .clone();
    answer.insert("modelAnswer".into(), prose);
    answer.insert("inputRevision".into(), current_outer);
    if restored != case.review_user {
        return Err("complete review payload inverse changed".into());
    }
    let originals = decode(&current["originalSpans"].to_string())?;
    let prior = decode(&case.review_user["originalSpans"].to_string())?;
    if originals != prior {
        return Err("whole original order or field values changed".into());
    }
    originals
        .as_array()
        .map(Vec::len)
        .ok_or_else(|| "decoded originals are absent".into())
}

pub(super) fn run(directory: PathBuf, log: PathBuf) -> Result<(), String> {
    let text = read_log(&log)?;
    let rows = text
        .lines()
        .map(|line| serde_json::from_str(line).map_err(|error| error.to_string()))
        .collect::<Result<Vec<Value>, _>>()?;
    let replay = extract(&rows, &PINS)?;
    let prepared = direct_reading_qa::development::prepare_all()?;
    if prepared.len() != replay.len()
        || prepared
            .iter()
            .zip(&replay)
            .any(|(case, prior)| case.id() != prior.id)
    {
        return Err("current prepared case schedule differs from sealed schedule".into());
    }
    emit(
        json!({"phase":"count_fixed_reviews_admission","wireFormat":"SourceDocumentGroupsQaV1",
        "model":GEMMA12B_CANDIDATE,"sealedStdoutSha256":LOG_SHA,"sealedStdoutBytes":LOG_BYTES,
        "compiledSources":direct_reading_qa::development::corpus_manifest(),
        "cases":direct_reading_qa::development::CASE_IDS,"scheduledCases":7,"knownDevelopmentCases":true,
        "heldOut":false,"referenceCriteriaServedToModel":false,"goldServedToModel":false,
        "maximumReplayedDrafts":7,"maximumGenerations":0,"actualWriterGenerations":0,"actualReviewGenerations":0,
        "reviewGrammarSha256":GenerationSchema::AskAnswerReviewV1.qa_grammar_sha256(),
        "corrections":0,"retries":0,"meaning":"not_assessed","reviewVerdicts":"not_generated",
        "native_io_authenticated":false,"product_role_authorized":false,"semantic_accepted":false,"production_accepted":false}),
    )?;
    let model = resolve_verified_artifact(&directory, &GEMMA12B_CANDIDATE)?;
    let mut host = LocalLlm::load_embed_host()?;
    let result = (|| {
        host.ensure_chat_model(&model)?;
        let mut failures = Vec::new();
        for (case, prior) in prepared.iter().zip(&replay) {
            let draft_counted = Cell::new(false);
            let writer_replayed = Cell::new(false);
            let review_tokens = Cell::new(None::<usize>);
            let forbidden_generation = Cell::new(false);
            let outcome = case.run_with_wire_format_qa(QaWireFormat::SourceDocumentGroupsQaV1,
                |system, user| {
                    if !draft_counted.get() {
                        check_draft(prior, system, user)?;
                        let counted = host.chat_token_count(system, user);
                        emit(json!({"phase":"count_fixed_reviews_draft_count","caseId":case.id(),
                            "systemSha256":fixture::hash(system),"userSha256":fixture::hash(user),
                            "tokenCount":counted.as_ref().ok(),"error":counted.as_ref().err(),
                            "actualWriterGenerations":0,"actualReviewGenerations":0}))?;
                        let tokens = counted?;
                        draft_counted.set(true);
                        return Ok(tokens);
                    }
                    if !writer_replayed.get() || review_tokens.get().is_some() {
                        return Err("fixed-review count stage repeated or reordered".into());
                    }
                    let originals = check_review(prior, system, user)?;
                    let counted = host.chat_token_count(system, user);
                    emit(json!({"phase":"count_fixed_reviews_observation","caseId":case.id(),
                        "system":system,"user":user,"systemSha256":fixture::hash(system),"userSha256":fixture::hash(user),
                        "rawDraftSha256":fixture::hash(&prior.raw),"tokenCount":counted.as_ref().ok(),"error":counted.as_ref().err(),
                        "contextTokens":4096,"outputTokens":768,"reserve":8,"inputAllowance":3320,
                        "fullPayloadInverseEqual":true,"originals":originals,"originalFieldComparisons":originals*14,
                        "referenceCriteriaServedToModel":false,"actualWriterGenerations":0,"actualReviewGenerations":0,
                        "meaning":"not_assessed","semantic_accepted":false,"production_accepted":false}))?;
                    review_tokens.set(Some(counted?));
                    // Stop at the real review count boundary, before generation or a native review receipt.
                    Err(STOP.into())
                },
                |system, user, output, context, schema| {
                    if schema != GenerationSchema::AskAnswerV1 || schema.qa_grammar_sha256() != DRAFT_GRAMMAR_SHA
                        || !draft_counted.get()
                        || writer_replayed.get() || (output, context) != (768,4096)
                    {
                        forbidden_generation.set(true);
                        return Err("model generation is forbidden in fixed-review count-only mode".into());
                    }
                    check_draft(prior, system, user)?;
                    emit(json!({"phase":"count_fixed_reviews_writer_replay","caseId":case.id(),
                        "rawOutputSha256":fixture::hash(&prior.raw),"draftSystemSha256":fixture::hash(system),
                        "draftUserSha256":fixture::hash(user),"replayedDrafts":1,"actualWriterGenerations":0,
                        "actualReviewGenerations":0,"native_io_authenticated":false,"product_role_authorized":false}))?;
                    writer_replayed.set(true);
                    Ok(prior.raw.clone())
                });
            let intentional = writer_replayed.get()
                && review_tokens.get().is_some()
                && !forbidden_generation.get()
                && outcome.as_ref().is_err_and(|error| {
                    error.code == "review_unavailable"
                        && error.detail == format!("review_unavailable: {STOP}")
                });
            let fit = review_tokens.get().is_some_and(|tokens| tokens <= 3320);
            emit(
                json!({"phase":"count_fixed_reviews_case_terminal","caseId":case.id(),
                "replayedDrafts":usize::from(writer_replayed.get()),"reviewCount":review_tokens.get(),
                "fullReviewFits":fit,"intentionalDiagnosticStop":intentional,
                "forbiddenGenerationCallback":forbidden_generation.get(),"actualWriterGenerations":0,"actualReviewGenerations":0,
                "flowError":outcome.as_ref().err().map(|error|json!({"code":error.code,"detail":error.detail})),
                "reviewVerdict":"not_generated","meaning":"not_assessed","semantic_accepted":false,"production_accepted":false}),
            )?;
            if !intentional || !fit {
                failures.push(case.id());
            }
        }
        emit(
            json!({"phase":"count_fixed_reviews_schedule_terminal","scheduledCases":7,
            "failedCountOrFitCases":failures.len(),"allReviewsFit":failures.is_empty(),
            "actualWriterGenerations":0,"actualReviewGenerations":0,"meaning":"not_assessed"}),
        )?;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "fixed-review count/fit failures: {}",
                failures.join(",")
            ))
        }
    })();
    drop(host);
    emit(
        json!({"phase":"count_fixed_reviews_host_dropped","ownedHostDropCompleted":true,
        "gpuMemoryReturnObserved":false,"processGlobalBackendReleaseObserved":false,"actualWriterGenerations":0,
        "actualReviewGenerations":0,"semantic_accepted":false,"production_accepted":false}),
    )?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> (Vec<Value>, [String; 3]) {
        let hashes = [
            fixture::hash("draft"),
            fixture::hash("system"),
            fixture::hash("{}"),
        ];
        let review_user =
            json!({"answerInputRevision":hashes[0],"answer":{"inputRevision":hashes[0]}})
                .to_string();
        (
            vec![
                json!({"phase":"development_reading_generation","caseId":"sample","call":1,
            "telemetry":{"schema":"askAnswerV1"},"wireFormat":"SourceDocumentGroupsQaV1",
            "cleanObservedDecode":true,"error":null,"telemetryError":null,"grammarSha256":DRAFT_GRAMMAR_SHA,
            "rawOutput":"draft","rawOutputSha256":hashes[0],"system":"system","systemSha256":hashes[1],
            "user":"{}","userSha256":hashes[2]}),
                json!({"phase":"development_reading_count","caseId":"sample","wireFormat":"SourceDocumentGroupsQaV1",
                "system":"system","systemSha256":hashes[1],"user":review_user,
                "userSha256":fixture::hash(&review_user),"error":null}),
            ],
            hashes,
        )
    }
    fn pin(hashes: &[String; 3]) -> ReplayPin<'_> {
        ReplayPin {
            id: "sample",
            raw: &hashes[0],
            system: &hashes[1],
            user: &hashes[2],
        }
    }
    #[test]
    fn unpinned_text_and_relative_paths_fail_before_model_resolution() {
        assert!(pinned_text("changed sealed stdout").is_err());
        assert!(read_log(Path::new("native-stdout.log")).is_err());
    }
    #[test]
    fn missing_duplicate_changed_or_error_drafts_cannot_enter_replay() {
        let (rows, hashes) = sample();
        assert_eq!(extract(&rows, &[pin(&hashes)]).unwrap().len(), 1);
        assert!(extract(&rows[1..], &[pin(&hashes)]).is_err());
        let mut duplicated = rows.clone();
        duplicated.push(rows[0].clone());
        assert!(extract(&duplicated, &[pin(&hashes)]).is_err());
        let mut changed = rows.clone();
        changed[0]["rawOutput"] = json!("different draft");
        changed[0]["rawOutputSha256"] = json!(fixture::hash("different draft"));
        assert!(extract(&changed, &[pin(&hashes)]).is_err());
        let mut errored = rows;
        errored[0]["error"] = json!("writer failed");
        assert!(extract(&errored, &[pin(&hashes)]).is_err());
    }
    #[test]
    fn changed_current_draft_system_or_user_fails_exact_replay_binding() {
        let (rows, hashes) = sample();
        let replay = extract(&rows, &[pin(&hashes)]).unwrap();
        assert!(check_draft(&replay[0], "system", "{}").is_ok());
        assert!(check_draft(&replay[0], "changed", "{}").is_err());
        assert!(check_draft(&replay[0], "system", "{ }").is_err());
    }

    #[test]
    fn full_review_inverse_keeps_both_originals_and_rejects_other_field_changes() {
        use myco_lib::local_synthesis::original_groups_qa::encode;
        let span = |id: &str, start: usize, text: &str, speaker: &str| {
            json!({
            "id":id,"sourceId":"S-sample","sourcePath":"synthetic.md","selectionPath":"synthetic.md",
            "sourceRevision":fixture::hash("oldnew"),"recordTime":null,"start":start,"end":start+text.len(),
            "sha256":fixture::hash(text),"text":text,"turnId":id,"speaker":speaker,"turnTime":null,"sourcePhase":null})
        };
        let originals = json!([
            span("Q-one", 0, "old", "user"),
            span("Q-two", 3, "new", "assistant")
        ]);
        let revision = fixture::hash("sealed raw");
        let whole = json!({"answerInputRevision":revision,"answer":{"inputRevision":revision,
            "modelAnswer":"Synthetic prose","proseWithoutModelLinkLabels":"Synthetic prose","sourceIds":["S1"]},
            "originalSpans":encode(&originals).unwrap(),"context":{"question":"sample"},"citations":["S1"],
            "independentVerificationReceipts":[]});
        let mut prior = ReplayCase {
            id: "sample".into(),
            system: String::new(),
            user: String::new(),
            raw: String::new(),
            review_system: "review system".into(),
            review_user: whole.clone(),
        };
        let mut factored = whole;
        let answer = factored["answer"].as_object_mut().unwrap();
        answer.remove("modelAnswer");
        answer.remove("inputRevision");
        assert_eq!(
            check_review(&prior, "review system", &factored.to_string()).unwrap(),
            2
        );
        assert!(check_review(&prior, "changed system", &factored.to_string()).is_err());
        let mut changed = factored.clone();
        changed["context"]["question"] = json!("changed");
        assert!(check_review(&prior, "review system", &changed.to_string()).is_err());
        let mut changed_source = factored.clone();
        changed_source["originalSpans"]["documents"][0]["originalSpans"][1]["text"] = json!("bad");
        assert!(check_review(&prior, "review system", &changed_source.to_string()).is_err());
        prior.review_user["answer"]["modelAnswer"] = json!("different prose");
        assert!(check_review(&prior, "review system", &factored.to_string()).is_err());
        prior.review_user["answer"]["modelAnswer"] = json!("[[linked]]");
        prior.review_user["answer"]["proseWithoutModelLinkLabels"] = json!("[[linked]]");
        assert!(check_review(&prior, "review system", &factored.to_string()).is_err());
        prior.review_user["answer"]["modelAnswer"] = json!("Synthetic prose");
        prior.review_user["answer"]["proseWithoutModelLinkLabels"] = json!("Synthetic prose");
        prior.review_user["answer"]["inputRevision"] = json!(fixture::hash("different raw"));
        assert!(check_review(&prior, "review system", &factored.to_string()).is_err());
    }
}
