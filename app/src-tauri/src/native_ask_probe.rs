//! Opt-in real Wry Ask boundary checks on an isolated synthetic profile.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{atomic::Ordering, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const PAGE: &str = "wiki/synthetic-export-policy.md";
const QUESTION: &str = "QZ17 내보내기 정책에 따르면 따옴표 안의 구분자는 어떻게 처리해야 하나요?";
const NOTE: &str = "# Synthetic QZ17 export policy\n\nQZ17 내보내기 정책: 따옴표 안의 구분자는 그대로 보존해야 합니다. 따옴표 밖의 구분자만 필드 경계로 사용합니다.\n\n## Human annotation\n\nSynthetic human annotation: preserve this exact paragraph.\n";
const RAW: &str = "Synthetic immutable original: QZ17 export policy source.\n";

mod activity;
mod artifact;
mod artifact_io;
mod compact_suite;
mod focus_sizing;
mod focus_suite;
pub(crate) use focus_sizing::observe as observe_focus_review_tokens;
pub(crate) use focus_sizing::{
    observe_initial_correction as observe_focus_initial_correction_tokens,
    observe_tokens as observe_focus_tokens, FocusTokenBudgetQa, FocusTokenPhaseQa,
};
mod transport;
use artifact::seed_artifact;
pub use compact_suite::run as run_compact_suite;
pub use focus_suite::{run as run_source_focus_suite, run_for as run_source_focus_suite_for};
pub use transport::{run as run_transport, BackgroundPolicyQa};

#[cfg(test)]
#[path = "native_ask_probe_tests.rs"]
mod tests;

/// Only explicitly passed prepared artifacts may enter this QA profile.
pub struct Config {
    pub control_artifact: Option<PathBuf>,
    pub watchdog_seconds: u64,
    pub visible_window: bool,
    pub background_policy: Option<BackgroundPolicyQa>,
    pub activity_questions: bool,
    pub activity_model_id: Option<String>,
    pub compact_claims: bool,
    pub source_focus_claims: bool,
    pub named_source_focus_claims: bool,
    pub ordinal_activity: bool,
    pub reviewed_activity_correction: bool,
}

impl Config {
    /// Candidate selection is explicit and restricted to the activity QA mode.
    pub fn activity_manifest(
        &self,
    ) -> Result<&'static crate::local_model::ModelManifest, &'static str> {
        if self.ordinal_activity
            && (!self.activity_questions
                || !self.source_focus_claims
                || self.compact_claims
                || self.named_source_focus_claims
                || self.reviewed_activity_correction)
        {
            return Err("Ordinal activity requires exclusive source-focus QA without correction");
        }
        if self.named_source_focus_claims
            && (!self.activity_questions || !self.source_focus_claims || self.compact_claims)
        {
            return Err("named source focus requires source focus activity QA mode");
        }
        if self.source_focus_claims && self.compact_claims {
            return Err("source focus and compact claims QA modes are mutually exclusive");
        }
        if self.source_focus_claims && !self.activity_questions {
            return Err("source focus claims require the activity questions QA mode");
        }
        if self.compact_claims && !self.activity_questions {
            return Err("compact claims require the activity questions QA mode");
        }
        if self.reviewed_activity_correction
            && (!self.activity_questions || !self.source_focus_claims || self.compact_claims)
        {
            return Err("reviewed activity correction requires source focus activity QA mode");
        }
        let Some(id) = self.activity_model_id.as_deref() else {
            return Ok(&crate::local_model::MODEL);
        };
        if !self.activity_questions {
            return Err("activity model requires the activity questions QA mode");
        }
        if id != crate::local_model::MODEL.id
            && id != crate::local_model::GEMMA_CANDIDATE.id
            && id != crate::local_model::QWEN9B_CANDIDATE.id
            && id != crate::local_model::GEMMA12B_CANDIDATE.id
        {
            return Err("unsupported activity QA model ID");
        }
        crate::local_model::manifest_for(Some(id))
            .map_err(|_| "activity QA model is not admitted by this build")
    }
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    HiddenWindow,
    VisibleWindow,
    WebviewReady,
    DispatchStarted,
    DispatchSent,
    DispatchFailed,
    NativeCommandReturnSiteOk,
    NativeCommandReturnSiteErr,
    ReplyCallbackEntered,
    ReplyMatched,
    ReplyDelivered,
    ReplyReceiverDropped,
    ReplyAwaitStarted,
    ReplyAwaitFinished,
    ReplyAwaitDropped,
    ReplyHeartbeat,
    WatchdogExpired,
    PublicCancelStarted,
    PublicCancelReceived,
    PublicCancelFailed,
    PublicCancelExpired,
    PublicCancelDispatchFailed,
    PublicCancelHeartbeat,
    QaCleanupCancelStarted,
    QaCleanupCancelFinished,
    TerminalDrainStarted,
    TerminalDrainFinished,
    TerminalDrainDropped,
    TerminalDrainExpired,
    TerminalDrainHeartbeat,
    VerifyStarted,
    VerifyPassed,
    VerifyPreparationRequired,
    VerifyFailed,
    TeardownEntered,
    TeardownQaCancelStarted,
    TeardownQaCancelFinished,
    TeardownDrainStarted,
    TeardownDrained,
    TeardownDrainExpired,
    TeardownHeartbeat,
    ChatUnloadStarted,
    ChatUnloadFinished,
    ChatUnloadFailed,
    EmbeddingUnloadStarted,
    EmbeddingUnloadFinished,
    EmbeddingUnloadFailed,
    GenerationStarted,
    GenerationFinished,
    EchoEntered,
    EchoReturnSite,
    TransportPrimaryFrozen,
    TransportCleanupWake,
    VaultCloseStarted,
    VaultCloseFinished,
    VaultCloseFailed,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseRecord {
    probe: &'static str,
    phase: Phase,
    ordinal: u64,
    elapsed_millis: u128,
    measured_at_unix_millis: Option<u128>,
    call_ordinal: Option<u64>,
    pending_replies: Option<usize>,
    workers_busy: Option<bool>,
}

static PHASE_ORDINAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static HEARTBEAT_EMITTED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static HEARTBEAT_DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const HEARTBEAT_LIMIT: u64 = 1024;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

fn emit_phase(
    phase: Phase,
    call_ordinal: Option<u64>,
    pending_replies: Option<usize>,
    workers_busy: Option<bool>,
) {
    static STARTED: OnceLock<Instant> = OnceLock::new();
    let record = PhaseRecord {
        probe: "native_ask_phase_v1",
        phase,
        ordinal: PHASE_ORDINAL.fetch_add(1, Ordering::Relaxed),
        elapsed_millis: STARTED.get_or_init(Instant::now).elapsed().as_millis(),
        measured_at_unix_millis: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|elapsed| elapsed.as_millis()),
        call_ordinal,
        pending_replies,
        workers_busy,
    };
    // Immediate diagnostics contain only closed phases, counters and timing.
    // They are separate from final records that retain synthetic protocol payloads.
    match serde_json::to_vec(&record) {
        Ok(mut bytes) => {
            bytes.push(b'\n');
            let mut output = std::io::stderr().lock();
            if output
                .write_all(&bytes)
                .and_then(|_| output.flush())
                .is_err()
            {
                eprintln!("native Ask QA phase output unavailable");
            }
        }
        Err(_) => eprintln!("native Ask QA phase serialization failed"),
    }
}

fn status_phase(app: &tauri::AppHandle, phase: Phase, call_ordinal: Option<u64>) {
    let state = app.state::<ProbeState>();
    let pending = state.replies.try_lock().ok().map(|replies| replies.len());
    // Unknown indicates contention or poisoning, never an idle assertion.
    emit_phase(
        phase,
        call_ordinal,
        pending,
        crate::local_generation::probe_busy(),
    );
}

/// Observe the production handler's return site only for this QA-owned app.
/// This does not assert that Tauri resolved the response or JavaScript received it.
pub(crate) fn local_command_returned(app: &tauri::AppHandle, resolved: bool) {
    if app.try_state::<ProbeState>().is_some() {
        status_phase(
            app,
            if resolved {
                Phase::NativeCommandReturnSiteOk
            } else {
                Phase::NativeCommandReturnSiteErr
            },
            None,
        );
    }
}

fn reserve_heartbeat(counter: &std::sync::atomic::AtomicU64) -> bool {
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
            (count < HEARTBEAT_LIMIT).then(|| count + 1)
        })
        .is_ok()
}

fn heartbeat(app: &tauri::AppHandle, phase: Phase, call_ordinal: Option<u64>) {
    if reserve_heartbeat(&HEARTBEAT_EMITTED) {
        status_phase(app, phase, call_ordinal);
    } else {
        HEARTBEAT_DROPPED.fetch_add(1, Ordering::Relaxed);
    }
}

struct Reply {
    sender: tokio::sync::oneshot::Sender<Result<Value, String>>,
    call_ordinal: u64,
}

#[derive(Default)]
struct ProbeState {
    activity_questions: bool,
    compact_claims: bool,
    source_focus_claims: bool,
    named_source_focus_claims: bool,
    ordinal_activity: bool,
    reviewed_activity_correction: bool,
    ready: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    replies: Mutex<BTreeMap<String, Reply>>,
    owned_requests: Mutex<BTreeSet<String>>,
    generations: Mutex<Vec<Value>>,
    compact_expansions: Mutex<Vec<Value>>,
    backing_observations: Mutex<Vec<Value>>,
    focus_review_tokens: Mutex<Vec<Value>>,
    observation_errors: std::sync::atomic::AtomicUsize,
}

/// A normal app, including a feature build, has no QA-owned compact route.
pub(crate) fn compact_claims_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<ProbeState>()
        .is_some_and(|state| state.compact_claims)
}

/// Explicit source-focus selection belongs only to the isolated activity QA app.
pub(crate) fn source_focus_claims_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<ProbeState>()
        .is_some_and(|state| state.activity_questions && state.source_focus_claims)
}

/// Ordinal activity is an explicit QA task; it never grants role authority.
pub(crate) fn ordinal_activity_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<ProbeState>().is_some_and(|state| {
        state.activity_questions
            && state.source_focus_claims
            && state.ordinal_activity
            && !state.compact_claims
            && !state.named_source_focus_claims
            && !state.reviewed_activity_correction
    })
}

/// Named syntax is an explicit wire intervention, never a role grant.
pub(crate) fn named_source_focus_claims_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<ProbeState>().is_some_and(|state| {
        state.activity_questions
            && state.source_focus_claims
            && !state.compact_claims
            && state.named_source_focus_claims
            && !state.ordinal_activity
    })
}

/// Explicit correction belongs only to the selected isolated activity QA route.
pub(crate) fn reviewed_activity_correction_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<ProbeState>()
        .is_some_and(|state| reviewed_activity_correction_mode(&state))
}

fn reviewed_activity_correction_mode(state: &ProbeState) -> bool {
    state.activity_questions
        && state.source_focus_claims
        && !state.compact_claims
        && state.reviewed_activity_correction
        && !state.ordinal_activity
}

/// Record admission counts before windowing without original bodies or semantic
/// authority. A normal app or an unselected activity QA route emits nothing.
pub(crate) fn observe_activity_backing(
    app: &tauri::AppHandle,
    request_id: &str,
    source_set: &crate::wiki_claims::SourceSet,
) {
    let Some(state) = app.try_state::<ProbeState>() else {
        return;
    };
    record_activity_backing(&state, request_id, source_set);
}

fn record_activity_backing(
    state: &ProbeState,
    request_id: &str,
    source_set: &crate::wiki_claims::SourceSet,
) -> bool {
    if !state.activity_questions {
        return false;
    }
    let result = (|| {
        let owned = state
            .owned_requests
            .lock()
            .map_err(|_| "native Ask QA backing ownership lock poisoned")?;
        if !owned.contains(request_id) {
            return Err("native Ask QA backing request is not owned");
        }
        drop(owned);
        let mut records = state
            .backing_observations
            .lock()
            .map_err(|_| "native Ask QA backing observation lock poisoned")?;
        if records.len() >= 128 {
            return Err("native Ask QA backing observation capacity exceeded");
        }
        if records
            .iter()
            .any(|record| record["requestId"] == request_id)
        {
            return Err("native Ask QA backing request was already observed");
        }
        let spans: Vec<_> = source_set.spans().collect();
        records.push(
            json!({"requestId":request_id,"stage":"initial_backing_before_windowing",
            "coverageUnit":"backing_original_span","originalSpanCount":spans.len(),
            "spanIds":spans.iter().map(|span|span.id()).collect::<Vec<_>>(),
            "sourceRevisions":spans.iter().map(|span|span.source_revision()).collect::<Vec<_>>(),
            "originalBodiesIncluded":false,"modelProvidedSpanCount":null,"processedSpanCount":null,
            "nativeIoAuthenticated":false,"semanticAccepted":false,"productionAccepted":false}),
        );
        Ok::<(), &'static str>(())
    })();
    if let Err(error) = result {
        state.observation_errors.fetch_add(1, Ordering::Relaxed);
        eprintln!("{error}");
        return false;
    }
    true
}

/// Only the initial extraction contract is transformed. Later resolution and
/// semantic review use their original representations and mandatory checks.
pub(crate) fn compact_extraction_packet(
    app: &tauri::AppHandle,
    system: &str,
    user: &str,
) -> Result<Option<crate::wiki_claims::compact_qa::PreparedCompactQa>, String> {
    prepare_compact_extraction(compact_claims_enabled(app), system, user)
}

fn prepare_compact_extraction(
    enabled: bool,
    system: &str,
    user: &str,
) -> Result<Option<crate::wiki_claims::compact_qa::PreparedCompactQa>, String> {
    if enabled
        && (system == crate::local_synthesis::claim_prompt::activity_system()
            || system == crate::local_synthesis::claim_prompt::activity_reading_system())
    {
        crate::wiki_claims::compact_qa::PreparedCompactQa::prepare(system, user).map(Some)
    } else {
        Ok(None)
    }
}

/// Record the unchanged expansion separately from the actual compact decoder text.
pub(crate) fn observe_compact_expansion(
    app: &tauri::AppHandle,
    request_id: &str,
    packet_sha256: &str,
    ordinal: Option<u64>,
    result: &Result<String, String>,
) {
    let Some(state) = app.try_state::<ProbeState>() else {
        return;
    };
    if !record_compact_expansion(&state, request_id, packet_sha256, ordinal, result) {
        state.observation_errors.fetch_add(1, Ordering::Relaxed);
        eprintln!("native Ask compact expansion observation unavailable");
    }
}

fn record_compact_expansion(
    state: &ProbeState,
    request_id: &str,
    packet_sha256: &str,
    ordinal: Option<u64>,
    result: &Result<String, String>,
) -> bool {
    let owned = state.compact_claims
        && state
            .owned_requests
            .lock()
            .ok()
            .is_some_and(|owned| owned.contains(request_id));
    let ordinal = ordinal.filter(|ordinal| {
        owned
            && state.generations.lock().ok().is_some_and(|records| {
                records.iter().any(|record| {
                    record["requestId"] == request_id
                        && record["ordinal"].as_u64() == Some(*ordinal)
                        && record["user"]
                            .as_str()
                            .and_then(|user| serde_json::from_str::<Value>(user).ok())
                            .is_some_and(|user| user["packetSha256"] == packet_sha256)
                })
            })
    });
    ordinal
        .and_then(|ordinal| {
            state
                .compact_expansions
                .lock()
                .ok()
                .and_then(|mut records| {
                    if records.len() >= 128
                        || records
                            .iter()
                            .any(|record| record["generationOrdinal"].as_u64() == Some(ordinal))
                    {
                        return None;
                    }
                    records.push(json!({"generationOrdinal":ordinal,"requestId":request_id,
                "packetSha256":packet_sha256,"result":result,"semanticAccepted":false}));
                    Some(())
                })
        })
        .is_some()
}

/// Full inputs are retained only by this isolated QA app, never a normal app.
pub(crate) fn observe_generation(
    app: &tauri::AppHandle,
    request_id: &str,
    system: &str,
    user: &str,
    result: &Result<String, String>,
    telemetry: Option<&crate::local_llm::generation_telemetry::GenerationTelemetry>,
) -> Option<u64> {
    let state = app.try_state::<ProbeState>()?;
    let owned = match state.owned_requests.lock() {
        Ok(requests) => requests.contains(request_id),
        Err(_) => {
            state.observation_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("native Ask QA generation ownership lock poisoned");
            return None;
        }
    };
    if !owned {
        return None;
    }
    let ordinal = match state.generations.lock() {
        Ok(mut records) => {
            if records.len() < 128 {
                let ordinal = records.len() + 1;
                records.push(json!({"requestId":request_id,"ordinal":ordinal,
                    "system":system,"systemSha256":sha(system.as_bytes()),
                    "user":user,"userSha256":sha(user.as_bytes()),
                    "result":result,"telemetry":telemetry}));
                Some(ordinal as u64)
            } else {
                state.observation_errors.fetch_add(1, Ordering::Relaxed);
                eprintln!("native Ask QA generation observation capacity exceeded");
                None
            }
        }
        Err(_) => {
            state.observation_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("native Ask QA generation observation lock poisoned");
            None
        }
    };
    emit_phase(Phase::GenerationFinished, None, None, None);
    ordinal
}

pub(crate) fn generation_started(app: &tauri::AppHandle) {
    if app.try_state::<ProbeState>().is_some() {
        emit_phase(Phase::GenerationStarted, None, None, None);
    }
}

fn owned_request(command: &str, arguments: &Value) -> Result<Option<String>, String> {
    if matches!(command, "local_synthesize" | "local_query_plan") {
        Ok(Some(
            arguments["request"]["requestId"]
                .as_str()
                .ok_or("missing owned Ask request ID")?
                .to_owned(),
        ))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn probe_webview_ready(state: tauri::State<ProbeState>) -> Result<(), String> {
    emit_phase(Phase::WebviewReady, None, None, None);
    if let Some(reply) = state
        .ready
        .lock()
        .map_err(|_| "probe ready lock poisoned")?
        .take()
    {
        let _ = reply.send(());
    }
    Ok(())
}

#[tauri::command]
fn probe_ask_reply(
    state: tauri::State<ProbeState>,
    request_id: String,
    value: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    accept_reply(&state, request_id, value, error)
}

fn accept_reply(
    state: &ProbeState,
    request_id: String,
    value: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    emit_phase(Phase::ReplyCallbackEntered, None, None, None);
    let reply = state
        .replies
        .lock()
        .map_err(|_| "probe reply lock poisoned")?
        .remove(&request_id)
        .ok_or("unexpected native Ask probe reply")?;
    emit_phase(Phase::ReplyMatched, Some(reply.call_ordinal), None, None);
    let result = match (value, error) {
        (Some(value), None) => value
            .get("nativeValue")
            .cloned()
            .ok_or("missing native Ask reply value".into()),
        (None, Some(error)) => Err(error),
        _ => Err("invalid native Ask probe reply envelope".into()),
    };
    // A timed-out caller may have dropped its receiver; the callback still drains it.
    let delivered = reply.sender.send(result).is_ok();
    emit_phase(
        if delivered {
            Phase::ReplyDelivered
        } else {
            Phase::ReplyReceiverDropped
        },
        Some(reply.call_ordinal),
        None,
        None,
    );
    Ok(())
}

struct Call {
    reply: tokio::sync::oneshot::Receiver<Result<Value, String>>,
    owned_request: Option<String>,
    ordinal: u64,
}

fn require(condition: bool, message: &str) -> Result<(), String> {
    condition.then_some(()).ok_or_else(|| message.into())
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn dispatch(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    command: &str,
    arguments: Value,
) -> Result<Call, String> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let ordinal = NEXT.fetch_add(1, Ordering::Relaxed);
    let id = format!("native-ask-reply-{ordinal}");
    status_phase(app, Phase::DispatchStarted, Some(ordinal));
    let owned_request = owned_request(command, &arguments)?;
    let arguments = if command == "probe_activity_clock" {
        activity::clock_arguments(&arguments)?
    } else {
        arguments.to_string()
    };
    let (reply, receiver) = tokio::sync::oneshot::channel();
    {
        let state = app.state::<ProbeState>();
        let mut replies = state
            .replies
            .lock()
            .map_err(|_| "probe reply lock poisoned")?;
        require(
            replies.len() < 2,
            "native Ask probe reply capacity exceeded",
        )?;
        replies.insert(
            id.clone(),
            Reply {
                sender: reply,
                call_ordinal: ordinal,
            },
        );
        if let Some(request) = &owned_request {
            state
                .owned_requests
                .lock()
                .map_err(|_| "probe owned request lock poisoned")?
                .insert(request.clone());
        }
    }
    let command = serde_json::to_string(command).map_err(|error| error.to_string())?;
    let correlation = serde_json::to_string(&id).map_err(|error| error.to_string())?;
    let script = format!("(async()=>{{try{{const value=await window.__TAURI_INTERNALS__.invoke({command},{arguments});await window.__TAURI_INTERNALS__.invoke('probe_ask_reply',{{requestId:{correlation},value:{{nativeValue:value}},error:null}});}}catch(error){{await window.__TAURI_INTERNALS__.invoke('probe_ask_reply',{{requestId:{correlation},value:null,error:String(error)}});}}}})()");
    if let Err(error) = window.eval(script) {
        app.state::<ProbeState>()
            .replies
            .lock()
            .map_err(|_| "probe reply lock poisoned")?
            .remove(&id);
        status_phase(app, Phase::DispatchFailed, Some(ordinal));
        return Err(format!("native Ask dispatch failed: {error}"));
    }
    status_phase(app, Phase::DispatchSent, Some(ordinal));
    Ok(Call {
        reply: receiver,
        owned_request,
        ordinal,
    })
}

type ReceivedReply = Result<Result<Value, String>, tokio::sync::oneshot::error::RecvError>;

enum ReplyWait {
    Received(ReceivedReply),
    Expired,
}

async fn wait_reply(
    app: &tauri::AppHandle,
    call: &mut Call,
    timeout: Duration,
    heartbeat_phase: Phase,
) -> ReplyWait {
    let waiting = tokio::time::timeout(timeout, &mut call.reply);
    tokio::pin!(waiting);
    let mut ticks = tokio::time::interval_at(
        tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
        HEARTBEAT_INTERVAL,
    );
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            result = &mut waiting => return match result {
                Ok(reply) => ReplyWait::Received(reply),
                Err(_) => ReplyWait::Expired,
            },
            _ = ticks.tick() => heartbeat(app, heartbeat_phase, Some(call.ordinal)),
        }
    }
}

async fn invoke(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    command: &str,
    arguments: Value,
    watchdog: Duration,
    records: &mut Vec<Value>,
    case: &str,
) -> Result<Result<Value, String>, String> {
    let mut call = dispatch(app, window, command, arguments)?;
    let started = Instant::now();
    status_phase(app, Phase::ReplyAwaitStarted, Some(call.ordinal));
    match wait_reply(app, &mut call, watchdog, Phase::ReplyHeartbeat).await {
        ReplyWait::Received(reply) => {
            status_phase(
                app,
                if reply.is_ok() {
                    Phase::ReplyAwaitFinished
                } else {
                    Phase::ReplyAwaitDropped
                },
                Some(call.ordinal),
            );
            let native = reply.map_err(|_| "native Ask WebView reply dropped")?;
            records.push(json!({"case":case,"command":command,"callOrdinal":call.ordinal,"elapsedSeconds":started.elapsed().as_secs_f64(),
                "transport":"real_wry_webview_invoke","resolved":native.is_ok(),"value":native.as_ref().ok(),"error":native.as_ref().err()}));
            Ok(native)
        }
        ReplyWait::Expired => {
            status_phase(app, Phase::WatchdogExpired, Some(call.ordinal));
            let mut public_cancel = None;
            if let Some(request) = &call.owned_request {
                // The second bounded reply slot is reserved for cancellation.
                status_phase(app, Phase::PublicCancelStarted, Some(call.ordinal));
                match dispatch(
                    app,
                    window,
                    "cancel_local_synthesis",
                    json!({"requestId":request}),
                ) {
                    Ok(mut cancel) => {
                        match wait_reply(
                            app,
                            &mut cancel,
                            Duration::from_secs(10),
                            Phase::PublicCancelHeartbeat,
                        )
                        .await
                        {
                            ReplyWait::Received(Ok(reply)) => {
                                status_phase(
                                    app,
                                    if reply.is_ok() {
                                        Phase::PublicCancelReceived
                                    } else {
                                        Phase::PublicCancelFailed
                                    },
                                    Some(cancel.ordinal),
                                );
                                public_cancel = Some(reply);
                            }
                            ReplyWait::Received(Err(_)) => {
                                status_phase(app, Phase::PublicCancelFailed, Some(cancel.ordinal))
                            }
                            ReplyWait::Expired => {
                                status_phase(app, Phase::PublicCancelExpired, Some(cancel.ordinal))
                            }
                        }
                    }
                    Err(_) => {
                        status_phase(app, Phase::PublicCancelDispatchFailed, Some(call.ordinal))
                    }
                }
                if public_cancel.as_ref().map_or(true, Result::is_err) {
                    // Cleanup only; this is not evidence of public cancellation transport.
                    status_phase(app, Phase::QaCleanupCancelStarted, Some(call.ordinal));
                    crate::local_generation::cancel(request);
                    status_phase(app, Phase::QaCleanupCancelFinished, Some(call.ordinal));
                }
            }
            status_phase(app, Phase::TerminalDrainStarted, Some(call.ordinal));
            let terminal = wait_reply(
                app,
                &mut call,
                Duration::from_secs(60),
                Phase::TerminalDrainHeartbeat,
            )
            .await;
            status_phase(
                app,
                match &terminal {
                    ReplyWait::Received(Ok(_)) => Phase::TerminalDrainFinished,
                    ReplyWait::Received(Err(_)) => Phase::TerminalDrainDropped,
                    ReplyWait::Expired => Phase::TerminalDrainExpired,
                },
                Some(call.ordinal),
            );
            let terminal_reply = match &terminal {
                ReplyWait::Received(Ok(reply)) => Some(reply),
                _ => None,
            };
            records.push(json!({"case":case,"command":command,"callOrdinal":call.ordinal,"watchdogExpired":true,
                "elapsedSeconds":started.elapsed().as_secs_f64(),"publicCancellation":public_cancel,
                "cancellationPurpose":"qa_watchdog_cleanup",
                "qaCleanupCancellationUsed":call.owned_request.is_some() && public_cancel.as_ref().map_or(true,Result::is_err),
                "terminalDrained":terminal_reply.is_some(),"terminalReply":terminal_reply}));
            Err("native Ask QA watchdog expired; late replies cannot pass".into())
        }
    }
}

async fn value(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    command: &str,
    arguments: Value,
    watchdog: Duration,
    records: &mut Vec<Value>,
    case: &str,
) -> Result<Value, String> {
    invoke(app, window, command, arguments, watchdog, records, case).await?
}

async fn capture(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    origin: &Value,
    role: &str,
    usage: &str,
    watchdog: Duration,
    records: &mut Vec<Value>,
) -> Result<Value, String> {
    value(
        app,
        window,
        "capture_model_role",
        json!({"origin":origin,"role":role,"usage":usage}),
        watchdog,
        records,
        "capture_native_role",
    )
    .await
}

async fn select(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    model: &str,
    watchdog: Duration,
    records: &mut Vec<Value>,
) -> Result<(), String> {
    let settings = value(
        app,
        window,
        "get_settings",
        json!({}),
        watchdog,
        records,
        "read_isolated_settings",
    )
    .await?;
    value(app,window,"select_model_role",json!({"request":{"role":"ask","providerId":"builtin-local","modelId":model,"effort":"(default)",
        "expectedAuthorizationRevision":settings["role_authorization_revision"]}}),watchdog,records,"explicit_local_ask_selection").await?;
    Ok(())
}

async fn open(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    root: &Path,
    watchdog: Duration,
    records: &mut Vec<Value>,
) -> Result<Value, String> {
    value(
        app,
        window,
        "open_vault",
        json!({"path":root}),
        watchdog,
        records,
        "open_synthetic_vault",
    )
    .await?;
    let origin = value(
        app,
        window,
        "agent_vault_session",
        json!({}),
        watchdog,
        records,
        "capture_native_opening",
    )
    .await?;
    require(
        origin["vaultPath"] == root.to_string_lossy().as_ref(),
        "native opening escaped synthetic root",
    )?;
    Ok(origin)
}

fn request(origin: &Value, grant: &Value, hits: &Value, id: &str) -> Value {
    json!({"request":{"modelId":crate::local_model::MODEL.id,"requestId":id,"question":QUESTION,"previousQuestion":null,
        "lang":"ko","hits":hits,"expectedVault":origin["vaultPath"],"origin":origin,"roleSnapshot":grant,
        "scope":"wiki","range":null,"paths":[PAGE],"maxTokens":768,"activityOverview":false,"resolution":null}})
}

fn error_gate(reply: Result<Value, String>, expected: &str) -> Result<(), String> {
    require(
        reply
            .as_ref()
            .err()
            .is_some_and(|error| error.contains(expected)),
        "native Ask accepted an unauthorized or cancelled request",
    )
}

fn fallback_gate(reply: Result<Value, String>, expected: &str) -> Result<(), String> {
    let answer = reply?;
    require(
        answer["fallback_reason"] == expected
            && answer["answer"] == ""
            && answer["activity_failure"]["code"] == expected
            && answer["used_sources"].as_array().is_some_and(Vec::is_empty)
            && answer.get("answerReceipt").is_none(),
        "native Ask failure became a successful answer",
    )
}

fn positive_gate(answer: &Value) -> Result<(), String> {
    let revision = answer["answerReceipt"]["automatedAnswerReviewInputRevision"]
        .as_str()
        .unwrap_or("");
    require(
        answer["answer"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
            && answer["model_id"] == crate::local_model::MODEL.id
            && answer.get("fallback_reason").is_none()
            && answer.get("activity_failure").is_none()
            && answer["used_sources"].as_array().is_some_and(|sources| {
                !sources.is_empty() && sources.iter().all(|source| source == PAGE)
            })
            && answer["answerReceipt"]["answerOriginalSpans"]
                .as_u64()
                .is_some_and(|count| count > 0)
            && revision.len() == 64
            && revision
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "ordinary Ask did not produce an original-bound reviewed answer protocol",
    )
}

fn fixture(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root.join("wiki")).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(root.join("raw")).map_err(|error| error.to_string())?;
    std::fs::write(root.join(PAGE), NOTE).map_err(|error| error.to_string())?;
    std::fs::write(root.join("raw/synthetic-original.md"), RAW)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn retained(root: &Path) -> Result<(), String> {
    require(
        std::fs::read(root.join(PAGE)).map_err(|error| error.to_string())? == NOTE.as_bytes(),
        "synthetic human annotation or source changed",
    )?;
    require(
        std::fs::read(root.join("raw/synthetic-original.md")).map_err(|error| error.to_string())?
            == RAW.as_bytes(),
        "synthetic raw original changed",
    )
}

fn paired(root: &Path) -> Result<Value, String> {
    let pair = crate::index_publication::load(root)?;
    let hashes: Vec<_> = crate::embeddings::chunk_page(NOTE)
        .iter()
        .map(|text| crate::embeddings::content_hash(text))
        .collect();
    require(
        pair.generation > 0
            && pair.store.model
                == format!("builtin-local:{}", crate::local_llm::BUILTIN_EMBED_MODEL)
            && pair.store.hashes_by_page().get(PAGE) == Some(&hashes)
            && pair.lexical.page_hashes(PAGE) == Some(hashes),
        "persisted lexical/dense pair does not match synthetic source",
    )?;
    let root_text = root.to_string_lossy();
    let path = crate::vector_index::VectorStore::path_for(&root_text)?;
    require(
        path == crate::retrieval::Bm25Index::path_for(&root_text)?,
        "lexical/dense readers use different publication paths",
    )?;
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(
        json!({"generation":pair.generation,"sha256":sha(&bytes),"model":pair.store.model,"dim":pair.store.dim}),
    )
}

fn seed_control(source: &Path) -> Result<Value, String> {
    seed_artifact(source, &crate::local_model::MODEL)
}

async fn verify(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    sandbox: &Path,
    config: &Config,
    records: &mut Vec<Value>,
) -> Result<bool, String> {
    status_phase(app, Phase::VerifyStarted, None);
    let watchdog = Duration::from_secs(config.watchdog_seconds);
    records.push(
        json!({"case":"synthetic_fixture","question":QUESTION,"original":NOTE,
        "sourceSha256":sha(NOTE.as_bytes()),"rawSha256":sha(RAW.as_bytes()),
        "scope":"wiki","paths":[PAGE],"language":"ko","maxTokens":768}),
    );
    let root = sandbox.join("vault-a");
    let other = sandbox.join("vault-b");
    fixture(&root)?;
    fixture(&other)?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let other = other.canonicalize().map_err(|error| error.to_string())?;
    let mut origin = open(app, window, &root, watchdog, records).await?;
    select(app, window, crate::local_model::MODEL.id, watchdog, records).await?;
    let mut grant = capture(app, window, &origin, "ask", "foreground", watchdog, records).await?;
    value(
        app,
        window,
        "reindex_embeddings",
        json!({"provider":"builtin-local","model":crate::local_llm::BUILTIN_EMBED_MODEL}),
        watchdog,
        records,
        "native_e5_pair_reindex",
    )
    .await?;
    let initial_pair = paired(&root)?;
    records.push(json!({"case":"persisted_paired_source_identity","value":initial_pair}));
    let search=value(app,window,"semantic_search",json!({"query":QUESTION,"k":6,"provider":"builtin-local","model":crate::local_llm::BUILTIN_EMBED_MODEL,
        "range":null,"scope":"wiki","paths":[PAGE],"tierWeights":null}),watchdog,records,"native_hybrid_retrieval").await?;
    let hits=Value::Array(search["hits"].as_array().ok_or("missing native retrieval hits")?.iter().map(|hit|json!({"page":hit["page"],"stem":hit["stem"],"section":hit["section"],"text":hit["text"]})).collect());
    require(
        hits.as_array()
            .is_some_and(|hits| !hits.is_empty() && hits.iter().all(|hit| hit["page"] == PAGE)),
        "native search did not return synthetic evidence",
    )?;
    let status = value(
        app,
        window,
        "local_chat_status",
        json!({"modelId":crate::local_model::MODEL.id}),
        watchdog,
        records,
        "missing_weights_status",
    )
    .await?;
    require(
        status["state"] == "missing",
        "QA profile discovered undeclared generation weights",
    )?;
    fallback_gate(
        invoke(
            app,
            window,
            "local_synthesize",
            request(&origin, &grant, &hits, "native-ask-missing"),
            watchdog,
            records,
            "missing_weights_ask",
        )
        .await?,
        "model_unavailable",
    )?;
    let mut forged = grant.clone();
    forged["snapshotId"] = Value::String("0".repeat(64));
    error_gate(
        invoke(
            app,
            window,
            "local_synthesize",
            request(&origin, &forged, &hits, "native-ask-forged"),
            watchdog,
            records,
            "forged_role_grant",
        )
        .await?,
        "snapshot_stale",
    )?;
    let wrong_role = capture(
        app,
        window,
        &origin,
        "compilation",
        "foreground",
        watchdog,
        records,
    )
    .await?;
    error_gate(
        invoke(
            app,
            window,
            "local_synthesize",
            request(&origin, &wrong_role, &hits, "native-ask-wrong-role"),
            watchdog,
            records,
            "wrong_role_grant",
        )
        .await?,
        "role_mismatch",
    )?;
    let wrong_usage = capture(app, window, &origin, "ask", "automatic", watchdog, records).await?;
    error_gate(
        invoke(
            app,
            window,
            "local_synthesize",
            request(&origin, &wrong_usage, &hits, "native-ask-wrong-usage"),
            watchdog,
            records,
            "wrong_usage_grant",
        )
        .await?,
        "role_mismatch",
    )?;
    select(
        app,
        window,
        crate::local_model::SMALL_MODEL.id,
        watchdog,
        records,
    )
    .await?;
    error_gate(
        invoke(
            app,
            window,
            "local_synthesize",
            request(&origin, &grant, &hits, "native-ask-revoked"),
            watchdog,
            records,
            "revoked_role_grant",
        )
        .await?,
        "snapshot_stale",
    )?;
    select(app, window, crate::local_model::MODEL.id, watchdog, records).await?;
    grant = capture(app, window, &origin, "ask", "foreground", watchdog, records).await?;
    let previous = request(&origin, &grant, &hits, "native-ask-old-opening");
    value(
        app,
        window,
        "close_vault",
        json!({}),
        watchdog,
        records,
        "close_before_same_path_reopen",
    )
    .await?;
    let reopened = open(app, window, &root, watchdog, records).await?;
    require(
        origin["openingToken"] != reopened["openingToken"],
        "same-path reopen reused native opening token",
    )?;
    error_gate(
        invoke(
            app,
            window,
            "local_synthesize",
            previous,
            watchdog,
            records,
            "same_path_stale_opening",
        )
        .await?,
        "vault changed",
    )?;
    origin = reopened;
    grant = capture(app, window, &origin, "ask", "foreground", watchdog, records).await?;
    let other_origin = open(app, window, &other, watchdog, records).await?;
    error_gate(
        invoke(
            app,
            window,
            "local_synthesize",
            request(&other_origin, &grant, &hits, "native-ask-cross-origin"),
            watchdog,
            records,
            "cross_origin_grant",
        )
        .await?,
        "role_mismatch",
    )?;
    origin = open(app, window, &root, watchdog, records).await?;
    grant = capture(app, window, &origin, "ask", "foreground", watchdog, records).await?;
    std::fs::write(root.join(PAGE), NOTE.replace("그대로 보존", "제거"))
        .map_err(|error| error.to_string())?;
    let stale = invoke(
        app,
        window,
        "local_synthesize",
        request(&origin, &grant, &hits, "native-ask-stale"),
        watchdog,
        records,
        "stale_index_source",
    )
    .await;
    std::fs::write(root.join(PAGE), NOTE).map_err(|error| error.to_string())?;
    fallback_gate(stale?, "source_verification_failed")?;
    std::fs::rename(root.join(PAGE), root.join("wiki/temporarily-moved.md"))
        .map_err(|error| error.to_string())?;
    let missing = invoke(
        app,
        window,
        "local_synthesize",
        request(&origin, &grant, &hits, "native-ask-source-io"),
        watchdog,
        records,
        "missing_native_source",
    )
    .await;
    std::fs::rename(root.join("wiki/temporarily-moved.md"), root.join(PAGE))
        .map_err(|error| error.to_string())?;
    fallback_gate(missing?, "source_verification_failed")?;
    let cancelled = "native-ask-pre-cancelled";
    let cancellation = value(
        app,
        window,
        "cancel_local_synthesis",
        json!({"requestId":cancelled}),
        watchdog,
        records,
        "pre_cancel_owned_request",
    )
    .await?;
    require(
        cancellation == false,
        "pre-cancel control unexpectedly found a running request",
    )?;
    error_gate(
        invoke(
            app,
            window,
            "local_synthesize",
            request(&origin, &grant, &hits, cancelled),
            watchdog,
            records,
            "pre_cancelled_ask",
        )
        .await?,
        "cancelled",
    )?;
    fallback_gate(
        invoke(
            app,
            window,
            "local_synthesize",
            request(&origin, &grant, &hits, "native-ask-current-control"),
            watchdog,
            records,
            "current_opening_missing_weights_control",
        )
        .await?,
        "model_unavailable",
    )?;
    require(
        paired(&root)? == initial_pair,
        "rejected Ask changed persisted pair generation",
    )?;
    retained(&root)?;
    retained(&other)?;
    records.push(json!({"case":"guards_and_preservation","passed":true,"generatorInference":false,"embeddingInference":true,
        "rawSha256":sha(RAW.as_bytes()),"sourceSha256":sha(NOTE.as_bytes())}));
    let Some(artifact) = config.control_artifact.clone() else {
        records.push(json!({"case":"actual_ordinary_ask","state":"preparation_required","reason":"explicit_control_artifact_not_supplied"}));
        return Ok(false);
    };
    let copied = tauri::async_runtime::spawn_blocking(move || seed_control(&artifact))
        .await
        .map_err(|error| error.to_string())??;
    records.push(json!({"case":"seed_explicit_control","value":copied}));
    let status = value(
        app,
        window,
        "local_chat_status",
        json!({"modelId":crate::local_model::MODEL.id}),
        watchdog,
        records,
        "verified_control_status",
    )
    .await?;
    require(
        status["state"] == "ready"
            && status["model_id"] == crate::local_model::MODEL.id
            && status["bytes"] == crate::local_model::MODEL.bytes,
        "native control weights not ready",
    )?;
    let answer = value(
        app,
        window,
        "local_synthesize",
        request(&origin, &grant, &hits, "native-ask-positive"),
        watchdog,
        records,
        "actual_ordinary_ask",
    )
    .await?;
    positive_gate(&answer)?;
    require(
        paired(&root)? == initial_pair,
        "ordinary Ask modified persisted pair",
    )?;
    retained(&root)?;
    retained(&other)?;
    records.push(json!({"case":"ordinary_native_protocol","passed":true,"independentSourceGradeRequired":true,"semanticReleaseAccepted":false}));
    Ok(true)
}

async fn teardown(app: &tauri::AppHandle, records: &mut Vec<Value>) -> Result<(), String> {
    status_phase(app, Phase::TeardownEntered, None);
    let owned = app
        .state::<ProbeState>()
        .owned_requests
        .lock()
        .map_err(|_| "probe owned request lock poisoned")?
        .clone();
    let cleanup_requests = owned.len();
    status_phase(app, Phase::TeardownQaCancelStarted, None);
    for request in owned {
        crate::local_generation::cancel(&request);
    }
    status_phase(app, Phase::TeardownQaCancelFinished, None);
    let started = Instant::now();
    let mut ticks = tokio::time::interval_at(
        tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
        HEARTBEAT_INTERVAL,
    );
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    status_phase(app, Phase::TeardownDrainStarted, None);
    loop {
        let pending = app
            .state::<ProbeState>()
            .replies
            .lock()
            .map_err(|_| "probe reply lock poisoned")?
            .len();
        if pending == 0 && !crate::local_generation::busy() {
            break;
        }
        if started.elapsed() > Duration::from_secs(60) {
            status_phase(app, Phase::TeardownDrainExpired, None);
            records.push(json!({"case":"teardown","terminalDrained":false,"pendingReplies":pending,"workersBusy":crate::local_generation::busy()}));
            return Err(
                "native Ask teardown could not drain owned work; host unload withheld".into(),
            );
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(25)) => {},
            _ = ticks.tick() => heartbeat(app, Phase::TeardownHeartbeat, None),
        }
    }
    status_phase(app, Phase::TeardownDrained, None);
    // These synchronous destructors have no new timeout. An unmatched start
    // phase identifies the boundary reached, without inferring its cause.
    status_phase(app, Phase::ChatUnloadStarted, None);
    if let Err(error) = app
        .state::<crate::local_generation::LocalChatState>()
        .unload_probe_chat()
    {
        status_phase(app, Phase::ChatUnloadFailed, None);
        return Err(error);
    }
    status_phase(app, Phase::ChatUnloadFinished, None);
    status_phase(app, Phase::EmbeddingUnloadStarted, None);
    if let Err(error) = app
        .state::<crate::commands::LocalLlmState>()
        .unload_probe_embedding()
    {
        status_phase(app, Phase::EmbeddingUnloadFailed, None);
        return Err(error);
    }
    status_phase(app, Phase::EmbeddingUnloadFinished, None);
    status_phase(app, Phase::VaultCloseStarted, None);
    if let Err(error) = crate::commands::close_vault(app.state()) {
        status_phase(app, Phase::VaultCloseFailed, None);
        return Err(error);
    }
    status_phase(app, Phase::VaultCloseFinished, None);
    records.push(json!({"case":"teardown","terminalDrained":true,"chatUnloaded":true,"embeddingUnloaded":true,
        "qaCleanupCancellationRequests":cleanup_requests,"publicCancellationTransportUsed":false}));
    Ok(())
}

/// Return 0 for declared native protocol gates, 1 for failure, 2 for missing preparation.
/// This does not certify semantic quality, installed UI, or observed zero egress.
pub fn run(config: Config) -> i32 {
    let selected_model = match config.activity_manifest() {
        Ok(manifest) => manifest,
        Err(error) => {
            eprintln!("native Ask QA model selection failed: {error}");
            return 1;
        }
    };
    if !(1..=3600).contains(&config.watchdog_seconds) {
        eprintln!("native Ask QA watchdog must be between 1 and 3600 seconds");
        return 1;
    }
    let sandbox = match tempfile::Builder::new()
        .prefix("myco-native-ask-qa-")
        .tempdir()
    {
        Ok(sandbox) => sandbox,
        Err(error) => {
            eprintln!("native Ask sandbox failed: {error}");
            return 1;
        }
    };
    let directory = sandbox.path().join("data");
    std::env::set_var("MYCO_DATA_DIR", &directory);
    std::env::remove_var("MEMEX_DATA_DIR");
    if let Err(error) = std::fs::create_dir_all(directory.join("models"))
        .map_err(|error| error.to_string())
        .and_then(|_| {
            crate::settings::save(&crate::settings::Settings {
                auto_import_enabled: false,
                ..Default::default()
            })
        })
    {
        eprintln!("native Ask isolated settings failed: {error}");
        return 1;
    }
    let root = sandbox.path().to_path_buf();
    let code = std::sync::Arc::new(std::sync::atomic::AtomicI32::new(1));
    let task_code = code.clone();
    let runtime=tauri::Builder::default()
        .manage(crate::commands::VaultRoot::default())
        .manage(crate::commands::LocalLlmState::default())
        .manage(crate::local_generation::LocalChatState::default())
        .manage(crate::vector_index::VectorCache::default())
        .manage(crate::retrieval::Bm25Cache::default())
        .manage(ProbeState {activity_questions:config.activity_questions,compact_claims:config.compact_claims,source_focus_claims:config.source_focus_claims,named_source_focus_claims:config.named_source_focus_claims,ordinal_activity:config.ordinal_activity,reviewed_activity_correction:config.reviewed_activity_correction,..ProbeState::default()})
        .invoke_handler(tauri::generate_handler![
            crate::commands::open_vault,crate::commands::close_vault,crate::commands::agent_vault_session,
            crate::commands::get_settings,crate::commands::select_model_role,crate::commands::capture_model_role,
            crate::commands::local_chat_status,crate::commands::reindex_embeddings,crate::commands::semantic_search,
            crate::commands::local_synthesize,crate::commands::cancel_local_synthesis,probe_webview_ready,probe_ask_reply
            ,crate::commands::local_query_plan,crate::commands::activity_recall,activity::probe_activity_clock
        ])
        .setup(move|app| {
            let handle=app.handle().clone();
            let result_code=task_code.clone();
            tauri::async_runtime::spawn(async move {
                let mut records=Vec::new();
                emit_phase(if config.visible_window { Phase::VisibleWindow } else { Phase::HiddenWindow },None,None,None);
                let (ready,received)=tokio::sync::oneshot::channel();
                *handle.state::<ProbeState>().ready.lock().unwrap()=Some(ready);
                let builder=tauri::WebviewWindowBuilder::new(&handle,"native-ask-qa",tauri::WebviewUrl::App("index.html".into())).visible(config.visible_window);
                let builder=match config.background_policy {
                    Some(BackgroundPolicyQa::Disabled)=>builder.background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled),
                    _=>builder,
                };
                let window=builder.build();
                let result=match window {
                    Ok(window)=> {
                        match tokio::time::timeout(Duration::from_secs(30),received).await {
                            Ok(Ok(()))=>if config.activity_questions {activity::verify(&handle,&window,&root,&config,&mut records).await} else {verify(&handle,&window,&root,&config,&mut records).await},
                            _=>Err("native Ask QA WebView did not become ready".into()),
                        }
                    }
                    Err(error)=>Err(format!("native Ask QA WebView failed: {error}")),
                };
                status_phase(&handle,match &result {
                    Ok(true)=>Phase::VerifyPassed,
                    Ok(false)=>Phase::VerifyPreparationRequired,
                    Err(_)=>Phase::VerifyFailed,
                },None);
                let drained=teardown(&handle,&mut records).await;
                let exit=if drained.is_err() || result.is_err() {1} else if result==Ok(true) {0} else {2};
                let mut terminal=json!({"probe":"native_ask","transport":"real_wry_webview_invoke","exitCode":exit,
                    "measuredAtUnixMillis":SystemTime::now().duration_since(UNIX_EPOCH).ok().map(|elapsed|elapsed.as_millis()),
                    "state":if exit==0 {"native_protocol_passed"} else if exit==2 {"preparation_required"} else {"failed"},
                    "error":result.err(),"teardownError":drained.err(),"records":records,
                    "controlModel":selected_model.id,"generationManifest":selected_model,"qaWatchdogSeconds":config.watchdog_seconds,
                    "qaVisibleWindow":config.visible_window,"phaseProtocol":"native_ask_phase_v1","immediatePhaseChannel":"stderr",
                    "qaBackgroundPolicy":config.background_policy.unwrap_or(BackgroundPolicyQa::Default),
                    "qaBackgroundPolicyObservedByOs":"not_instrumented","qaWebKitStore":"existing_default_persistent",
                    "qaActivityQuestions":config.activity_questions,"generationObservations":handle.state::<ProbeState>().generations.lock().ok().as_deref(),
                    "qaCompactClaims":config.compact_claims,"qaCompactMeaningRepair":false,"qaCompactClaimStage":"initial_extraction_only",
                    "compactExpansions":handle.state::<ProbeState>().compact_expansions.lock().ok().as_deref(),
                    "generationObservationErrors":handle.state::<ProbeState>().observation_errors.load(Ordering::Relaxed),
                    "nativeCommandReturnObserver":"qa_app_only_final_handler_return_site",
                    "nativeCommandEarlyReturns":"not_observed","tauriResolverDelivery":"not_instrumented",
                    "heartbeatIntervalSeconds":HEARTBEAT_INTERVAL.as_secs(),"heartbeatLimit":HEARTBEAT_LIMIT,
                    "heartbeatRecordsEmitted":HEARTBEAT_EMITTED.load(Ordering::Relaxed),"heartbeatRecordsDropped":HEARTBEAT_DROPPED.load(Ordering::Relaxed),
                    "privateVaultRead":false,"installedAppRead":false,"downloads":false,"externalApiCalls":false,
                    "importedCompiledLineage":"not_run","inFlightMutationBarrier":"not_run",
                    "installedUi":"not_run","runtimeZeroEgress":"not_observed","semanticReleaseAccepted":false,
                    "independentSourceGradeRequired":true});
                terminal["qaSourceFocusClaims"]=json!(config.source_focus_claims);
                terminal["qaNamedSourceFocusClaims"]=json!(config.named_source_focus_claims);
                terminal["qaOrdinalActivity"]=json!(config.ordinal_activity);
                terminal["qaOrdinalActivityInitialCorrectionSupported"]=if config.ordinal_activity { json!(false) } else { Value::Null };
                terminal["qaOrdinalActivityAnswerCorrectionSupported"]=if config.ordinal_activity { json!(false) } else { Value::Null };
                terminal["qaSourceFocusWireVersion"]=if !config.source_focus_claims { Value::Null } else {
                    json!(if config.ordinal_activity { "NativeActivityTypesQaV2" } else if config.named_source_focus_claims { "WikiSourceFocusClaimsNamedQaV1" } else { "WikiSourceFocusClaimsQaV1" })
                };
                terminal["qaSourceFocusMeaningRepair"]=json!(false);
                terminal["qaSourceFocusClaimStage"]=json!("initial_extraction_only");
                terminal["qaReviewedActivityCorrection"]=json!(config.reviewed_activity_correction);
                terminal["qaReviewedActivityCorrectionNativeMeaningRepair"]=json!(false);
                terminal["qaReviewedActivityCorrectionLimits"]=json!({"enabled":config.reviewed_activity_correction,
                    "initialExtractionCorrectionsPerRequest":1,"answerCorrectionsPerRequest":1,
                    "totalCorrectionsPerRequest":2,"perBatchReset":false,"laterResolutionCorrection":false,
                    "observationIsRetryAuthority":false});
                terminal["activityBackingObservations"]=json!(handle.state::<ProbeState>().backing_observations.lock().ok().as_deref());
                focus_sizing::append_terminal(&handle.state::<ProbeState>(), &mut terminal);
                println!("{terminal}");
                result_code.store(exit,Ordering::SeqCst);
                handle.exit(exit);
            });
            Ok(())
        }).build(crate::app_context());
    match runtime {
        Ok(app) => {
            app.run_return(|_, event| {
                if let tauri::RunEvent::ExitRequested {
                    code: None, api, ..
                } = event
                {
                    api.prevent_exit();
                }
            });
        }
        Err(error) => eprintln!("native Ask QA app build failed: {error}"),
    }
    code.load(Ordering::SeqCst)
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;

    #[test]
    fn immediate_phase_records_have_only_closed_diagnostic_fields() {
        let record = serde_json::to_value(PhaseRecord {
            probe: "native_ask_phase_v1",
            phase: Phase::ReplyHeartbeat,
            ordinal: 7,
            elapsed_millis: 5_000,
            measured_at_unix_millis: Some(5_000),
            call_ordinal: Some(2),
            pending_replies: Some(1),
            workers_busy: Some(false),
        })
        .unwrap();
        assert_eq!(record["phase"], "reply_heartbeat");
        assert_eq!(record["callOrdinal"], 2);
        assert_eq!(record["pendingReplies"], 1);
        assert_eq!(record["workersBusy"], false);
        let keys: BTreeSet<_> = record
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            BTreeSet::from([
                "probe",
                "phase",
                "ordinal",
                "elapsedMillis",
                "measuredAtUnixMillis",
                "callOrdinal",
                "pendingReplies",
                "workersBusy",
            ])
        );
    }

    #[test]
    fn unavailable_status_is_not_serialized_as_idle() {
        let record = serde_json::to_value(PhaseRecord {
            probe: "native_ask_phase_v1",
            phase: Phase::ReplyHeartbeat,
            ordinal: 1,
            elapsed_millis: 0,
            measured_at_unix_millis: None,
            call_ordinal: None,
            pending_replies: None,
            workers_busy: None,
        })
        .unwrap();
        assert!(record["pendingReplies"].is_null());
        assert!(record["workersBusy"].is_null());
    }

    #[test]
    fn heartbeat_budget_is_bounded_without_mutating_global_runtime_state() {
        let counter = std::sync::atomic::AtomicU64::new(0);
        for _ in 0..HEARTBEAT_LIMIT {
            assert!(reserve_heartbeat(&counter));
        }
        assert!(!reserve_heartbeat(&counter));
        assert!(!reserve_heartbeat(&counter));
        assert_eq!(counter.load(Ordering::Relaxed), HEARTBEAT_LIMIT);
    }
}
