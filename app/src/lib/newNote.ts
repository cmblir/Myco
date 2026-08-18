// Shared "new note" flow — sidebar "+", folder context menu, command bar and
// the ⌘N shortcut all funnel here. Creation goes through openWikilink so a new
// note inherits the wikilink rules: an existing stem opens instead of erroring,
// a fresh one lands in wiki/ (or the given folder) and is seeded with valid
// frontmatter by the create_file command — born visible to Views and the graph.

import { promptText } from "../stores/dialogStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import type { Strings } from "./i18n";

/**
 * Trim, drop a typed ".md" (it is re-added on create), fold path separators to
 * "-", and strip leading dots (no hidden files). Unicode passes through —
 * Korean titles are the norm. Returns null when nothing usable remains.
 */
export function sanitizeNoteName(raw: string): string | null {
  const s = raw
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[\\/]/g, "-")
    .replace(/^\.+/, "")
    .trim();
  return s.length > 0 ? s : null;
}

/**
 * Create `<dir>/<name>.md` (default: `<vault>/wiki/`) and route straight into
 * its editor. A duplicate stem resolves to the existing note instead of
 * erroring. Returns the routed path, or null (invalid name / no vault).
 */
export async function createNoteAndOpen(
  rawName: string,
  dir?: string,
): Promise<string | null> {
  const name = sanitizeNoteName(rawName);
  if (!name) return null;
  const path = await useVaultStore.getState().openWikilink(name, dir);
  if (path) useUIStore.getState().setRoute(`page:${path}`);
  return path;
}

/** Prompt for a title, then create and open. No-op without an open vault. */
export async function promptNewNote(t: Strings, dir?: string): Promise<void> {
  if (!useVaultStore.getState().currentVault) return;
  const raw = await promptText({
    title: t.sb_new_note ?? "New note",
    message: t.sb_new_note_msg ?? "Note title (.md is added automatically)",
    placeholder: t.sb_new_note_ph ?? "untitled",
  });
  if (!raw) return;
  await createNoteAndOpen(raw, dir);
}
