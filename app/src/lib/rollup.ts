// Rollup layers of the compression pyramid. One function, two layers:
//   weekly  (ROADMAP P1) — a settled ISO week's daily/ digests  -> weekly/<YYYY-Www>.md
//   monthly              — a settled month's weekly/ rollups     -> monthly/<YYYY-MM>.md
// and in both cases the source files then move to the cold tier via
// ipc.archiveRolled. Structurally the same step as sessionDigest.ts one level
// down (sessions/ -> daily/), and deliberately built out of that file's parts
// rather than beside them: the fingerprint, the MMR selection, and the
// marker-in-the-same-write contract are all imported, not reimplemented.
//
// Why it exists: sessions/ compressing into daily/ only moves the problem —
// daily/ then grows one file per active day forever, and weekly/ grows one
// file per active week for exactly the same reason. The pyramid has to get
// denser going up, so each layer needs its own digest above it.

import { ipc } from "./ipc";
import { complete, getActiveModel } from "./chat";
import { fingerprint, mmrSelect } from "./sessionDigest";
import {
  dropNearDuplicates,
  renderQuoteBullets,
  stripFiller,
  type QuoteUnit,
} from "./quoteBullets";

export interface RollupOutcome {
  /** Buckets (ISO weeks, or months one layer up) rolled up by this run. */
  bucketsRolledUp: number;
  /** Source files moved to `<src>/archive/<bucket>/` by this run. */
  sourcesArchived: number;
  skipped: "nothing" | null;
  /** How the bullets were produced — an LLM summary, or (builtin-local, which
   *  has no generative model) extractive quotes ranked by embedding. Same
   *  contract as DigestOutcome.mode: a marker-guarded bucket rolled up one way
   *  is never re-rolled the other. */
  mode: "llm" | "extractive";
}

export const ROLLUP_SYSTEM =
  "These are one week's daily digests of an engineer's work. Compress them " +
  "into the week's durable decisions, facts and outcomes. Output 3-10 " +
  "markdown bullets. No preamble. Drop anything a later day in the week " +
  "superseded; mark uncertain items with '(uncertain)'.";

export const MONTHLY_SYSTEM =
  "These are one month's weekly rollups of an engineer's work. Compress them " +
  "into the month's durable decisions, facts and outcomes. Output 3-10 " +
  "markdown bullets. No preamble. Drop anything a later week in the month " +
  "superseded; mark uncertain items with '(uncertain)'.";

/** What differs between the two layers. Everything else in this file — the
 *  marker, the maturity contract, the retry split, the manifest fold-in — is
 *  shared, which is the point: the monthly layer is the weekly one re-aimed,
 *  not a second implementation to keep in sync. */
interface RollupLayerSpec {
  /** Rust's `rollup_layer` name, passed on every IPC call. */
  layer: "weekly" | "monthly";
  /** Directory the rollup files live in — also `<out>/<bucket>.md`. */
  out: string;
  /** What one source file is called in the `_from N …_` label. */
  sourceLabel: string;
  /** Section header, distinct per layer so a repeat run appends under the
   *  right one (and so distill.rs's marker scan stays unambiguous). */
  header: string;
  system: string;
}

const WEEKLY_LAYER: RollupLayerSpec = {
  layer: "weekly",
  out: "weekly",
  sourceLabel: "daily digests",
  header: "## Weekly rollup",
  system: ROLLUP_SYSTEM,
};

const MONTHLY_LAYER: RollupLayerSpec = {
  layer: "monthly",
  out: "monthly",
  sourceLabel: "weekly rollups",
  header: "## Monthly rollup",
  system: MONTHLY_SYSTEM,
};

// Char ceiling shared across the week's daily files, the same cheap prompt
// guard MAX_DAY_CHARS is for a day's session logs. Smaller than that one:
// daily files are already digests, so a week of them should fit comfortably —
// if it doesn't, the omission line says so rather than silently truncating.
const MAX_WEEK_CHARS = 40_000;

// Machine-readable record of WHICH daily files a rollup section covers,
// written in the same weekly/<week>.md write as the bullets — so a crash can
// never leave the rollup durable but its record missing, and a re-run never
// re-charges. Parsed by distill.rs's `marker_entries(weekly/, …)`
// (ROLLUP_MARKER_OPEN / DIGEST_MARKER_CLOSE); keep the literals in lockstep.
const MARKER_OPEN = "<!-- myco:rolled-up-days ";
const MARKER_CLOSE = " -->";

// `<day>:<fingerprint>` per daily file. The day alone survives every append —
// a later session digest adds another section to the same daily/<day>.md, and
// the user edits daily notes by hand — so a day-keyed record would archive the
// grown file with its new half never rolled up. Bound to the content instead;
// same accepted trade as the session digest's marker (earlier bullets get
// summarized twice, which is cheaper than losing the later ones).
function rollupMarker(files: string[], fingerprints: string[]): string {
  const entries = files.map(
    (f, i) => (f.split("/").pop() ?? f).replace(/\.md$/, "") + ":" + fingerprints[i],
  );
  return MARKER_OPEN + entries.join(" ") + MARKER_CLOSE;
}

// Per-run cap on weeks, reusing llm_digest_days rather than adding a knob:
// it is already labelled "digest units per run" and bounds exactly the same
// cost (one provider call per unit). A week is a much bigger unit than a day,
// so the same number is a strictly smaller bill.
const DEFAULT_DIGEST_DAYS = 3;

// ---------------------------------------------------------------------------
// Extractive rollup (builtin-local) — the mirror of sessionDigest.ts's
// extractive path, over a coarser unit: a daily file is already a list of
// digest bullets, so the candidate units are those bullets rather than
// speaker turns. Deterministic for the same inputs (the embedder is, and
// mmrSelect breaks ties to document order).
// ---------------------------------------------------------------------------

const MAX_UNITS = 64;
const MIN_UNIT_CHARS = 30;
const UNIT_CHARS = 400;
const BULLET_CHARS = 220;
const MAX_BULLETS = 10;

/** One source file's candidate units: its markdown bullets, or — for a
 * hand-written daily note that has none — its paragraphs, so a rollup that is
 * about to archive that file never quotes nothing from it. A weekly rollup is
 * bullets by construction, so the same split serves the layer above. */
function splitDaily(doc: string): string[] {
  const bullets = doc
    .split("\n")
    .filter((l) => /^\s*[-*]\s+\S/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, ""));
  return bullets.length > 0 ? bullets : doc.split(/\n{2,}/);
}

function candidateUnits(files: string[], contents: string[]): QuoteUnit[] {
  const units: QuoteUnit[] = [];
  for (let i = 0; i < files.length && units.length < MAX_UNITS; i++) {
    const day = (files[i].split("/").pop() ?? files[i]).replace(/\.md$/, "");
    for (const line of splitDaily(contents[i])) {
      if (units.length >= MAX_UNITS) break;
      // Filler comes off before the length filter and before embedding, same
      // as the session digest — a daily note is partly hand-written, so its
      // bullets carry acknowledgments too.
      const text = stripFiller(line.replace(/\s+/g, " ").trim());
      // Skips the headings, the `_from N session logs_` labels and the markers
      // themselves — none of which is a week's outcome.
      if (text.length < MIN_UNIT_CHARS || text.startsWith("<!--") || text.startsWith("#")) {
        continue;
      }
      units.push({ text: text.slice(0, UNIT_CHARS), label: day });
    }
  }
  return units;
}

/** The extractive counterpart of the week's `complete()` call: quoted bullets
 * grouped under the day they came from, top MAX_BULLETS by centroid+MMR once
 * near-duplicates are dropped. Grouping matters more here than one level down:
 * a week restates itself across days, and the same point surviving Monday to
 * Friday should not spend five bullets. */
async function extractiveBullets(files: string[], contents: string[]): Promise<string> {
  const units = candidateUnits(files, contents);
  // A week of empty daily notes still gets a section — the marker in the same
  // write is what stops it being re-offered forever.
  if (units.length === 0) return "- (no quotable content)";
  const vectors = await ipc.embedLocalTexts(units.map((u) => u.text));
  const ranked = dropNearDuplicates(mmrSelect(vectors, MAX_BULLETS * 2), vectors);
  return renderQuoteBullets(units, ranked.slice(0, MAX_BULLETS), BULLET_CHARS);
}

function buildWeekPrompt(files: string[], contents: string[], sourceLabel: string): string {
  let out = "";
  let i = 0;
  for (; i < files.length; i++) {
    const remaining = MAX_WEEK_CHARS - out.length;
    if (remaining <= 0) break;
    const name = files[i].split("/").pop() ?? files[i];
    const header = `### ${name}\n`;
    out += header + contents[i].slice(0, Math.max(0, remaining - header.length)) + "\n\n";
  }
  const omitted = files.length - i;
  if (omitted > 0) {
    out += `…(${omitted} more ${sourceLabel} omitted for length)\n`;
  }
  return out;
}

/** Read-or-empty + append into `weekly/<week>.md`, byte-for-byte the idiom
 * `appendDigest` uses for `daily/<day>.md`: a repeat run for the same week
 * appends under a `_run of <ISO date>_` sub-line instead of duplicating the
 * header, and the return value says whether THIS call created the file — the
 * only case the caller records a manifest `created` entry for, since a file
 * that already existed was visible to undo before this run touched it. */
async function appendRollup(
  vaultPath: string,
  spec: RollupLayerSpec,
  week: string,
  bullets: string,
  files: string[],
  fingerprints: string[],
  extractive: boolean,
): Promise<boolean> {
  const filePath = `${vaultPath}/${spec.out}/${week}.md`;
  // Blank counts as missing, for the same reason it does in appendDigest: a
  // zero-byte file left by an earlier crash reads back fine and would
  // otherwise skip the branch that seeds the title and sets `created`.
  const existingRaw = await ipc
    .readFile(filePath)
    .then((f) => f.raw)
    .catch(() => "");
  const created = existingRaw.trim() === "";
  if (created) {
    try {
      await ipc.createFolder(vaultPath, spec.out);
    } catch {
      /* already exists */
    }
  }
  const existing = created ? `# ${week}\n\n` : existingRaw;
  const marker = rollupMarker(files, fingerprints);
  const label = extractive
    ? `_from ${files.length} ${spec.sourceLabel} — extractive quotes (no LLM)_`
    : `_from ${files.length} ${spec.sourceLabel} — low confidence_`;
  const runLine = extractive
    ? `_run of ${new Date().toISOString()} (extractive)_`
    : `_run of ${new Date().toISOString()}_`;
  const section = existing.includes(spec.header)
    ? `\n${runLine}\n${marker}\n${bullets.trim()}\n`
    : `\n${spec.header}\n${label}\n${marker}\n${bullets.trim()}\n`;
  // One atomic write (vault::write_file is tmpfile+fsync+rename) carrying both
  // the rollup text and the record of what it covers.
  await ipc.writeFile(filePath, existing + section);
  return created;
}

/** Rolls up to `llm_digest_days` of the oldest settled buckets into
 * `<out>/<bucket>.md`, one provider call per bucket, then moves that bucket's
 * source files to `<src>/archive/<bucket>/`. Stops at the first bucket that
 * errors (logged, not thrown) so a bad bucket never gets archived —
 * everything before it still did. Every branch here has a session-digest
 * counterpart; see runSessionDigest for the reasoning behind each. */
async function runRollup(vaultPath: string, spec: RollupLayerSpec): Promise<RollupOutcome> {
  const { provider } = await getActiveModel("query");
  const extractive = provider === "builtin-local";
  const mode = extractive ? ("extractive" as const) : ("llm" as const);

  const cfg = await ipc.getDistillConfig(vaultPath).catch(() => null);
  const weekCap = cfg?.llm_digest_days ?? DEFAULT_DIGEST_DAYS;
  const buckets = (await ipc.rollupableBuckets(vaultPath, spec.layer)).slice(0, weekCap);
  if (buckets.length === 0) {
    return { bucketsRolledUp: 0, sourcesArchived: 0, skipped: "nothing", mode };
  }

  let bucketsRolledUp = 0;
  let sourcesArchived = 0;
  for (const { bucket, files, already_rolled } of buckets) {
    try {
      if (already_rolled) {
        // Retry: a prior run's appendRollup already wrote these exact files'
        // rollup (its marker names them, which is how Rust set this flag) but
        // the archive move failed afterward — only the move needs retrying.
        // No fingerprints of our own to hand over; the marker on disk is the
        // record and Rust re-checks each file against it.
        await ipc.archiveRolled(vaultPath, spec.layer, bucket, files, null);
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
                { role: "system", content: spec.system },
                { role: "user", content: buildWeekPrompt(files, contents, spec.sourceLabel) },
              ],
            });
        const fingerprints = contents.map(fingerprint);
        const rollupCreated = await appendRollup(
          vaultPath,
          spec,
          bucket,
          bullets,
          files,
          fingerprints,
          extractive,
        );
        // Same fingerprints the marker just recorded: a source file can be
        // appended to (a concurrent digest one layer down) or hand-edited
        // between the read above and the move, so Rust archives only files
        // still holding the bytes we rolled up.
        const manifestId = await ipc.archiveRolled(
          vaultPath,
          spec.layer,
          bucket,
          files,
          fingerprints,
        );
        // Fold the rollup file's create into the SAME manifest the archive
        // just wrote, so "undo this run" reverses both. Best-effort: a
        // bookkeeping failure must not undo the rollup/archive that already
        // succeeded.
        if (rollupCreated) {
          await ipc
            .appendDistillManifest(vaultPath, manifestId, [], [`${spec.out}/${bucket}.md`])
            .catch((e) => {
              console.error("[distill] manifest append failed for rollup", vaultPath, bucket, e);
            });
        }
      }
    } catch (err) {
      console.error(`[distill] ${spec.layer} rollup failed`, vaultPath, bucket, err);
      break;
    }
    bucketsRolledUp++;
    sourcesArchived += files.length;
  }

  return { bucketsRolledUp, sourcesArchived, skipped: null, mode };
}

/** daily/ -> weekly/<YYYY-Www>.md (ROADMAP P1). */
export function runWeeklyRollup(vaultPath: string): Promise<RollupOutcome> {
  return runRollup(vaultPath, WEEKLY_LAYER);
}

/** weekly/ -> monthly/<YYYY-MM>.md — the same step one layer further up, run
 *  immediately after the weekly one so a month whose last week was only just
 *  rolled up is still held back by that week's own maturity gate. */
export function runMonthlyRollup(vaultPath: string): Promise<RollupOutcome> {
  return runRollup(vaultPath, MONTHLY_LAYER);
}
