//! Thin IPC adapters for native-owned Audio source and publication jobs.

use crate::audio_overview::{
    self, AudioOverviewRegistry, Draft, DraftContext, JobContext, Publication,
};
use crate::local_generation::LocalChatState;
use crate::vault_session::{AgentVaultSession, VaultRoot};

#[tauri::command]
pub(crate) fn audio_overview_begin(
    vault: tauri::State<VaultRoot>,
    registry: tauri::State<AudioOverviewRegistry>,
    origin: AgentVaultSession,
    page_paths: Vec<String>,
    title: String,
    date_iso: String,
) -> Result<JobContext, String> {
    audio_overview::begin(&vault, &registry, &origin, &page_paths, &title, &date_iso)
}

#[tauri::command]
pub(crate) async fn audio_overview_generate(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    registry: tauri::State<'_, AudioOverviewRegistry>,
    model: tauri::State<'_, LocalChatState>,
    context: JobContext,
) -> Result<Draft, String> {
    audio_overview::generate(app, model.inner().clone(), &vault, &registry, &context).await
}

#[tauri::command]
pub(crate) fn audio_overview_publish(
    vault: tauri::State<VaultRoot>,
    registry: tauri::State<AudioOverviewRegistry>,
    context: DraftContext,
) -> Result<Publication, String> {
    audio_overview::publish(&vault, &registry, &context)
}

#[tauri::command]
pub(crate) fn audio_overview_cancel(
    registry: tauri::State<AudioOverviewRegistry>,
    context: JobContext,
) -> Result<bool, String> {
    audio_overview::cancel(&registry, &context)
}
