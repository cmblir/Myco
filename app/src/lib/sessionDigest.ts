// Session daily-digest (Phase B, Task 2). Collapses each day's raw agent
// session logs into a handful of markdown bullets appended to daily/<day>.md,
// then archives the source logs to the cold tier via ipc.archiveDigestedSessions
// (Phase B, Task 1) — this is the step that actually shrinks the active index,
// unlike Task 1's read-only bookkeeping.

import { ipc } from "./ipc";
import { complete, getActiveModel } from "./chat";

export interface DigestOutcome {
  daysDigested: number;
  filesArchived: number;
  skipped: "nothing" | null;
  /** How this run produced its bullets: an LLM summary, or (builtin-local,
   *  which has no generative model) extractive quotes ranked by embedding.
   *  A marker-guarded day digested one way is never re-digested the other. */
  mode: "llm" | "extractive";
}

export const DIGEST_SYSTEM =
  "Extract only decisions, facts and outcomes from these agent session logs. " +
  "Output 3-10 markdown bullets. No preamble. These are machine logs: mark " +
  "uncertain items with '(uncertain)'.";

// Cheap guard against a pathological day (many/huge session files) blowing
// the prompt budget — not a token-accurate count, just a char ceiling shared
// across the day's files so the total stays roughly bounded regardless of
// how many files landed on that day.
const MAX_DAY_CHARS = 60_000;

// Digest section header. Must differ from Rust's "## Distill summary (auto)"
// (Task 1, the summary tier) — this is a separate section in the same file.
const HEADER = "## Session digest (auto)";

// Machine-readable record of WHICH session files a digest section covers,
// written into the same daily/<day>.md write as the bullets themselves — so
// there is no window where the digest is durable but the record isn't, and a
// crash can never re-charge the LLM for work already on disk.
// Parsed by distill.rs's digested_session_entries (DIGEST_MARKER_OPEN /
// DIGEST_MARKER_CLOSE); keep the literals in lockstep. Anchored on the FILES,
// not the day: session_day derives the day from frontmatter/mtime, so the same
// file can bucket into a different day on a later run.
const MARKER_OPEN = "<!-- myco:digested-sessions ";
const MARKER_CLOSE = " -->";

/** FNV-1a (32-bit) over `text`'s UTF-8 bytes, as 8 lowercase hex chars. Must
 * stay byte-identical to distill.rs's `content_fingerprint`, which reads back
 * what this writes. Not a cryptographic hash — it only has to notice that a
 * session file changed since it was digested. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h = Math.imul(h ^ b, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// `<stem>:<fingerprint>` per file. The stem alone is the CONVERSATION id and
// survives a re-import unchanged, so a conversation the user resumed would
// match its own earlier record and be archived without ever being digested;
// binding the record to the content makes the grown file a miss. Accepted
// trade: that file is then digested in full, duplicating its earlier turns in
// a later daily note — cheaper than losing the new half of a conversation.
function digestMarker(files: string[], fingerprints: string[]): string {
  const entries = files.map(
    (f, i) => (f.split("/").pop() ?? f).replace(/\.md$/, "") + ":" + fingerprints[i],
  );
  return MARKER_OPEN + entries.join(" ") + MARKER_CLOSE;
}

// Fallback llm_digest_days when getDistillConfig is unavailable — mirrors
// DistillConfig's Rust-side default.
const DEFAULT_DIGEST_DAYS = 3;

// ---------------------------------------------------------------------------
// Extractive digest (builtin-local). No generative model is bundled (bge-m3
// embeds only; Ask quotes notes verbatim), so instead of skipping the day the
// digest quotes it: split the day's session docs into speaker turns, embed
// them locally, rank by cosine to the day centroid with MMR diversity, and
// emit the top picks as quoted bullets. Deterministic given the same inputs —
// the embedder is, and MMR ties break to document order.
// ---------------------------------------------------------------------------

// Embedding-batch cap per day: bounds local embed time the way MAX_DAY_CHARS
// bounds the LLM prompt. Candidates keep document order, so the cap drops the
// tail of the day, mirroring buildDayPrompt's omission behaviour.
const MAX_UNITS = 48;
// Drops "ok"/"thanks" turns that could never carry a decision or outcome.
const MIN_UNIT_CHARS = 40;
// Per-unit slice for embedding and quoting — a turn can be pages long.
const UNIT_CHARS = 600;
// Rendered per-bullet cap.
const BULLET_CHARS = 200;
const MAX_BULLETS = 8;
// MMR relevance/diversity trade-off. 0.6 (not the textbook 0.7) so an exact
// duplicate of an already-picked quote always loses to a distinct one.
const MMR_LAMBDA = 0.6;

interface QuoteUnit {
  text: string;
  stem: string;
}

/** Split one session doc into candidate quote units. Importer-written docs
 * (importers/mod.rs `to_inbox_doc`) delimit turns with `**Role:**` headers;
 * hand-placed files without them fall back to blank-line paragraphs. */
function splitTurns(doc: string): string[] {
  let body = doc;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end >= 0) body = body.slice(end + 5);
  }
  const turns = body.split(/^\*\*(?:User|Assistant|System|Tool):\*\*\s*$/m);
  return turns.length > 1 ? turns.slice(1) : body.split(/\n{2,}/);
}

function candidateUnits(files: string[], contents: string[]): QuoteUnit[] {
  const units: QuoteUnit[] = [];
  for (let i = 0; i < files.length && units.length < MAX_UNITS; i++) {
    const stem = (files[i].split("/").pop() ?? files[i]).replace(/\.md$/, "");
    for (const turn of splitTurns(contents[i])) {
      if (units.length >= MAX_UNITS) break;
      // Collapse to one line — these render inside a single markdown bullet.
      const text = turn.replace(/\s+/g, " ").trim();
      if (text.length < MIN_UNIT_CHARS) continue;
      units.push({ text: text.slice(0, UNIT_CHARS), stem });
    }
  }
  return units;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Indices of up to `k` vectors, MMR-selected against the (unnormalized)
 * centroid: score = λ·cos(v, centroid) − (1−λ)·max cos(v, picked). Ties break
 * to the lowest index, i.e. document order — that is what makes the whole
 * digest deterministic. Exported for its own test. */
export function mmrSelect(vectors: number[][], k: number, lambda = MMR_LAMBDA): number[] {
  if (vectors.length === 0) return [];
  // Sum, not mean: cosine is scale-invariant, so dividing by n changes nothing.
  const centroid = new Array(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < v.length; i++) centroid[i] += v[i];
  const rel = vectors.map((v) => cosine(v, centroid));
  const picked: number[] = [];
  while (picked.length < Math.min(k, vectors.length)) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < vectors.length; i++) {
      if (picked.includes(i)) continue;
      let div = 0;
      for (const j of picked) div = Math.max(div, cosine(vectors[i], vectors[j]));
      const score = lambda * rel[i] - (1 - lambda) * div;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    picked.push(best);
  }
  return picked;
}

/** The extractive counterpart of the day's `complete()` call: quoted bullets,
 * `- "<quote>" — <session stem>`, top MAX_BULLETS by centroid+MMR. */
async function extractiveBullets(files: string[], contents: string[]): Promise<string> {
  const units = candidateUnits(files, contents);
  // A day of blank/trivial files still deserves a section — the marker in the
  // same write is what stops it being re-offered forever.
  if (units.length === 0) return "- (no quotable content)";
  const vectors = await ipc.embedLocalTexts(units.map((u) => u.text));
  return mmrSelect(vectors, MAX_BULLETS)
    .map((i) => {
      const u = units[i];
      const text =
        u.text.length > BULLET_CHARS ? `${u.text.slice(0, BULLET_CHARS).trimEnd()}…` : u.text;
      return `- "${text}" — ${u.stem}`;
    })
    .join("\n");
}

function buildDayPrompt(files: string[], contents: string[]): string {
  let out = "";
  let i = 0;
  for (; i < files.length; i++) {
    const remaining = MAX_DAY_CHARS - out.length;
    if (remaining <= 0) break;
    const name = files[i].split("/").pop() ?? files[i];
    const header = `### ${name}\n`;
    out += header + contents[i].slice(0, Math.max(0, remaining - header.length)) + "\n\n";
  }
  // Files that never made it into the pool must say so — otherwise the model
  // digests a partial day and has no way to signal it isn't the whole thing.
  const omitted = files.length - i;
  if (omitted > 0) {
    out += `…(${omitted} more session logs omitted for length)\n`;
  }
  return out;
}

/** Read-or-empty + append, following Sidebar's DailyNoteButton idiom. Avoids
 * duplicating the header on repeat runs the same day: a second run appends
 * its bullets under a "_run of <ISO date>_" sub-line instead. Returns
 * whether this call created `daily/<day>.md` (vs. appending to one that
 * already existed) — the caller only needs to record a manifest `created`
 * entry (Important 4, Phase B whole-branch review) in the former case; an
 * appended-to-existing file was already visible to undo/the run report
 * before this run touched it. */
async function appendDigest(
  vaultPath: string,
  day: string,
  bullets: string,
  files: string[],
  fingerprints: string[],
  extractive: boolean,
): Promise<boolean> {
  const filePath = `${vaultPath}/daily/${day}.md`;
  // Blank counts as missing: an earlier crash could leave a zero-byte
  // daily/<day>.md that reads back fine, and the retry would then skip the
  // only place that seeds the title and sets `created` — producing an
  // untitled daily note whose content undo never hears about. There is no
  // separate create step any more; writeFile is tmpfile+fsync+rename and
  // creates the file itself, so the window that made the blank file is gone.
  const existingRaw = await ipc
    .readFile(filePath)
    .then((f) => f.raw)
    .catch(() => "");
  const created = existingRaw.trim() === "";
  if (created) {
    try {
      await ipc.createFolder(vaultPath, "daily");
    } catch {
      /* already exists */
    }
  }
  const existing = created ? `# ${day}\n\n` : existingRaw;
  const marker = digestMarker(files, fingerprints);
  // The HEADER itself never changes (distill.rs and repeat-run detection key
  // on it) — extractive runs are labeled in the sub-line instead.
  const label = extractive
    ? `_from ${files.length} session logs — extractive quotes (no LLM)_`
    : `_from ${files.length} session logs — low confidence_`;
  const runLine = extractive
    ? `_run of ${new Date().toISOString()} (extractive)_`
    : `_run of ${new Date().toISOString()}_`;
  const section = existing.includes(HEADER)
    ? `\n${runLine}\n${marker}\n${bullets.trim()}\n`
    : `\n${HEADER}\n${label}\n${marker}\n${bullets.trim()}\n`;
  // One atomic write (vault::write_file is tmpfile+fsync+rename) carrying both
  // the digest text and the record of what it covers.
  await ipc.writeFile(filePath, existing + section);
  return created;
}

/** Digests up to `llm_digest_days` of the oldest digestable session-log days
 * into daily/<day>.md, one LLM call per day, then archives the source files
 * to the cold tier. Stops at the first day that errors (logged, not thrown)
 * so a bad day never gets archived — everything before it still did. */
export async function runSessionDigest(vaultPath: string): Promise<DigestOutcome> {
  const { provider } = await getActiveModel("query");
  // builtin-local used to skip here ("no-provider") — it now digests
  // extractively instead: quotes ranked by the bundled embedder, no LLM call.
  // Everything else (marker, manifest, archive) is the same machinery.
  const extractive = provider === "builtin-local";
  const mode = extractive ? ("extractive" as const) : ("llm" as const);

  const cfg = await ipc.getDistillConfig(vaultPath).catch(() => null);
  const digestDays = cfg?.llm_digest_days ?? DEFAULT_DIGEST_DAYS;
  const days = (await ipc.digestableSessionDays(vaultPath)).slice(0, digestDays);
  if (days.length === 0) {
    return { daysDigested: 0, filesArchived: 0, skipped: "nothing", mode };
  }

  let daysDigested = 0;
  let filesArchived = 0;
  for (const { day, files, already_digested } of days) {
    try {
      if (already_digested) {
        // Retry: a prior run's appendDigest already put these exact files'
        // digest in daily/<day>.md (its marker names them, which is how Rust
        // set this flag) but archiveDigestedSessions failed afterward — only
        // the file move needs retrying, never the LLM call or a second append.
        // No fingerprints of our own to hand over — the marker that run wrote
        // is the record, and Rust re-checks each file against it.
        await ipc.archiveDigestedSessions(vaultPath, day, files, null);
      } else {
        const contents = await Promise.all(
          files.map((f) => ipc.readFile(`${vaultPath}/${f}`).then((fc) => fc.raw)),
        );
        const bullets = extractive
          ? await extractiveBullets(files, contents)
          : await complete({
              task: "query",
              cwd: vaultPath,
              messages: [
                { role: "system", content: DIGEST_SYSTEM },
                { role: "user", content: buildDayPrompt(files, contents) },
              ],
            });
        // The append itself records which files it covered (Defect C fix): if
        // archiveDigestedSessions below fails, the next run's
        // digestableSessionDays reads that marker back, flags these files
        // already_digested, and takes the retry branch above — no re-paid LLM
        // call, no duplicate digest section, and no second write to lose.
        const fingerprints = contents.map(fingerprint);
        const dailyCreated = await appendDigest(
          vaultPath,
          day,
          bullets,
          files,
          fingerprints,
          extractive,
        );
        // Same fingerprints the marker just recorded: the auto-collect sweep
        // has its own timer and can rewrite a resumed conversation's file
        // between the read above and this move, so Rust archives only files
        // still holding the bytes we digested (a changed one stays in
        // sessions/ for the next run — see archive_digested_sessions).
        const manifestId = await ipc.archiveDigestedSessions(vaultPath, day, files, fingerprints);
        // Important 4 (Phase B whole-branch review): fold the daily-file
        // create into the SAME manifest archiveDigestedSessions just wrote for
        // this day's session-file moves, so "undo this run" reverses both —
        // only when this run actually created the file (see appendDigest's
        // doc comment). Best-effort: a bookkeeping failure here must not
        // undo the digest/archive that already succeeded.
        if (dailyCreated) {
          await ipc
            .appendDistillManifest(vaultPath, manifestId, [], [`daily/${day}.md`])
            .catch((e) => {
              console.error("[distill] manifest append failed for daily digest file", vaultPath, day, e);
            });
        }
      }
    } catch (err) {
      console.error("[distill] session digest failed", vaultPath, day, err);
      break;
    }
    daysDigested++;
    filesArchived += files.length;
  }

  return { daysDigested, filesArchived, skipped: null, mode };
}
