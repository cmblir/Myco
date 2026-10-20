//! Public image authorization checks through real Wry IPC.
//! Synthetic HTTP responses prove transport boundaries, not vision quality.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

const PROMPT: &str = "Describe this synthetic image without changing its source.";
// A synthetic one-pixel PNG; no user image is read by this probe.
const IMAGE: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 240, 31, 0, 5,
    0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];
// Independent fixture encoding, rather than the provider encoder under test.
const IMAGE_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const HUMAN: &str = "# Synthetic human note\nKeep this annotation unchanged.\n";
const ROUTES: [(&str, &str); 3] = [
    ("openai-api", "gpt-5.4-mini"),
    ("google-api", "gemini-2.5-flash"),
    ("anthropic-api", "claude-haiku-4-5"),
];
const GATES: &[&str] = &[
    "isolated_qa_profile",
    "webview_ready",
    "no_account_local_zero_send",
    "connected_only_local_zero_send",
    "legacy_query_local_zero_send",
    "ask_only_zero_send",
    "old_public_abi_rejected",
    "missing_origin_rejected",
    "missing_snapshot_rejected",
    "forged_grant_rejected",
    "wrong_usage_rejected",
    "stale_opening_rejected",
    "disconnected_before_dispatch_zero_send",
    "unknown_capability_zero_send",
    "openai_selected_payload",
    "google_selected_payload",
    "anthropic_selected_payload",
    "delayed_role_change",
    "delayed_disconnect",
    "delayed_same_path_reopen",
    "early_stop_zero_send",
    "inflight_stop_late_refusal",
    "new_request_survives_old_cancel",
    "retry_role_change_zero_additional_send",
    "retry_stop_zero_additional_send",
    "normal_retry_same_frozen_payload",
    "native_attempts_drained",
    "source_and_human_preserved",
    "close_vault_null_reply",
    "webview_closed",
    "loopback_workers_drained",
    "synthetic_sandbox_removed",
];

type NativeReply = Result<Value, Value>;
type Reply = tokio::sync::oneshot::Sender<NativeReply>;

#[derive(Default)]
struct ProbeState {
    ready: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    replies: Mutex<BTreeMap<String, Reply>>,
    next: AtomicUsize,
}

#[tauri::command]
fn probe_webview_ready(state: tauri::State<ProbeState>) -> Result<(), String> {
    if let Some(sender) = state
        .ready
        .lock()
        .map_err(|_| "probe ready lock poisoned")?
        .take()
    {
        sender
            .send(())
            .map_err(|_| "probe ready receiver dropped")?;
    }
    Ok(())
}

#[tauri::command]
fn probe_image_reply(
    state: tauri::State<ProbeState>,
    request_id: String,
    value: Value,
    error: Option<Value>,
) -> Result<(), String> {
    let sender = state
        .replies
        .lock()
        .map_err(|_| "probe reply lock poisoned")?
        .remove(&request_id)
        .ok_or("unexpected native image probe reply")?;
    sender
        .send(error.map_or(Ok(value), Err))
        .map_err(|_| "probe reply receiver dropped".into())
}

struct Pending {
    id: String,
    command: String,
    request_id: Option<String>,
    result: tokio::sync::oneshot::Receiver<NativeReply>,
}

fn dispatch(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    command: &str,
    args: Value,
) -> Result<Pending, String> {
    let state = app.state::<ProbeState>();
    let id = format!(
        "image-probe-reply-{}",
        state.next.fetch_add(1, Ordering::SeqCst)
    );
    let (sender, result) = tokio::sync::oneshot::channel();
    state
        .replies
        .lock()
        .map_err(|_| "probe reply lock poisoned")?
        .insert(id.clone(), sender);
    let encoded_command = serde_json::to_string(command).map_err(|error| error.to_string())?;
    let encoded_id = serde_json::to_string(&id).map_err(|error| error.to_string())?;
    let request_id = args
        .get("request")
        .unwrap_or(&args)
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let script = format!("(async()=>{{try{{const value=await window.__TAURI_INTERNALS__.invoke({encoded_command},{args});await window.__TAURI_INTERNALS__.invoke('probe_image_reply',{{requestId:{encoded_id},value,error:null}});}}catch(error){{await window.__TAURI_INTERNALS__.invoke('probe_image_reply',{{requestId:{encoded_id},value:null,error}});}}}})()");
    if let Err(error) = window.eval(script) {
        state
            .replies
            .lock()
            .map_err(|_| "probe reply lock poisoned")?
            .remove(&id);
        return Err(error.to_string());
    }
    Ok(Pending {
        id,
        command: command.into(),
        request_id,
        result,
    })
}

async fn finish(
    app: &tauri::AppHandle,
    pending: Pending,
    report: &mut Report,
) -> Result<NativeReply, String> {
    let outcome = tokio::time::timeout(Duration::from_secs(20), pending.result)
        .await
        .map_err(|_| "native image WebView invocation timed out".to_owned())
        .and_then(|result| result.map_err(|_| "native image reply channel dropped".to_owned()));
    app.state::<ProbeState>()
        .replies
        .lock()
        .map_err(|_| "probe reply lock poisoned")?
        .remove(&pending.id);
    let record = match &outcome {
        Ok(Ok(value)) => {
            json!({"command":pending.command,"requestId":pending.request_id,"outcome":"native_success","value":value})
        }
        Ok(Err(error)) => {
            json!({"command":pending.command,"requestId":pending.request_id,"outcome":"native_error","error":error})
        }
        Err(error) => {
            json!({"command":pending.command,"requestId":pending.request_id,"outcome":"transport_error","error":error})
        }
    };
    println!(
        "{}",
        json!({"probe":"native_image","record":"invoke_reply","call":record})
    );
    report.calls.push(record);
    outcome
}

async fn invoke(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    command: &str,
    args: Value,
    report: &mut Report,
) -> Result<NativeReply, String> {
    finish(app, dispatch(app, window, command, args)?, report).await
}

#[derive(Clone)]
struct SyntheticCredentials {
    values: Arc<Mutex<BTreeMap<String, String>>>,
    reads: Arc<AtomicUsize>,
}

impl SyntheticCredentials {
    fn new() -> Self {
        Self {
            values: Arc::new(Mutex::new(BTreeMap::new())),
            reads: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn insert(&self, provider: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "synthetic credential lock poisoned")?
            .insert(provider.into(), format!("synthetic-image-key-{provider}"));
        Ok(())
    }

    fn state(&self) -> crate::image_ingest::ImageIngestState {
        let credentials = self.clone();
        crate::image_ingest::ImageIngestState::with_credential_resolver(Arc::new(move |provider| {
            credentials.reads.fetch_add(1, Ordering::SeqCst);
            Ok(credentials
                .values
                .lock()
                .map_err(|_| "synthetic credential lock poisoned")?
                .get(provider)
                .cloned())
        }))
    }
}

#[derive(Clone)]
struct HttpRequest {
    path: String,
    headers: BTreeMap<String, String>,
    body: Value,
}

enum RequestRead {
    Complete(HttpRequest),
    EmptyConnection(&'static str),
}

struct Loopback {
    base: String,
    requests: Arc<Mutex<Vec<HttpRequest>>>,
    attempts: Arc<AtomicUsize>,
    errors: Arc<Mutex<Vec<String>>>,
    connections: Arc<Mutex<Vec<Value>>>,
    writes: Arc<Mutex<Vec<Value>>>,
    delay: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    next_status: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

fn read_request(stream: &mut TcpStream, received_bytes: &mut usize) -> Result<RequestRead, String> {
    // Darwin may inherit the listener's nonblocking flag on accepted sockets.
    stream
        .set_nonblocking(false)
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut chunk = [0; 4096];
        let count = match stream.read(&mut chunk) {
            Ok(0) if bytes.is_empty() => {
                return Ok(RequestRead::EmptyConnection("closed_before_http_bytes"));
            }
            Err(error)
                if bytes.is_empty()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
            {
                return Ok(RequestRead::EmptyConnection("bounded_idle_timeout"));
            }
            Err(error)
                if bytes.is_empty()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                    ) =>
            {
                return Ok(RequestRead::EmptyConnection("reset_before_http_bytes"));
            }
            result => result.map_err(|error| error.to_string())?,
        };
        if count == 0 {
            return Err("HTTP fixture closed before complete headers".into());
        }
        bytes.extend_from_slice(&chunk[..count]);
        *received_bytes += count;
        if let Some(offset) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break offset + 4;
        }
        if bytes.len() > 64 * 1024 {
            return Err("HTTP fixture headers exceed bound".into());
        }
    };
    let headers_text =
        std::str::from_utf8(&bytes[..header_end]).map_err(|error| error.to_string())?;
    let mut lines = headers_text.lines();
    let first = lines.next().ok_or("HTTP fixture has no request line")?;
    if !first.starts_with("POST ") {
        return Err("HTTP fixture accepts only POST".into());
    }
    let path = first
        .split_whitespace()
        .nth(1)
        .ok_or("HTTP fixture has no path")?
        .to_owned();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .collect::<BTreeMap<_, _>>();
    let size = headers
        .get("content-length")
        .ok_or("HTTP fixture requires content-length")?
        .parse::<usize>()
        .map_err(|error| error.to_string())?;
    if size > 128 * 1024 {
        return Err("HTTP fixture body exceeds bound".into());
    }
    while bytes.len() < header_end + size {
        let mut chunk = [0; 4096];
        let count = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("HTTP fixture closed before complete body".into());
        }
        bytes.extend_from_slice(&chunk[..count]);
        *received_bytes += count;
    }
    let body = serde_json::from_slice(&bytes[header_end..header_end + size])
        .map_err(|error| error.to_string())?;
    Ok(RequestRead::Complete(HttpRequest {
        path,
        headers,
        body,
    }))
}

impl Loopback {
    fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let base = format!(
            "http://{}",
            listener.local_addr().map_err(|error| error.to_string())?
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let attempts = Arc::new(AtomicUsize::new(0));
        let errors = Arc::new(Mutex::new(Vec::new()));
        let connection_records = Arc::new(Mutex::new(Vec::new()));
        let writes = Arc::new(Mutex::new(Vec::new()));
        let delay = Arc::new(Mutex::new(None::<Arc<AtomicBool>>));
        let next_status = Arc::new(AtomicUsize::new(200));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, failures, delay_state, stopped) = (
            requests.clone(),
            errors.clone(),
            delay.clone(),
            stop.clone(),
        );
        let (connections, responses) = (attempts.clone(), writes.clone());
        let connection_observations = connection_records.clone();
        let status_state = next_status.clone();
        let worker = std::thread::spawn(move || {
            let mut children = Vec::new();
            while !stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, address)) => {
                        let connection_ordinal = connections.fetch_add(1, Ordering::SeqCst) + 1;
                        let (seen, failures, stopped) =
                            (seen.clone(), failures.clone(), stopped.clone());
                        let responses = responses.clone();
                        let observations = connection_observations.clone();
                        let (delay_state, status_state) =
                            (delay_state.clone(), status_state.clone());
                        children.push(std::thread::spawn(move || {
                            if !address.ip().is_loopback() { failures.lock().unwrap().push("non-loopback fixture connection".into()); return; }
                            let mut received_bytes = 0;
                            let request = match read_request(&mut stream, &mut received_bytes) {
                                Ok(RequestRead::Complete(request)) => request,
                                Ok(RequestRead::EmptyConnection(reason)) => {
                                    observations.lock().unwrap().push(json!({"connectionOrdinal":connection_ordinal,"outcome":"empty_connection","reason":reason,"httpBytesRead":received_bytes,"cancellation":"not_proven"}));
                                    return;
                                }
                                Err(error) => {
                                    observations.lock().unwrap().push(json!({"connectionOrdinal":connection_ordinal,"outcome":"http_read_failed","httpBytesRead":received_bytes,"error":error}));
                                    failures.lock().unwrap().push(error);
                                    return;
                                }
                            };
                            let path = request.path.clone();
                            let (ordinal, delayed, status) = {
                                // Only a complete, valid POST can consume a response fixture.
                                let mut requests = seen.lock().unwrap();
                                let delayed = delay_state.lock().unwrap().take();
                                let status = status_state.swap(200, Ordering::SeqCst);
                                let ordinal = requests.len() + 1;
                                observations.lock().unwrap().push(json!({"connectionOrdinal":connection_ordinal,"outcome":"http_admitted","httpBytesRead":received_bytes,"requestOrdinal":ordinal,"status":status,"delayed":delayed.is_some()}));
                                requests.push(request);
                                (ordinal, delayed, status)
                            };
                            let response = if status == 503 {
                                json!({"error":{"message":"synthetic transient fixture failure"}})
                            } else if path.starts_with("/anthropic") {
                                json!({"content":[{"type":"text","text":"synthetic selected image answer"}]})
                            } else if path.starts_with("/google/") {
                                json!({"candidates":[{"content":{"parts":[{"text":"synthetic selected image answer"}]}}]})
                            } else {
                                json!({"choices":[{"message":{"content":"synthetic selected image answer"}}]})
                            };
                            if let Some(released) = &delayed {
                                while !released.load(Ordering::SeqCst) && !stopped.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(5)); }
                            }
                            if !stopped.load(Ordering::SeqCst) {
                                let body = response.to_string();
                                let reason = if status == 503 { "Service Unavailable" } else { "OK" };
                                let wire = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                                // A revoked reqwest future may close its socket before this late response.
                                let written = stream.write_all(wire.as_bytes());
                                responses.lock().unwrap().push(json!({"requestOrdinal":ordinal,"status":status,"delayed":delayed.is_some(),"writeSucceeded":written.is_ok(),"error":written.as_ref().err().map(ToString::to_string)}));
                                if let Err(error) = written {
                                    if delayed.is_none() { failures.lock().unwrap().push(error.to_string()); }
                                }
                            } else {
                                responses.lock().unwrap().push(json!({"requestOrdinal":ordinal,"status":status,"delayed":delayed.is_some(),"writeAttempted":false,"reason":"fixture_shutdown"}));
                            }
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => {
                        failures.lock().unwrap().push(error.to_string());
                        break;
                    }
                }
            }
            for child in children {
                if child.join().is_err() {
                    failures
                        .lock()
                        .unwrap()
                        .push("HTTP fixture worker panicked".into());
                }
            }
        });
        Ok(Self {
            base,
            requests,
            attempts,
            errors,
            connections: connection_records,
            writes,
            delay,
            next_status,
            stop,
            worker: Some(worker),
        })
    }

    fn count(&self) -> Result<usize, String> {
        Ok(self
            .requests
            .lock()
            .map_err(|_| "HTTP fixture lock poisoned")?
            .len())
    }

    fn delay_next(&self) -> Result<Arc<AtomicBool>, String> {
        let release = Arc::new(AtomicBool::new(false));
        let mut delayed = self
            .delay
            .lock()
            .map_err(|_| "HTTP fixture delay lock poisoned")?;
        if delayed.is_some() {
            return Err("HTTP fixture delay already armed".into());
        }
        *delayed = Some(release.clone());
        Ok(release)
    }

    fn transient_next(&self) -> Result<(), String> {
        self.next_status
            .compare_exchange(200, 503, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| ())
            .map_err(|_| "HTTP fixture transient status already armed".into())
    }

    async fn await_status_written(&self, ordinal: usize, status: usize) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let written = self
                .writes
                .lock()
                .map_err(|_| "HTTP fixture write lock poisoned")?
                .iter()
                .any(|reply| {
                    reply["requestOrdinal"] == ordinal
                        && reply["status"] == status
                        && reply["writeSucceeded"] == true
                });
            if written {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("synthetic HTTP status write timed out".into());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn await_delayed_admission(&self, expected: usize) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.count()? < expected {
            if Instant::now() >= deadline {
                return Err("synthetic HTTP admission timed out".into());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let armed = self
            .connections
            .lock()
            .map_err(|_| "HTTP fixture connection lock poisoned")?
            .iter()
            .any(|connection| {
                connection["requestOrdinal"] == expected
                    && connection["outcome"] == "http_admitted"
                    && connection["delayed"] == true
                    && connection["status"] == 200
            });
        if !armed {
            return Err("synthetic HTTP admission did not capture the armed delay".into());
        }
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), String> {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| "HTTP fixture owner panicked")?;
        }
        let errors = self
            .errors
            .lock()
            .map_err(|_| "HTTP fixture error lock poisoned")?;
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

impl Drop for Loopback {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            eprintln!("native image fixture teardown failed: {error}");
        }
    }
}

struct Environment(Vec<(String, Option<std::ffi::OsString>)>);
impl Environment {
    fn set(&mut self, key: &str, value: impl AsRef<std::ffi::OsStr>) {
        self.0.push((key.into(), std::env::var_os(key)));
        std::env::set_var(key, value);
    }
}
impl Drop for Environment {
    fn drop(&mut self) {
        for (key, value) in self.0.iter().rev() {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

struct Report {
    gates: Vec<Value>,
    calls: Vec<Value>,
}
impl Report {
    fn new() -> Self {
        Self {
            gates: GATES
                .iter()
                .map(|name| json!({"gate":name,"result":"not_run"}))
                .collect(),
            calls: Vec::new(),
        }
    }
    fn gate(&mut self, name: &str, passed: bool, proof: Value) -> Result<(), String> {
        let gate = self
            .gates
            .iter_mut()
            .find(|gate| gate["gate"] == name)
            .ok_or("unknown native image gate")?;
        *gate = json!({"gate":name,"result":if passed {"passed"} else {"failed"},"proof":proof});
        println!(
            "{}",
            json!({"probe":"native_image","record":"gate","gate":gate})
        );
        passed.then_some(()).ok_or_else(|| name.into())
    }
    fn terminal(&self, error: Option<&str>, teardown_error: Option<&str>, sandbox: &Path) -> i32 {
        let passed = error.is_none()
            && teardown_error.is_none()
            && self.gates.iter().all(|gate| gate["result"] == "passed");
        let exit = i32::from(!passed);
        println!(
            "{}",
            json!({"probe":"native_image","record":"terminal","protocol":"native_image_ipc_v1",
            "transport":"real_wry_webview_invoke","result":if passed {"passed"} else {"failed"},"exitCode":exit,
            "error":error,"teardownError":teardown_error,"syntheticSandbox":sandbox,"gates":self.gates,"calls":self.calls,
            "modelInference":false,"realKeychainRead":false,"credentialBoundary":"injected_synthetic_resolver_no_fallback",
            "allowedHttp":"probe_owned_loopback_only","paidInference":false,"privateVaultRead":false,"installedAppRead":false,
            "installedUi":"not_run","runtimeZeroEgress":"not_observed","remoteProcessingStopped":"not_proven",
            "transmittedBytesRecalled":false,"semanticReleaseAccepted":false})
        );
        exit
    }
}

fn connect(connected: bool) -> Result<(), String> {
    let mut settings = crate::settings::read_checked()?;
    settings.providers.openai_api = connected;
    settings.providers.google_api = connected;
    settings.providers.anthropic_api = connected;
    crate::role_authorization::save_settings(&settings)
}

async fn origin(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    report: &mut Report,
) -> Result<Value, String> {
    invoke(app, window, "agent_vault_session", json!({}), report)
        .await?
        .map_err(|error| error.to_string())
}

async fn capture(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    opening: &Value,
    role: &str,
    report: &mut Report,
) -> Result<Value, String> {
    invoke(
        app,
        window,
        "capture_model_role",
        json!({"origin":opening,"role":role,"usage":"foreground"}),
        report,
    )
    .await?
    .map_err(|error| error.to_string())
}

async fn select(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    role: &str,
    provider: &str,
    model: &str,
    report: &mut Report,
) -> Result<Value, String> {
    let settings = invoke(app, window, "get_settings", json!({}), report)
        .await?
        .map_err(|error| error.to_string())?;
    invoke(app, window, "select_model_role", json!({"request":{"role":role,"providerId":provider,"modelId":model,
        "effort":"(default)","expectedAuthorizationRevision":settings["role_authorization_revision"]}}), report).await?.map_err(|error| error.to_string())
}

fn request(path: &Path, opening: &Value, snapshot: &Value, id: &str) -> Value {
    json!({"request":{"path":path,"prompt":PROMPT,"origin":opening,"roleSnapshot":snapshot,"requestId":id}})
}

fn typed_failure(reply: &NativeReply, code: &str) -> bool {
    reply
        .as_ref()
        .is_err_and(|error| error == &json!({"version":"ImageIngestFailureV1","code":code}))
}

fn decode_failure(reply: &NativeReply) -> bool {
    reply
        .as_ref()
        .is_err_and(|error| error.as_str().is_some_and(|message| !message.is_empty()))
}

fn expected_denial(name: &str, reply: &NativeReply) -> bool {
    match name {
        "missing_origin_rejected" | "missing_snapshot_rejected" => decode_failure(reply),
        "no_account_local_zero_send"
        | "connected_only_local_zero_send"
        | "legacy_query_local_zero_send"
        | "unknown_capability_zero_send" => typed_failure(reply, "capability_unavailable"),
        _ => typed_failure(reply, "role_authorization_failed"),
    }
}

async fn denied(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    server: &Loopback,
    credentials: &SyntheticCredentials,
    name: &str,
    args: Value,
    report: &mut Report,
) -> Result<(), String> {
    let before = (
        server.count()?,
        server.attempts.load(Ordering::SeqCst),
        credentials.reads.load(Ordering::SeqCst),
        app.state::<crate::image_ingest::ImageIngestState>()
            .read_attempts(),
    );
    let reply = invoke(app, window, "describe_image", args, report).await?;
    let after = (
        server.count()?,
        server.attempts.load(Ordering::SeqCst),
        credentials.reads.load(Ordering::SeqCst),
        app.state::<crate::image_ingest::ImageIngestState>()
            .read_attempts(),
    );
    report.gate(name, expected_denial(name, &reply) && before == after,
        json!({"nativeError":reply.err(),"httpRequestsBefore":before.0,"httpRequestsAfter":after.0,
            "acceptedConnectionsBefore":before.1,"acceptedConnectionsAfter":after.1,
            "credentialReadsBefore":before.2,"credentialReadsAfter":after.2,"fileReadAttemptsBefore":before.3,"fileReadAttemptsAfter":after.3}))
}

fn payload_matches(request: &HttpRequest, provider: &str, model: &str) -> bool {
    let encoded = IMAGE_BASE64;
    match provider {
        "openai-api" => {
            request.path == "/openai"
                && request.body["model"] == model
                && request.body["max_completion_tokens"] == 1024
                && request.body.get("max_tokens").is_none()
                && request.body.pointer("/messages/0/content/0/text") == Some(&json!(PROMPT))
                && request.body.pointer("/messages/0/content/1/image_url/url")
                    == Some(&json!(format!("data:image/png;base64,{encoded}")))
                && request.headers.get("authorization")
                    == Some(&format!("Bearer synthetic-image-key-{provider}"))
        }
        "anthropic-api" => {
            request.path == "/anthropic"
                && request.body["model"] == model
                && request.body["max_tokens"] == 1024
                && request.body.pointer("/messages/0/content/1/text") == Some(&json!(PROMPT))
                && request.body.pointer("/messages/0/content/0/source/data")
                    == Some(&json!(encoded))
                && request
                    .body
                    .pointer("/messages/0/content/0/source/media_type")
                    == Some(&json!("image/png"))
                && request.headers.get("x-api-key")
                    == Some(&format!("synthetic-image-key-{provider}"))
        }
        "google-api" => {
            request.path == format!("/google/{model}:generateContent")
                && request.body.pointer("/contents/0/parts/1/text") == Some(&json!(PROMPT))
                && request.body.pointer("/contents/0/parts/0/inline_data/data")
                    == Some(&json!(encoded))
                && request
                    .body
                    .pointer("/contents/0/parts/0/inline_data/mime_type")
                    == Some(&json!("image/png"))
                && request.headers.get("x-goog-api-key")
                    == Some(&format!("synthetic-image-key-{provider}"))
        }
        _ => false,
    }
}

async fn verify_retries(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    image: &Path,
    opening: &Value,
    server: &Loopback,
    credentials: &SyntheticCredentials,
    report: &mut Report,
) -> Result<(), String> {
    for mode in [
        "retry_role_change_zero_additional_send",
        "retry_stop_zero_additional_send",
        "normal_retry_same_frozen_payload",
    ] {
        select(app, window, "compilation", ROUTES[0].0, ROUTES[0].1, report).await?;
        let selected = capture(app, window, opening, "compilation", report).await?;
        let before = (
            server.count()?,
            server.attempts.load(Ordering::SeqCst),
            credentials.reads.load(Ordering::SeqCst),
            app.state::<crate::image_ingest::ImageIngestState>()
                .read_attempts(),
        );
        server.transient_next()?;
        let pending = dispatch(
            app,
            window,
            "describe_image",
            request(image, opening, &selected, mode),
        )?;
        // The first complete 503 must be written before the authority or Stop action.
        server.await_status_written(before.0 + 1, 503).await?;
        let action = match mode {
            "retry_role_change_zero_additional_send" => invoke(app, window, "select_model_role", json!({"request":{
                "role":"compilation","providerId":"builtin-local","modelId":crate::local_model::SMALL_MODEL.id,
                "effort":"(default)","expectedAuthorizationRevision":selected["authorizationRevision"]}}), report).await?,
            "retry_stop_zero_additional_send" => invoke(app, window, "cancel_image_ingest", json!({"origin":opening,"requestId":mode}), report).await?,
            _ => Ok(Value::Null),
        };
        let reply = finish(app, pending, report).await?;
        // This window exceeds the first retry delay; retain unexpected later attempts.
        tokio::time::sleep(Duration::from_millis(400)).await;
        let after = (
            server.count()?,
            server.attempts.load(Ordering::SeqCst),
            credentials.reads.load(Ordering::SeqCst),
            app.state::<crate::image_ingest::ImageIngestState>()
                .read_attempts(),
        );
        let is_control = mode == "normal_retry_same_frozen_payload";
        let expected_posts = if is_control { 2 } else { 1 };
        let exact_payloads = {
            let requests = server
                .requests
                .lock()
                .map_err(|_| "HTTP fixture lock poisoned")?;
            requests.get(before.0..).is_some_and(|new| {
                new.len() == expected_posts
                    && new
                        .iter()
                        .all(|request| payload_matches(request, ROUTES[0].0, ROUTES[0].1))
            })
        };
        let native_result = if is_control {
            reply == Ok(json!("synthetic selected image answer"))
        } else {
            typed_failure(
                &reply,
                if mode == "retry_stop_zero_additional_send" {
                    "cancelled"
                } else {
                    "role_authorization_failed"
                },
            )
        };
        let action_passed = if mode == "retry_stop_zero_additional_send" {
            action == Ok(json!(true))
        } else if is_control {
            action == Ok(Value::Null)
        } else {
            action.as_ref().is_ok_and(|settings| {
                settings["model_roles"]["roles"]["compilation"]["providerId"] == "builtin-local"
            })
        };
        report.gate(mode, native_result && action_passed && exact_payloads
            && after.0 == before.0 + expected_posts && after.1 == before.1 + expected_posts
            && after.2 == before.2 + 1 && after.3 == before.3 + 1
            && app.state::<crate::image_ingest::ImageIngestState>().active_count() == 0,
            json!({"nativeReply":reply,"actionReply":action,"firstStatusWritten":503,"observationAfterNativeReplyMs":400,
                "httpPosts":after.0 - before.0,"acceptedConnections":after.1 - before.1,
                "credentialReads":after.2 - before.2,"fileReadAttempts":after.3 - before.3,
                "sameFrozenPayloads":exact_payloads,"activeNativeAttempts":app.state::<crate::image_ingest::ImageIngestState>().active_count()}))?;
    }
    Ok(())
}

async fn verify(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    root: &Path,
    server: &Loopback,
    credentials: &SyntheticCredentials,
    report: &mut Report,
) -> Result<(), String> {
    let image = root.join("synthetic.png");
    let absent = root.join("never-created.png");
    let mut opening = origin(app, window, report).await?;
    let local = capture(app, window, &opening, "compilation", report).await?;
    denied(
        app,
        window,
        server,
        credentials,
        "no_account_local_zero_send",
        request(&absent, &opening, &local, "no-account"),
        report,
    )
    .await?;
    for (provider, _) in ROUTES {
        credentials.insert(provider)?;
    }
    connect(true)?;
    let local = capture(app, window, &opening, "compilation", report).await?;
    denied(
        app,
        window,
        server,
        credentials,
        "connected_only_local_zero_send",
        request(&absent, &opening, &local, "connected-only"),
        report,
    )
    .await?;
    let mut settings = crate::settings::read_checked()?;
    settings.query_provider = ROUTES[0].0.into();
    settings.query_model = ROUTES[0].1.into();
    crate::role_authorization::save_settings(&settings)?;
    let local = capture(app, window, &opening, "compilation", report).await?;
    denied(
        app,
        window,
        server,
        credentials,
        "legacy_query_local_zero_send",
        request(&absent, &opening, &local, "legacy-query"),
        report,
    )
    .await?;
    select(app, window, "ask", ROUTES[0].0, ROUTES[0].1, report).await?;
    let ask = capture(app, window, &opening, "ask", report).await?;
    denied(
        app,
        window,
        server,
        credentials,
        "ask_only_zero_send",
        request(&absent, &opening, &ask, "ask-only"),
        report,
    )
    .await?;
    let old_abi = invoke(
        app,
        window,
        "describe_image",
        json!({"provider":ROUTES[0].0,"model":ROUTES[0].1,"path":image,"prompt":PROMPT}),
        report,
    )
    .await?;
    report.gate("old_public_abi_rejected", decode_failure(&old_abi) && server.count()? == 0 && server.attempts.load(Ordering::SeqCst) == 0 && credentials.reads.load(Ordering::SeqCst) == 0
        && app.state::<crate::image_ingest::ImageIngestState>().read_attempts() == 0,
        json!({"nativeError":old_abi.err(),"httpRequests":server.count()?,"fileReadAttempts":app.state::<crate::image_ingest::ImageIngestState>().read_attempts()}))?;
    select(app, window, "compilation", ROUTES[0].0, ROUTES[0].1, report).await?;
    let selected = capture(app, window, &opening, "compilation", report).await?;
    for (field, gate) in [
        ("origin", "missing_origin_rejected"),
        ("roleSnapshot", "missing_snapshot_rejected"),
    ] {
        for is_null in [false, true] {
            let mut args = request(
                &absent,
                &opening,
                &selected,
                &format!("decode-{field}-{is_null}"),
            );
            if is_null {
                args["request"][field] = Value::Null;
            } else {
                args["request"]
                    .as_object_mut()
                    .ok_or("image request fixture is not an object")?
                    .remove(field);
            }
            // Required-field serde failures are public ABI errors, not core FailureV1 results.
            denied(app, window, server, credentials, gate, args, report).await?;
        }
    }
    let mut forged = selected.clone();
    forged["snapshotId"] = json!("never-issued-synthetic-grant");
    denied(
        app,
        window,
        server,
        credentials,
        "forged_grant_rejected",
        request(&absent, &opening, &forged, "forged-grant"),
        report,
    )
    .await?;
    let settings = invoke(app, window, "get_settings", json!({}), report)
        .await?
        .map_err(|error| error.to_string())?;
    invoke(
        app,
        window,
        "set_role_automatic_use",
        json!({"role":"compilation","allowed":true,
        "expectedAuthorizationRevision":settings["role_authorization_revision"]}),
        report,
    )
    .await?
    .map_err(|error| error.to_string())?;
    let automatic = invoke(
        app,
        window,
        "capture_model_role",
        json!({"origin":opening,"role":"compilation","usage":"automatic"}),
        report,
    )
    .await?
    .map_err(|error| error.to_string())?;
    denied(
        app,
        window,
        server,
        credentials,
        "wrong_usage_rejected",
        request(&absent, &opening, &automatic, "automatic-grant"),
        report,
    )
    .await?;
    let selected = capture(app, window, &opening, "compilation", report).await?;
    invoke(app, window, "open_vault", json!({"path":root}), report)
        .await?
        .map_err(|error| error.to_string())?;
    let newer = origin(app, window, report).await?;
    if opening["openingToken"] == newer["openingToken"] {
        return Err("same-path reopen did not replace native opening token".into());
    }
    denied(
        app,
        window,
        server,
        credentials,
        "stale_opening_rejected",
        request(&absent, &opening, &selected, "stale-opening"),
        report,
    )
    .await?;
    opening = newer;
    let selected = capture(app, window, &opening, "compilation", report).await?;
    connect(false)?;
    denied(
        app,
        window,
        server,
        credentials,
        "disconnected_before_dispatch_zero_send",
        request(&absent, &opening, &selected, "disconnected"),
        report,
    )
    .await?;
    connect(true)?;
    select(
        app,
        window,
        "compilation",
        ROUTES[0].0,
        "synthetic-unknown-image-model",
        report,
    )
    .await?;
    let unknown = capture(app, window, &opening, "compilation", report).await?;
    denied(
        app,
        window,
        server,
        credentials,
        "unknown_capability_zero_send",
        request(&absent, &opening, &unknown, "unknown-capability"),
        report,
    )
    .await?;

    for ((provider, model), gate) in ROUTES.into_iter().zip([
        "openai_selected_payload",
        "google_selected_payload",
        "anthropic_selected_payload",
    ]) {
        select(app, window, "compilation", provider, model, report).await?;
        let selected = capture(app, window, &opening, "compilation", report).await?;
        let before = server.count()?;
        let reply = invoke(
            app,
            window,
            "describe_image",
            request(&image, &opening, &selected, gate),
            report,
        )
        .await?;
        let requests = server
            .requests
            .lock()
            .map_err(|_| "HTTP fixture lock poisoned")?;
        let matches = requests
            .get(before)
            .is_some_and(|request| payload_matches(request, provider, model));
        report.gate(gate, reply == Ok(json!("synthetic selected image answer")) && requests.len() == before + 1
            && matches, json!({"provider":provider,"model":model,"httpRequestsBefore":before,
            "httpRequestsAfter":requests.len(),"exactAdmittedPayloadMatched":matches,"credential":"synthetic_only","nativeReply":reply}))?;
    }

    for mode in [
        "delayed_role_change",
        "delayed_disconnect",
        "delayed_same_path_reopen",
    ] {
        connect(true)?;
        select(app, window, "compilation", ROUTES[0].0, ROUTES[0].1, report).await?;
        let selected = capture(app, window, &opening, "compilation", report).await?;
        let before = server.count()?;
        let released = server.delay_next()?;
        let pending = dispatch(
            app,
            window,
            "describe_image",
            request(&image, &opening, &selected, mode),
        )?;
        server.await_delayed_admission(before + 1).await?;
        match mode {
            "delayed_role_change" => {
                select(
                    app,
                    window,
                    "compilation",
                    "builtin-local",
                    crate::local_model::SMALL_MODEL.id,
                    report,
                )
                .await?;
            }
            "delayed_disconnect" => connect(false)?,
            _ => {
                invoke(app, window, "open_vault", json!({"path":root}), report)
                    .await?
                    .map_err(|error| error.to_string())?;
                opening = origin(app, window, report).await?;
            }
        }
        // Do not release the HTTP response until the native command has rejected it.
        let reply = finish(app, pending, report).await?;
        released.store(true, Ordering::SeqCst);
        report.gate(mode, typed_failure(&reply, "role_authorization_failed") && server.count()? == before + 1 && app.state::<crate::image_ingest::ImageIngestState>().active_count() == 0,
            json!({"lateResponseReleasedAfterRejection":typed_failure(&reply,"role_authorization_failed"),"nativeError":reply.err(),"admittedRequests":1,"nativeAttemptsAfterReply":app.state::<crate::image_ingest::ImageIngestState>().active_count(),"remoteProcessingStopped":"not_proven"}))?;
    }
    connect(true)?;
    select(app, window, "compilation", ROUTES[0].0, ROUTES[0].1, report).await?;
    let selected = capture(app, window, &opening, "compilation", report).await?;
    let before = (
        server.count()?,
        server.attempts.load(Ordering::SeqCst),
        credentials.reads.load(Ordering::SeqCst),
        app.state::<crate::image_ingest::ImageIngestState>()
            .read_attempts(),
    );
    let cancelled = invoke(
        app,
        window,
        "cancel_image_ingest",
        json!({"origin":opening,"requestId":"early-stop"}),
        report,
    )
    .await?;
    let reply = invoke(
        app,
        window,
        "describe_image",
        request(&image, &opening, &selected, "early-stop"),
        report,
    )
    .await?;
    report.gate("early_stop_zero_send", cancelled == Ok(json!(true)) && typed_failure(&reply, "cancelled")
        && before == (server.count()?, server.attempts.load(Ordering::SeqCst), credentials.reads.load(Ordering::SeqCst), app.state::<crate::image_ingest::ImageIngestState>().read_attempts()),
        json!({"cancelReply":cancelled,"nativeError":reply.err(),"earlyStopOnly":true,"httpRequestsBefore":before.0,"httpRequestsAfter":server.count()?}))?;
    let before = server.count()?;
    let released = server.delay_next()?;
    let pending = dispatch(
        app,
        window,
        "describe_image",
        request(&image, &opening, &selected, "inflight-stop"),
    )?;
    server.await_delayed_admission(before + 1).await?;
    let cancel = invoke(
        app,
        window,
        "cancel_image_ingest",
        json!({"origin":opening,"requestId":"inflight-stop"}),
        report,
    )
    .await?;
    let reply = finish(app, pending, report).await?;
    released.store(true, Ordering::SeqCst);
    report.gate("inflight_stop_late_refusal", cancel == Ok(json!(true)) && typed_failure(&reply, "cancelled") && server.count()? == before + 1
        && app.state::<crate::image_ingest::ImageIngestState>().active_count() == 0, json!({"lateResponseReleasedAfterRejection":typed_failure(&reply,"cancelled"),"cancelReply":cancel,"nativeError":reply.err(),"remoteProcessingStopped":"not_proven"}))?;
    let before = server.count()?;
    let released = server.delay_next()?;
    let pending = dispatch(
        app,
        window,
        "describe_image",
        request(&image, &opening, &selected, "fresh-after-stop"),
    )?;
    server.await_delayed_admission(before + 1).await?;
    let old_cancel = invoke(
        app,
        window,
        "cancel_image_ingest",
        json!({"origin":opening,"requestId":"inflight-stop"}),
        report,
    )
    .await?;
    released.store(true, Ordering::SeqCst);
    let reply = finish(app, pending, report).await?;
    // Terminal cancellation registers an early marker for exactly the old ID.
    let marker_before = (
        server.count()?,
        credentials.reads.load(Ordering::SeqCst),
        app.state::<crate::image_ingest::ImageIngestState>()
            .read_attempts(),
    );
    let old_retry = invoke(
        app,
        window,
        "describe_image",
        request(&image, &opening, &selected, "inflight-stop"),
        report,
    )
    .await?;
    let marker_after = (
        server.count()?,
        credentials.reads.load(Ordering::SeqCst),
        app.state::<crate::image_ingest::ImageIngestState>()
            .read_attempts(),
    );
    report.gate("new_request_survives_old_cancel", old_cancel == Ok(json!(true)) && reply == Ok(json!("synthetic selected image answer")) && server.count()? == before + 1
        && typed_failure(&old_retry, "cancelled") && marker_before == marker_after
        && app.state::<crate::image_ingest::ImageIngestState>().early_cancel_count() == 0,
        json!({"oldCancelReply":old_cancel,"nativeReply":reply,"newRequestId":"fresh-after-stop",
            "oldIdRetryError":old_retry.err(),"oldMarkerConsumed":true,"earlyCancelMarkers":app.state::<crate::image_ingest::ImageIngestState>().early_cancel_count()}))?;
    verify_retries(app, window, &image, &opening, server, credentials, report).await?;
    let image_preserved = std::fs::read(&image).map_err(|error| error.to_string())? == IMAGE;
    let human_preserved = std::fs::read_to_string(root.join("wiki/human.md"))
        .map_err(|error| error.to_string())?
        == HUMAN;
    report.gate("source_and_human_preserved", image_preserved && human_preserved,
        json!({"exactSyntheticImagePreserved":image_preserved,"exactHumanNotePreserved":human_preserved,"nativeSaveCommandDispatched":false}))
}

async fn exercise(
    app: &tauri::AppHandle,
    sandbox: &Path,
    server: &Loopback,
    credentials: &SyntheticCredentials,
    report: &mut Report,
) -> (Result<(), String>, Option<tauri::WebviewWindow>) {
    let mut window = None;
    let result = async {
        report.gate("isolated_qa_profile", app.config().identifier == "dev.cmblir.myco.native-index-qa"
            && crate::settings::settings_dir()? == sandbox.join("data") && crate::INDEX_UPDATER.get().is_none(),
            json!({"identifier":app.config().identifier,"settingsDir":crate::settings::settings_dir()?,"syntheticCredentialBoundary":true}))?;
        let root = sandbox.join("vault");
        std::fs::create_dir_all(root.join("wiki")).map_err(|error| error.to_string())?;
        std::fs::write(root.join("synthetic.png"), IMAGE).map_err(|error| error.to_string())?;
        std::fs::write(root.join("wiki/human.md"), HUMAN).map_err(|error| error.to_string())?;
        let root = root.canonicalize().map_err(|error| error.to_string())?;
        let (ready, receiver) = tokio::sync::oneshot::channel();
        *app.state::<ProbeState>().ready.lock().map_err(|_| "probe ready lock poisoned")? = Some(ready);
        window = Some(tauri::WebviewWindowBuilder::new(app, "native-image-probe", tauri::WebviewUrl::App("index.html".into())).visible(false).build().map_err(|error| error.to_string())?);
        tokio::time::timeout(Duration::from_secs(20), receiver).await.map_err(|_| "native image WebView ready timeout")?.map_err(|_| "native image ready channel dropped")?;
        report.gate("webview_ready", true, json!({"visible":false,"source":"QA_embedded_local_index.html"}))?;
        let window = window.as_ref().ok_or("native image WebView missing")?;
        invoke(app, window, "open_vault", json!({"path":root}), report).await?.map_err(|error| error.to_string())?;
        verify(app, window, &root, server, credentials, report).await
    }.await;
    (result, window)
}

async fn teardown(
    app: &tauri::AppHandle,
    window: Option<&tauri::WebviewWindow>,
    mut server: Loopback,
    sandbox: tempfile::TempDir,
    report: &mut Report,
) -> Result<(), String> {
    let mut failures = Vec::new();
    let mut closed = false;
    let mut native_drained = false;
    if let Some(window) = window {
        let close = invoke(app, window, "close_vault", json!({}), report).await;
        closed = matches!(&close, Ok(Ok(value)) if value.is_null())
            && app
                .state::<crate::commands::VaultRoot>()
                .current()
                .is_none();
        if let Err(error) = report.gate(
            "close_vault_null_reply",
            closed,
            json!({"reply":close,"nativeRootClosed":closed}),
        ) {
            failures.push(error);
        }
        // Keep the Wry callback bridge alive while revoked native attempts settle.
        let deadline = Instant::now() + Duration::from_secs(5);
        let (active, pending) = loop {
            let active = app
                .state::<crate::image_ingest::ImageIngestState>()
                .active_count();
            let pending = app
                .state::<ProbeState>()
                .replies
                .lock()
                .map_err(|_| "probe reply lock poisoned")?
                .len();
            if (active == 0 && pending == 0) || Instant::now() >= deadline {
                break (active, pending);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        native_drained = closed && active == 0 && pending == 0;
        if let Err(error) = report.gate("native_attempts_drained", native_drained,
            json!({"nativeRootClosed":closed,"activeNativeAttempts":active,"pendingWryReplies":pending,"deadlineSeconds":5})) { failures.push(error); }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = Arc::new(Mutex::new(Some(sender)));
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                match sender.lock() {
                    Ok(mut sender) => {
                        if let Some(sender) = sender.take() {
                            if sender.send(()).is_err() {
                                eprintln!("native image destroy receiver dropped");
                            }
                        }
                    }
                    Err(_) => eprintln!("native image destroy event lock poisoned"),
                }
            }
        });
        let close = match window.close() {
            Ok(()) => tokio::time::timeout(Duration::from_secs(20), receiver)
                .await
                .map_err(|_| "native image destroy timeout".to_owned())
                .and_then(|result| {
                    result.map_err(|_| "native image destroy channel dropped".into())
                }),
            Err(error) => Err(error.to_string()),
        };
        if let Err(error) = report.gate(
            "webview_closed",
            close.is_ok(),
            json!({"destroyEventObserved":close.is_ok(),"error":close.err()}),
        ) {
            failures.push(error);
        }
    } else {
        failures.push("no native image WebView available for teardown".into());
    }
    let drained = server.shutdown();
    let http_drained = drained.is_ok();
    if let Err(error) = report.gate("loopback_workers_drained", http_drained, json!({"listenerAndWorkersJoined":http_drained,
        "httpRequests":server.count()?,"acceptedConnections":server.attempts.load(Ordering::SeqCst),
        "connectionObservations":server.connections.lock().map_err(|_| "HTTP fixture connection lock poisoned")?.clone(),
        "readMode":"blocking_with_2s_read_timeout","responseAssignment":"complete_valid_post_admission",
        "responseWrites":server.writes.lock().map_err(|_| "HTTP fixture write lock poisoned")?.clone(),"error":drained.err()})) { failures.push(error); }
    let path = sandbox.path().to_path_buf();
    if closed && native_drained && http_drained {
        let removed = sandbox.close().map_err(|error| error.to_string());
        if let Err(error) = report.gate(
            "synthetic_sandbox_removed",
            removed.is_ok() && !path.exists(),
            json!({"path":path,"existsAfterClose":path.exists(),"error":removed.err()}),
        ) {
            failures.push(error);
        }
    } else {
        // Preserve only this probe-owned root when a native/fixture drain was not confirmed.
        let retained = sandbox.keep();
        if let Err(error) = report.gate("synthetic_sandbox_removed", false,
            json!({"path":retained,"retainedForFailureInspection":true,"nativeRootClosed":closed,"nativeAttemptsDrained":native_drained,"httpWorkersDrained":http_drained})) { failures.push(error); }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/// Run the isolated QA identity without production setup, models or real keychain access.
pub fn run() -> i32 {
    let mut environment = Environment(Vec::new());
    let sandbox = match tempfile::Builder::new()
        .prefix("myco-native-image-qa-")
        .tempdir()
    {
        Ok(sandbox) => sandbox,
        Err(error) => {
            return Report::new().terminal(
                Some(&format!("native image sandbox failed: {error}")),
                None,
                Path::new("unavailable"),
            )
        }
    };
    let path = sandbox.path().to_path_buf();
    environment.set("MYCO_DATA_DIR", path.join("data"));
    environment.set("MEMEX_DATA_DIR", "");
    let server = match Loopback::start() {
        Ok(server) => server,
        Err(error) => return Report::new().terminal(Some(&error), None, &path),
    };
    environment.set("MYCO_OPENAI_URL", format!("{}/openai", server.base));
    environment.set("MYCO_GOOGLE_URL", format!("{}/google", server.base));
    environment.set("MYCO_ANTHROPIC_URL", format!("{}/anthropic", server.base));
    let credentials = SyntheticCredentials::new();
    let exit = Arc::new(AtomicI32::new(1));
    let task_exit = exit.clone();
    let terminal = Arc::new(AtomicBool::new(false));
    let task_terminal = terminal.clone();
    let runtime = tauri::Builder::default()
        .manage(crate::commands::VaultRoot::default())
        .manage(credentials.state())
        .manage(ProbeState::default())
        .invoke_handler(tauri::generate_handler![
            crate::commands::open_vault,
            crate::commands::close_vault,
            crate::commands::agent_vault_session,
            crate::commands::get_settings,
            crate::commands::select_model_role,
            crate::commands::set_role_automatic_use,
            crate::commands::capture_model_role,
            crate::commands::describe_image,
            crate::commands::cancel_image_ingest,
            probe_webview_ready,
            probe_image_reply
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut report = Report::new();
                let (result, window) =
                    exercise(&handle, &path, &server, &credentials, &mut report).await;
                let teardown =
                    teardown(&handle, window.as_ref(), server, sandbox, &mut report).await;
                let code = report.terminal(
                    result.as_ref().err().map(String::as_str),
                    teardown.as_ref().err().map(String::as_str),
                    &path,
                );
                task_exit.store(code, Ordering::SeqCst);
                task_terminal.store(true, Ordering::SeqCst);
                handle.exit(code);
            });
            Ok(())
        })
        .build(crate::app_context());
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
        Err(error) => {
            return Report::new().terminal(
                Some(&format!("native image QA runtime build failed: {error}")),
                None,
                Path::new("setup_not_started"),
            )
        }
    }
    if !terminal.load(Ordering::SeqCst) {
        return Report::new().terminal(
            Some("native image runtime ended before owned terminal receipt"),
            None,
            Path::new("setup_terminal_missing"),
        );
    }
    exit.load(Ordering::SeqCst)
}
