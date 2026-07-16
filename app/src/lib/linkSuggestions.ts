// Suggested links — the embedding-similarity pairs surfaced as a review queue.
// The vector store already computes "these two notes are about the same thing";
// this module keeps only the pairs that are NOT yet wikilinked, minus the ones
// the user has dismissed, ranked by similarity. Accepting a suggestion appends
// a [[wikilink]] under a "## Related" section — the AI proposes, the user
// disposes, nothing is ever inserted automatically.

import type { Adjacency, SemEdge } from "./ipc";
import { stem } from "./graphData";

export interface LinkSuggestion {
  source: string;
  target: string;
  score: number;
  /** Stable order-independent identity for dismissal persistence. */
  key: string;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function linked(adj: Adjacency, a: string, b: string): boolean {
  return (
    (adj.forward[a]?.includes(b) ?? false) || (adj.forward[b]?.includes(a) ?? false)
  );
}

/** Filter the semantic pairs down to actionable, novel, non-dismissed ones. */
export function suggestLinks(
  adj: Adjacency,
  sem: SemEdge[],
  dismissed: ReadonlySet<string>,
  max = 12,
): LinkSuggestion[] {
  const seen = new Set<string>();
  const out: LinkSuggestion[] = [];
  const sorted = [...sem].sort((a, b) => b.score - a.score);
  for (const e of sorted) {
    if (e.source === e.target) continue;
    const key = pairKey(e.source, e.target);
    if (seen.has(key) || dismissed.has(key)) continue;
    seen.add(key);
    if (linked(adj, e.source, e.target)) continue;
    out.push({ source: e.source, target: e.target, score: e.score, key });
    if (out.length >= max) break;
  }
  return out;
}

/** Append `- [[target]]` under a "## Related" section (created if absent).
 * Returns the original content unchanged if the wikilink is already there. */
export function appendWikilink(content: string, targetPath: string): string {
  const name = stem(targetPath);
  if (content.includes(`[[${name}]]`)) return content;
  const line = `- [[${name}]]`;
  const m = /^##\s+Related\s*$/m.exec(content);
  if (m) {
    // Insert right after the heading line (and any blank line following it).
    const headEnd = m.index + m[0].length;
    const rest = content.slice(headEnd);
    const nl = rest.startsWith("\n") ? "" : "\n";
    return content.slice(0, headEnd) + nl + "\n" + line + rest.replace(/^\n/, "\n");
  }
  const sep = content.endsWith("\n") ? "" : "\n";
  return `${content}${sep}\n## Related\n\n${line}\n`;
}

// --- dismissal persistence ---------------------------------------------------

const KEY = "memex.linkSuggestions.dismissed.v1";
const MAX_DISMISSED = 500; // bounded so localStorage can't grow unbounded

export function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveDismissed(set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set].slice(-MAX_DISMISSED)));
  } catch {
    /* localStorage unavailable */
  }
}
