// Multimodal ingest helpers (Feature 2). Turns a dropped/picked image or
// audio/video file into text the normal ingest pipeline can wiki-ify: images
// via a vision provider (describe_image), audio/video via an installed whisper
// CLI (transcribe_media). Plain documents keep going through read_external_text.

import { ipc, type ImageIngestRequest } from "./ipc";

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const MEDIA_RE = /\.(mp3|m4a|wav|flac|ogg|mp4|mov|webm|mkv|aac)$/i;

export function isImageFile(path: string): boolean {
  return IMAGE_RE.test(path);
}

export function isMediaFile(path: string): boolean {
  return MEDIA_RE.test(path);
}

// Formats read_external_text can turn into text: extract.rs's parser arms
// (pdf/office/html) plus the plain-text fallthrough the picker offers.
const EXTRACT_EXTS = new Set([
  "pdf", "docx", "pptx", "xlsx", "xls", "xlsm", "xlsb", "ods",
  "html", "htm", "txt", "markdown", "json", "yaml", "yml", "csv", "tsv",
]);

export type InboxKind = "md" | "extract" | "image" | "media" | "unsupported";

/** Classify an inbox filename for routing (Q4 item 20a): which pipeline can
 *  turn it into text, or "unsupported" when none can (epub, zip, …). */
export function classifyInboxEntry(name: string): InboxKind {
  if (/\.md$/i.test(name)) return "md";
  if (isImageFile(name)) return "image";
  if (isMediaFile(name)) return "media";
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return EXTRACT_EXTS.has(ext) ? "extract" : "unsupported";
}

/** Whether some ingest pipeline can read this file at all. */
export function isSupportedSource(name: string): boolean {
  return classifyInboxEntry(name) !== "unsupported";
}

export const IMAGE_INGEST_PROMPT =
  "Describe this image in detail as source material for a knowledge wiki. " +
  "Transcribe any text verbatim, and summarize diagrams, figures, charts, or " +
  "data so the content can be turned into cited notes.";

export type ImageIngestContext = Pick<
  ImageIngestRequest,
  "origin" | "roleSnapshot" | "requestId"
>;

/** DTO consistency only; native private authority and capabilities remain mandatory. */
export function checkedImageContext(
  context: ImageIngestContext | undefined,
): ImageIngestContext {
  const origin = context?.origin;
  const snapshot = context?.roleSnapshot;
  const route = snapshot?.routeSignature;
  const bounded = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    );
  if (
    !origin ||
    typeof origin.vaultPath !== "string" ||
    !origin.vaultPath ||
    !bounded(origin.openingToken) ||
    !bounded(context?.requestId) ||
    !snapshot ||
    snapshot.role !== "compilation" ||
    snapshot.usage !== "foreground" ||
    snapshot.origin?.vaultPath !== origin.vaultPath ||
    snapshot.origin.openingToken !== origin.openingToken ||
    !bounded(snapshot.snapshotId) ||
    !bounded(snapshot.authorizationRevision) ||
    !route ||
    route.role !== "compilation" ||
    !bounded(route.signature) ||
    !bounded(route.providerId) ||
    !bounded(route.modelId)
  ) {
    throw new Error(
      "Image ingest requires the initiating Compilation foreground context",
    );
  }
  return context!;
}

/** Resolve a dropped/picked file to ingestable text, dispatching on kind. */
export async function sourceTextFor(
  path: string,
  context?: ImageIngestContext,
): Promise<string> {
  if (isImageFile(path)) {
    return ipc.describeImage({
      ...checkedImageContext(context),
      path,
      prompt: IMAGE_INGEST_PROMPT,
    });
  }
  if (isMediaFile(path)) {
    return ipc.transcribeMedia(path);
  }
  return ipc.readExternalText(path);
}

/** Text for an image or recording in the vault that stays the same across
 *  retries, and the marker naming the file's bytes for ingest to file it
 *  under. A description or transcript is sampled anew on every call, so a
 *  retried `_inbox/` file made a new raw payload each time, find_raw_copy
 *  never matched it, and every failed pass filed one more permanent copy. A
 *  later attempt at the same bytes takes the text back out of the raw copy
 *  that carries the marker, so ingest rebuilds the same payload and reuses
 *  that copy. */
export async function retryStableSourceText(
  path: string,
  context?: ImageIngestContext,
): Promise<{ text: string; marker: string }> {
  if (isImageFile(path)) checkedImageContext(context);
  const { marker, copy } = await ipc.derivedRawCopy(path);
  if (copy == null) return { text: await sourceTextFor(path, context), marker };
  // ingestStore's writeRaw filed `# <title>\n\n<marker>\n\n<text>\n`.
  const text = copy.slice(copy.indexOf(marker) + marker.length);
  return { text: text.replace(/^\n\n/, "").replace(/\n$/, ""), marker };
}
