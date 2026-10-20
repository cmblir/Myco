// Offline ingest preserves quoted evidence, with an optional bounded preview
// only when the user explicitly selects a verified local generator for ingest.
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
import { sessionTitle } from "./sessionTitle";
import { refreshSessionNote } from "./sessionNote";
import { sha256 } from "./tidyRun";
import { getValue, parseFrontmatter } from "./frontmatter";
import type { AgentVaultSession, CandidatePage, SessionCompileContext } from "./ipc";
import type { RoleSnapshot } from "./modelRoles";
import type { Lang, Strings } from "./i18n";
import { evidenceCoverage, evidenceSection, isMissingFile, nextEvidenceBatch, sourceEvidence } from "./sessionEvidence";
import { writeEvidenceNote, type EvidenceWriteIO } from "./evidenceWrite";
import { localTransformNote, LocalTransformSourceError, requireLocalTransformPreview, selectedLocalTransformModel, tryLocalTransform, type LocalTransformPreview } from "./localTransform";

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
// Paired with `validator::tests::offline_ingest_page_passes_validation` (and
// `offline_ingest_session_page_…`, the session-transcript case) in
// src-tauri/src/validator.rs: that test holds this function's output verbatim
// and runs the real validate_pages over it, so the frontmatter and citation
// contract cannot drift between the two languages unnoticed.
export function extractiveSummary(
  t: Strings,
  args: {
    slug: string;
    /** The source's path under raw/ without `.md`: `slug` itself unless
     *  ingest reused an archived copy (`archive/<month>/<slug>`). */
    source?: string;
    citationSlug?: string;
    summaryPath?: string;
    title: string;
    body: string;
    candidates: CandidatePage[];
    /** Stems of the pages the vault has — decides whether a transcript
     *  candidate has a summary to link instead. */
    pageStems?: ReadonlySet<string>;
    vaultTags: string[];
    now: Date;
  },
): ExtractiveSummary {
  const { slug, title, body, now } = args;
  const summaryTarget = args.summaryPath?.replace(/\.md$/, "") ?? `source-${slug}`;
  const passages = leadPassages(body);
  const tags = matchedTags(body, args.vaultTags);
  // A transcript (sessions/) is indexed but lives outside wiki/, so its stem
  // is a dangling link: point at its summary when one exists, else drop it.
  const pageStems = args.pageStems ?? new Set<string>();
  const related = args.candidates
    .flatMap((c) =>
      !c.page.startsWith("sessions/")
        ? [c.stem]
        : pageStems.has(`source-${c.stem}`)
          ? [`source-${c.stem}`]
          : [],
    )
    .slice(0, MAX_RELATED);
  const date = isoDate(now);
  const citationSlug = args.citationSlug ?? slug;
  const claims = passages.map((p) => `- ${p} [^src-${citationSlug}]`).join("\n");
  const note = t.ing_extractive_note.replace("{slug}", args.source ?? slug);

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
  content += args.source?.startsWith("conversations/")
    ? `\n[^src-${citationSlug}]: raw/${args.source}.md · [[${summaryTarget}]]\n`
    : `\n[^src-${citationSlug}]: [[${summaryTarget}]]` +
      (args.source && args.source !== slug ? ` · raw/${args.source}.md` : "") + "\n";

  return { rel: args.summaryPath ?? `wiki/source-${slug}.md`, content, passages, tags, related };
}

/** Append the catalog line under `wiki/index.md`'s `## Sources` heading
 *  (created if the vault's index has none yet). Idempotent. */
export function appendIndexEntry(indexMd: string, slug: string, title: string, previousTitle?: string, summaryTarget = `source-${slug}`): string {
  const prefix = `- [[${summaryTarget}]] — `;
  const legacyPrefix = `- [[source-${slug}]] — `;
  const line = `${prefix}${title}`;
  const old = indexMd.split("\n").find(row => row.startsWith(prefix) || row.startsWith(legacyPrefix));
  if (old) {
    const oldTitle = old.slice(old.startsWith(prefix) ? prefix.length : legacyPrefix.length);
    const next = `${prefix}${previousTitle !== undefined && oldTitle === previousTitle ? title : oldTitle}`;
    return indexMd.replace(old, () => next);
  }
  return appendUnderHeading(indexMd, "Sources", line);
}

/** Append one dated line to `wiki/log.md`. Chronological, so it goes at the
 *  end — the log is the one page whose order is time, not relevance. */
export function appendLogEntry(logMd: string, line: string): string {
  const sep = logMd.endsWith("\n") || logMd === "" ? "" : "\n";
  return `${logMd}${sep}\n${line}\n`;
}

/** The WHY report distinguishes quote-only runs from attempted local previews. */
export function extractiveReport(
  t: Strings,
  args: {
    slug: string;
    source?: string;
    title: string;
    summary: ExtractiveSummary;
    now: Date;
    localPreview?: LocalTransformPreview | null;
  },
): string {
  const { slug, title, summary } = args;
  const related = summary.related.length
    ? summary.related.map((s) => `[[${s}]]`).join(", ")
    : "—";
  return (
    // A function replacement: a title is a verbatim prompt, and a string one
    // would expand `$&`, `$'` and `$$` in it.
    `# ${t.ing_extractive_report_title.replace("{title}", () => title)}\n\n` +
    `${args.localPreview
      ? (args.localPreview.text ? t.local_transform_report_why : localTransformNote(args.localPreview, t))
      : t.ing_extractive_report_why}\n\n` +
    (args.localPreview?.text ? `${localTransformNote(args.localPreview, t)}\n\n` : "") +
    `- source: \`raw/${args.source ?? slug}.md\`\n` +
    `- summary: \`${summary.rel}\`\n` +
    `- passages quoted: ${summary.passages.length}\n` +
    `- tags reused: ${summary.tags.length ? summary.tags.join(", ") : "—"}\n` +
    `- related: ${related}\n` +
    `- confidence: low\n`
  );
}

/** File IO this module needs, injected so the whole pipeline is testable
 *  without Tauri — the same shape `LinkSuggestionIO` uses. */
export interface ExtractiveIngestIO extends EvidenceWriteIO {
  writeFile: (path: string, content: string) => Promise<unknown>;
  createFolder: (parent: string, name: string) => Promise<unknown>;
}

export interface ExtractiveIngestResult {
  /** Vault-relative paths written, in write order. */
  written: string[];
  summary: ExtractiveSummary;
  chunksProcessed: number;
  chunksPending: number;
  localPreview?: LocalTransformPreview | null;
}

/** Run one offline ingest, preserving evidence independently of its preview.
 * The caller has already saved immutable raw before this starts. */
export async function runExtractiveIngest(
  io: ExtractiveIngestIO,
  t: Strings,
  args: {
    vaultPath: string;
    origin?: AgentVaultSession;
    roleSnapshot?: RoleSnapshot;
    slug: string;
    /** See extractiveSummary's `source`. */
    source?: string;
    sessionKey?: string;
    sessionCompile?: SessionCompileContext;
    summaryPath?: string;
    title: string;
    body: string;
    candidates: CandidatePage[];
    pageStems?: ReadonlySet<string>;
    vaultTags: string[];
    now?: Date;
    localModelId?: string;
    lang?: Lang;
    signal?: AbortSignal;
  },
): Promise<ExtractiveIngestResult> {
  const now = args.now ?? new Date();
  const { vaultPath, slug } = args;
  const checkStopped = (): void => { if (args.signal?.aborted) throw new Error("cancelled"); };
  checkStopped();
  const localModelId = selectedLocalTransformModel("builtin-local", args.localModelId ?? "");
  const sourcePath = `raw/${args.source ?? slug}.md`;
  // The saved raw payload can include headings absent from the pasted body.
  const body = localModelId ? (await io.readFile(`${vaultPath}/${sourcePath}`)).raw : args.body;
  checkStopped();
  // A session transcript arrives titled by its opaque stem; name it by what
  // was asked instead, the way Tidy renames the summaries already written.
  const title = sessionTitle(body) ?? args.title;
  const evidence = sourceEvidence(sourcePath, body, isoDate(now));
  const citationSlug = args.sessionKey ? `${slug}-${(await sha256(`${sourcePath}\u0000${body}`)).slice(0, 12)}` : slug;
  const summary = extractiveSummary(t, { ...args, body, title, now, citationSlug });
  let localPreview: LocalTransformPreview | null = null;
  let previewSection = "";
  if (localModelId) {
    let existing = "";
    try { existing = (await io.readFile(`${vaultPath}/${summary.rel}`)).raw; }
    catch (error) { if (!isMissingFile(error)) throw error; }
    checkStopped();
    const batch = nextEvidenceBatch([evidence], existing);
    localPreview = await tryLocalTransform({ batch, vaultPath, kind: "ingest", modelId: localModelId,
      origin: args.origin, roleSnapshot: args.roleSnapshot,
      lang: args.lang, signal: args.signal, originals: new Map([[sourcePath, body]]), sessionCompile: args.sessionCompile });
    checkStopped();
    // Also verify fallback quotes: an unavailable model is not permission to
    // persist the earlier raw snapshot after an external source change.
    if (sourceEvidence(sourcePath, (await io.readFile(`${vaultPath}/${sourcePath}`)).raw, isoDate(now)).revision !== evidence.revision) {
      throw new LocalTransformSourceError("source_changed_during_generation");
    }
    checkStopped();
    if (batch.length) requireLocalTransformPreview(localPreview);
    if (localPreview) {
      const marker = `<!-- myco:local-preview ${JSON.stringify({ model: localModelId, source: sourcePath,
        revision: evidence.revision, batch_chunks: batch.map(chunk => chunk.id) })} -->`;
      previewSection = `\n${marker}\n_${localTransformNote(localPreview, t)}_\n` +
        (localPreview.text ? `\n${localPreview.text}\n` : "");
      const oldNote = t.ing_extractive_note.replace("{slug}", args.source ?? slug);
      summary.content = summary.content.replace(`_${oldNote}_\n\n`, "");
    }
  }

  const written: string[] = [];
  const write = async (rel: string, content: string): Promise<void> => {
    checkStopped();
    await io.writeFile(`${vaultPath}/${rel}`, content);
    written.push(rel);
    checkStopped();
  };
  // A vault missing wiki/ or ingest-reports/ is a vault someone scaffolded by
  // hand; create rather than fail. Other folder errors must propagate.
  const ensure = async (name: string): Promise<void> => {
    checkStopped();
    try { await io.createFolder(vaultPath, name); }
    catch (error) { if (!/already exists|\(os error 17\)/i.test(String(error))) throw error; }
    checkStopped();
  };

  await ensure("wiki");
  const summaryTarget = args.summaryPath?.replace(/\.md$/, "") ?? `source-${slug}`;
  // A retry appends only new evidence. The user's edits, title and earlier
  // source revisions remain untouched, including edits to generated quotes.
  const definition = args.source?.startsWith("conversations/")
    ? `[^src-${citationSlug}]: raw/${args.source}.md · [[${summaryTarget}]]`
    : `[^src-${citationSlug}]: [[${summaryTarget}]] · raw/${args.source ?? slug}.md`;
  const saved = await writeEvidenceNote(io, `${vaultPath}/${summary.rel}`, (existing) => {
    checkStopped();
    const batch = nextEvidenceBatch([evidence], existing ?? "");
    const section = evidenceSection([evidence], batch, { [evidence.path]: `[^src-${citationSlug}]` });
    const preview = previewSection && !existing?.includes(previewSection.split("\n")[1]) ? previewSection : "";
    let content = existing !== null
      ? existing + preview + section + (existing.includes(`[^src-${citationSlug}]:`) ? "" : `\n${definition}\n`)
      : summary.content + preview + section;
    if (args.sessionKey) content = refreshSessionNote(content, args.sessionKey, title, evidence.revision, isoDate(now), existing === null, body, batch);
    const previousTitle = getValue(parseFrontmatter(existing ?? ""), "session_generated_title");
    return { content, result: { content, chunksProcessed: batch.length,
      previousTitle: typeof previousTitle === "string" ? previousTitle.replace(/^Source: /, "") : undefined } };
  });
  summary.content = saved.content;
  written.push(summary.rel);
  checkStopped();
  const covered = evidenceCoverage(summary.content).get(`${evidence.path}\u0000${evidence.revision}`);
  const chunksPending = evidence.chunks.filter((chunk) => !covered?.has(chunk.id)).length;

  await writeEvidenceNote(io, `${vaultPath}/wiki/index.md`, (current) => {
    checkStopped();
    return { content: appendIndexEntry(current ?? "# Index\n", slug, title, args.sessionCompile ? undefined : saved.previousTitle, summaryTarget), result: undefined };
  });
  written.push("wiki/index.md");
  checkStopped();

  const line = localPreview
    ? `${isoDate(now)} — [[${summaryTarget}]] (${title}) · ${localTransformNote(localPreview, t)}`
    : t.ing_extractive_log
    .replace("{date}", isoDate(now))
    .replace("{slug}", slug)
    .replace("{title}", () => title)
    .replace(`[[source-${slug}]]`, () => `[[${summaryTarget}]]`);
  await writeEvidenceNote(io, `${vaultPath}/wiki/log.md`, (current) => {
    checkStopped();
    return { content: appendLogEntry(current ?? "# Log\n", `- ${line}`), result: undefined };
  });
  written.push("wiki/log.md");
  checkStopped();

  await ensure("ingest-reports");
  await write(
    args.sessionCompile?.reportPath ?? reportRel(slug, now),
    extractiveReport(t, { slug, source: args.source, title, summary, now, localPreview }),
  );

  return { written, summary, chunksProcessed: saved.chunksProcessed, chunksPending,
    ...(localPreview ? { localPreview } : {}) };
}
