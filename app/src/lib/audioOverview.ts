// Audio Overview (Feature 5) — script generation + transcript persistence.
// Turns a chosen set of wiki pages into a grounded two-host spoken "deep dive":
// one LLM call over the pages' markdown emits a speaker-tagged dialogue (JSON),
// which we validate/repair, format as a portable transcript, and persist under
// `audio/<slug>-<date>.md`. Playback itself is the browser's speechSynthesis
// (see tts.ts) — offline, no bundled engine, no lock-in. raw/ is never touched.

import { ipc } from "./ipc";
import { complete } from "./chat";
import { extractJsonArray } from "./study";

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
  /** Vault-relative or absolute paths of the source pages. */
  sourcePages: string[];
}

// How much page markdown to feed the script model (chars). Kept modest so the
// bundled offline model's small window survives; cloud providers tolerate more.
const PAGE_BUDGET = 24_000;

const SYSTEM =
  "You are Memex's audio-overview writer. You turn wiki notes into a lively, " +
  "accurate two-host spoken dialogue (Host A interviews Guest B). Every claim " +
  "must come ONLY from the provided notes — no invention. Attach the page the " +
  "claim came from to that turn's cites (copy the [[stem]] header or a [^src-*] " +
  "token). Keep it conversational and about 12–20 turns. Reply with ONLY a JSON " +
  'array of {"speaker":"A"|"B","text":string,"cites":string[]}.';

function stemOf(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, "");
}

/** Concatenate the selected pages' bodies (bounded) with citeable headers. */
export async function assemblePages(
  pagePaths: string[],
  budget = PAGE_BUDGET,
): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  for (const path of pagePaths) {
    const file = await ipc.readFile(path).catch(() => null);
    const text = file?.content?.trim();
    if (!text) continue;
    const block = `===== [[${stemOf(path)}]] =====\n${text}`;
    if (used + block.length > budget && parts.length > 0) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Coerce a raw JSON array into validated dialogue turns. */
export function toTurns(raw: unknown[]): DialogueTurn[] {
  const out: DialogueTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = asStr(o.text);
    if (!text) continue;
    const speaker = asStr(o.speaker).toUpperCase() === "B" ? "B" : "A";
    const cites = Array.isArray(o.cites) ? o.cites.map(asStr).filter(Boolean) : [];
    out.push({ speaker, text, cites });
  }
  return out;
}

/** Generate a two-host dialogue script from the given pages. Retries JSON once;
 *  falls back to a single-narrator summary turn if the model can't produce
 *  valid dialogue, so the caller always gets a usable transcript. */
export async function generateScript(
  vaultPath: string,
  pagePaths: string[],
  title: string,
): Promise<AudioScript> {
  const context = await assemblePages(pagePaths);
  const user =
    `Create the audio-overview dialogue for these notes.\n\nNOTES:\n${context}`;

  let turns: DialogueTurn[] = [];
  for (let attempt = 0; attempt < 2 && turns.length === 0; attempt++) {
    const reply = await complete({
      task: "query",
      cwd: vaultPath,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    });
    const arr = extractJsonArray(reply);
    if (arr) turns = toTurns(arr);
    // Last resort: use the raw reply as a single narrator turn.
    if (turns.length === 0 && attempt === 1 && reply.trim()) {
      turns = [{ speaker: "A", text: reply.trim(), cites: [] }];
    }
  }
  if (turns.length === 0) {
    throw new Error("Could not generate an audio overview from these pages.");
  }
  return { title, turns, sourcePages: pagePaths };
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

/** Persist the transcript under `audio/<slug>-<date>.md`; returns its path. */
export async function saveTranscript(
  vaultPath: string,
  script: AudioScript,
  dateIso: string,
): Promise<string> {
  try {
    await ipc.createFolder(vaultPath, "audio");
  } catch {
    /* already exists */
  }
  const day = dateIso.slice(0, 10);
  const path = `${vaultPath}/audio/${overviewSlug(script.title)}-${day}.md`;
  await ipc.writeFile(path, formatTranscript(script, dateIso));
  return path;
}
