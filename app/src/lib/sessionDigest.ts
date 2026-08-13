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
 * its bullets under a "_run of <ISO date>_" sub-line instead. */
async function appendDigest(
  vaultPath: string,
  day: string,
  bullets: string,
  fileCount: number,
): Promise<void> {
  const dailyDir = `${vaultPath}/daily`;
  const filePath = `${dailyDir}/${day}.md`;
  let existing: string;
  try {
    existing = (await ipc.readFile(filePath)).raw;
  } catch {
    try {
      await ipc.createFolder(vaultPath, "daily");
    } catch {
      /* already exists */
    }
    try {
      await ipc.createFile(dailyDir, `${day}.md`);
    } catch {
      /* race */
    }
    existing = `# ${day}\n\n`;
  }
  const section = existing.includes(HEADER)
    ? `\n_run of ${new Date().toISOString()}_\n${bullets.trim()}\n`
    : `\n${HEADER}\n_from ${fileCount} session logs — low confidence_\n${bullets.trim()}\n`;
  await ipc.writeFile(filePath, existing + section);
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
  for (const { day, files } of days) {
    try {
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
      // ponytail: append-then-archive isn't atomic — if archiveDigestedSessions
      // fails right after appendDigest succeeds, the day stays digestable and
      // the next run re-digests it (LLM cost + a second "_run of…_" sub-section).
      // Acceptable because the header check above appends a run sub-line rather
      // than duplicating; upgrade = persist a digested-day marker before archiving.
      await appendDigest(vaultPath, day, bullets, files.length);
      await ipc.archiveDigestedSessions(vaultPath, day, files);
    } catch (err) {
      console.error("[distill] session digest failed", vaultPath, day, err);
      break;
    }
    daysDigested++;
    filesArchived += files.length;
  }

  return { daysDigested, filesArchived, skipped: null };
}
