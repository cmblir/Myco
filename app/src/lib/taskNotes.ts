// A task's detail notes are the indented lines directly under its checkbox —
// the markdown-native shape: Obsidian renders them as the item's child
// content, they travel with the line in git, and a vault opened in any other
// editor still shows the notes next to the task. No database, no sidecar.
//
// Block rules (deliberately narrow so nothing else is ever swallowed):
// consecutive lines strictly more indented than the task line, stopping at a
// blank line, at any line that is itself a checkbox (a nested subtask is a
// task, not prose), or at the first line back at/below the task's indent.

const TASK_LINE_RE = /^(\s*)[-*+]\s*\[[^\]]\]/;

/** Indent for written notes: the task's own indent plus two spaces. */
function noteIndent(taskLine: string): string {
  const m = TASK_LINE_RE.exec(taskLine);
  return `${m?.[1] ?? ""}  `;
}

/** The `[start, end)` line-index range of the notes block under `idx`. */
function notesRange(lines: string[], idx: number): [number, number] {
  const taskIndent = (TASK_LINE_RE.exec(lines[idx])?.[1] ?? "").length;
  let end = idx + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "") break;
    const indent = line.length - line.trimStart().length;
    if (indent <= taskIndent) break;
    if (TASK_LINE_RE.test(line)) break;
    end += 1;
  }
  return [idx + 1, end];
}

/** Dedented notes text under the checkbox at `lineNo` (1-based); "" when the
 * task has none. `null` when that line is not a checkbox — the scan is stale
 * and the caller must rescan, same contract as taskLine's writers. */
export function readTaskNotes(content: string, lineNo: number): string | null {
  const lines = content.split("\n");
  const idx = lineNo - 1;
  const line = lines[idx];
  if (line === undefined || !TASK_LINE_RE.test(line)) return null;
  const [start, end] = notesRange(lines, idx);
  const block = lines.slice(start, end);
  if (block.length === 0) return "";
  // Dedent by the block's own minimum indent, not the writer's convention —
  // notes hand-written in Obsidian with tabs or four spaces read back clean.
  const minIndent = Math.min(
    ...block.map((l) => l.length - l.trimStart().length),
  );
  return block.map((l) => l.slice(minIndent)).join("\n");
}

/** Replace the notes block under the checkbox at `lineNo` with `notes`
 * (empty string removes the block). Every other line survives byte-identical.
 * `null` = stale, nothing to write. */
export function setTaskNotes(
  content: string,
  lineNo: number,
  notes: string,
): string | null {
  const lines = content.split("\n");
  const idx = lineNo - 1;
  const line = lines[idx];
  if (line === undefined || !TASK_LINE_RE.test(line)) return null;
  const [start, end] = notesRange(lines, idx);
  const indent = noteIndent(line);
  const block = notes
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => (l.trim() === "" ? "" : `${indent}${l}`));
  // A blank interior line would terminate the block on read, silently
  // orphaning everything after it — collapse runs of blanks away instead.
  const cleaned = block.filter((l) => l !== "");
  lines.splice(start, end - start, ...(notes.trim() === "" ? [] : cleaned));
  return lines.join("\n");
}
