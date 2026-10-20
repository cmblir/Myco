//! Exact-question diagnostics through the production native activity commands.

use super::*;
use crate::local_model::ModelManifest;

#[cfg(test)]
#[path = "activity_tests.rs"]
mod tests;

const MANIFEST: &str =
    include_str!("../../eval/local-wiki-native-activity-development-v1/manifest.json");
const MAPPING: &str =
    include_str!("../../eval/local-wiki-native-activity-development-v1/span-mapping.json");
const CONTAINERS: [(&str, &str); 4] = [
    ("sessions/2026-10/synthetic-native-synthetic-dev-plan-negation.md", include_str!("../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-plan-negation.fixture")),
    ("sessions/2026-10/synthetic-native-synthetic-dev-decision-cause.md", include_str!("../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-decision-cause.fixture")),
    ("sessions/2026-10/synthetic-native-synthetic-dev-actor-event-date.md", include_str!("../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-actor-event-date.fixture")),
    ("sessions/2026-10/synthetic-native-synthetic-dev-cancel-reopen.md", include_str!("../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-cancel-reopen.fixture")),
];
const QUESTIONS: [(&str, &str, &str); 3] = [
    (
        "recent_work",
        "내가 최근에 한 일들에 대해서 정리해줘",
        "historical_as_of",
    ),
    (
        "month_work",
        "내가 최근 한달동안 한 일에 대해서 알려줘",
        "historical_as_of",
    ),
    (
        "next_work",
        "내가 앞으로 어떤 작업을 하는게 좋을까?",
        "current_state",
    ),
];

fn fixture(root: &Path) -> Result<(), String> {
    let manifest: Value = serde_json::from_str(MANIFEST).map_err(|error| error.to_string())?;
    require(
        manifest["mappingArtifact"]["sha256"] == sha(MAPPING.as_bytes()),
        "activity mapping identity changed",
    )?;
    for (ordinal, (path, source)) in CONTAINERS.iter().enumerate() {
        let expected = &manifest["containers"][ordinal];
        require(
            expected["vaultPath"] == *path && expected["sha256"] == sha(source.as_bytes()),
            "activity container identity changed",
        )?;
        let target = root.join(path);
        std::fs::create_dir_all(
            target
                .parent()
                .ok_or("activity fixture parent unavailable")?,
        )
        .map_err(|error| error.to_string())?;
        std::fs::write(target, source).map_err(|error| error.to_string())?;
    }
    std::fs::create_dir_all(root.join("raw")).map_err(|error| error.to_string())?;
    std::fs::write(root.join("raw/synthetic-original.md"), RAW).map_err(|error| error.to_string())
}

fn retained(root: &Path) -> Result<(), String> {
    for (path, source) in CONTAINERS {
        require(
            std::fs::read(root.join(path)).map_err(|error| error.to_string())? == source.as_bytes(),
            "activity original changed",
        )?;
    }
    require(
        std::fs::read(root.join("raw/synthetic-original.md")).map_err(|error| error.to_string())?
            == RAW.as_bytes(),
        "activity immutable raw changed",
    )
}

/// The WebView computes local civil midnights exactly as queryDateRange does.
pub(super) fn clock_arguments(input: &Value) -> Result<String, String> {
    require(
        input.is_object(),
        "activity renderer clock arguments are invalid",
    )?;
    Ok(format!(
        r#"(()=>{{
const input={input};
const capturedQueryEpoch=input.capturedQueryEpoch??Math.floor(Date.now()/1000);
const queryTime=new Date(capturedQueryEpoch*1000);
const fmt=date=>`${{date.getFullYear()}}-${{String(date.getMonth()+1).padStart(2,'0')}}-${{String(date.getDate()).padStart(2,'0')}}`;
const clock={{today:fmt(queryTime),capturedQueryEpoch,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,queryOffsetMinutes:queryTime.getTimezoneOffset(),range:null}};
if(input.range){{
 const dates=[input.range.start,input.range.end].map(day=>{{
  const match=/^(\d{{4}})-(\d{{2}})-(\d{{2}})$/.exec(day);
  if(!match)throw new Error('invalid activity planner date');
  const date=new Date(+match[1],+match[2]-1,+match[3]);
  if(fmt(date)!==day)throw new Error('invalid activity planner date');
  return date;
 }});
 if(dates[0]>dates[1]||input.range.end>clock.today)throw new Error('invalid activity planner period');
 clock.range={{start:input.range.start,end:input.range.end,startEpoch:dates[0].getTime()/1000,endEpoch:new Date(dates[1].getFullYear(),dates[1].getMonth(),dates[1].getDate()+1).getTime()/1000}};
}}
return {{clock}};
}})()"#
    ))
}

#[tauri::command]
pub(super) fn probe_activity_clock(clock: Value) -> Result<Value, String> {
    require(
        clock["today"].as_str().is_some_and(|day| day.len() == 10)
            && clock["capturedQueryEpoch"].as_u64().is_some()
            && clock["timeZone"].as_str().is_some(),
        "activity renderer clock reply is invalid",
    )?;
    Ok(clock)
}

fn ready(status: &Value, manifest: &ModelManifest) -> Result<(), String> {
    require(
        status["state"] == "ready"
            && status["model_id"] == manifest.id
            && status["bytes"] == manifest.bytes,
        "activity selected local model is not ready",
    )
}

fn selected_role(grant: &Value, manifest: &ModelManifest) -> Result<(), String> {
    let route = &grant["routeSignature"];
    require(
        grant["role"] == "ask"
            && grant["usage"] == "foreground"
            && route["role"] == "ask"
            && route["providerId"] == "builtin-local"
            && route["modelId"] == manifest.id
            && route["artifactRevision"] == manifest.revision
            && route["artifactSha256"] == crate::local_model::artifact_identity(manifest)
            && route["executionLocation"] == "in-process"
            && route["runtimeContract"] == crate::local_model::runtime_contract(manifest),
        "activity Ask grant does not match the selected local artifact",
    )
}

fn positive(
    answer: &Value,
    range: &Value,
    resolution: &Value,
    hits: &Value,
    manifest: &ModelManifest,
) -> Result<(), String> {
    require(
        answer["model_id"] == manifest.id,
        "activity answer model mismatch",
    )?;
    if let Some(failure) = answer.get("activity_failure") {
        let code = failure["code"]
            .as_str()
            .ok_or("native activity failure code unavailable")?;
        let detail = failure["detail"]
            .as_str()
            .ok_or("native activity failure detail unavailable")?;
        return Err(format!("native activity {code}: {detail}"));
    }
    if let Some(reason) = answer.get("fallback_reason") {
        return Err(format!(
            "native activity fallback: {}",
            reason
                .as_str()
                .ok_or("native activity fallback reason unavailable")?
        ));
    }
    let receipt = &answer["activity_receipt"];
    let count = |field: &str| {
        receipt[field]
            .as_u64()
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or("activity receipt count unavailable")
    };
    let period_total = |field: &str| {
        ["inPeriodSpans", "outsidePeriodSpans", "uncertainSpans"]
            .into_iter()
            .try_fold(0u64, |total, category| {
                receipt[field][category]
                    .as_u64()
                    .filter(|value| *value <= 9_007_199_254_740_991)
                    .and_then(|value| total.checked_add(value))
                    .ok_or("activity period count unavailable or overflowing")
            })
    };
    let processed = count("processedWindows")?;
    let selected = count("selectedClaims")?;
    require(
        receipt["scope"] == "all"
            && receipt["activityPeriod"]["start"] == range["start"]
            && receipt["activityPeriod"]["end"] == range["end"]
            && receipt["activityPeriod"]["startEpoch"] == range["startEpoch"]
            && receipt["activityPeriod"]["endEpoch"] == range["endEpoch"]
            && receipt["resolutionWindow"]["mode"] == resolution["mode"]
            && receipt["resolutionWindow"]["startEpoch"] == range["startEpoch"]
            && receipt["resolutionWindow"]["asOfEpoch"] == resolution["asOfEpoch"]
            && receipt["resolutionWindow"]["capturedQueryEpoch"]
                == resolution["capturedQueryEpoch"]
            && receipt["resolutionWindow"]["endEpoch"].as_i64()
                == resolution["asOfEpoch"]
                    .as_i64()
                    .and_then(|epoch| epoch.checked_add(1))
            && receipt["claimSourceAndStructureChecked"] == true
            && receipt["semanticReviewRequired"] == true
            && receipt["originalInputsIncomplete"].is_boolean()
            && receipt["independentVerificationReceipts"] == 0
            && count("eligibleOriginalSpans")? > 0
            && period_total("originalPeriodCounts")? == count("eligibleOriginalSpans")?
            && processed > 0
            && selected > 0
            && count("extractionBatches")? > 0
            && count("automatedClaimReviews")? == count("extractionBatches")?
            && processed.checked_add(count("omittedWindows")?) == Some(count("boundedWindows")?)
            && selected.checked_add(count("omittedClaims")?) == Some(count("proposedClaims")?)
            && count("answerOriginalSpans")? > 0
            && count("answerOriginalSpans")? <= count("boundedWindows")?
            && count("boundedWindows")? <= 512
            && period_total("answerPeriodCounts")? == count("answerOriginalSpans")?
            && receipt["automatedAnswerReviewInputRevision"]
                .as_str()
                .is_some_and(|text| {
                    text.len() == 64
                        && text
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                }),
        "activity receipt is not bound to the requested native protocol",
    )?;
    let mut allowed: BTreeSet<String> = hits
        .as_array()
        .ok_or("activity initial sources unavailable")?
        .iter()
        .map(|hit| {
            hit["page"]
                .as_str()
                .ok_or("activity initial source invalid")
                .map(str::to_owned)
        })
        .collect::<Result<_, _>>()?;
    for declaration in receipt["additionalSources"]
        .as_array()
        .ok_or("activity additional sources unavailable")?
    {
        allowed.insert(
            declaration["citationPage"]
                .as_str()
                .ok_or("activity additional source invalid")?
                .to_owned(),
        );
    }
    require(
        allowed
            .iter()
            .all(|page| CONTAINERS.iter().any(|(path, _)| page == path)),
        "activity source escaped synthetic originals",
    )?;
    let used: BTreeSet<String> = answer["used_sources"]
        .as_array()
        .ok_or("activity used sources unavailable")?
        .iter()
        .map(|source| {
            source
                .as_str()
                .ok_or("activity used source invalid")
                .map(str::to_owned)
        })
        .collect::<Result<_, _>>()?;
    let text = answer["answer"]
        .as_str()
        .ok_or("activity answer unavailable")?;
    let normalize = |page: &str| page.trim_end_matches(".md").to_owned();
    let cited: BTreeSet<_> = crate::parser::parse_links_from_text(text)
        .iter()
        .map(|page| normalize(page))
        .collect();
    require(
        answer["model_id"] == manifest.id
            && !text.trim().is_empty()
            && answer.get("fallback_reason").is_none()
            && answer.get("activity_failure").is_none()
            && !used.is_empty()
            && used.is_subset(&allowed)
            && cited == used.iter().map(|page| normalize(page)).collect(),
        "activity native protocol did not produce a reviewed cited answer",
    )
}

#[allow(clippy::too_many_arguments)]
async fn question(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    origin: &Value,
    manifest: &'static ModelManifest,
    id: &str,
    question: &str,
    mode: &str,
    watchdog: Duration,
    records: &mut Vec<Value>,
) -> Result<(), String> {
    let clock = value(
        app,
        window,
        "probe_activity_clock",
        json!({}),
        watchdog,
        records,
        "capture_question_renderer_clock",
    )
    .await?;
    let grant = capture(app, window, origin, "ask", "foreground", watchdog, records).await?;
    selected_role(&grant, manifest)?;
    ready(
        &value(
            app,
            window,
            "local_chat_status",
            json!({"modelId":manifest.id}),
            watchdog,
            records,
            "activity_model_status",
        )
        .await?,
        manifest,
    )?;
    let plan = value(app, window, "local_query_plan", json!({"request":{
        "requestId":format!("native-activity-{id}-plan"),"question":question,"today":clock["today"],
        "modelId":manifest.id,"expectedVault":origin["vaultPath"],
        "origin":origin,"roleSnapshot":grant,"scope":"all","paths":null
    }}), watchdog, records, "model_selected_activity_period").await?;
    require(
        plan["model_id"] == manifest.id,
        "activity planner model mismatch",
    )?;
    let boundaries = value(app, window, "probe_activity_clock", json!({"capturedQueryEpoch":clock["capturedQueryEpoch"],"range":{"start":plan["start"],"end":plan["end"]}}), watchdog, records, "renderer_local_period_boundaries").await?;
    let range = &boundaries["range"];
    let captured = clock["capturedQueryEpoch"]
        .as_i64()
        .ok_or("activity query clock unavailable")?;
    let start = range["startEpoch"]
        .as_i64()
        .ok_or("activity local period start unavailable")?;
    let end = range["endEpoch"]
        .as_i64()
        .ok_or("activity local period end unavailable")?;
    let as_of = if mode == "current_state" {
        captured
    } else {
        (end - 1).min(captured)
    };
    require(
        as_of >= start,
        "activity resolution cutoff precedes selected period",
    )?;
    let recall = value(
        app,
        window,
        "activity_recall",
        json!({"request":{
            "expectedVault":origin["vaultPath"],"origin":origin,"roleSnapshot":grant,
            "range":range,"scope":"all","paths":null
        }}),
        watchdog,
        records,
        "actual_dated_activity_retrieval",
    )
    .await?;
    let hits = Value::Array(recall["hits"].as_array().ok_or("activity native hits unavailable")?.iter()
        .map(|hit| json!({"page":hit["page"],"stem":hit["stem"],"section":hit["section"],"text":hit["text"]})).collect());
    require(
        hits.as_array().is_some_and(|hits| !hits.is_empty()),
        "activity planner period retrieved no original activity",
    )?;
    records.push(
        json!({"case":"activity_selected_inputs","questionId":id,"question":question,
        "clock":clock,"range":range,"initialRecallIncomplete":recall["incomplete"],
        "initialHitCount":hits.as_array().map(Vec::len),"periodOrHitsInjected":false,
        "resolutionMode":mode,"independentSourceGradeRequired":true}),
    );
    ready(
        &value(
            app,
            window,
            "local_chat_status",
            json!({"modelId":manifest.id}),
            watchdog,
            records,
            "activity_synthesis_model_status",
        )
        .await?,
        manifest,
    )?;
    let resolution = json!({"mode":mode,"asOfEpoch":as_of,"capturedQueryEpoch":captured});
    let answer = value(app, window, "local_synthesize", json!({"request":{
        "requestId":format!("native-activity-{id}-answer"),"question":question,"previousQuestion":null,"lang":"ko",
        "modelId":manifest.id,"expectedVault":origin["vaultPath"],"origin":origin,"roleSnapshot":grant,
        "scope":"all","paths":null,"range":range,"hits":hits,"maxTokens":768,"activityOverview":true,
        "resolution":resolution
    }}), watchdog, records, "actual_activity_synthesis").await?;
    positive(&answer, range, &resolution, &hits, manifest)
}

async fn drain_question(
    app: &tauri::AppHandle,
    id: &str,
    failed: bool,
    records: &mut Vec<Value>,
) -> Result<(), String> {
    if failed {
        // Exact QA cleanup is separate from proof of public cancellation.
        for suffix in ["plan", "answer"] {
            crate::local_generation::cancel(&format!("native-activity-{id}-{suffix}"));
        }
    }
    let started = Instant::now();
    let mut ticks = tokio::time::interval_at(
        tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
        HEARTBEAT_INTERVAL,
    );
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let pending = app
            .state::<ProbeState>()
            .replies
            .try_lock()
            .ok()
            .map(|replies| replies.len());
        let busy = crate::local_generation::probe_busy();
        if pending == Some(0) && busy == Some(false) {
            records.push(json!({"case":"activity_question_drain","questionId":id,"terminalDrained":true,
                "pendingReplies":0,"workersBusy":false,"qaCleanupCancellationUsed":failed,"publicCancellationTransportUsed":false}));
            return Ok(());
        }
        if started.elapsed() >= Duration::from_secs(60) {
            records.push(json!({"case":"activity_question_drain","questionId":id,"terminalDrained":false,
                "pendingReplies":pending,"workersBusy":busy,"qaCleanupCancellationUsed":failed,"publicCancellationTransportUsed":false}));
            return Err(
                "activity native work not drained; remaining questions stay unobserved".into(),
            );
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(25)) => {},
            _ = ticks.tick() => heartbeat(app, Phase::TerminalDrainHeartbeat, None),
        }
    }
}

pub(super) async fn verify(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    sandbox: &Path,
    config: &Config,
    records: &mut Vec<Value>,
) -> Result<bool, String> {
    let manifest = config.activity_manifest().map_err(str::to_owned)?;
    status_phase(app, Phase::VerifyStarted, None);
    let watchdog = Duration::from_secs(config.watchdog_seconds);
    let root = sandbox.join("activity-vault");
    fixture(&root)?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    records.push(json!({"case":"native_activity_corpus","manifest":serde_json::from_str::<Value>(MANIFEST).map_err(|error|error.to_string())?,
        "manifestSha256":sha(MANIFEST.as_bytes()),"mappingSha256":sha(MAPPING.as_bytes()),
        "questions":QUESTIONS.iter().map(|(id,question,mode)|json!({"id":id,"question":question,"resolutionMode":mode})).collect::<Vec<_>>(),
        "generationManifest":manifest,"modelIdExplicit":config.activity_model_id.is_some(),
        "frontendRouting":"not_run","frontendReceiptValidation":"not_run","nativeProductionArgumentSequence":true,"importedCompiledLineage":"not_run"}));
    let origin = open(app, window, &root, watchdog, records).await?;
    select(app, window, manifest.id, watchdog, records).await?;
    value(
        app,
        window,
        "reindex_embeddings",
        json!({"provider":"builtin-local","model":crate::local_llm::BUILTIN_EMBED_MODEL}),
        watchdog,
        records,
        "native_activity_corpus_reindex",
    )
    .await?;
    let pair = crate::index_publication::load(&root)?;
    require(
        pair.generation > 0
            && pair.store.model
                == format!("builtin-local:{}", crate::local_llm::BUILTIN_EMBED_MODEL)
            && crate::vector_index::VectorStore::path_for(&root.to_string_lossy())?
                == crate::retrieval::Bm25Index::path_for(&root.to_string_lossy())?,
        "activity lexical/dense pair identity mismatch",
    )?;
    for (path, source) in CONTAINERS {
        let hashes: Vec<_> = crate::embeddings::chunk_page(source)
            .iter()
            .map(|chunk| crate::embeddings::content_hash(chunk))
            .collect();
        require(
            pair.lexical.page_hashes(path) == Some(hashes.clone())
                && pair.store.hashes_by_page().get(path) == Some(&hashes),
            "activity published source identity mismatch",
        )?;
    }
    records.push(json!({"case":"native_activity_paired_index","generation":pair.generation,"model":pair.store.model,"pairedOriginals":4}));
    let Some(artifact) = config.control_artifact.clone() else {
        records.push(json!({"case":"actual_activity_questions","state":"preparation_required","scheduled":QUESTIONS.len(),"observed":0}));
        return Ok(false);
    };
    let seeded = tauri::async_runtime::spawn_blocking(move || seed_artifact(&artifact, manifest))
        .await
        .map_err(|error| error.to_string())??;
    records.push(json!({"case":"seed_activity_control","value":seeded}));
    let mut failures = 0;
    for (ordinal, (id, text, mode)) in QUESTIONS.iter().enumerate() {
        let result = question(
            app, window, &origin, manifest, id, text, mode, watchdog, records,
        )
        .await;
        retained(&root)?;
        let drained = drain_question(app, id, result.is_err(), records).await;
        records.push(json!({"case":"activity_question_terminal","questionId":id,"question":text,
            "nativeProtocolPassed":result.is_ok(),"error":result.as_ref().err(),"semanticReleaseAccepted":false}));
        if result.is_err() {
            failures += 1;
        }
        if let Err(error) = drained {
            records.push(json!({"case":"activity_questions_schedule","scheduled":QUESTIONS.len(),"observed":ordinal+1,"unobserved":QUESTIONS.len()-ordinal-1,"reason":"undrained_native_work"}));
            return Err(error);
        }
    }
    retained(&root)?;
    require(
        app.state::<ProbeState>()
            .observation_errors
            .load(Ordering::Relaxed)
            == 0,
        "activity generation observations are incomplete",
    )?;
    records.push(json!({"case":"activity_questions_schedule","scheduled":QUESTIONS.len(),"observed":QUESTIONS.len(),"nativeProtocolFailures":failures,"semanticReleaseAccepted":false}));
    require(
        failures == 0,
        "exact activity questions failed native protocol; inspect each terminal record",
    )?;
    Ok(true)
}
