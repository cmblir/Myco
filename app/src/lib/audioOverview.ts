// Audio Overview (Feature 5) — script generation + transcript persistence.
// Turns a chosen set of wiki pages into a grounded two-host spoken "deep dive":
// a native source job emits a speaker-tagged dialogue, validates/repairs it,
// and conditionally persists its private draft under
// `audio/<slug>-<date>.md`. Playback itself is the browser's speechSynthesis
// (see tts.ts) — offline, no bundled engine, no lock-in. raw/ is never touched.

import { ipc } from "./ipc";
import type {
  AgentVaultSession,
  AudioOverviewCoverage,
  AudioOverviewDraft,
  AudioOverviewDraftContext,
  AudioOverviewJobContext,
  AudioOverviewPublication,
} from "./ipc";
import { log } from "./log";

/** One spoken turn in the two-host dialogue. */
export interface DialogueTurn {
  /** "A" (host) or "B" (guest). */
  speaker: "A" | "B";
  text: string;
  /** Page citations for this turn, e.g. ["[[attention-mechanism]]"]. */
  cites: string[];
}

export interface AudioScript {
  title: string;
  turns: DialogueTurn[];
  /** Only native-admitted bodies actually included in the model input. */
  sourcePages: string[];
  context?: AudioOverviewDraftContext;
  coverage?: Pick<AudioOverviewCoverage, "selectedPages" | "includedPages" | "omittedPages">;
}

export interface AudioGenerationLifecycle {
  isCurrent: () => boolean;
  onJob: (context: AudioOverviewJobContext) => void;
}

export type AudioOverviewFailure =
  | "stale"
  | "source"
  | "generation"
  | "publication"
  | "partial"
  | "cancellation";

/** Static failures never expose a native provider response or private source. */
export class AudioOverviewError extends Error {
  constructor(
    readonly code: AudioOverviewFailure,
    readonly retainedPath?: string,
    readonly cancellationUnconfirmed = false,
  ) {
    super({
      stale: "The active vault changed before audio execution.",
      source: "Audio source admission failed. Check the selected saved notes and retry.",
      generation: "The model did not return a valid audio dialogue. Try again.",
      publication: "Audio transcript publication could not be confirmed.",
      partial: "The audio transcript is retained, but publication is incomplete.",
      cancellation: "Audio cancellation could not be confirmed.",
    }[code]);
    this.name = "AudioOverviewError";
  }
}

// How much page markdown to feed the script model (chars). Kept modest so the
// bundled offline model's small window survives; cloud providers tolerate more.
const PAGE_BUDGET = 24_000;

function stemOf(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, "");
}

/** Concatenate selected page bodies, rejecting read failures and empty input. */
export async function assemblePages(
  pagePaths: string[],
  budget = PAGE_BUDGET,
): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  for (const path of pagePaths) {
    const file = await ipc.readFile(path);
    const text = file?.content?.trim();
    if (!text) continue;
    const block = `===== [[${stemOf(path)}]] =====\n${text}`;
    if (used + block.length > budget && parts.length > 0) break;
    parts.push(block);
    used += block.length;
  }
  if (parts.length === 0) {
    throw new Error(
      "No non-empty source pages are available for the audio overview.",
    );
  }
  return parts.join("\n\n");
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Coerce a raw JSON array into non-empty, normalized dialogue turns. */
export function toTurns(raw: unknown[]): DialogueTurn[] {
  const out: DialogueTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = asStr(o.text);
    if (!text) continue;
    const speaker = asStr(o.speaker).toUpperCase() === "B" ? "B" : "A";
    const cites = Array.isArray(o.cites)
      ? o.cites.map(asStr).filter(Boolean)
      : [];
    out.push({ speaker, text, cites });
  }
  return out;
}

function sameOrigin(left: AgentVaultSession, right: AgentVaultSession): boolean {
  return left?.vaultPath === right?.vaultPath && left?.openingToken === right?.openingToken;
}

function isJob(context: AudioOverviewJobContext | undefined): context is AudioOverviewJobContext {
  return !!context && typeof context.jobId === "string" && !!context.jobId &&
    typeof context.origin?.vaultPath === "string" && !!context.origin.vaultPath &&
    typeof context.origin.openingToken === "string" && !!context.origin.openingToken;
}

function sameJob(left: AudioOverviewJobContext, right: AudioOverviewJobContext): boolean {
  return left.jobId === right.jobId && sameOrigin(left.origin, right.origin);
}

function isPaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((path) => typeof path === "string" && !!path);
}

function equalPaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function validateDraft(draft: AudioOverviewDraft, job: AudioOverviewJobContext, selected: string[]): void {
  const coverage = draft?.coverage;
  if (!draft || typeof draft.title !== "string" || !isJob(draft.context) ||
    !sameJob(draft.context, job) || typeof draft.context.draftId !== "string" || !draft.context.draftId ||
    !Array.isArray(draft.turns) || draft.turns.length === 0 || draft.turns.some((turn) =>
      !turn || !["A", "B"].includes(turn.speaker) || typeof turn.text !== "string" || !turn.text.trim() ||
      !Array.isArray(turn.cites) || turn.cites.some((cite) => typeof cite !== "string")) ||
    !isPaths(draft.sourcePages) || !coverage || !isPaths(coverage.selectedPages) ||
    !isPaths(coverage.includedPages) || !isPaths(coverage.omittedPages) ||
    !equalPaths(coverage.selectedPages, selected) || !equalPaths(draft.sourcePages, coverage.includedPages) ||
    coverage.includedPages.length === 0 ||
    coverage.includedPages.length + coverage.omittedPages.length !== selected.length ||
    [...coverage.includedPages, ...coverage.omittedPages].some((path) => !selected.includes(path)) ||
    new Set([...coverage.includedPages, ...coverage.omittedPages]).size !== selected.length) {
    throw new AudioOverviewError("generation");
  }
}

const cancellations = new WeakMap<AudioOverviewJobContext, Promise<void>>();

/** Cancel only this native job, including a begin returned after an opening changed. */
export function cancelAudioOverview(context: AudioOverviewJobContext): Promise<void> {
  const previous = cancellations.get(context);
  if (previous) return previous;
  const cancellation = (async () => {
    try {
      const acknowledged = await ipc.audioOverviewCancel(context);
      if (acknowledged !== true) throw new Error("Unconfirmed Audio cancellation acknowledgement");
    } catch {
      log.warn("audio.cancel_unconfirmed");
      throw new AudioOverviewError("cancellation");
    }
  })();
  cancellations.set(context, cancellation);
  return cancellation;
}

/** Native owns source reads, the captured Audio grant, and both format attempts. */
export async function generateScript(
  vaultPath: string,
  pagePaths: string[],
  title: string,
  lifecycle?: AudioGenerationLifecycle,
): Promise<AudioOverviewDraft> {
  const sourcePages = [...pagePaths];
  if (lifecycle && !lifecycle.isCurrent()) throw new AudioOverviewError("stale");
  let origin: AgentVaultSession;
  try {
    origin = Object.freeze({ ...await ipc.agentVaultSession() });
  } catch {
    throw new AudioOverviewError("source");
  }
  if (origin.vaultPath !== vaultPath || !origin.openingToken || (lifecycle && !lifecycle.isCurrent())) {
    throw new AudioOverviewError("stale");
  }
  let job: AudioOverviewJobContext;
  try {
    job = await ipc.audioOverviewBegin(origin, sourcePages, title, new Date().toISOString());
  } catch {
    throw new AudioOverviewError("source");
  }
  if (!isJob(job) || !sameOrigin(job.origin, origin)) throw new AudioOverviewError("source");
  job = Object.freeze({ jobId: job.jobId, origin });
  try {
    // Registration must precede the stale check: a reset during begin still
    // needs the returned exact capability to release the old native job.
    lifecycle?.onJob(job);
    if (lifecycle && !lifecycle.isCurrent()) throw new AudioOverviewError("stale");
    let draft: AudioOverviewDraft;
    try {
      draft = await ipc.audioOverviewGenerate(job);
    } catch {
      throw new AudioOverviewError("generation");
    }
    if (lifecycle && !lifecycle.isCurrent()) throw new AudioOverviewError("stale");
    validateDraft(draft, job, sourcePages);
    return draft;
  } catch (error) {
    let cancellationUnconfirmed = false;
    try {
      await cancelAudioOverview(job);
    } catch {
      cancellationUnconfirmed = true;
    }
    if (error instanceof AudioOverviewError) {
      if (!cancellationUnconfirmed) throw error;
      throw new AudioOverviewError(error.code, error.retainedPath, true);
    }
    throw new AudioOverviewError("generation", undefined, cancellationUnconfirmed);
  }
}

/** Format a script as a portable, speaker-tagged transcript markdown file. */
export function formatTranscript(script: AudioScript, dateIso: string): string {
  const lines: string[] = [
    `# Audio Overview — ${script.title}`,
    "",
    `> Generated ${dateIso} · two-host deep dive`,
    "",
    "## Sources",
    ...script.sourcePages.map((p) => `- [[${stemOf(p)}]]`),
    "",
    "## Transcript",
    "",
  ];
  for (const turn of script.turns) {
    const host = turn.speaker === "A" ? "Host" : "Guest";
    const cites = turn.cites.length ? ` ${turn.cites.join(" ")}` : "";
    lines.push(`**${host}:** ${turn.text}${cites}`, "");
  }
  return lines.join("\n");
}

export function overviewSlug(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "overview"
  );
}

/** Publish the native draft; caller text and dates cannot retarget its output. */
export async function saveTranscript(
  vaultPath: string,
  script: AudioScript,
  _dateIso: string,
): Promise<string> {
  const context = script.context;
  if (!isJob(context) || context.origin.vaultPath !== vaultPath ||
    typeof context.draftId !== "string" || !context.draftId) {
    throw new AudioOverviewError("publication");
  }
  let receipt: AudioOverviewPublication;
  try {
    receipt = await ipc.audioOverviewPublish(context);
  } catch {
    throw new AudioOverviewError("publication");
  }
  const prefix = `${vaultPath.replace(/\\/g, "/").replace(/\/$/, "")}/audio/`;
  const normalizedPath = typeof receipt?.path === "string" ? receipt.path.replace(/\\/g, "/") : "";
  const filename = normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : "";
  if (!receipt || !sameJob(receipt, context) || receipt.draftId !== context.draftId ||
    normalizedPath.split("/").some((segment) => segment === "." || segment === "..") ||
    !filename || filename.includes("/") || filename === ".md" || !filename.endsWith(".md") ||
    (receipt.state !== "persisted" && receipt.state !== "partial")) {
    throw new AudioOverviewError("publication");
  }
  if (receipt.state === "partial") {
    throw new AudioOverviewError("partial", receipt.path);
  }
  if (typeof receipt.revision !== "string" || !/^[a-f0-9]{64}$/i.test(receipt.revision) || receipt.error !== null) {
    throw new AudioOverviewError("publication");
  }
  return receipt.path;
}
