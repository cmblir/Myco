// Suggested links — the embedding-similarity pairs surfaced as a review queue.
// The vector store already computes "these two notes are about the same thing";
// this module keeps only the pairs that are NOT yet wikilinked, minus the ones
// the user has dismissed, ranked by similarity. Accepting a suggestion appends
// a [[wikilink]] under a "## Related" section — the AI proposes, the user
// disposes, nothing is ever inserted automatically.

import type { Adjacency, SemEdge } from "./ipc";
import { stem } from "./graphData";
import { sha256 } from "./tidyRun";
import { matchWikilinkAt, wikilinkBase } from "./wikilinks";

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

// All surfaces request the same full queue, often on every progress tick.
// Store snapshots are immutable: reuse the derivation until one input moves.
let pendingCache: { adj: Adjacency; sem: SemEdge[]; dismissed: ReadonlySet<string>; value: LinkSuggestion[] } | null = null;

/** Filter the semantic pairs down to actionable, novel, non-dismissed ones. */
export function suggestLinks(
  adj: Adjacency,
  sem: SemEdge[],
  dismissed: ReadonlySet<string>,
  max = 12,
): LinkSuggestion[] {
  if (max <= 0) return [];
  if (pendingCache?.adj === adj && pendingCache.sem === sem && pendingCache.dismissed === dismissed) {
    return Number.isFinite(max) ? pendingCache.value.slice(0, max) : pendingCache.value;
  }
  const seen = new Set<string>();
  const out: LinkSuggestion[] = [];
  const sorted = [...sem].sort((a, b) => b.score - a.score);
  for (const e of sorted) {
    if (e.source === e.target || !Number.isFinite(e.score)) continue;
    const key = pairKey(e.source, e.target);
    if (seen.has(key) || dismissed.has(key)) continue;
    seen.add(key);
    if (linked(adj, e.source, e.target)) continue;
    out.push({ source: e.source, target: e.target, score: e.score, key });
  }
  pendingCache = { adj, sem, dismissed, value: out };
  return Number.isFinite(max) ? out.slice(0, max) : out;
}

/** Total pending suggestions — uncapped, unlike suggestLinks' display default.
 * The one derivation both Overview's card ("Accept all (N)") and the Topbar
 * activity popover count from. */
export function pendingLinkCount(
  adj: Adjacency,
  sem: SemEdge[],
  dismissed: ReadonlySet<string>,
): number {
  return suggestLinks(adj, sem, dismissed, Number.POSITIVE_INFINITY).length;
}

export interface LinkSuggestionIO {
  readFile: (path: string) => Promise<{ raw: string }>;
  writeFile: (path: string, content: string) => Promise<unknown>;
  /** Disk writers use CAS; the reader instead appends to its live draft. */
  writeFileIfUnchanged?: (path: string, content: string, expectedSha256: string | null) => Promise<unknown>;
  /** Transform a live draft synchronously; undefined delegates to disk IO. */
  transformFile?: (path: string, transform: (raw: string) => string) => Promise<unknown> | undefined;
  vaultRoot?: string;
}

/** Accept one suggestion: read the source, append the wikilink, write back
 * only if it changed. The one write path — both a single ✓ and "accept all"
 * call this and nothing else. */
export async function acceptSuggestion(
  s: LinkSuggestion,
  io: LinkSuggestionIO,
): Promise<void> {
  await acceptSourceGroup([s], io);
}

async function acceptSourceGroup(group: LinkSuggestion[], io: LinkSuggestionIO): Promise<void> {
  const source = group[0].source;
  const transform = (raw: string): string => appendWikilinks(raw, group.map((s) => s.target), io.vaultRoot);
  const draftWrite = io.transformFile?.(source, transform);
  if (draftWrite) { await draftWrite; return; }
  for (let attempt = 0; ; attempt++) {
    const { raw } = await io.readFile(source);
    const next = transform(raw);
    if (next === raw) return;
    try {
      if (io.writeFileIfUnchanged) await io.writeFileIfUnchanged(source, next, await sha256(raw));
      else await io.writeFile(source, next);
      return;
    } catch (error) {
      if (attempt >= 2 || !/^write conflict:/i.test(String(error).replace(/^Error:\s*/, ""))) throw error;
    }
  }
}

/** One append per source document, stopping at the first failed document.
 * A failed group stays wholly pending; completed documents are never retried. */
export async function acceptAll(
  suggestions: LinkSuggestion[],
  io: LinkSuggestionIO,
  onProgress?: (done: number, total: number) => void,
): Promise<{ accepted: LinkSuggestion[]; remaining: LinkSuggestion[]; error: string | null }> {
  const accepted: LinkSuggestion[] = [];
  const groups = new Map<string, LinkSuggestion[]>();
  for (const s of suggestions) {
    const group = groups.get(s.source);
    if (group) group.push(s);
    else groups.set(s.source, [s]);
  }
  for (const group of groups.values()) {
    try {
      await acceptSourceGroup(group, io);
      accepted.push(...group);
      onProgress?.(accepted.length, suggestions.length);
    } catch (e) {
      const done = new Set(accepted.map((s) => s.key));
      return { accepted, remaining: suggestions.filter((s) => !done.has(s.key)), error: String(e) };
    }
  }
  return { accepted, remaining: [], error: null };
}

/** Append `- [[target]]` under a "## Related" section (created if absent).
 * Returns the original content unchanged if the wikilink is already there. */
export function appendWikilink(content: string, targetPath: string, vaultRoot?: string): string {
  return appendWikilinks(content, [targetPath], vaultRoot);
}

/** Scan and insert once even when thousands of targets share one document. */
function appendWikilinks(content: string, targets: string[], vaultRoot?: string): string {
  const existing = new Set<string>();
  for (let i = content.indexOf("[["); i >= 0; i = content.indexOf("[[", i + 2)) {
    const m = matchWikilinkAt(content, i);
    if (m) existing.add(wikilinkBase(m.target).replace(/\.md$/i, "").normalize("NFC").toLowerCase());
  }
  const lines: string[] = [];
  for (const path of targets) {
    const name = stem(path);
    // Precise paths distinguish two notes sharing a filename. Preserve the
    // legacy stem-only helper for callers without a known vault root.
    const target = vaultRoot ? suggestionRelativePath(path, vaultRoot).replace(/\.md$/i, "") : name;
    if (/[\]\n|#]/.test(target)) throw new Error("Cannot represent this note path as a wikilink");
    const key = target.normalize("NFC").toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    lines.push(`- [[${target}${vaultRoot ? `|${name}` : ""}]]`);
  }
  return lines.length ? appendUnderHeading(content, "Related", lines.join("\n")) : content;
}

/** UI defense in depth; native confinement and immutable-raw checks still apply. */
export function suggestionRelativePath(path: string, vaultRoot: string): string {
  const root = vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = path.replace(/\\/g, "/");
  if (!root || !normalized.startsWith(`${root}/`)) throw new Error("Link suggestion belongs to another vault");
  const relative = normalized.slice(root.length + 1);
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid link suggestion path");
  }
  if (/^(raw|sessions|_inbox|ingest-reports|daily|weekly|monthly)\//i.test(relative)) {
    throw new Error("Imported sources and generated notes are not link suggestions");
  }
  return relative;
}

/** Append `line` under the `## <heading>` section (created at the end if the
 * page has none). Returns the content unchanged when the line is already
 * there. Extracted from `appendWikilink` so the offline ingest's
 * `wiki/index.md` catalog line lands the same way (extractiveIngest.ts). */
export function appendUnderHeading(
  content: string,
  heading: string,
  line: string,
): string {
  if (content.includes(line)) return content;
  const m = new RegExp(`^##\\s+${heading}\\s*$`, "m").exec(content);
  if (m) {
    // Insert right after the heading line (and any blank line following it).
    const headEnd = m.index + m[0].length;
    const rest = content.slice(headEnd);
    const nl = rest.startsWith("\n") ? "" : "\n";
    return content.slice(0, headEnd) + nl + "\n" + line + rest.replace(/^\n/, "\n");
  }
  const sep = content.endsWith("\n") ? "" : "\n";
  return `${content}${sep}\n## ${heading}\n\n${line}\n`;
}

// --- dismissal persistence ---------------------------------------------------

const KEY = "myco.linkSuggestions.dismissed.v1";

export function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((x) => typeof x === "string"));
    if (!parsed || typeof parsed !== "object" || !("pages" in parsed) || !("pairs" in parsed)) return new Set();
    const { pages, pairs } = parsed;
    if (!Array.isArray(pages) || !pages.every((p) => typeof p === "string") || !Array.isArray(pairs)) return new Set();
    const keys = new Set<string>();
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [a, b] = pair;
      if (Number.isInteger(a) && Number.isInteger(b) && typeof pages[a] === "string" && typeof pages[b] === "string") keys.add(pairKey(pages[a], pages[b]));
    }
    if ("extra" in parsed && Array.isArray(parsed.extra)) for (const key of parsed.extra) if (typeof key === "string") keys.add(key);
    return keys;
  } catch {
    return new Set();
  }
}

export function saveDismissed(set: ReadonlySet<string>): void {
  // Page dictionary keeps a 28k-edge queue compact without forgetting older
  // decisions. Quota/unavailable errors reach the action's warning surface.
  const pages: string[] = [];
  const index = new Map<string, number>();
  const pairs: [number, number][] = [];
  const extra: string[] = [];
  const id = (path: string): number => {
    const current = index.get(path);
    if (current !== undefined) return current;
    const next = pages.length;
    pages.push(path);
    index.set(path, next);
    return next;
  };
  for (const key of set) {
    const parts = key.split("|");
    if (parts.length === 2) pairs.push([id(parts[0]), id(parts[1])]);
    else extra.push(key);
  }
  localStorage.setItem(KEY, JSON.stringify({ pages, pairs, extra }));
}
