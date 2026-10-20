//! Explicit Compilation image ingest with immutable bytes and owned cancellation.

mod capabilities;
mod requests;

use crate::role_authorization::RoleSnapshot;
use crate::vault_session::AgentVaultSession;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
type CredentialResolver = dyn Fn(&str) -> Result<Option<String>, String> + Send + Sync;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DescribeImageRequest {
    pub path: String,
    pub prompt: String,
    pub origin: AgentVaultSession,
    pub role_snapshot: RoleSnapshot,
    pub request_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    InvalidRequest,
    RoleAuthorizationFailed,
    CapabilityUnavailable,
    Cancelled,
    ImageReadFailed,
    ImageTooLarge,
    CredentialUnavailable,
    TransportFailed,
    RequestBusy,
}

impl FailureCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::RoleAuthorizationFailed => "role_authorization_failed",
            Self::CapabilityUnavailable => "capability_unavailable",
            Self::Cancelled => "cancelled",
            Self::ImageReadFailed => "image_read_failed",
            Self::ImageTooLarge => "image_too_large",
            Self::CredentialUnavailable => "credential_unavailable",
            Self::TransportFailed => "transport_failed",
            Self::RequestBusy => "request_busy",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Failure {
    version: &'static str,
    pub code: FailureCode,
}

impl From<FailureCode> for Failure {
    fn from(code: FailureCode) -> Self {
        Self {
            version: "ImageIngestFailureV1",
            code,
        }
    }
}

impl From<String> for Failure {
    fn from(_private_role_error: String) -> Self {
        // Common authority errors are propagated without private path details.
        FailureCode::RoleAuthorizationFailed.into()
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code.as_str())
    }
}

pub struct ImageIngestState {
    requests: requests::Registry,
    credential_resolver: Arc<CredentialResolver>,
    read_attempts: Arc<AtomicUsize>,
    #[cfg(test)]
    before_read: Option<Arc<dyn Fn() + Send + Sync>>,
    #[cfg(test)]
    before_open: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Default for ImageIngestState {
    fn default() -> Self {
        Self {
            requests: requests::Registry::default(),
            credential_resolver: Arc::new(crate::secrets::get_key),
            read_attempts: Arc::new(AtomicUsize::new(0)),
            #[cfg(test)]
            before_read: None,
            #[cfg(test)]
            before_open: None,
        }
    }
}

impl ImageIngestState {
    /// QA credentials replace the resolver entirely; no OS-keychain fallback.
    #[cfg(any(test, feature = "native-index-probe"))]
    pub fn with_credential_resolver(resolver: Arc<CredentialResolver>) -> Self {
        Self {
            credential_resolver: resolver,
            ..Self::default()
        }
    }

    /// Owned attempts include a bounded file worker until it actually drains.
    #[cfg(any(test, feature = "native-index-probe"))]
    pub fn active_count(&self) -> usize {
        self.requests.active_count()
    }

    /// File-open/read attempts, observed before touching the external file.
    #[cfg(any(test, feature = "native-index-probe"))]
    pub fn read_attempts(&self) -> usize {
        self.read_attempts.load(Ordering::Acquire)
    }

    #[cfg(any(test, feature = "native-index-probe"))]
    pub fn early_cancel_count(&self) -> usize {
        self.requests.early_count()
    }

    pub(crate) fn cancel(
        &self,
        origin: &AgentVaultSession,
        request_id: &str,
    ) -> Result<bool, Failure> {
        self.requests.cancel(origin, request_id)
    }
}

struct FrozenImage {
    bytes: Vec<u8>,
    media_type: &'static str,
}

fn validate_request(request: &DescribeImageRequest) -> Result<(), Failure> {
    if !requests::valid_id(&request.request_id)
        || request.path.len() > 8192
        || !Path::new(&request.path).is_absolute()
        || request.prompt.trim().is_empty()
        || request.prompt.len() > 64 * 1024
    {
        return Err(FailureCode::InvalidRequest.into());
    }
    Ok(())
}

fn read_bounded(
    path: &Path,
    run: &requests::Run,
    before_open: impl FnOnce(),
) -> Result<FrozenImage, Failure> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let media_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err(FailureCode::ImageReadFailed.into()),
    };
    // Reject special files before opening: a FIFO open can otherwise block
    // before the owned worker reaches a cancellation check.
    let before_metadata = std::fs::metadata(path).map_err(|_| FailureCode::ImageReadFailed)?;
    if !before_metadata.is_file() {
        return Err(FailureCode::ImageReadFailed.into());
    }
    before_open();
    run.check()?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A path replacement after metadata must not turn open into a
        // blocking FIFO operation. Regular files and symlinks still work.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| FailureCode::ImageReadFailed)?;
    let metadata = file.metadata().map_err(|_| FailureCode::ImageReadFailed)?;
    if !metadata.is_file() {
        return Err(FailureCode::ImageReadFailed.into());
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(FailureCode::ImageTooLarge.into());
    }
    // The handle and sentinel cap survive path replacement or file growth.
    // Transport receives this frozen buffer, never the live source path.
    let mut bytes = Vec::new();
    let mut limited = file.take(MAX_IMAGE_BYTES + 1);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        run.check()?;
        let count = limited
            .read(&mut chunk)
            .map_err(|_| FailureCode::ImageReadFailed)?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    run.check()?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(FailureCode::ImageTooLarge.into());
    }
    if bytes.is_empty() {
        return Err(FailureCode::ImageReadFailed.into());
    }
    Ok(FrozenImage { bytes, media_type })
}

/// The public bridge supplies its fixed foreground Compilation authority check.
pub(crate) async fn run(
    state: &ImageIngestState,
    request: DescribeImageRequest,
    authorize: impl Fn() -> Result<(), Failure> + Send + Sync,
) -> Result<String, Failure> {
    validate_request(&request)?;
    authorize()?;
    let route = &request.role_snapshot.route_signature;
    if !capabilities::supports(&route.provider_id, &route.model_id) {
        return Err(FailureCode::CapabilityUnavailable.into());
    }
    let run = state.requests.begin(&request.origin, &request.request_id)?;
    // Revocation drops the outer await side. Only this acquired flag is set;
    // an already-started file worker keeps ownership until it actually drains.
    let _cancel_on_drop = run.cancel_on_drop();
    run.check()?;

    let read_owner = run.clone();
    let read_attempts = state.read_attempts.clone();
    let path = PathBuf::from(&request.path);
    #[cfg(test)]
    let before_read = state.before_read.clone();
    #[cfg(test)]
    let before_open = state.before_open.clone();
    let read = tauri::async_runtime::spawn_blocking(move || {
        let owner = read_owner;
        #[cfg(test)]
        if let Some(before_read) = before_read {
            before_read();
        }
        owner.check()?;
        read_attempts.fetch_add(1, Ordering::AcqRel);
        read_bounded(&path, &owner, || {
            #[cfg(test)]
            if let Some(before_open) = before_open {
                before_open();
            }
        })
    });
    tokio::pin!(read);
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(25));
    tick.tick().await;
    let read = loop {
        tokio::select! {
            result = &mut read => break result,
            _ = tick.tick() => { run.check()?; }
        }
    };
    run.check()?;
    authorize()?;
    let image = read.map_err(|_| FailureCode::ImageReadFailed)??;

    let key = (state.credential_resolver)(&route.provider_id);
    run.check()?;
    authorize()?;
    let key = key
        .map_err(|_| FailureCode::CredentialUnavailable)?
        .filter(|key| !key.trim().is_empty())
        .ok_or(FailureCode::CredentialUnavailable)?;

    // Called by the adapter before every send, including after retry backoff.
    let transport_authorize = || {
        run.check()
            .and_then(|_| authorize())
            .map_err(|failure| failure.to_string())
    };
    let transport = crate::providers::describe_image_authorized(
        &route.provider_id,
        &route.model_id,
        &image.bytes,
        image.media_type,
        &request.prompt,
        Some(key),
        &transport_authorize,
    );
    tokio::pin!(transport);
    let result = loop {
        tokio::select! {
            result = &mut transport => break result,
            _ = tick.tick() => { run.check()?; }
        }
    };
    // Failed transports must also reject revocation and cancellation. Public
    // errors never include credentials, provider response bodies or paths.
    run.check()?;
    authorize()?;
    let text = result.map_err(|_| FailureCode::TransportFailed)?;
    if text.trim().is_empty() {
        return Err(FailureCode::TransportFailed.into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests;
