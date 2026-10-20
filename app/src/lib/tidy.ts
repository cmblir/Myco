// Tidy (정리) — Aside's one-button Tidy, for the vault: propose readable
// groups for the mess extractive session ingest left, apply what the user
// ticks, undo it. Spec: app/docs/specs/2026-09-28-tidy-and-graph-rails.md.
//
// The planner is pure (files in, groups out). It only ever proposes writes to
// wiki/ pages; transcripts under sessions/ and raw/ are read for their first
// prompt and never touched. Applying and undoing a plan is lib/tidyRun.ts.

import { sessionIdOf } from "./displayName";
import { getValue, parseFrontmatter, patchFrontmatter } from "./frontmatter";
import { frontmatterLength } from "./markdown";
import { sessionTitle } from "./sessionTitle";

/** A vault file: vault-relative path and its whole text. */
export interface TidyFile {
  path: string;
  raw: string;
}

export interface TidyInput {
  /** wiki/** pages — the only files Tidy writes. */
  pages: TidyFile[];
  /** Session transcripts under sessions/** or raw/** — read only. */
  transcripts: TidyFile[];
}

export type TidyKey = "titles" | "links" | "move";

/** One before → after line; `after` null = the Related bullet is removed. */
export interface TidyRow {
  path: string;
  before: string;
  after: string | null;
}

export interface TidyGroup {
  key: TidyKey;
  rows: TidyRow[];
}

export interface TidyPlan {
  /** Groups with something to do, in sheet order. */
  groups: TidyGroup[];
  /** Opaque pages no transcript was found for — named, never touched. */
  skipped: string[];
}

/** One file's whole change: its new text, and where it ends up. */
export interface TidyEdit {
  path: string;
  to: string;
  before: string;
  after: string;
}

const KEYS: TidyKey[] = ["titles", "links", "move"];

/** Tidy writes wiki/ pages and nothing else: raw/ is immutable and sessions/
 *  holds the transcripts it reads. */
export function isTidyWritable(path: string): boolean {
  return path.startsWith("wiki/") && !path.split("/").includes("..");
}

export const stemOf = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** Session id → readable title, by the transcript's stem and by its own
 *  `source` + `conversation_id` (either copy: sessions/ or ingest's raw/). */
function transcriptTitles(files: TidyFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const title = sessionTitle(f.raw);
    if (!title) continue;
    const source = /^source:[ \t]*(\S+)/m.exec(f.raw)?.[1];
    const conv = /^conversation_id:[ \t]*(\S+)/m.exec(f.raw)?.[1];
    for (const id of [
      sessionIdOf(stemOf(f.path)),
      sessionIdOf(`${source}-${conv}`),
    ]) {
      if (id && !out.has(id)) out.set(id, title);
    }
  }
  return out;
}

/** `title:` and an opaque H1 become `title`; the rest stays byte-identical. */
function retitle(raw: string, title: string): string {
  const next = patchFrontmatter(raw, { title }).raw;
  const head = frontmatterLength(next);
  const body = next
    .slice(head)
    .replace(/^#[ \t]+(.+?)[ \t]*$/m, (line, text: string) =>
      sessionIdOf(text) ? `# ${title}` : line,
    );
  return next.slice(0, head) + body;
}

const RELATED = /^##[ \t]+Related[ \t]*\r?\n?$/i;
const HEADING = /^#{1,6}[ \t]/;
const BULLET = /^\s*[-*+][ \t]/;
// Every `[[target(#anchor|alias)]]` on a line, with the `·` / `,` / `;` that
// joins it to the link before it, so cutting one link takes its separator too.
const LINK = /((?:[ \t]*[·,;][ \t]*)?)\[\[([^\]|#\n]+)((?:[#|][^\]\n]*)?)\]\]/g;

/** `## Related` bullets' links to a transcript stem (a session id with no
 *  page) point at its `source-` summary when there is one, and are cut
 *  otherwise; other links and text on the bullet stay, and a bullet left with
 *  no link goes. Prose, other sections and footnote definitions are never
 *  touched. */
function relinkRelated(
  raw: string,
  stems: ReadonlySet<string>,
): { raw: string; links: { from: string; to: string | null }[] } {
  const head = frontmatterLength(raw);
  const links: { from: string; to: string | null }[] = [];
  let inRelated = false;
  const kept: string[] = [];
  for (const line of raw.slice(head).split(/(?<=\n)/)) {
    if (HEADING.test(line)) inRelated = RELATED.test(line);
    if (!inRelated || !BULLET.test(line)) {
      kept.push(line);
      continue;
    }
    let touched = false;
    const next = line.replace(LINK, (all, sep: string, name: string, rest: string) => {
      const target = name.trim();
      if (
        !sessionIdOf(target) ||
        target.startsWith("source-") ||
        stems.has(target.toLowerCase())
      )
        return all;
      touched = true;
      const summary = `source-${target}`;
      if (!stems.has(summary.toLowerCase())) {
        links.push({ from: target, to: null });
        return "";
      }
      links.push({ from: target, to: summary });
      return `${sep}[[${summary}${rest}]]`;
    });
    if (!touched) kept.push(line);
    else if (next.includes("[[")) {
      kept.push(
        next
          .replace(/^(\s*[-*+])[ \t]+(?:[·,;][ \t]*)?/, "$1 ")
          .replace(/[ \t]+(\r?\n?)$/, "$1"),
      );
    }
  }
  return { raw: raw.slice(0, head) + kept.join(""), links };
}

const SESSION_SUMMARY = /^wiki\/source-(?:claude-code|codex)-[^/]+\.md$/;

interface PagePlan {
  page: TidyFile;
  current: string;
  /** New title; null = opaque but no transcript; undefined = already readable. */
  title: string | null | undefined;
  links: { from: string; to: string | null }[];
  relinked: string;
  moveTo: string | null;
}

function analyse(input: TidyInput): PagePlan[] {
  const pages = input.pages.filter((p) => isTidyWritable(p.path));
  const stems = new Set(pages.map((p) => stemOf(p.path).toLowerCase()));
  const paths = new Set(pages.map((p) => p.path));
  const titles = transcriptTitles(input.transcripts);
  return pages.map((page) => {
    const fm = parseFrontmatter(page.raw);
    const t = getValue(fm, "title");
    const current = (typeof t === "string" && t.trim()) || stemOf(page.path);
    const id = sessionIdOf(current);
    const { raw: relinked, links } = relinkRelated(page.raw, stems);
    const month = /^(\d{4}-\d{2})-\d{2}/.exec(
      String(getValue(fm, "created") ?? ""),
    )?.[1];
    const to =
      month && `wiki/sessions/${month}/${page.path.slice("wiki/".length)}`;
    return {
      page,
      current,
      title: id ? (titles.get(id) ?? null) : undefined,
      links,
      relinked,
      moveTo:
        to && SESSION_SUMMARY.test(page.path) && !paths.has(to) ? to : null,
    };
  });
}

/** What Tidy would do to `input`, as the sheet's groups. */
export function planTidy(input: TidyInput): TidyPlan {
  const rows: Record<TidyKey, TidyRow[]> = { titles: [], links: [], move: [] };
  const skipped: string[] = [];
  for (const p of analyse(input)) {
    const path = p.page.path;
    if (p.title === null) skipped.push(path);
    else if (p.title)
      rows.titles.push({ path, before: p.current, after: p.title });
    for (const l of p.links)
      rows.links.push({
        path,
        before: `[[${l.from}]]`,
        after: l.to ? `[[${l.to}]]` : null,
      });
    if (p.moveTo) rows.move.push({ path, before: path, after: p.moveTo });
  }
  return {
    groups: KEYS.filter((k) => rows[k].length).map((key) => ({
      key,
      rows: rows[key],
    })),
    skipped,
  };
}

/** The ticked groups, composed per file: one edit per page that changes. */
export function tidyEdits(
  input: TidyInput,
  keys: ReadonlySet<TidyKey>,
): TidyEdit[] {
  const edits: TidyEdit[] = [];
  for (const p of analyse(input)) {
    const { path, raw } = p.page;
    let after = keys.has("links") ? p.relinked : raw;
    if (keys.has("titles") && p.title) after = retitle(after, p.title);
    const to = keys.has("move") && p.moveTo ? p.moveTo : path;
    if (after !== raw || to !== path)
      edits.push({ path, to, before: raw, after });
  }
  return edits;
}
