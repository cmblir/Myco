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
  skipped: "no-provider" | "nothing" | null;
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
  const section = existing.includes(HEADER)
    ? `\n_run of ${new Date().toISOString()}_\n${marker}\n${bullets.trim()}\n`
    : `\n${HEADER}\n_from ${files.length} session logs — low confidence_\n${marker}\n${bullets.trim()}\n`;
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
  if (provider === "builtin-local") {
    return { daysDigested: 0, filesArchived: 0, skipped: "no-provider" };
  }

  const cfg = await ipc.getDistillConfig(vaultPath).catch(() => null);
  const digestDays = cfg?.llm_digest_days ?? DEFAULT_DIGEST_DAYS;
  const days = (await ipc.digestableSessionDays(vaultPath)).slice(0, digestDays);
  if (days.length === 0) {
    return { daysDigested: 0, filesArchived: 0, skipped: "nothing" };
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
        const bullets = await complete({
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
        const dailyCreated = await appendDigest(vaultPath, day, bullets, files, fingerprints);
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

  return { daysDigested, filesArchived, skipped: null };
}
