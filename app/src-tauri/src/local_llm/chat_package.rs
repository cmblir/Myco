//! Keep a native adapter and its owning model in one resident allocation.

use super::generation_telemetry::GenerationErrorCode;
use llama_cpp_2::context::{params::LlamaContextParams, LlamaContext};
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::model::{LlamaLoraAdapter, LlamaModel};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

// llama-cpp-2 0.1.150 does not mark the non-owning adapter handle Send.
struct ModelOwnedAdapter(LlamaLoraAdapter);

// SAFETY: the pinned native model owns and frees its registered adapters
// (llama-adapter.cpp / llama-model.cpp). This private handle moves only with
// ResidentChat, whose LlamaModel is Send. Initialization finishes before the
// pair is published; subsequent mutable handle access is serialized by Mutex.
// Contexts borrow the pair and cannot outlive it. No pointer is exposed, cloned
// or independently freed, and no thread-affine state is held by this wrapper.
unsafe impl Send for ModelOwnedAdapter {}

pub(super) struct ResidentChat {
    // Drop the non-owning handle before the model frees the native adapter.
    adapter: Option<Mutex<ModelOwnedAdapter>>,
    model: LlamaModel,
}

impl ResidentChat {
    pub(super) fn new(model: LlamaModel, adapter: Option<&Path>) -> Result<Self, String> {
        let adapter = adapter
            .map(|path| {
                model
                    .lora_adapter_init(path)
                    .map(|handle| Mutex::new(ModelOwnedAdapter(handle)))
                    .map_err(|error| format!("load learned chat adapter: {error}"))
            })
            .transpose()?;
        Ok(Self { adapter, model })
    }

    pub(super) fn model(&self) -> &LlamaModel {
        &self.model
    }

    pub(super) fn new_context(
        &self,
        backend: &LlamaBackend,
        params: LlamaContextParams,
    ) -> Result<LlamaContext<'_>, (GenerationErrorCode, String)> {
        let context = self.model.new_context(backend, params).map_err(|error| {
            (
                GenerationErrorCode::ContextCreateFailed,
                format!("new_context: {error}"),
            )
        })?;
        if let Some(adapter) = &self.adapter {
            let mut handle = adapter.lock().map_err(|_| {
                (
                    GenerationErrorCode::AdapterApplyFailed,
                    "learned chat adapter lock poisoned".into(),
                )
            })?;
            // GGUF alpha/rank already encodes the trained scaling. Applying
            // the adapter at 1.0 avoids multiplying that scaling a second time.
            context
                .lora_adapter_set(&mut handle.0, 1.0)
                .map_err(|error| {
                    (
                        GenerationErrorCode::AdapterApplyFailed,
                        format!("apply learned chat adapter: {error}"),
                    )
                })?;
        }
        Ok(context)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ChatIdentity {
    pub(super) model: (PathBuf, u64, SystemTime),
    adapter: Option<(PathBuf, u64, SystemTime)>,
    package: Option<String>,
}

impl ChatIdentity {
    pub(super) fn read(
        model: &Path,
        adapter: Option<&Path>,
        package: Option<&str>,
    ) -> Result<Self, String> {
        Ok(Self {
            model: file_stamp(model)?,
            adapter: adapter.map(file_stamp).transpose()?,
            package: package.map(str::to_owned),
        })
    }
}

fn file_stamp(path: &Path) -> Result<(PathBuf, u64, SystemTime), String> {
    let path = path
        .canonicalize()
        .map_err(|error| format!("chat model path: {error}"))?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("chat model metadata: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("chat model must be a nonempty file".into());
    }
    let modified = metadata
        .modified()
        .map_err(|error| format!("chat model timestamp: {error}"))?;
    Ok((path, metadata.len(), modified))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resident_identity_changes_with_adapter_or_package_even_when_base_is_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("base.gguf");
        let first = temp.path().join("first.gguf");
        let second = temp.path().join("second.gguf");
        std::fs::write(&base, b"synthetic base").unwrap();
        std::fs::write(&first, b"synthetic adapter").unwrap();
        std::fs::write(&second, b"synthetic adapter").unwrap();
        let learned = ChatIdentity::read(&base, Some(&first), Some("package-one")).unwrap();
        assert_eq!(
            learned,
            ChatIdentity::read(&base, Some(&first), Some("package-one")).unwrap()
        );
        assert_ne!(learned, ChatIdentity::read(&base, None, None).unwrap());
        assert_ne!(
            learned,
            ChatIdentity::read(&base, Some(&second), Some("package-one")).unwrap()
        );
        assert_ne!(
            learned,
            ChatIdentity::read(&base, Some(&first), Some("package-two")).unwrap()
        );
    }

    #[test]
    fn incomplete_package_cannot_supply_a_resident_identity() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("base.gguf");
        let adapter = temp.path().join("adapter.gguf");
        std::fs::write(&base, b"synthetic base").unwrap();
        assert!(ChatIdentity::read(&base, Some(&adapter), Some("package")).is_err());
        std::fs::write(&adapter, b"").unwrap();
        assert!(ChatIdentity::read(&base, Some(&adapter), Some("package")).is_err());
        assert!(ChatIdentity::read(&base, Some(temp.path()), Some("package")).is_err());
    }

    #[test]
    fn native_pair_can_move_with_the_serial_host() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<ResidentChat>();
        assert_send_sync::<super::super::LocalLlm>();
    }
}
