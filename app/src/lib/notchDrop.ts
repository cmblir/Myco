// Drop → `_inbox/`. The notch and the menubar popover both receive drops; the
// rules for what a dropped thing IS, what it gets called, and what it carries
// live here once so neither surface owns them.
//
// The frontmatter spine mirrors `clip.rs` (`source`/`title` as double-quoted
// scalars, `created` as a unix INTEGER) so the readers that already exist take a
// dropped note unchanged: provenance.rs wants source/title as strings,
// distill.rs wants an integer `created`.
//
// Files are COPIED, never moved — the original on the user's disk is theirs.

import { classifyInboxEntry } from "./mediaIngest";
import type { InboxKind } from "./mediaIngest";

/** What landed on the surface. Files arrive as absolute paths (Tauri's
 *  drag-drop event), a link and a text selection each as one string. */
export type DropPayload =
  | { type: "files"; paths: string[] }
  | { type: "url"; url: string }
  | { type: "text"; text: string };

/** `InboxKind` (md | extract | image | media | unsupported) plus the two things
 *  that arrive without a file behind them. */
export type DropKind = InboxKind | "url" | "text";

export interface DropVerdict {
  kind: DropKind;
  /** Absolute path for a file; the raw URL or the raw text otherwise. */
  source: string;
  /** Basename / the URL / the opening words — the note title and the row the
   *  surface shows. */
  title: string;
  /** Only when `kind` is "unsupported": why, ready to show. */
  reason?: string;
}

/** English fallback for the S9 "받지 못했습니다" reason line, filled with the
 *  extension. The surface passes the localized string; this is what shows when
 *  the locale lacks the key (the `dropNoticeFor` convention). */
const UNSUPPORTED_FALLBACK = "This format can't be read yet ({ext})";

/** Provenance slug for everything this module writes — the `source:` bucket
 *  the inflow counters and provenance read. */
const DROP_SOURCE = "drop";

/** Opening words are the only name a bare text selection has (voice_markdown
 *  does the same with a transcript). */
const MAX_TITLE = 80;

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

/** Lowercased extension without the dot; "" when the name has none. */
function extOf(name: string): string {
  return /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, MAX_TITLE);
}

/** Filename-safe slug. Unicode letters survive — Korean titles are the norm
 *  here, and clip.rs's slug keeps them too (`char::is_alphanumeric`). */
function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DD-HHMM`, local — the stamp voice captures already use. */
function stamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

/**
 * What each dropped thing is, and for the ones nothing can read, why.
 *
 * Files route through `classifyInboxEntry` — the same judgement auto-ingest
 * makes when it walks `_inbox/`, so the surface never accepts something the
 * pipeline would later stare at. An empty link or selection yields no verdict
 * at all: nothing was dropped, so there is nothing to accept or refuse.
 */
export function classifyDrop(
  payload: DropPayload,
  unsupportedTemplate?: string,
): DropVerdict[] {
  if (payload.type === "url") {
    const url = payload.url.trim();
    return url ? [{ kind: "url", source: url, title: url }] : [];
  }
  if (payload.type === "text") {
    const title = firstLine(payload.text);
    return title ? [{ kind: "text", source: payload.text, title }] : [];
  }
  return payload.paths.map((path) => {
    const name = basename(path);
    const kind = classifyInboxEntry(name);
    if (kind !== "unsupported") return { kind, source: path, title: name };
    const ext = extOf(name);
    return {
      kind,
      source: path,
      title: name,
      // No extension (a folder, a bare `README`) — name the thing itself
      // rather than showing an empty pair of parentheses.
      reason: (unsupportedTemplate ?? UNSUPPORTED_FALLBACK).replace(
        "{ext}",
        ext ? `.${ext}` : name,
      ),
    };
  });
}

/**
 * Free `_inbox/` filename. A file keeps its own name (slugged) and extension so
 * the user recognizes it in the pending list; a link or a selection becomes
 * `drop-<slug>.md`. A name already `taken` gets `-2`, `-3`… — voice_inbox_rel's
 * rule, and the reason dropping the same file twice never clobbers the first.
 *
 * `taken` is compared case-insensitively: the vault normally sits on a
 * case-insensitive filesystem, where `Paper.pdf` and `paper.pdf` are one file.
 */
export function inboxFilename(
  kind: DropKind,
  hint: string,
  now: Date,
  taken: Iterable<string> = [],
): string {
  const isNote = kind === "url" || kind === "text";
  const name = basename(hint);
  const ext = isNote ? "md" : extOf(name);
  // A link's scheme and `www.` slug into noise nobody reads.
  const body = isNote
    ? slug(hint.replace(/^https?:\/\//, "").replace(/^www\./, ""))
    : slug(name.replace(/\.[^.]+$/, ""));
  const stem = isNote
    ? `drop-${body || stamp(now)}`
    : body || `drop-${stamp(now)}`;
  const suffix = ext ? `.${ext}` : "";
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  let candidate = `${stem}${suffix}`;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${stem}-${n}${suffix}`;
  }
  return candidate;
}

export interface InboxFrontmatter {
  /** No `source` field: it is always DROP_SOURCE (this module is the only
   *  writer), so passing it in only invited it to disagree with what is
   *  written. clip.rs writes `clipper`, voice writes `voice`, drops write `drop`. */
  title: string;
  /** Only for a dropped link. */
  url?: string;
  /** Unix SECONDS. distill.rs reads `created` as an integer. */
  created: number;
}

/** A double-quoted YAML scalar. Titles come off filenames and web pages, so
 *  they hold `:`, `#`, quotes and newlines — any of which turns a bare scalar
 *  into frontmatter that fails to parse or, worse, parses to something else.
 *  JSON string syntax IS a valid YAML double-quoted scalar and escapes exactly
 *  those characters (clip.rs's `yaml_str`, same trick). */
function yamlStr(s: string): string {
  return JSON.stringify(s);
}

/** The `_inbox/` frontmatter block, trailing blank line included. */
export function inboxFrontmatter(fm: InboxFrontmatter): string {
  // Not `fm.source`: this module is the only writer and always stamps the same
  // slug, so the field (and its defensive re-slug) was dead weight.
  const lines = [`source: ${DROP_SOURCE}`];
  if (fm.url) lines.push(`url: ${yamlStr(fm.url)}`);
  lines.push(`title: ${yamlStr(fm.title)}`);
  // Non-finite would render as `NaN` and break the integer contract; clip.rs's
  // now_secs falls back to 0 for the same reason.
  lines.push(
    `created: ${Number.isFinite(fm.created) ? Math.floor(fm.created) : 0}`,
  );
  return `---\n${lines.join("\n")}\n---\n\n`;
}

/** The markdown a link or a selection becomes — clip_markdown's shape: the
 *  frontmatter spine, an H1, then the source line or the quoted text. */
function noteBody(verdict: DropVerdict, created: number): string {
  const head =
    inboxFrontmatter({
      title: verdict.title,
      url: verdict.kind === "url" ? verdict.source : undefined,
      created,
    }) + `# ${verdict.title}\n\n`;
  if (verdict.kind === "url") return `${head}Source: ${verdict.source}\n`;
  return `${head}${verdict.source
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n")}\n`;
}

export interface DropDeps {
  /** Names already in `<vault>/_inbox/` — collision avoidance. */
  inboxNames: () => Promise<string[]>;
  /** COPY a dropped file in. Never a move: the original is the user's. */
  copyFile: (from: string, to: string) => Promise<unknown>;
  writeFile: (path: string, content: string) => Promise<unknown>;
  /** Epoch ms. Injected so names are stable under test. */
  now?: () => number;
  /** Localized "this format can't be read yet ({ext})" for the S9 line. */
  unsupportedTemplate?: string;
}

export interface DropOutcome {
  /** `<vault>/_inbox/<name>` for everything that landed. */
  written: string[];
  /** What nothing can read — each carries the reason to show. */
  rejected: DropVerdict[];
}

/**
 * Sit the drop in `<vault>/_inbox/`: files copied as they are, links and
 * selections written as markdown notes. Nothing is written when nothing is
 * readable — an unsupported drop reaches the disk not at all.
 *
 * ponytail: a failing copy/write aborts the rest of a multi-file drop rather
 * than reporting per item. One file is the normal drop; add per-item failure
 * rows if batch drops turn out to matter.
 */
export async function writeDrop(
  vaultPath: string,
  payload: DropPayload,
  deps: DropDeps,
): Promise<DropOutcome> {
  const verdicts = classifyDrop(payload, deps.unsupportedTemplate);
  const rejected = verdicts.filter((v) => v.kind === "unsupported");
  const accepted = verdicts.filter((v) => v.kind !== "unsupported");
  if (accepted.length === 0) return { written: [], rejected };

  const ms = deps.now?.() ?? Date.now();
  const at = new Date(ms);
  const created = Math.floor(ms / 1000);
  const taken = new Set(await deps.inboxNames());
  const written: string[] = [];
  for (const verdict of accepted) {
    const name = inboxFilename(verdict.kind, verdict.title, at, taken);
    // Claim it before the next one is named — two files of the same name in
    // ONE drop collide with each other, not just with the folder.
    taken.add(name);
    const dest = `${vaultPath}/_inbox/${name}`;
    if (verdict.kind === "url" || verdict.kind === "text") {
      await deps.writeFile(dest, noteBody(verdict, created));
    } else {
      await deps.copyFile(verdict.source, dest);
    }
    written.push(dest);
  }
  return { written, rejected };
}
