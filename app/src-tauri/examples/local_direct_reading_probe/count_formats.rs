//! Count presentation costs only; never serve the projected format or issue a review receipt.

use super::*;
use myco_lib::local_synthesis::original_groups_qa::{decode, encode};
use std::cell::Cell;

const STOP: &str = "count_only_complete";

fn project(user: &str) -> Result<(String, usize, usize), String> {
    let flat: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
    let mut projected = flat.clone();
    let mut originals = 0;
    let mut groups = 0;
    for source in projected["sources"]
        .as_array_mut()
        .ok_or("draft sources absent")?
    {
        let grouped = encode(&source["originalSpans"])?;
        originals += source["originalSpans"]
            .as_array()
            .ok_or("flat spans absent")?
            .len();
        groups += grouped["documents"]
            .as_array()
            .ok_or("groups absent")?
            .len();
        source["originalSpans"] = grouped;
    }
    let mut restored = projected.clone();
    for source in restored["sources"]
        .as_array_mut()
        .ok_or("projected sources absent")?
    {
        source["originalSpans"] = decode(&source["originalSpans"].to_string())?;
    }
    if originals == 0 || restored != flat {
        return Err("complete draft payload round trip changed".into());
    }
    Ok((
        serde_json::to_string(&projected).map_err(|error| error.to_string())?,
        originals,
        groups,
    ))
}

pub(super) fn run(directory: PathBuf) -> Result<(), String> {
    let prepared = direct_reading_qa::development::prepare_all()?;
    emit(
        json!({"phase":"count_formats_admission","model":GEMMA12B_CANDIDATE,
        "cases":direct_reading_qa::development::CASE_IDS,"scheduledCases":7,
        "preparedOriginalInstances":30,"uniqueOriginals":9,"generationCalls":0,
        "measurement":"draft USER representation cost under unchanged SYS; no serving instruction",
        "reviewFit":"not_assessed","meaning":"not_assessed","production_accepted":false}),
    )?;
    let model = resolve_verified_artifact(&directory, &GEMMA12B_CANDIDATE)?;
    let mut host = LocalLlm::load_embed_host()?;
    let result = (|| {
        host.ensure_chat_model(&model)?;
        let mut failures = Vec::new();
        for (index, case) in prepared.iter().enumerate() {
            let captured = Cell::new(false);
            let generated = Cell::new(false);
            let outcome = case.run(
                |system, user| {
                    if captured.get() {
                        return Err("unexpected second count stage".into());
                    }
                    let (projected, originals, groups) = project(user)?;
                    let flat_count = host.chat_token_count(system, user);
                    let grouped_count = host.chat_token_count(system, &projected);
                    emit(json!({"phase":"count_formats_observation","caseIndex":index,"caseId":case.id(),
                        "system":system,"systemSha256":fixture::hash(system),
                        "flatUser":user,"flatUserBytes":user.len(),"flatUserSha256":fixture::hash(user),
                        "groupedUser":projected,"groupedUserBytes":projected.len(),"groupedUserSha256":fixture::hash(&projected),
                        "flatTokens":flat_count.as_ref().ok(),"flatError":flat_count.as_ref().err(),
                        "groupedTokens":grouped_count.as_ref().ok(),"groupedError":grouped_count.as_ref().err(),
                        "roundTripAllPayloadValues":true,"originals":originals,"groups":groups,
                        "draftInputBudget":3320,"generationCalls":0,"reviewFit":"not_assessed",
                        "semantic_accepted":false,"production_accepted":false}))?;
                    flat_count?;
                    grouped_count?;
                    captured.set(true);
                    // Stop before admission to generation, even if either representation fits.
                    Err(STOP.into())
                },
                |_, _, _, _, _| {
                    generated.set(true);
                    Err("count-only generation invocation is forbidden".into())
                },
            );
            let complete = captured.get()
                && !generated.get()
                && outcome.as_ref().is_err_and(|error| {
                    error.code == "review_unavailable"
                        && error.detail == format!("review_unavailable: {STOP}")
                });
            emit(
                json!({"phase":"count_formats_case_terminal","caseId":case.id(),
                "captured":captured.get(),"complete":complete,"generationInvoked":generated.get(),
                "intentionalDiagnosticStop":complete,
                "flowError":outcome.as_ref().err().map(|error|json!({"code":error.code,"detail":error.detail})),
                "semantic_accepted":false,"production_accepted":false}),
            )?;
            if !complete {
                failures.push(case.id());
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!("count-only failures: {}", failures.join(",")))
        }
    })();
    drop(host);
    emit(
        json!({"phase":"count_formats_host_dropped","ownedHostDropCompleted":true,
        "gpuMemoryReturnObserved":false,"semantic_accepted":false,"production_accepted":false}),
    )?;
    result
}
