// First-run wizard rules (M10, reshaped to three steps by UX S18). Kept out of
// the component so what decides when a step may be left is testable in the
// node-only vitest env.

import type { ReindexStage } from "../stores/reindexStore";
import { sanitizeNoteName } from "./newNote";

/** Choose a folder → write or load a first note → ask one question about it.
 *  Session import and vault history are not steps: a new user had to answer
 *  them before writing anything, so they wait on Home (HomeGuide) instead. */
export const WIZARD_STEPS = 3;

/**
 * Whether `step` may be left (Next), or for the last step whether its Ask
 * may run. Step 2 waits while the first index builds — asking before it
 * exists answers from nothing — but unlocks on error as well as done: the
 * wizard must never become a trap between a broken step and the app.
 */
export function wizardStepReady(
  step: number,
  reindexStage: ReindexStage,
  hasVault: boolean,
): boolean {
  if (step === 0) return hasVault;
  if (step === 2) return reindexStage !== "loading-model" && reindexStage !== "indexing";
  return true;
}

/**
 * Which button is the step's one primary: its own action ("action" — Choose
 * a folder, Ask it) until that is done, then Next. Step 1's Next is its
 * action: it saves the note. Two filled buttons per step read as two main
 * actions, so the wizard styles and focuses exactly this one.
 */
export function wizardPrimary(step: number, hasVault: boolean): "action" | "next" {
  if (step === 0) return hasVault ? "next" : "action";
  if (step === 1) return "next";
  return "action";
}

/** A long first line still titles the note, cut to this many characters. */
const TITLE_MAX = 40;

/**
 * The first note from what was typed or loaded into the wizard's box. A
 * loaded file is titled by its name and keeps all its text; a typed note is
 * titled by its first line, which then leaves the body (the page heading
 * already says it) unless it was too long to be a title. Null for an empty
 * box: Next then goes on without a note.
 */
export function firstNoteDraft(
  text: string,
  fileName: string | null,
  fallbackTitle: string,
): { title: string; body: string } | null {
  const all = text.trim();
  if (!all) return null;
  if (fileName) {
    return { title: sanitizeNoteName(fileName.replace(/\.[^.]+$/, "")) ?? fallbackTitle, body: all };
  }
  const [first, ...rest] = all.split("\n");
  const line = first.replace(/^#+\s*/, "").trim();
  if (line.length <= TITLE_MAX) {
    return { title: sanitizeNoteName(line) ?? fallbackTitle, body: rest.join("\n").trim() };
  }
  return { title: sanitizeNoteName(line.slice(0, TITLE_MAX)) ?? fallbackTitle, body: all };
}

/** The note the wizard's note step wrote: where, its title, the frontmatter
 *  and heading create_file seeded, and the text it holds. */
export interface FirstNote {
  path: string;
  title: string;
  head: string;
  text: string;
}

/** The vault calls writing the first note takes (lib/ipc's, in the app). */
export interface NoteIo {
  createFile(parent: string, name: string): Promise<string>;
  readFile(path: string): Promise<{ raw: string }>;
  writeFile(path: string, content: string): Promise<unknown>;
  renamePath(from: string, toName: string): Promise<string>;
}

/**
 * Write the first note: `<wikiDir>/<title>.md` through create_file (which
 * seeds the frontmatter and heading, and refuses to overwrite), then the body
 * under that heading. Back and Next again rewrites the note `saved` made
 * rather than making a second one; a first line edited meanwhile renames it
 * and retitles its heading. The title leaves the body, so keeping the old
 * name would drop the line the user typed.
 */
export async function writeFirstNote(
  io: NoteIo,
  wikiDir: string,
  draft: { title: string; body: string },
  saved: FirstNote | null,
  text: string,
): Promise<FirstNote> {
  let note = saved;
  if (!note) {
    const path = await io.createFile(wikiDir, `${draft.title}.md`);
    note = { path, title: draft.title, head: (await io.readFile(path)).raw, text };
  } else if (note.title !== draft.title) {
    const path = await io.renamePath(note.path, `${draft.title}.md`);
    // create_file's heading is the stem with - and _ read as spaces.
    const heading = `# ${draft.title.replace(/[-_]/g, " ")}`;
    note = { path, title: draft.title, head: note.head.replace(/^# .*$/m, () => heading), text };
  }
  if (draft.body || saved) {
    await io.writeFile(note.path, draft.body ? `${note.head.trimEnd()}\n\n${draft.body}\n` : note.head);
  }
  return { ...note, text };
}

/** Whether Escape skips the wizard (it is Skip's key): not on the note step
 *  while its box holds text that is not saved yet, where one stray key would
 *  throw the user's first note away. The Skip button still leaves. */
export function escapeSkips(step: number, text: string, savedText: string | null): boolean {
  return !(step === 1 && text.trim() !== "" && text !== savedText);
}

/**
 * Whether the wizard shows. The first-run test is "no pages yet", and the
 * note step makes the first page — so once open, the wizard stays until it
 * is finished or skipped instead of vanishing before its question.
 */
export function keepWizardOpen(wasOpen: boolean, firstRun: boolean, onboarded: boolean): boolean {
  return !onboarded && (wasOpen || firstRun);
}

/** "1" — offered by a finished wizard; "0" — dismissed for good. */
const HOME_GUIDE_KEY = "myco.homeGuide";

function readGuide(): string | null {
  try {
    return localStorage.getItem(HOME_GUIDE_KEY);
  } catch {
    return null;
  }
}

const guideListeners = new Set<() => void>();

function writeGuide(v: string): void {
  try {
    localStorage.setItem(HOME_GUIDE_KEY, v);
  } catch {
    /* storage unavailable: the card simply does not show */
  }
  guideListeners.forEach((fn) => fn());
}

/** For useSyncExternalStore: Home sits behind the wizard, already mounted,
 *  when the wizard's close offers the card. */
export function subscribeHomeGuide(fn: () => void): () => void {
  guideListeners.add(fn);
  return () => guideListeners.delete(fn);
}

/** Called when onboarding ends: Home then shows its guide card. */
export function offerHomeGuide(): void {
  if (readGuide() !== "0") writeGuide("1");
}

export function homeGuideOffered(): boolean {
  return readGuide() === "1";
}

export function dismissHomeGuide(): void {
  writeGuide("0");
}
