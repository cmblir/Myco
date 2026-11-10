/** UI-only provenance. This is what the model received, not a claim that every
 * span supports the answer. Never put it into a subsequent conversation prompt. */
export interface CitationSpan {
  id: string;
  start: number;
  end: number;
  text: string;
  sha256: string;
  speaker: string;
  turnTime: string | null;
}
export interface CitationSource {
  path: string;
  revision: string;
  spans: CitationSpan[];
}
export interface CitationEvidence {
  version: 1;
  sources: CitationSource[];
}
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const pathOK = (v: unknown): v is string => typeof v === "string" && v.endsWith(".md") &&
  !/[\\\\\u0000-\u001f#|]/.test(v) && !v.startsWith("/") && !v.split("/").some(p => !p || p === "." || p === "..");

/** History is untrusted and optional metadata must not erase a readable answer.
 * Return a new bounded object, never retain arbitrary deserialized properties. */
export function readCitationEvidence(value: unknown): CitationEvidence | undefined {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.sources) || value.sources.length > 12) return;
  const sources: CitationSource[] = [];
  let bytes = 0, count = 0;
  for (const source of value.sources) {
    if (!object(source) || !pathOK(source.path) || !hash(source.revision) || !Array.isArray(source.spans) || !source.spans.length || sources.some(s => s.path === source.path)) return;
    const spans: CitationSpan[] = [];
    for (const span of source.spans) {
      if (!object(span) || typeof span.id !== "string" || !span.id || span.id.length > 200 ||
          !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || (span.start as number) < 0 || (span.end as number) <= (span.start as number) ||
          typeof span.text !== "string" || !span.text.trim() || !hash(span.sha256) ||
          typeof span.speaker !== "string" || span.speaker.length > 64 ||
          !(span.turnTime === null || typeof span.turnTime === "string" && span.turnTime.length <= 80)) return;
      const size = new TextEncoder().encode(span.text).length;
      bytes += size; count++;
      if (size !== (span.end as number) - (span.start as number) || bytes > 524288 || count > 128 || spans.some(s => s.id === span.id)) return;
      spans.push({id: span.id, start: span.start as number, end: span.end as number, text: span.text,
        sha256: span.sha256, speaker: span.speaker, turnTime: span.turnTime});
    }
    sources.push({path: source.path, revision: source.revision, spans});
  }
  return sources.length ? {version: 1, sources} : undefined;
}

/** Bind the native original packet to the exact projected model input. Source
 * and span IDs may be projected; compare order/text/attribution, not guessed IDs.
 * Only accepted cited paths leave the completed request. */
export function citationEvidenceFromPacket(original: string | undefined, projected: string, citedPaths: string[]): CitationEvidence | undefined {
  if (!original) return;
  try {
    const raw = JSON.parse(original), model = JSON.parse(projected);
    if (!Array.isArray(raw.sources) || !Array.isArray(model.sources) || raw.sources.length !== model.sources.length) return;
    const sources: CitationSource[] = [];
    for (let i = 0; i < raw.sources.length; i++) {
      const source = raw.sources[i], view = model.sources[i];
      if (!source || !view || source.id !== view.id || source.path !== view.path ||
          !Array.isArray(source.originalSpans) || !Array.isArray(view.originalSpans) || source.originalSpans.length !== view.originalSpans.length) return;
      for (let j = 0; j < source.originalSpans.length; j++) {
        const span = source.originalSpans[j], shown = view.originalSpans[j];
        if (!span || !shown || span.sourcePath !== source.path || span.sourceRevision !== source.originalSpans[0].sourceRevision ||
            span.text !== shown.text || span.speaker !== shown.speaker || span.turnTime !== shown.turnTime) return;
      }
      if (citedPaths.includes(source.path)) sources.push({path: source.path,
        revision: source.originalSpans[0]?.sourceRevision, spans: source.originalSpans});
    }
    if (citedPaths.some(path => !sources.some(s => s.path === path))) return;
    return readCitationEvidence({version: 1, sources});
  } catch { return; }
}

/** Validate against the current document, including byte coordinates. This can
 * locate a repeated literal span without guessing which occurrence was cited. */
export async function locateCitationSpan(doc: string, source: CitationSource, span: CitationSpan): Promise<{from: number; to: number} | null> {
  const valid = readCitationEvidence({version: 1, sources: [{...source, spans: [span]}]});
  if (!valid) return null;
  const bytes = new TextEncoder().encode(doc);
  const digest = async (data: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)))
    .map(n => n.toString(16).padStart(2, "0")).join("");
  if (span.end > bytes.length || await digest(bytes) !== source.revision) return null;
  const part = bytes.slice(span.start, span.end);
  if (await digest(part) !== span.sha256) return null;
  try {
    const decode = new TextDecoder("utf-8", {fatal: true});
    if (decode.decode(part) !== span.text) return null;
    const text = span.text.trim();
    const prefix = decode.decode(bytes.slice(0, span.start)) + span.text.slice(0, span.text.indexOf(text));
    const from = prefix.split("\n").length;
    return {from, to: from + text.split("\n").length - 1};
  } catch { return null; }
}

/** Check a fresh disk snapshot as well as the rendered draft. Cancellation is
 * distinct from source failure: a superseded vault/navigation must stay silent. */
export async function verifyCitationNavigation(args: {
  source: CitationSource; span: CitationSpan;
  readCurrent: () => Promise<string>;
  draft: () => string;
  isCurrent: () => boolean;
}): Promise<{status: "ready"; lines: {from: number; to: number}} | {status: "changed"} | {status: "cancelled"}> {
  if (!args.isCurrent()) return {status: "cancelled"};
  const draft = args.draft();
  const current = await args.readCurrent().catch(() => null);
  if (!args.isCurrent()) return {status: "cancelled"};
  if (current === null || current !== draft || args.draft() !== draft) return {status: "changed"};
  const lines = await locateCitationSpan(current, args.source, args.span).catch(() => null);
  if (!args.isCurrent()) return {status: "cancelled"};
  if (!lines || args.draft() !== draft) return {status: "changed"};
  return {status: "ready", lines};
}
