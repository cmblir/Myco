// Lossless, revision-bound evidence for digest previews. A small preview may
// omit a quote; a coverage receipt may never omit input and call it complete.

export const EVIDENCE_BATCH_SIZE = 48;
export const EVIDENCE_CHUNK_CHARS = 600;
const CHUNK_OVERLAP_CHARS = 80;
const RECEIPT_OPEN = "<!-- myco:evidence-coverage ";
const RECEIPT_CLOSE = " -->";

export interface EvidenceChunk {
  id: string;
  source: string;
  revision: string;
  title: string;
  role: string;
  turnId?: string;
  timestamp?: string;
  phase?: string;
  originalRole?: string;
  /** UTF-16 offsets within the normalized turn, not byte offsets in raw/. */
  start: number;
  end: number;
  text: string;
  topics: string[];
  decisionMention: boolean;
}

export interface EvidenceSource {
  path: string;
  revision: string;
  chunks: EvidenceChunk[];
}

interface CoverageReceipt {
  version: 1;
  source: string;
  revision: string;
  chunks: string[];
  total: number;
  evidenceHash: string;
}

/** Content identity shared with Rust's digest markers. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h = Math.imul(h ^ b, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const DECISION_MENTION =
  /\b(?:decid(?:e[ds]?|ing)|decision|agreed|approved|cancel(?:led|ed)?|supersed(?:e[ds]?|ing)|revert(?:ed)?|rejected)\b|결정|합의|승인|취소|철회/iu;

function frontmatter(raw: string): { body: string; fields: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  return match
    ? { fields: match[1], body: raw.slice(match[0].length) }
    : { fields: "", body: raw };
}

function turnMetadata(fields: string): Record<string, unknown>[] | null {
  const line = /^turn_metadata:\s*(\[[^\r\n]*\])\s*$/m.exec(fields)?.[1];
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return Array.isArray(parsed) && parsed.every(value =>
      value && typeof value === "object" && !Array.isArray(value))
      ? parsed as Record<string, unknown>[] : null;
  } catch {
    return null;
  }
}

function field(
  metadata: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = metadata[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sourceDate(fields: string): string | undefined {
  const value = /^created:\s*([^\r\n]+)\s*$/m
    .exec(fields)?.[1]
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!value) return undefined;
  if (/^\d{9,11}$/.test(value)) {
    const date = new Date(Number(value) * 1_000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

/** Split every turn, including short names and the tail of long messages.
 * Metadata comes from the importer's ordinal-aligned turn_metadata array.
 * Classification labels only a mention; it never asserts a decision is final. */
export function sourceEvidence(
  path: string,
  raw: string,
  fallbackDate: string,
): EvidenceSource {
  const revision = fingerprint(raw);
  const { body, fields } = frontmatter(raw);
  const created = sourceDate(fields) ?? fallbackDate;
  const title =
    /^#\s+(.+)$/m.exec(body)?.[1].trim() ||
    path.split("/").pop()?.replace(/\.md$/, "") ||
    path;
  const metadata = turnMetadata(fields);
  const hasTurnMetadata = /^turn_metadata:\s*/m.test(fields);
  const headers = [
    ...body.matchAll(/^\*\*(User|Assistant|System|Tool):\*\*\s*$/gm),
  ];
  // Literal role markers inside a message can shift every later ordinal.
  // Explicit importer metadata must match the complete header contract.
  const hasAlignedTurnMetadata = metadata !== null && metadata.length === headers.length;
  const turns = headers.length
    ? headers.map((header, ordinal) => ({
        role: hasTurnMetadata && !hasAlignedTurnMetadata ? "Unknown" : header[1],
        text: body.slice(
          (header.index ?? 0) + header[0].length,
          headers[ordinal + 1]?.index ?? body.length,
        ),
        metadata: hasAlignedTurnMetadata && metadata ? metadata[ordinal] : {},
      }))
    : [{ role: "Source", text: body, metadata: {} as Record<string, unknown> }];
  if (headers.length) {
    const preamble = body.slice(0, headers[0].index).trim();
    if (preamble) turns.push({ role: "Source", text: preamble, metadata: {} });
  }
  const chunks: EvidenceChunk[] = [];
  turns.forEach((turn, ordinal) => {
    // Only our machine receipts are scaffolding. Semantic headings, human
    // comments and short names are evidence and must not disappear.
    const text = turn.text
      .replace(
        /<!--\s*myco:(?:evidence-coverage|digested-sessions|rolled-up-days)\s[\s\S]*?-->/g,
        "",
      )
      .trim();
    const turnId = field(turn.metadata, "message_id");
    let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + EVIDENCE_CHUNK_CHARS);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const quote = text.slice(start, end);
      const topics = [...quote.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map(
        (match) => match[1].trim(),
      );
      chunks.push({
        id: `${ordinal}:${start}-${end}`,
        source: path,
        revision,
        title,
        role: turn.role,
        turnId,
        timestamp:
          field(turn.metadata, "timestamp") ??
          (hasTurnMetadata ? undefined : created),
        phase: field(turn.metadata, "phase"),
        originalRole: field(turn.metadata, "original_role"),
        start,
        end,
        text: quote,
        topics: [...new Set(topics)],
        decisionMention: DECISION_MENTION.test(quote),
      });
      if (end === text.length) break;
      start = end - CHUNK_OVERLAP_CHARS;
      if (/[\uDC00-\uDFFF]/.test(text[start])) start--;
    }
  });
  return { path, revision, chunks };
}

function key(source: string, revision: string): string {
  return `${source}\u0000${revision}`;
}

/** Unknown/corrupt/legacy markers cannot authorize complete coverage. */
export function evidenceCoverage(markdown: string): Map<string, Set<string>> {
  const covered = new Map<string, Set<string>>();
  let offset = 0;
  while ((offset = markdown.indexOf(RECEIPT_OPEN, offset)) >= 0) {
    const start = offset + RECEIPT_OPEN.length;
    const end = markdown.indexOf(RECEIPT_CLOSE, start);
    if (end < 0) break;
    offset = end + RECEIPT_CLOSE.length;
    try {
      const value: unknown = JSON.parse(markdown.slice(start, end));
      if (!value || typeof value !== "object") continue;
      const receipt = value as Partial<CoverageReceipt>;
      if (
        receipt.version !== 1 ||
        typeof receipt.source !== "string" ||
        typeof receipt.revision !== "string" ||
        typeof receipt.evidenceHash !== "string" ||
        !Array.isArray(receipt.chunks) ||
        !receipt.chunks.every((id) => typeof id === "string")
      )
        continue;
      const blockStart = markdown.lastIndexOf(
        "\n### Source evidence\n\n",
        start,
      );
      const blockEnd = markdown.indexOf(RECEIPT_OPEN, blockStart);
      if (
        blockStart < 0 ||
        blockEnd < 0 ||
        fingerprint(markdown.slice(blockStart, blockEnd)) !==
          receipt.evidenceHash
      )
        continue;
      const receiptKey = key(receipt.source, receipt.revision);
      const ids = covered.get(receiptKey) ?? new Set<string>();
      receipt.chunks.forEach((id) => ids.add(id));
      covered.set(receiptKey, ids);
    } catch {
      // A receipt is a hint until validated; malformed input is reprocessed.
    }
  }
  return covered;
}

/** At most 48 chunks enter an embed/model batch; subsequent runs resume. */
export function nextEvidenceBatch(
  sources: EvidenceSource[],
  markdown: string,
): EvidenceChunk[] {
  const covered = evidenceCoverage(markdown);
  const batch: EvidenceChunk[] = [];
  for (const source of sources) {
    const ids = covered.get(key(source.path, source.revision));
    for (const chunk of source.chunks) {
      if (!ids?.has(chunk.id)) batch.push(chunk);
      if (batch.length === EVIDENCE_BATCH_SIZE) return batch;
    }
  }
  return batch;
}

export function completedEvidenceSources(
  sources: EvidenceSource[],
  markdown: string,
): EvidenceSource[] {
  const covered = evidenceCoverage(markdown);
  return sources.filter((source) => {
    const ids = covered.get(key(source.path, source.revision));
    return (
      ids !== undefined && source.chunks.every((chunk) => ids.has(chunk.id))
    );
  });
}

function plainMarkdown(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/([`*_[\]<>])/g, "\\$1");
}

/** Keep full quotes behind the small preview, with immutable source identity.
 * No existing section is rewritten, and historical imports add evidence only. */
export function evidenceSection(
  sources: EvidenceSource[],
  batch: EvidenceChunk[],
  citationBySource: Readonly<Record<string, string>> = {},
): string {
  const quotes = batch.map((chunk) => {
    const attribution = [
      chunk.timestamp,
      chunk.role,
      chunk.originalRole ? `original: ${chunk.originalRole}` : undefined,
      chunk.phase,
      chunk.turnId,
    ]
      .filter(Boolean)
      .map((value) => plainMarkdown(value!))
      .join(" · ");
    const topics = chunk.topics.length
      ? ` · ${chunk.topics.map(plainMarkdown).join(", ")}`
      : "";
    const mention = chunk.decisionMention
      ? " · decision mention (quoted, not verified)"
      : "";
    const source = chunk.source.replace(/[[\]|\r\n]/g, (character) =>
      encodeURIComponent(character),
    );
    return (
      `#### ${plainMarkdown(chunk.title)}${topics}\n${attribution}${mention}\n\n` +
      `- ${plainMarkdown(chunk.text.replace(/\s+/g, " "))}${citationBySource[chunk.source] ? ` ${citationBySource[chunk.source]}` : ""}\n\n` +
      `Source: [[${source}]] · revision \`${chunk.revision}\` · chunk \`${chunk.id}\`\n`
    );
  });
  const evidence = `\n### Source evidence\n\n${quotes.join("\n")}\n`;
  const evidenceHash = fingerprint(evidence);
  const receipts = sources.flatMap((source) => {
    const chunks = batch.filter(
      (chunk) =>
        chunk.source === source.path && chunk.revision === source.revision,
    );
    if (!chunks.length && source.chunks.length) return [];
    const receipt: CoverageReceipt = {
      version: 1,
      source: source.path,
      revision: source.revision,
      chunks: chunks.map((chunk) => chunk.id),
      total: source.chunks.length,
      evidenceHash,
    };
    const json = JSON.stringify(receipt)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e");
    return [`${RECEIPT_OPEN}${json}${RECEIPT_CLOSE}`];
  });
  return evidence + receipts.join("\n") + "\n";
}

export function evidencePrompt(batch: EvidenceChunk[]): string {
  return batch
    .map(
      (chunk) =>
        `### ${chunk.source} [${chunk.revision}:${chunk.id}]\n${chunk.timestamp ?? ""} · ${chunk.role}\n${chunk.text}`,
    )
    .join("\n\n");
}

/** Read failures must not turn an existing hand-edited note into an empty one. */
export function isMissingFile(error: unknown): boolean {
  return /ENOENT|not found|no such file/i.test(String(error));
}
