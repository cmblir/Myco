//! Thin IPC adapters for opening-bound deck snapshots and checked writes.

use crate::study_deck_io::{self, Context, MutationReceipt, Snapshot, StudyDeckRegistry};
use crate::vault_session::{AgentVaultSession, VaultRoot};

#[tauri::command]
pub(crate) fn read_study_deck(
    vault: tauri::State<VaultRoot>,
    registry: tauri::State<StudyDeckRegistry>,
    path: String,
    origin: AgentVaultSession,
) -> Result<Snapshot, String> {
    study_deck_io::read(&vault, &registry, &path, &origin)
}

#[tauri::command]
pub(crate) fn write_study_deck(
    vault: tauri::State<VaultRoot>,
    registry: tauri::State<StudyDeckRegistry>,
    context: Context,
    content: String,
) -> Result<MutationReceipt, String> {
    study_deck_io::write(&vault, &registry, &context, &content)
}

#[tauri::command]
pub(crate) fn discard_study_deck_snapshot(
    registry: tauri::State<StudyDeckRegistry>,
    context: Context,
) -> Result<bool, String> {
    study_deck_io::discard(&registry, &context)
}
