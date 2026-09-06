// Offline ingest for the `builtin-local` provider — the writing half of the
// same bargain extractive Ask struck (see extractive.ts): no chat GGUF ships,
// so instead of asking a model that isn't there to summarise, QUOTE the
// source. Every claim line is a verbatim passage from `raw/<slug>.md` with a
// `[^src-<slug>]` citation; nothing here writes a sentence the source did not
// already contain.
//
// It produces exactly the file set the LLM ingest path produces — the
// `wiki/source-<slug>.md` summary, the `wiki/index.md` catalog line, the
// `wiki/log.md` entry and an `ingest-reports/` WHY report — so everything
// downstream of `startIngest` (the wiki-changed check, `validate_ingest`, the
// report-path discovery) works unchanged. `raw/<slug>.md` itself is NOT
// written here: startIngest's own `writeRaw` already did it, after the
// judgement gate, and `raw/` is immutable afterwards.
//
// Tags and links are reused, never invented: tags come from the vault's own
// tag index (only tags that already exist AND literally occur in the source),
// and `## Related` links come from the embedder's `wikify_candidates` ranking,
// inserted with linkSuggestions' own `appendWikilink`.

import { quoteBody } from "./extractive";
import { appendUnderHeading, appendWikilink } from "./linkSuggestions";
import { stripFrontmatter } from "./markdown";
import type { CandidatePage } from "./ipc";
import type { Strings } from "./i18n";

/** Passages quoted onto the summary page. Five is the same order as the
 *  extractive Ask answer's page cap — enough to represent a source, short
 *  enough that the page stays a summary. */
const MAX_PASSAGES = 5;
/** Per-passage quote budget, cut through `quoteBody` (line-safe, "…"). */
const PASSAGE_CHARS = 400;
/** Blocks shorter than this are headings, captions, list scaffolding or
 *  stray metadata — not claims worth quoting. */
const MIN_PASSAGE_CHARS = 40;
/** `## Related` wikilinks. */
const MAX_RELATED = 5;
/** Tags carried over from the vault's existing vocabulary. */
const MAX_TAGS = 4;

/** Verbatim passages from `text`, lead-first — the classic extractive
 * baseline, and the only selection that cannot misrepresent a source we have
 * no model to read.
 *
 * Each passage is one line: internal newlines collapse to spaces so a passage
 * survives as a single markdown list item with its citation at the end.
 * Frontmatter, ATX headings, fenced code and anything under
 * `MIN_PASSAGE_CHARS` are skipped. Footnote references (`[^…]`) are stripped
 * out of the quoted text on purpose: copied through, a stray `[^src-other]`
 * in the source would become a DANGLING CITATION — a hard validator error
 * that would fail the whole ingest over a marker the source, not this page,
 * owns. */
export function leadPassages(
  text: string,
  max = MAX_PASSAGES,
  perPassageChars = PASSAGE_CHARS,
): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const block of stripFrontmatter(text).split(/\n\s*\n/)) {
    if (out.length >= max) break;
    const raw = block.trim();
    if (!raw) continue;
    // A fence can open in one block and close in another; track it across the
    // whole document rather than per block.
    const fences = (raw.match(/^```/gm) ?? []).length;
    const startedFenced = fenced;
    if (fences % 2 !== 0) fenced = !fenced;
    if (startedFenced || raw.startsWith("```")) continue;
    if (/^#{1,6}\s/.test(raw)) continue; // heading
    const flat = raw
      .replace(/\[\^[^\]]*\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (flat.length < MIN_PASSAGE_CHARS) continue;
    out.push(quoteBody([flat], perPassageChars));
  }
  return out;
}

/** Existing vault tags that literally occur in the source, most-frequent tag
 * first (the order `tagCandidates` already ranks them in). No tag is ever
 * coined here — an offline run can only reuse the vocabulary the vault has. */
export function matchedTags(text: string, vaultTags: string[], max = MAX_TAGS): string[] {
  const haystack = text.toLowerCase();
  return vaultTags
    .filter((tag) => tag.length > 1 && haystack.includes(tag.toLowerCase()))
    .slice(0, max);
}

function yamlTagList(tags: string[]): string {
  return tags.map((tag) => `  - ${tag}\n`).join("");
}

/** `YYYY-MM-DD` in the caller's local time — the frontmatter date format the
 *  vault contract uses (`vault.rs`'s VAULT_CLAUDE_MD). */
export function isoDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `ingest-reports/<date>-<time>-<slug>.md`. The time component keeps two
 *  runs of the same slug on the same day from colliding, and the `-<slug>.md`
 *  suffix is what `startIngest` matches on to open the report. */
export function reportRel(slug: string, now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `ingest-reports/${isoDate(now)}-${time}-${slug}.md`;
}

export interface ExtractiveSummary {
  /** Vault-relative path of the summary page. */
  rel: string;
  content: string;
  passages: string[];
  tags: string[];
  /** Stems linked under `## Related`. */
  related: string[];
}

/** Build `wiki/source-<slug>.md`: the project's frontmatter contract, one
 * cited list item per quoted passage, and the candidates as `## Related`
 * wikilinks. `confidence: low` because nothing read this source for meaning —
 * the report says so in as many words. */
// Paired with `validator::tests::offline_ingest_page_passes_validation` in
// src-tauri/src/validator.rs: that test holds this function's output verbatim
// and runs the real validate_pages over it, so the frontmatter and citation
// contract cannot drift between the two languages unnoticed.
export function extractiveSummary(
  t: Strings,
  args: {
    slug: string;
    title: string;
    body: string;
    candidates: CandidatePage[];
    vaultTags: string[];
    now: Date;
  },
): ExtractiveSummary {
  const { slug, title, body, now } = args;
  const passages = leadPassages(body);
  const tags = matchedTags(body, args.vaultTags);
  const related = args.candidates.slice(0, MAX_RELATED).map((c) => c.stem);
  const date = isoDate(now);
  const claims = passages.map((p) => `- ${p} [^src-${slug}]`).join("\n");
  const note = t.ing_extractive_note.replace("{slug}", slug);

  let content =
    `---\n` +
    `title: ${JSON.stringify(`Source: ${title}`)}\n` +
    `type: source-summary\n` +
    `tags:\n` +
    yamlTagList(["source-summary", ...tags]) +
    `created: ${date}\n` +
    `last_updated: ${date}\n` +
    `source_count: 1\n` +
    `confidence: low\n` +
    `status: active\n` +
    `---\n\n` +
    `# Source: ${title}\n\n` +
    `_${note}_\n\n` +
    (claims ? `${claims}\n` : "");
  // The exact insertion linkSuggestions' accept-a-suggestion flow performs,
  // so a `## Related` section written here and one grown by hand are the same
  // section. Done BEFORE the footnote definition so the definition stays last,
  // as it is on every `wiki/source-*.md` the sample vault ships.
  for (const stem of related) content = appendWikilink(content, stem);
  content += `\n[^src-${slug}]: [[source-${slug}]]\n`;

  return { rel: `wiki/source-${slug}.md`, content, passages, tags, related };
}

/** Append the catalog line under `wiki/index.md`'s `## Sources` heading
 *  (created if the vault's index has none yet). Idempotent. */
export function appendIndexEntry(indexMd: string, slug: string, title: string): string {
  return appendUnderHeading(indexMd, "Sources", `- [[source-${slug}]] — ${title}`);
}

/** Append one dated line to `wiki/log.md`. Chronological, so it goes at the
 *  end — the log is the one page whose order is time, not relevance. */
export function appendLogEntry(logMd: string, line: string): string {
  const sep = logMd.endsWith("\n") || logMd === "" ? "" : "\n";
  return `${logMd}${sep}\n${line}\n`;
}

/** The WHY report. States plainly that the run was extractive and made no
 *  model call — the one claim a reader most needs in order to judge the page
 *  it produced. */
export function extractiveReport(
  t: Strings,
  args: { slug: string; title: string; summary: ExtractiveSummary; now: Date },
): string {
  const { slug, title, summary } = args;
  const related = summary.related.length
    ? summary.related.map((s) => `[[${s}]]`).join(", ")
    : "—";
  return (
    `# ${t.ing_extractive_report_title.replace("{title}", title)}\n\n` +
    `${t.ing_extractive_report_why}\n\n` +
    `- source: \`raw/${slug}.md\`\n` +
    `- summary: \`wiki/source-${slug}.md\`\n` +
    `- passages quoted: ${summary.passages.length}\n` +
    `- tags reused: ${summary.tags.length ? summary.tags.join(", ") : "—"}\n` +
    `- related: ${related}\n` +
    `- confidence: low\n`
  );
}

/** File IO this module needs, injected so the whole pipeline is testable
 *  without Tauri — the same shape `LinkSuggestionIO` uses. */
export interface ExtractiveIngestIO {
  readFile: (path: string) => Promise<{ raw: string }>;
  writeFile: (path: string, content: string) => Promise<unknown>;
  createFolder: (parent: string, name: string) => Promise<unknown>;
}

export interface ExtractiveIngestResult {
  /** Vault-relative paths written, in write order. */
  written: string[];
  summary: ExtractiveSummary;
}

/** Run one offline ingest: summary page → index line → log line → report.
 * Zero model calls. `raw/<slug>.md` is the caller's (startIngest's) job and is
 * already on disk by the time this runs. */
export async function runExtractiveIngest(
  io: ExtractiveIngestIO,
  t: Strings,
  args: {
    vaultPath: string;
    slug: string;
    title: string;
    body: string;
    candidates: CandidatePage[];
    vaultTags: string[];
    now?: Date;
  },
): Promise<ExtractiveIngestResult> {
  const now = args.now ?? new Date();
  const { vaultPath, slug, title } = args;
  const summary = extractiveSummary(t, { ...args, now });

  const written: string[] = [];
  const write = async (rel: string, content: string): Promise<void> => {
    await io.writeFile(`${vaultPath}/${rel}`, content);
    written.push(rel);
  };
  // A vault missing wiki/ or ingest-reports/ is a vault someone scaffolded by
  // hand; create rather than fail, same best-effort idiom as writeRaw.
  const ensure = async (name: string): Promise<void> => {
    await io.createFolder(vaultPath, name).catch(() => undefined);
  };
  const readOr = async (rel: string, fallback: string): Promise<string> =>
    io.readFile(`${vaultPath}/${rel}`).then(
      (f) => f.raw,
      () => fallback,
    );

  await ensure("wiki");
  await write(summary.rel, summary.content);

  const index = await readOr("wiki/index.md", "# Index\n");
  await write("wiki/index.md", appendIndexEntry(index, slug, title));

  const logMd = await readOr("wiki/log.md", "# Log\n");
  const line = t.ing_extractive_log
    .replace("{date}", isoDate(now))
    .replace("{slug}", slug)
    .replace("{title}", title);
  await write("wiki/log.md", appendLogEntry(logMd, `- ${line}`));

  await ensure("ingest-reports");
  await write(reportRel(slug, now), extractiveReport(t, { slug, title, summary, now }));

  return { written, summary };
}
