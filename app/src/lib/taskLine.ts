// Markdown checkbox lines as the task store. Nothing here does IO: it builds a
// task line, reads its metadata back, and rewrites one line's checkbox state.
//
// Tasks stay plain `- [ ] text` in the user's own notes rather than moving into
// a database — the vault is the product, and a task written here is still
// editable in Obsidian, greppable, and carried by git history. Metadata rides
// along as conventions the scanner already tolerates: Obsidian Tasks' emoji
// markers (`🛫` `⏳` `📅` `✅` `🔁`) plus `⏱` for an estimate, and the older
// `@YYYY-MM-DD` due date this app wrote first. Read wide, write narrow: the
// parser accepts both dialects, the writer emits emoji dates and `!p1`..`!p3`.

/** Checkbox marks, in the Obsidian Tasks convention the scanner already reads. */
export type TaskStatus = "todo" | "doing" | "blocked" | "done";

const MARK: Record<TaskStatus, string> = {
  todo: " ",
  doing: "/",
  blocked: "-",
  done: "x",
};

/** A `- [ ] …` line for a new task. `due` is `YYYY-MM-DD`, empty for none. */
export function buildTaskLine(text: string, due = "", priority = 0): string {
  const parts = [text.trim()];
  if (due) parts.push(`📅 ${due}`);
  if (priority >= 1 && priority <= 3) parts.push(`!p${priority}`);
  return `- [ ] ${parts.join(" ")}`;
}

// `@` followed by a date, optionally with a time — the time is accepted so a
// per-item reminder can be added later without changing what is already written.
const DUE_RE = /@(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/;
const PRIORITY_RE = /!p([1-3])\b/;

/** Obsidian Tasks' own field markers, so a task written here reads correctly in
 *  the plugin and vice versa. `⏱` is ours — Tasks has no estimate field, and it
 *  leaves an unknown token in the description rather than dropping it. */
const START_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/u;
const SCHEDULED_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/u;
const DUE_EMOJI_RE = /📅\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/u;
const DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/u;
const ESTIMATE_RE = /⏱\s*(\d+(?:\.\d+)?[mhdw])/u;
// Greedy to the next field marker or end of line: "every 2 weeks" is one rule.
const RECUR_RE = /🔁\s*([^🛫⏳📅✅⏱!\n]+)/u;
const PRIORITY_EMOJI: Record<string, number> = { "🔺": 1, "⏫": 1, "🔼": 2, "🔽": 3, "⏬": 3 };
const PRIORITY_EMOJI_RE = /(🔺|⏫|🔼|🔽|⏬)/u;

export interface TaskMeta {
  /** Task text with every known marker stripped, for display. Unknown text —
   *  wikilinks, tags, anything the user wrote — stays. */
  title: string;
  start: string;
  scheduled: string;
  /** `YYYY-MM-DD`, optionally `THH:MM`, or "" when the task has no due date. */
  due: string;
  doneAt: string;
  /** Raw rule text after 🔁 (`every week`), or "". Parsed by taskRecurrence. */
  recur: string;
  /** Raw duration token (`2d`), or "". Parsed by taskDuration. */
  estimate: string;
  /** 1 (highest) … 3, or 0 when unset. */
  priority: number;
}

export type TaskField =
  | "start"
  | "scheduled"
  | "due"
  | "doneAt"
  | "recur"
  | "estimate"
  | "priority";

/** Pull the conventions back out of a task's text. Reads both the emoji set and
 *  the older `@date` / `!pN` this app wrote first; `📅` wins when a line
 *  somehow carries both. */
export function parseTaskMeta(text: string): TaskMeta {
  const start = START_RE.exec(text)?.[1] ?? "";
  const scheduled = SCHEDULED_RE.exec(text)?.[1] ?? "";
  const due = DUE_EMOJI_RE.exec(text)?.[1] ?? DUE_RE.exec(text)?.[1] ?? "";
  const doneAt = DONE_RE.exec(text)?.[1] ?? "";
  const estimate = ESTIMATE_RE.exec(text)?.[1] ?? "";
  const recur = RECUR_RE.exec(text)?.[1]?.trim() ?? "";
  const emojiPriority = PRIORITY_EMOJI_RE.exec(text)?.[1];
  const priority =
    Number(PRIORITY_RE.exec(text)?.[1] ?? 0) ||
    (emojiPriority ? PRIORITY_EMOJI[emojiPriority] : 0);
  const title = text
    .replace(START_RE, "")
    .replace(SCHEDULED_RE, "")
    .replace(DUE_EMOJI_RE, "")
    .replace(DONE_RE, "")
    .replace(ESTIMATE_RE, "")
    .replace(RECUR_RE, "")
    .replace(PRIORITY_EMOJI_RE, "")
    .replace(DUE_RE, "")
    .replace(PRIORITY_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return { title, start, scheduled, due, doneAt, recur, estimate, priority };
}

/** `meta` back to one line's text, markers in a fixed order so repeated edits
 *  produce no diff churn. A legacy `@date` therefore becomes `📅` the first
 *  time the line is edited — and only then. */
export function serializeTaskText(meta: TaskMeta): string {
  const parts = [meta.title.trim()];
  if (meta.start) parts.push(`🛫 ${meta.start}`);
  if (meta.scheduled) parts.push(`⏳ ${meta.scheduled}`);
  if (meta.due) parts.push(`📅 ${meta.due}`);
  if (meta.recur) parts.push(`🔁 ${meta.recur}`);
  if (meta.estimate) parts.push(`⏱ ${meta.estimate}`);
  if (meta.priority >= 1 && meta.priority <= 3) parts.push(`!p${meta.priority}`);
  if (meta.doneAt) parts.push(`✅ ${meta.doneAt}`);
  return parts.filter(Boolean).join(" ");
}

/** Rewrite line `lineNo`'s scheduling fields, leaving the bullet, indentation
 * and checkbox mark exactly as written. An empty string clears a field.
 *
 * `null` for the same reason as `setLineStatus`: that line is no longer a
 * checkbox, so the scan it came from is stale and rewriting would edit the
 * wrong line. */
export function setLineFields(
  content: string,
  lineNo: number,
  patch: Partial<Pick<TaskMeta, TaskField>>,
): string | null {
  const lines = content.split("\n");
  const idx = lineNo - 1;
  const line = lines[idx];
  if (line === undefined) return null;
  const m = /^(\s*[-*+]\s*\[[^\]]\]\s*)(.*)$/.exec(line);
  if (!m) return null;
  const next = { ...parseTaskMeta(m[2]), ...patch };
  lines[idx] = `${m[1]}${serializeTaskText(next)}`.trimEnd();
  return lines.join("\n");
}

/** Rewrite line `lineNo` (1-based) of `content` to `status`, leaving every other
 * character — indentation, bullet style, trailing notes — exactly as written.
 *
 * Returns `null` when that line is not a checkbox any more, which means the file
 * changed since the scan: rewriting by line number would then edit the wrong
 * line, so the caller must rescan instead of guessing. */
export function setLineStatus(
  content: string,
  lineNo: number,
  status: TaskStatus,
): string | null {
  const lines = content.split("\n");
  const idx = lineNo - 1;
  const line = lines[idx];
  if (line === undefined) return null;
  // Same shape the Rust scanner accepts: -/*/+ bullet, any indent, one mark.
  const m = /^(\s*[-*+]\s*\[)([^\]])(\].*)$/.exec(line);
  if (!m) return null;
  lines[idx] = `${m[1]}${MARK[status]}${m[3]}`;
  return lines.join("\n");
}

/** Append a task line to a note, keeping exactly one trailing newline. */
export function appendTaskLine(content: string, line: string): string {
  const body = content.replace(/\s*$/, "");
  return body ? `${body}\n${line}\n` : `${line}\n`;
}

/** The days of the calendar grid containing `month`, padded to whole weeks so
 * every row has seven cells. `weekStart` is the first column in getDay()
 * terms (0 = Sunday … 6 = Saturday); it defaults to Monday, which is what a
 * work week reads as here — the DatePicker passes the locale's own first day
 * instead. Pure and local-time throughout — a UTC-based grid puts tasks on
 * the wrong day for anyone east of Greenwich. */
export function monthGrid(month: Date, weekStart = 1): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // getDay() is Sunday-0; shift so `weekStart` is the first column.
  const lead = (first.getDay() - weekStart + 7) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  // Trim a trailing all-next-month week so a short month is not padded to six
  // rows of mostly greyed-out cells.
  return days.slice(0, days[35].getMonth() === month.getMonth() ? 42 : 35);
}

/** Parse a `YYYY-MM-DD` back into a Date at local midnight — the inverse of
 * `today()`. Never `Date.parse`, which reads a bare date as UTC midnight and
 * shifts it onto the previous day for anyone west of Greenwich. Returns null
 * for anything that is not a date string. */
export function parseIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Local `YYYY-MM-DD` — the user's calendar day, not UTC's, so a task written
 * late in the evening lands on the day they wrote it. */
export function today(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
