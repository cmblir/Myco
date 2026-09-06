// Authorship UI helpers (Q4 item 16) — pure. The reader badge percentages and
// the sidebar's "human-only (on record)" tree filter.
import type { Lang } from "./i18n";
import type { AuthorshipIndex, FileNode, LineRun, PageAuthorship } from "./ipc";
import { lcsOps } from "./wordDiff";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

export interface AuthBadgeView {
  humanPct: number;
  agentPct: number;
  lastHumanRel: string | null;
}

/** Rounded split that always sums to 100 — human absorbs the remainder. */
export function badgeView(
  a: PageAuthorship,
  now: number,
  lang: Lang,
): AuthBadgeView {
  const total = a.agent_lines + a.human_lines;
  const agentPct = total === 0 ? 0 : Math.round((a.agent_lines / total) * 100);
  let lastHumanRel: string | null = null;
  if (a.last_human_at !== null) {
    const delta = now - a.last_human_at;
    const [unit, secs] = UNITS.find(([, s]) => delta >= s) ?? ["minute", 60];
    lastHumanRel = new Intl.RelativeTimeFormat(lang, {
      numeric: "auto",
    }).format(-Math.max(1, Math.round(delta / secs)), unit);
  }
  return { humanPct: 100 - agentPct, agentPct, lastHumanRel };
}

/** Keeps files never committed by the agent author. Untracked files are kept
 *  too (`touched` simply has no row — untracked means unknown, not agent).
 *  Directories survive only while they still hold a kept child. */
export function filterHumanTree(
  tree: FileNode[],
  touched: AuthorshipIndex,
  vaultRoot: string,
): FileNode[] {
  const out: FileNode[] = [];
  for (const node of tree) {
    if (node.kind === "file") {
      const rel = node.path.startsWith(vaultRoot + "/")
        ? node.path.slice(vaultRoot.length + 1)
        : node.path;
      if (touched[rel] !== true) out.push(node);
    } else {
      const children = filterHumanTree(node.children, touched, vaultRoot);
      if (children.length > 0) out.push({ ...node, children });
    }
  }
  return out;
}

// --- authorship gutter (reader) ---------------------------------------------

/** git's "not committed yet" blame sha. */
const UNCOMMITTED = "0".repeat(40);

/** One paragraph of the document, attributed. `from`/`to` are 1-based
 *  inclusive line numbers, matching LineRun. */
export interface GutterRun {
  from: number;
  to: number;
  /** Every line of the paragraph came from an agent commit. */
  agent: boolean;
  sha: string;
  ts: number;
  /** Safe to offer "revert this paragraph": one commit wrote the whole
   *  paragraph, it is an agent commit, and it is actually in history. */
  revertable: boolean;
}

/**
 * Line runs → paragraph runs. A paragraph is a maximal block of non-blank
 * lines; it takes the attribution of the runs covering it, and is revertable
 * only when a single agent commit wrote all of it.
 *
 * Ceiling: `git blame` answers "which commit introduced this line", not
 * "where did this paragraph come from". A paragraph MOVED after its commit
 * still blames to that commit and looks revertable here — the revert then
 * aligns against the parent revision (parentParagraph) and comes back with
 * nothing to restore, which is where that case is caught.
 */
export function gutterRuns(runs: readonly LineRun[], doc: string): GutterRun[] {
  if (runs.length === 0) return [];
  const lines = doc.split("\n");
  const out: GutterRun[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < lines.length && lines[end + 1].trim() !== "") end++;
    const from = i + 1;
    const to = end + 1;
    const covering = runs.filter((r) => r.to >= from && r.from <= to);
    if (covering.length > 0) {
      const one = covering.length === 1 ? covering[0] : null;
      out.push({
        from,
        to,
        agent: covering.every((r) => r.agent),
        sha: one?.sha ?? "",
        ts: one?.ts ?? Math.max(...covering.map((r) => r.ts)),
        revertable: !!one && one.agent && one.sha !== "" && one.sha !== UNCOMMITTED,
      });
    }
    i = end + 1;
  }
  return out;
}

/**
 * What lines [from..to] of `current` looked like in `parent`, aligned by the
 * same line LCS the diff view uses. `""` = the paragraph did not exist in the
 * parent (reverting deletes it); `null` = the parent still holds it unchanged,
 * i.e. there is nothing to revert (a moved paragraph lands here).
 */
export function parentParagraph(
  current: string,
  parent: string,
  from: number,
  to: number,
): string | null {
  const cur = current.split("\n");
  const par = parent.split("\n");
  const kept: string[] = [];
  let changed = false;
  let c = 0; // current lines consumed so far
  for (const op of lcsOps(par, cur)) {
    if (op.kind === "same") {
      c++;
      if (c >= from && c <= to) kept.push(op.text);
    } else if (op.kind === "add") {
      // A line only in `current`: inside the range it is what we are reverting.
      c++;
      if (c >= from && c <= to) changed = true;
    } else {
      // A line only in `parent`. Attribute it to the range it was removed from.
      if (c + 1 >= from && c <= to) {
        kept.push(op.text);
        changed = true;
      }
    }
  }
  return changed ? kept.join("\n") : null;
}

/** `current` with lines [from..to] replaced by `text` (empty = drop them). */
export function replaceLines(
  current: string,
  from: number,
  to: number,
  text: string,
): string {
  const lines = current.split("\n");
  lines.splice(from - 1, to - from + 1, ...(text === "" ? [] : text.split("\n")));
  return lines.join("\n");
}
