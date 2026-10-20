//! One-shot transport comparison without model, vault or role operations.

use super::*;
use std::sync::{atomic::AtomicBool, Arc};

const TOKEN: &str = "synthetic-native-transport-v1";
const DELAY_SECONDS: u64 = 35;
const PRIMARY_SECONDS: u64 = 50;

/// Explicit QA selection; default omits the background-policy builder method.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundPolicyQa {
    Default,
    Disabled,
}

#[derive(Default)]
struct EchoState {
    active: Arc<AtomicBool>,
    entered: std::sync::atomic::AtomicUsize,
    returned: std::sync::atomic::AtomicUsize,
}

struct EchoGuard(Arc<AtomicBool>);
impl Drop for EchoGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn expected_echo() -> Value {
    json!({"token":TOKEN,"echo":"native_delay_completed","delaySeconds":DELAY_SECONDS})
}

#[tauri::command]
async fn probe_transport_echo(app: tauri::AppHandle, token: String) -> Result<Value, String> {
    require(token == TOKEN, "unregistered transport token")?;
    let state = app.state::<EchoState>();
    state
        .active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "transport echo already active")?;
    let _guard = EchoGuard(state.active.clone());
    state.entered.fetch_add(1, Ordering::SeqCst);
    emit_phase(Phase::EchoEntered, None, None, None);
    tokio::time::sleep(Duration::from_secs(DELAY_SECONDS)).await;
    state.returned.fetch_add(1, Ordering::SeqCst);
    emit_phase(Phase::EchoReturnSite, None, None, None);
    Ok(expected_echo())
}

#[tauri::command]
fn probe_transport_wake() -> Value {
    json!({"purpose":"qa_cleanup_only"})
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrimaryReport {
    passed: bool,
    watchdog_expired: bool,
    elapsed_seconds: f64,
    reply: Option<Value>,
    error: Option<String>,
}

fn grade_primary(waiting: ReplyWait, elapsed_seconds: f64) -> PrimaryReport {
    let (reply, mut error, watchdog_expired) = match waiting {
        ReplyWait::Received(Ok(Ok(value))) => (Some(value), None, false),
        ReplyWait::Received(Ok(Err(error))) => (None, Some(error), false),
        ReplyWait::Received(Err(error)) => (None, Some(error.to_string()), false),
        ReplyWait::Expired => (
            None,
            Some("transport primary watchdog expired".into()),
            true,
        ),
    };
    let within_deadline = elapsed_seconds.is_finite()
        && (DELAY_SECONDS as f64..=PRIMARY_SECONDS as f64).contains(&elapsed_seconds);
    let passed = reply.as_ref() == Some(&expected_echo()) && error.is_none() && within_deadline;
    if reply.is_some() && !passed {
        error = Some(if !within_deadline {
            "transport reply is outside the registered primary interval".into()
        } else {
            "transport echo payload does not match the registered value".into()
        });
    }
    PrimaryReport {
        passed,
        watchdog_expired,
        elapsed_seconds,
        reply,
        error,
    }
}

fn cleanup_result(waiting: ReplyWait, phase: &str) -> Result<Value, String> {
    match waiting {
        ReplyWait::Received(Ok(reply)) => {
            reply.map_err(|error| format!("{phase} native error: {error}"))
        }
        ReplyWait::Received(Err(error)) => Err(format!("{phase} reply dropped: {error}")),
        ReplyWait::Expired => Err(format!("{phase} watchdog expired")),
    }
}

async fn verify(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(PrimaryReport, Value), String> {
    let started = Instant::now();
    let mut call = dispatch(app, window, "probe_transport_echo", json!({"token":TOKEN}))?;
    status_phase(app, Phase::ReplyAwaitStarted, Some(call.ordinal));
    let remaining = Duration::from_secs(PRIMARY_SECONDS).saturating_sub(started.elapsed());
    let waiting = wait_reply(app, &mut call, remaining, Phase::ReplyHeartbeat).await;
    // Freeze the verdict before any eval, ping, wake or cleanup dispatch.
    let primary = grade_primary(waiting, started.elapsed().as_secs_f64());
    let wake_attempted = primary.watchdog_expired;
    status_phase(app, Phase::TransportPrimaryFrozen, Some(call.ordinal));
    eprintln!(
        "{}",
        json!({"probe":"native_transport_primary","callOrdinal":call.ordinal,"primary":primary})
    );
    let mut wake_reply = None;
    let mut late_reply = None;
    if primary.watchdog_expired {
        status_phase(app, Phase::TransportCleanupWake, Some(call.ordinal));
        match dispatch(app, window, "probe_transport_wake", json!({})) {
            Ok(mut wake) => {
                wake_reply = Some(cleanup_result(
                    wait_reply(
                        app,
                        &mut wake,
                        Duration::from_secs(5),
                        Phase::TerminalDrainHeartbeat,
                    )
                    .await,
                    "cleanup_wake",
                ))
            }
            Err(error) => wake_reply = Some(Err(format!("cleanup_wake dispatch failed: {error}"))),
        }
        late_reply = Some(cleanup_result(
            wait_reply(
                app,
                &mut call,
                Duration::from_secs(40),
                Phase::TerminalDrainHeartbeat,
            )
            .await,
            "original_drain",
        ));
    }
    let state = app.state::<EchoState>();
    let pending = app
        .state::<ProbeState>()
        .replies
        .lock()
        .map_err(|_| "probe reply lock poisoned")?
        .len();
    let active = state.active.load(Ordering::SeqCst);
    let entered = state.entered.load(Ordering::SeqCst);
    let returned = state.returned.load(Ordering::SeqCst);
    let drained = pending == 0 && !active;
    let completed = entered == 1 && returned == 1;
    let cleanup_errors: Vec<_> = wake_reply
        .iter()
        .chain(late_reply.iter())
        .filter_map(|reply| reply.as_ref().err())
        .collect();
    Ok((
        primary,
        json!({"wakeAttempted":wake_attempted,
        "wakeReply":wake_reply,"lateReply":late_reply,"errors":cleanup_errors,
        "pendingReplies":pending,"nativeEchoActive":active,"echoEntered":entered,
        "echoReturnSites":returned,"echoCompleted":completed,"terminalDrained":drained,
        "primaryVerdictRecomputedAfterCleanup":false}),
    ))
}

/// Runs a Mac-only QA app; no model/role/vault commands are registered.
pub fn run(policy: BackgroundPolicyQa) -> i32 {
    if !cfg!(target_os = "macos") {
        eprintln!("native transport background comparison requires macOS");
        return 1;
    }
    let sandbox = match tempfile::Builder::new()
        .prefix("myco-native-transport-qa-")
        .tempdir()
    {
        Ok(sandbox) => sandbox,
        Err(error) => {
            eprintln!("native transport profile failed: {error}");
            return 1;
        }
    };
    let directory = sandbox.path().join("data");
    if let Err(error) = std::fs::create_dir(&directory) {
        eprintln!("native transport data directory failed: {error}");
        return 1;
    }
    std::env::set_var("MYCO_DATA_DIR", &directory);
    std::env::remove_var("MEMEX_DATA_DIR");
    let code = Arc::new(std::sync::atomic::AtomicI32::new(1));
    let task_code = code.clone();
    let runtime = tauri::Builder::default()
        .manage(ProbeState::default())
        .manage(EchoState::default())
        .invoke_handler(tauri::generate_handler![
            probe_webview_ready, probe_ask_reply, probe_transport_echo, probe_transport_wake
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let result_code = task_code.clone();
            tauri::async_runtime::spawn(async move {
                let (ready, received) = tokio::sync::oneshot::channel();
                *handle.state::<ProbeState>().ready.lock().unwrap() = Some(ready);
                emit_phase(Phase::HiddenWindow, None, None, None);
                // Both comparison arms use the same nonpersistent WebKit store.
                let builder = tauri::WebviewWindowBuilder::new(&handle, "native-ask-qa", tauri::WebviewUrl::App("index.html".into()))
                    .visible(false).incognito(true);
                let builder = match policy {
                    BackgroundPolicyQa::Default => builder,
                    BackgroundPolicyQa::Disabled => builder.background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled),
                };
                let result = match builder.build() {
                    Ok(window) => match tokio::time::timeout(Duration::from_secs(30), received).await {
                        Ok(Ok(())) => verify(&handle, &window).await,
                        _ => Err("native transport WebView did not become ready".into()),
                    },
                    Err(error) => Err(format!("native transport window failed: {error}")),
                };
                let passed = result.as_ref().is_ok_and(|(primary, cleanup)| primary.passed && cleanup["terminalDrained"] == true && cleanup["echoCompleted"] == true);
                let exit = if passed { 0 } else { 1 };
                println!("{}", json!({"probe":"native_transport","exitCode":exit,
                    "backgroundPolicy":policy,"backgroundPolicyObservedByOs":"not_instrumented",
                    "hiddenWindow":true,"webKitStore":"nonpersistent_common_to_both_arms",
                    "differenceFromEarlierActualTrial":"incognito store and model-free command; not exact planner replay",
                    "nativeDelaySeconds":DELAY_SECONDS,"primaryWatchdogSeconds":PRIMARY_SECONDS,
                    "primary":result.as_ref().ok().map(|(primary,_)|primary),
                    "cleanup":result.as_ref().ok().map(|(_,cleanup)|cleanup),"error":result.as_ref().err(),
                    "transport":"same_native_ask_dispatch_iife_and_reply_registry",
                    "primaryWaitWakeups":"rust_heartbeat_only","modelsPrepared":false,
                    "generatorInference":false,"embeddingInference":false,"vaultCommandsRegistered":false,
                    "roleCommandsRegistered":false,"downloads":false,"privateVaultRead":false,
                    "installedAppRead":false,"externalApiCalls":false,"runtimeZeroEgress":"not_observed",
                    "plannerAuthorityChecks":"not_run","modelMeaning":"not_assessed","releaseAccepted":false}));
                result_code.store(exit, Ordering::SeqCst);
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
        Err(error) => eprintln!("native transport app build failed: {error}"),
    }
    code.load(Ordering::SeqCst)
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
