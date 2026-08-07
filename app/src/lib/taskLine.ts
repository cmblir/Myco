// Markdown checkbox lines as the task store. Nothing here does IO: it builds a
// task line, reads its metadata back, and rewrites one line's checkbox state.
//
// Tasks stay plain `- [ ] text` in the user's own notes rather than moving into
// a database — the vault is the product, and a task written here is still
// editable in Obsidian, greppable, and carried by git history. Metadata rides
// along as conventions the scanner already tolerates: `@YYYY-MM-DD` for a due
// date, `!p1`..`!p3` for priority.

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
  if (due) parts.push(`@${due}`);
  if (priority >= 1 && priority <= 3) parts.push(`!p${priority}`);
  return `- [ ] ${parts.join(" ")}`;
}

export interface TaskMeta {
  /** Task text with the `@due` / `!p` markers stripped, for display. */
  title: string;
  /** `YYYY-MM-DD`, or "" when the task has no due date. */
  due: string;
  /** 1 (highest) … 3, or 0 when unset. */
  priority: number;
}

// `@` followed by a date, optionally with a time — the time is accepted so a
// per-item reminder can be added later without changing what is already written.
const DUE_RE = /@(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/;
const PRIORITY_RE = /!p([1-3])\b/;

/** Pull the conventions back out of a task's text. */
export function parseTaskMeta(text: string): TaskMeta {
  const due = DUE_RE.exec(text)?.[1] ?? "";
  const priority = Number(PRIORITY_RE.exec(text)?.[1] ?? 0);
  const title = text.replace(DUE_RE, "").replace(PRIORITY_RE, "").replace(/\s+/g, " ").trim();
  return { title, due, priority };
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

/** Local `YYYY-MM-DD` — the user's calendar day, not UTC's, so a task written
 * late in the evening lands on the day they wrote it. */
export function today(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
