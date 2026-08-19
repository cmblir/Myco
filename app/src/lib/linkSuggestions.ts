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

export interface LinkSuggestionIO {
  readFile: (path: string) => Promise<{ raw: string }>;
  writeFile: (path: string, content: string) => Promise<unknown>;
}

/** Accept one suggestion: read the source, append the wikilink, write back
 * only if it changed. The one write path — both a single ✓ and "accept all"
 * call this and nothing else. */
export async function acceptSuggestion(
  s: LinkSuggestion,
  io: LinkSuggestionIO,
): Promise<void> {
  const file = await io.readFile(s.source);
  const next = appendWikilink(file.raw, s.target);
  if (next !== file.raw) await io.writeFile(s.source, next);
}

/** Accept every suggestion in order through acceptSuggestion. Stops at the
 * first failure so the remainder stays listed (and unattempted) rather than
 * racing ahead past a broken one. */
export async function acceptAll(
  suggestions: LinkSuggestion[],
  io: LinkSuggestionIO,
  onProgress?: (done: number, total: number) => void,
): Promise<{ accepted: LinkSuggestion[]; remaining: LinkSuggestion[]; error: string | null }> {
  const accepted: LinkSuggestion[] = [];
  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    try {
      await acceptSuggestion(s, io);
      accepted.push(s);
      onProgress?.(accepted.length, suggestions.length);
    } catch (e) {
      return { accepted, remaining: suggestions.slice(i), error: String(e) };
    }
  }
  return { accepted, remaining: [], error: null };
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

const KEY = "myco.linkSuggestions.dismissed.v1";
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
