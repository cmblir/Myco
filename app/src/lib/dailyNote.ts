// Daily notes: `daily/YYYY-MM-DD.md`, one per local calendar day. Home, the
// Reader's ‹ › and the sidebar's Today's note open them through here.
// Capturing a line into today's note is the notch's `ipc.captureNote`.

import { setReaderIntent } from "./askLoop";
import { flattenMarkdown, stem } from "./graphData";
import type { Strings } from "./i18n";
import { ipc } from "./ipc";
import { notice } from "./notice";
import { trimToSentence } from "./quoteBullets";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

export function dailyPath(vault: string, isoDay: string): string {
  return `${vault}/daily/${isoDay}.md`;
}

/** A real calendar day in `YYYY-MM-DD`. File names are untrusted: JSC
 *  (WKWebView) gives an Invalid Date for 2026-02-30 and V8 rolls it over to
 *  March, so only a day that round-trips counts. */
function isDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A daily note, vault-relative: `daily/YYYY-MM-DD.md`, or where the weekly
 *  rollup moves a settled day (`daily/archive/<YYYY-Www>/…`). */
export const DAILY_RE = /^daily\/(?:archive\/(?:[^/]+\/)*)?(\d{4})-(\d{2})-(\d{2})\.md$/;

/** The day `path` is the vault's own daily note for, or null for any other
 *  file — a `daily/` folder deeper in the vault is not the one ‹ › step in. */
export function dailyDayOf(path: string, vault: string): string | null {
  if (!path.startsWith(`${vault}/`)) return null;
  const m = DAILY_RE.exec(path.slice(vault.length + 1));
  const day = m ? `${m[1]}-${m[2]}-${m[3]}` : "";
  return isDay(day) ? day : null;
}

/** What capture_note appended (`myco://daily-captured`): Home's ⌘Enter and
 *  the notch write today's note on disk, which may be open in a reader. */
export interface Captured {
  /** Vault-relative daily-note path. */
  rel: string;
  /** The `- HH:MM text` line, without its newline. */
  line: string;
  /** The quote's `[^src-<stem>]: raw/<rel>` definition, when this capture
   *  wrote it after the line (Default 8: once per note). */
  footnote?: string;
}

/** The open draft once capture_note appended `line` (and a quote's
 *  `footnote` definition) to its file, or null when the draft is clean and
 *  should re-read the file instead. A dirty draft's next autosave rewrites
 *  the file, so it has to carry what was written. */
export function draftAfterCapture(
  draft: string,
  dirty: boolean,
  line: string,
  footnote?: string,
): string | null {
  if (!dirty) return null;
  return appendCapture(draft, line, footnote);
}

/** The note's closing footnote definitions, after a blank line. */
const TRAILING_DEFS = /\n\s*\n((?:\[\^[^\]\n]+\]:[^\n]*(?:\n\s*|$))+)$/;

/** `text` with `line` appended above its closing footnote definitions, which
 *  stay at the bottom (a new `footnote` joins them): capture_note's
 *  append_capture, for a draft and the mock. */
export function appendCapture(text: string, line: string, footnote?: string): string {
  const m = TRAILING_DEFS.exec(text);
  const head = m ? text.slice(0, m.index) : text;
  const defs = [...(m ? m[1].trimEnd().split(/\n\s*/) : []), ...(footnote ? [footnote] : [])];
  const sep = head === "" || head.endsWith("\n") ? "" : "\n";
  return `${head}${sep}${line}\n${defs.length ? `\n${defs.join("\n")}\n` : ""}`;
}

/** capture_note joins all whitespace into one line, so the Home box that
 *  feeds it never holds a line break: what it shows is what gets saved. */
export function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/** The line an abstained question goes into today's note as ("질문: …"):
 *  the question alone, never an answer. The function replacer keeps `$&`
 *  and the like in the question literal. */
export function questionLine(q: string, t: Pick<Strings, "q_abstain_note_line">): string {
  return t.q_abstain_note_line.replace("{q}", () => oneLine(q).trim());
}

/** Longest quote taken from one selection; capture_note refuses 4 KiB, and a
 *  quote is a sentence or two, not the page. Picked, not measured. */
const MAX_QUOTE = 500;

/** The line a selection in a raw/ original goes into today's note as (S41):
 *  the selected words on one line, citing the original as `[^src-<stem>]` —
 *  the form provenance and Sources resolve to raw/<stem>.*. Null when there is
 *  nothing to quote, or the file name cannot be a footnote label (the same
 *  `[\w-]+` the wiki lint accepts), since that would cite nothing. */
export function quoteLine(selection: string, rawPath: string): string | null {
  const text = oneLine(selection).replace(/\s+/g, " ").trim();
  const name = stem(rawPath);
  if (!text || !/^[\p{L}\p{N}_-]+$/u.test(name)) return null;
  return `${trimToSentence(text, MAX_QUOTE)} [^src-${name}]`;
}

/** One quote line per block of a selection (S41's card path): blocks come
 *  apart at a blank line (PageReader's selectedProse ends each with one), so
 *  a cloze is never one run-on sentence made of two list items, while a
 *  paragraph wrapped over source lines (a single newline) stays whole. */
export function quoteBlocks(selection: string, rawPath: string): string[] {
  return selection
    .split(/\n\s*\n/)
    .map((block) => quoteLine(block, rawPath))
    .filter((line): line is string => line !== null);
}

/** `isoDay` moved by `delta` days. Calendar arithmetic in UTC, so a DST
 *  change in the local zone can never skip or repeat a day. */
export function shiftDay(isoDay: string, delta: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Open the day's note — `daily/<isoDay>.md`, else the one the weekly rollup
 *  archived — creating `daily/<isoDay>.md` only when the day has neither. */
export async function openDailyNote(vault: string, isoDay: string): Promise<void> {
  // 9999-12-31's Tomorrow is "+010000-01": never a file name.
  if (!isDay(isoDay)) return;
  const filePath = dailyPath(vault, isoDay);
  try {
    await ipc.readFile(filePath);
  } catch {
    const archived = flattenMarkdown(useVaultStore.getState().fileTree).find(
      (p) => p !== filePath && dailyDayOf(p, vault) === isoDay,
    );
    if (archived) {
      useUIStore.getState().setRoute(`page:${archived}`);
      return;
    }
    try {
      await ipc.createFolder(vault, "daily");
    } catch {
      /* exists */
    }
    try {
      // create_file refuses an existing file, so a read that failed for any
      // other reason never becomes a write over the user's note.
      await ipc.createFile(`${vault}/daily`, `${isoDay}.md`);
      await ipc.writeFile(filePath, `# ${isoDay}\n\n`);
    } catch {
      /* race */
    }
    await useVaultStore.getState().refreshTree();
  }
  useUIStore.getState().setRoute(`page:${filePath}`);
}

/** Open the note a capture went into on the line it wrote, scrolled to and
 *  lit: a busy day's newest line is below the first screen. Only this
 *  vault's daily note, as the receipt may come from another webview; false
 *  for anything else. */
export function openCaptured(vault: string, { rel, line }: Captured): boolean {
  const day = dailyDayOf(`${vault}/${rel}`, vault);
  if (!day) return false;
  if (typeof line === "string")
    setReaderIntent(`${vault}/${rel}`, { kind: "show", section: null, quote: line });
  void openDailyNote(vault, day);
  return true;
}

/** A capture that went to `_inbox/` (a voice note, a web clip): open that
 *  file. The path may come from another webview, so only a file directly in
 *  this vault's `_inbox/` opens; false for anything else. */
export function openInboxDoc(vault: string, rel: unknown): boolean {
  if (!isInboxDoc(rel)) return false;
  useUIStore.getState().setRoute(`page:${vault}/${rel}`);
  return true;
}

function isInboxDoc(rel: unknown): rel is string {
  return typeof rel === "string" && /^_inbox\/[^/\\]+\.md$/.test(rel) && !rel.includes("..");
}

/** The web clip's in-app receipt (`myco://clip-saved` from the deep-link
 *  handler): where it went and what happens next, the voice chip's words,
 *  with an Open. The OS notification only says that it was clipped. */
export function clipReceipt(
  saved: { rel?: unknown; title?: unknown } | null | undefined,
  t: Pick<Strings, "capture_inbox_receipt" | "home_open_daily">,
): void {
  const vault = useVaultStore.getState().currentVault?.path;
  const rel = saved?.rel;
  if (!vault || !isInboxDoc(rel)) return;
  notice.ok(t.capture_inbox_receipt.replace("{rel}", rel), {
    sub: typeof saved?.title === "string" ? saved.title : undefined,
    action: { label: t.home_open_daily, run: () => void openInboxDoc(vault, rel) },
  });
}

/** Append `line` to today's note through capture_note, then say so: the ok
 *  toast's Open goes to the note capture_note named, on the `- HH:MM` line
 *  it wrote. `source` is the vault-relative raw/ original a quote cites, so
 *  the note gets its footnote definition. Resolves to what was written, null
 *  when nothing was. */
export async function captureToDaily(
  line: string,
  t: Pick<Strings, "home_captured" | "home_capture_failed" | "home_open_daily">,
  source?: string,
): Promise<Captured | null> {
  const vault = useVaultStore.getState().currentVault?.path;
  let written: Captured;
  try {
    written = await ipc.captureNote(line, source);
  } catch (e) {
    notice.warn(t.home_capture_failed, { sub: String(e) });
    return null;
  }
  const day = vault ? dailyDayOf(`${vault}/${written.rel}`, vault) : null;
  notice.ok(
    t.home_captured,
    vault && day
      ? { action: { label: t.home_open_daily, run: () => void openCaptured(vault, written) } }
      : undefined,
  );
  void useVaultStore.getState().refreshTree();
  return written;
}
