// Pure derivations behind the reader's single rail (mockup "Manuscript"):
// the merged Connections list, this note's citation coverage, and the minimal
// range one text insertion covers. Kept out of the components so they are
// testable in the node environment.

import type { ProvenanceRow, SourceRef, TierWeights, VecHit } from "./ipc";
import { hitTier, sourceTier } from "./extractive";
import type { LinkSuggestion } from "./linkSuggestions";
import { stem } from "./graphData";
import { stripFrontmatter } from "./markdown";
import { matchWikilinkAt, wikilinkBase } from "./wikilinks";

export interface ConnRow {
  /** Backlinks first, then semantic neighbours, then unaccepted suggestions. */
  kind: "backlink" | "related" | "suggested";
  /** Absolute vault path the row opens. */
  path: string;
  name: string;
  /** Similarity, 0..1 — semantic rows only. */
  score?: number;
  /** The suggestion this row stands for; `suggested` rows only. */
  suggestion?: LinkSuggestion;
  /** The sentence that links here; `backlink` rows only, when one was found. */
  context?: LinkContext;
}

/**
 * Backlinks + related + this page's link suggestions as ONE list, deduped by
 * target path with the strongest relationship winning (a page that links here
 * is a backlink, not a "similar note"). Suggestions are oriented so `path` is
 * always the OTHER page — accepting one appends the wikilink to THIS note.
 */
export function connectionRows(args: {
  filePath: string;
  /** adjacency.backward[filePath]. */
  backward: readonly string[] | undefined;
  /** related_pages hits (vault-RELATIVE pages), or null while unknown. */
  related: readonly VecHit[] | null;
  vaultRoot: string;
  suggestions: readonly LinkSuggestion[];
  /** Linking sentence per backlink path (linkContext of that note's text). */
  contexts?: ReadonlyMap<string, LinkContext>;
}): ConnRow[] {
  const { filePath, backward, related, vaultRoot, suggestions, contexts } = args;
  const out: ConnRow[] = [];
  const seen = new Set<string>([filePath]);
  const push = (row: ConnRow): void => {
    if (seen.has(row.path)) return;
    seen.add(row.path);
    out.push(row);
  };
  for (const p of backward ?? []) {
    const context = contexts?.get(p);
    push({ kind: "backlink", path: p, name: stem(p), ...(context ? { context } : {}) });
  }
  for (const h of related ?? []) {
    const abs = vaultRoot ? `${vaultRoot}/${h.page}` : h.page;
    push({ kind: "related", path: abs, name: h.stem, score: h.score });
  }
  for (const s of suggestions) {
    const other = s.source === filePath ? s.target : s.source;
    push({
      kind: "suggested",
      path: other,
      name: stem(other),
      score: s.score,
      // Oriented: acceptSuggestion writes to `source`, and the note being read
      // is the one that should gain the link.
      suggestion: { ...s, source: filePath, target: other },
    });
  }
  return out;
}

/** Why a note links here: the sentence holding the link, verbatim, with the
 *  link itself apart so the row can mark it. `before` / `after` carry a `…`
 *  where the sentence was trimmed. */
export interface LinkContext {
  before: string;
  link: string;
  after: string;
}

/** Context budget in display cells (a Latin char is one, a wide char two;
 *  the 266px rail holds ~44 a line). The lead-in stays short and never takes
 *  the after side's room, so the link starts on line 1 and ends by line 2
 *  whatever the script: the 3-line clamp may then cut only the after side. */
const CTX_BEFORE = 30;
/** Lead-in plus link: a long link leaves less before it. */
const CTX_LINK = 80;
/** Everything (the old 100-char context plus a short link); the after side
 *  gets what the other two leave. */
const CTX_TOTAL = 105;

// East Asian Wide/Fullwidth blocks and emoji — two cells each. ponytail: a
// block-range approximation of EastAsianWidth.txt; exact enough for a budget.
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;
const cells = (c: string): number => (WIDE.test(c) ? 2 : 1);
const width = (s: string): number => Array.from(s).reduce((w, c) => w + cells(c), 0);

/** How many of `cp`, from the front, fit in `room` cells. */
function fits(cp: readonly string[], room: number): number {
  let n = 0;
  for (let w = 0; n < cp.length && (w += cells(cp[n])) <= room; n++);
  return n;
}

// A sentence ends at terminal punctuation (and the citations / closers that
// follow it) before whitespace. ponytail: "e.g. " ends a sentence too — an
// abbreviation list would fix it; the row still shows real, verbatim text.
// Group 1 is the char before the run, so a match can only start where a run
// does: starting inside one re-read the rest of it every time, quadratic on
// a long `....` (no lookbehind — the 10.15 WebKit floor, Q5).
const SENTENCE_END = /(^|[^.!?。！？])([.!?。！？]+(?:\[\^[^\]\s]+\])*["'”’)\]]*)(?=\s|$)/g;
// Quote, callout, list, task and heading markers — not part of the sentence.
const BLOCK_PREFIX =
  /^\s*(?:>\s?)*\s*(?:\[![^\]]+\][+-]?\s*)?(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?(?:#{1,6}\s+)?/;
// Context with no letters or pictographs — `— `, `!`, `**…** · 68%`, `→` —
// says no more than a bare bullet: the app's own quote attribution, Ask source
// line and embed. Emoji (\p{So}) and every script still count as words.
const WORDLESS = /^[\s\p{P}\p{N}\p{Sm}\p{Sk}]*$/u;
const FOOTNOTE_DEF = /^\[\^([^\]]+)\]:/;
// A fence run and the rest of its line (the info string, or a closer's tail).
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/** Name key the link graph resolves by (index.rs resolve_links): the target
 *  before `#`, trailing `\` trimmed (parser.rs: `[[a\|alias]]` in a table,
 *  `[[a\]]`), its last path segment, `.md` dropped, NFC, lowercase. */
function linkKey(target: string): string {
  const base =
    wikilinkBase(target).replace(/\\+$/, "").trim().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.md$/i, "").normalize("NFC").toLowerCase();
}

/** `[from, to)` of every wikilink on the line, and the ones naming `want`. */
function wikilinks(text: string, want: string): { all: [number, number][]; hits: [number, number][] } {
  const all: [number, number][] = [];
  const hits: [number, number][] = [];
  for (let i = text.indexOf("[["); i >= 0; i = text.indexOf("[[", i + 2)) {
    const m = matchWikilinkAt(text, i);
    if (!m) continue;
    all.push([i, m.end]);
    if (linkKey(m.target) === want) hits.push([i, m.end]);
  }
  return { all, hits };
}

/** The sentence around `[s, e)` on one line — never split inside a wikilink;
 *  a table row also ends at its cell's pipes. Null when the link stands alone
 *  (a `## Related` bullet says nothing about why). */
function sentenceAround(
  text: string,
  s: number,
  e: number,
  links: readonly [number, number][],
  table: boolean,
): LinkContext | null {
  const inLink = (i: number): boolean => links.some(([a, b]) => i >= a && i < b);
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(SENTENCE_END)) {
    const at = m.index + m[1].length;
    if (inLink(at)) continue;
    const b = at + m[2].length;
    if (b <= s) start = b;
    else {
      // Past the span, or a citation right after a period that IS the span
      // (`summed.[^s1]`): either way this is where its sentence ends.
      end = Math.max(b, e);
      break;
    }
  }
  if (table)
    for (let i = text.indexOf("|"); i >= 0; i = text.indexOf("|", i + 1)) {
      if (inLink(i)) continue;
      if (i < s) start = Math.max(start, i + 1);
      else if (i >= e) {
        end = Math.min(end, i);
        break;
      }
    }
  const before = text.slice(start, s).trimStart();
  const after = text.slice(e, end).trimEnd();
  if (WORDLESS.test(before + after)) return null;
  const link = text.slice(s, e);
  const lw = width(link);
  const lead = keepEnd(before, Math.max(0, Math.min(CTX_BEFORE, CTX_LINK - lw)));
  return { before: lead, link, after: keepStart(after, Math.max(0, CTX_TOTAL - width(lead) - lw)) };
}

/** The last `room` cells, starting on a word when the text has spaces. */
function keepEnd(s: string, room: number): string {
  const cp = Array.from(s);
  const n = fits([...cp].reverse(), room);
  if (n === cp.length) return s;
  let tail = cp.slice(cp.length - n).join("");
  const sp = tail.search(/\s/);
  if (!/\s/.test(cp[cp.length - n - 1]) && sp >= 0 && sp < tail.length - 1)
    tail = tail.slice(sp + 1);
  return `…${tail}`;
}

/** The first `room` cells, ending on a word when the text has spaces. */
function keepStart(s: string, room: number): string {
  const cp = Array.from(s);
  const n = fits(cp, room);
  if (n === cp.length) return s;
  let head = cp.slice(0, n).join("");
  const sp = head.search(/\s\S*$/);
  if (!/\s/.test(cp[n]) && sp > 0) head = head.slice(0, sp);
  return `${head.trimEnd()}…`;
}

/**
 * Why `markdown` (a note that links here) links to `targetStem`: the first
 * sentence in its body holding such a link with words around it. A link
 * held only by a footnote (`[^s]: [[target]]`) is explained by the sentence
 * citing `[^s]`, which is then the marked part. Frontmatter and fenced code
 * are skipped. Null when no link has a sentence.
 *
 * ponytail: one line is one paragraph (how this wiki is written); a
 * hard-wrapped paragraph yields the line's part of the sentence.
 */
export function linkContext(markdown: string, targetStem: string): LinkContext | null {
  const want = linkKey(targetStem);
  const body: { text: string; table: boolean }[] = [];
  const notes: string[] = [];
  // CommonMark, as Preview renders it: a backtick info string holding a
  // backtick is no fence (```x``` is inline code), and only a bare run of
  // the opener's char, at least as long, closes it.
  let fence: { ch: string; len: number } | null = null;
  for (const raw of stripFrontmatter(markdown).normalize("NFC").split("\n")) {
    const f = FENCE.exec(raw);
    if (fence !== null) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !f[2].trim()) fence = null;
      continue;
    }
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = { ch: f[1][0], len: f[1].length };
      continue;
    }
    const def = FOOTNOTE_DEF.exec(raw);
    if (def) {
      if (wikilinks(raw, want).hits.length > 0) notes.push(def[1]);
      continue;
    }
    const text = raw.slice(BLOCK_PREFIX.exec(raw)?.[0].length ?? 0);
    body.push({ text, table: text.startsWith("|") });
  }
  for (const { text, table } of body) {
    const { all, hits } = wikilinks(text, want);
    for (const [s, e] of hits) {
      const c = sentenceAround(text, s, e, all, table);
      if (c) return c;
    }
  }
  for (const id of notes) {
    const ref = `[^${id}]`;
    for (const { text, table } of body) {
      const s = text.indexOf(ref);
      if (s < 0) continue;
      const c = sentenceAround(text, s, s + ref.length, wikilinks(text, want).all, table);
      if (c) return c;
    }
  }
  return null;
}

export interface SourceView {
  ref: SourceRef;
  /** The tier prior Ask applies to the layer this citation resolves into;
   *  null when no raw file backs it (a dangling citation has no trust). */
  weight: number | null;
}

export interface SourcesView {
  cited: number;
  total: number;
  uncited: number;
  /** Cited claims as a whole percent; 0 when the note makes no claims. */
  pct: number;
  sources: SourceView[];
}

/** This note's row out of the vault-wide provenance scan. `null` = not scanned
 *  yet, or the scan has no row for this path (a file with no claims at all). */
export function sourcesView(
  rows: readonly ProvenanceRow[] | null,
  filePath: string,
  weights: TierWeights,
): SourcesView | null {
  const row = rows?.find((r) => r.path === filePath);
  if (!row) return null;
  return {
    cited: row.cited,
    total: row.total,
    uncited: Math.max(0, row.total - row.cited),
    pct: row.total === 0 ? 0 : Math.round((row.cited / row.total) * 100),
    sources: row.sources.map((ref) => ({ ref, weight: sourceWeight(ref, weights) })),
  };
}

function sourceWeight(ref: SourceRef, weights: TierWeights): number | null {
  if (!ref.resolved) return null;
  return weights[hitTier(sourceTier(`raw/${ref.slug}.md`))];
}

/** The one changed range between two texts (common prefix / suffix trimmed),
 *  so an append can be dispatched into the open editor without replacing the
 *  whole document — which would drop the caret and swallow undo history. */
export function insertionRange(
  before: string,
  after: string,
): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  let from = 0;
  while (from < before.length && before[from] === after[from]) from++;
  let tail = 0;
  const max = Math.min(before.length, after.length) - from;
  while (
    tail < max &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  return {
    from,
    to: before.length - tail,
    insert: after.slice(from, after.length - tail),
  };
}

/** Width the note and the rail need side by side: the note's 22rem basis, the
 *  rail's 18rem and the 1.5rem gap (styles.css `.reader-body--rail`). */
const RAIL_BESIDE_REM = 22 + 18 + 1.5;
/** Under this the note is cramped beside the rail (its old 30rem basis). */
const RAIL_ROOMY_REM = 30 + 18 + 1.5;

/** Under this window width the rail always opens as a sheet (owner default 5). */
const SHEET_WINDOW_PX = 960;

/** The rail opens as an overlay sheet (scrim, Esc, focus back to its button)
 *  in a narrow window or a reader body too narrow for both columns (a split
 *  beside Ask). Laid over the note's edge inline, it covered the text. */
export function railIsSheet(bodyPx: number, windowPx: number, remPx: number): boolean {
  return windowPx < SHEET_WINDOW_PX || bodyPx < RAIL_BESIDE_REM * remPx;
}

/** Opening the rail folds the sidebar only when the note is cramped beside it
 *  and the width the fold hands this pane (`gainPx`: the sidebar's width, or
 *  a split pane's share of it) puts the rail beside the note. */
export function railFoldsSidebar(bodyPx: number, gainPx: number, remPx: number): boolean {
  return (
    gainPx > 0 &&
    bodyPx < RAIL_ROOMY_REM * remPx &&
    bodyPx + gainPx >= RAIL_BESIDE_REM * remPx
  );
}

/** A source's `created` for its row (S29): the importer's epoch seconds as
 *  a date in the app's language; a date string as written. */
export function sourceCreated(created: string, lang: string): string {
  if (!/^\d{9,11}$/.test(created)) return created;
  return new Intl.DateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric" }).format(
    Number(created) * 1000,
  );
}
