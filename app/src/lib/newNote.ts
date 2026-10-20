// Shared "new note" flow — sidebar "+", folder context menu, command bar and
// the ⌘N shortcut all funnel here. Creation goes through openWikilink so a new
// note inherits the wikilink rules: an existing stem opens instead of erroring,
// a fresh one lands in the given folder, else beside the open note (wiki/ when
// that folder is one myco manages or the vault root, or nothing is open —
// lib/vaultAreas; a template note follows the same rule), and is
// seeded with valid frontmatter by the create_file command — born visible to
// Views and the graph.

import { promptText } from "../stores/dialogStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import type { Strings } from "./i18n";
import { ipc } from "./ipc";
import { requestNoteWriting } from "./noteWriting";
import { newNoteDir } from "./vaultAreas";

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

/** The folder a note made with none given goes in: the open note's, or
 *  undefined for the default (wiki/) — see newNoteDir. */
export function defaultNoteDir(): string | undefined {
  const { route } = useUIStore.getState();
  const open = route.startsWith("page:") ? route.slice("page:".length) : null;
  const root = useVaultStore.getState().currentVault?.path ?? "";
  return newNoteDir(open, root) ?? undefined;
}

/**
 * Create `<dir>/<name>.md` (default: the open note's folder, see newNoteDir,
 * else `<vault>/wiki/`) and route straight into
 * its editor. A duplicate stem resolves to the existing note instead of
 * erroring. Returns the routed path, or null (invalid name / no vault).
 */
export async function createNoteAndOpen(
  rawName: string,
  dir?: string,
): Promise<string | null> {
  const name = sanitizeNoteName(rawName);
  if (!name) return null;
  const path = await useVaultStore.getState().openWikilink(name, dir ?? defaultNoteDir());
  if (path) {
    requestNoteWriting(path);
    useUIStore.getState().setEditorMode("live");
    useUIStore.getState().setRoute(`page:${path}`);
  }
  return path;
}

/** Prompt for a title, then create and open. Returns the opened path, or null
 *  (cancelled / invalid name / no open vault). */
export async function promptNewNote(t: Strings, dir?: string): Promise<string | null> {
  if (!useVaultStore.getState().currentVault) return null;
  const raw = await promptText({
    title: t.sb_new_note ?? "New note",
    message: t.sb_new_note_msg ?? "Note title (.md is added automatically)",
    placeholder: t.sb_new_note_ph ?? "untitled",
  });
  if (!raw) return null;
  return createNoteAndOpen(raw, dir);
}

/** A short note's name: its title, else the first line of its text, cut to
 *  40 characters. Null when neither leaves a usable name. */
export function shortNoteName(title: string, body: string): string | null {
  const first = body.trim().split(/\r?\n/, 1)[0] ?? "";
  return sanitizeNoteName(title) ?? sanitizeNoteName(Array.from(first).slice(0, 40).join(""));
}

/** The line a short note leaves in today's note: its title and its text, so
 *  the title is not lost on the way (the daily note takes one line). */
export function shortDailyLine(title: string, body: string): string {
  return [title.trim(), body.trim()].filter(Boolean).join(" — ");
}

/** Save `body` as a new note named `rawName` and open it (UX S35: a short
 *  note the ingest judge turned away). create_file refuses an existing
 *  file, so the text can never land in, or over, another note — that
 *  rejection reaches the caller. The note keeps the frontmatter create_file
 *  seeds and gets the text under it. */
export async function saveAsNewNote(rawName: string, body: string): Promise<string | null> {
  const vault = useVaultStore.getState().currentVault;
  const name = sanitizeNoteName(rawName);
  if (!vault || !name) return null;
  let dir = defaultNoteDir();
  if (!dir) {
    await ipc.createFolder(vault.path, "wiki").catch(() => undefined);
    dir = `${vault.path}/wiki`;
  }
  const path = await ipc.createFile(dir, `${name}.md`);
  const seeded = (await ipc.readFile(path)).raw;
  const sep = seeded === "" || seeded.endsWith("\n") ? "" : "\n";
  await ipc.writeFile(path, `${seeded}${sep}${body.trim()}\n`);
  await useVaultStore.getState().refreshTree();
  useUIStore.getState().setRoute(`page:${path}`);
  return path;
}
