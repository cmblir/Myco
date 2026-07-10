// Multimodal ingest helpers (Feature 2). Turns a dropped/picked image or
// audio/video file into text the normal ingest pipeline can wiki-ify: images
// via a vision provider (describe_image), audio/video via an installed whisper
// CLI (transcribe_media). Plain documents keep going through read_external_text.

import { ipc } from "./ipc";

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const MEDIA_RE = /\.(mp3|m4a|wav|flac|ogg|mp4|mov|webm|mkv|aac)$/i;

export function isImageFile(path: string): boolean {
  return IMAGE_RE.test(path);
}

export function isMediaFile(path: string): boolean {
  return MEDIA_RE.test(path);
}

export const IMAGE_INGEST_PROMPT =
  "Describe this image in detail as source material for a knowledge wiki. " +
  "Transcribe any text verbatim, and summarize diagrams, figures, charts, or " +
  "data so the content can be turned into cited notes.";

export interface SourceDeps {
  provider: string;
  model: string;
}

/** Resolve a dropped/picked file to ingestable text, dispatching on kind. */
export async function sourceTextFor(
  path: string,
  deps: SourceDeps,
): Promise<string> {
  if (isImageFile(path)) {
    return ipc.describeImage(deps.provider, deps.model, path, IMAGE_INGEST_PROMPT);
  }
  if (isMediaFile(path)) {
    return ipc.transcribeMedia(path);
  }
  return ipc.readExternalText(path);
}
