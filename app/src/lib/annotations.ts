// PDF annotation sidecar (Feature 6). Highlights on a source PDF are stored as
// an external, plain-JSON overlay — never touching the immutable raw/ file — at
// `wiki/.annotations/<raw-stem>.json`. Each anchor records the page, the quad
// rectangles of the selection, the quoted text, a colour, and the wiki note
// that cites it, so highlights re-render on reopen and click through both ways.

import { ipc } from "./ipc";

/** A normalized highlight rectangle (0..1 fractions of the page box). */
export interface Quad {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Anchor {
  id: string;
  /** 1-based page number. */
  page: number;
  quads: Quad[];
  /** The selected text (kept even if the location later fails to resolve). */
  text: string;
  /** CSS colour for the highlight. */
  color: string;
  /** Vault-relative path of the wiki note that cites this anchor. */
  note: string;
  /** ISO timestamp. */
  created: string;
}

export interface Sidecar {
  /** Vault-relative raw path, e.g. "raw/attention.pdf". */
  source: string;
  anchors: Anchor[];
}

export function sidecarPath(vaultPath: string, rawStem: string): string {
  return `${vaultPath}/wiki/.annotations/${rawStem}.json`;
}

export function emptySidecar(source: string): Sidecar {
  return { source, anchors: [] };
}

/** Parse a sidecar JSON string, tolerating absence/corruption (→ empty). */
export function parseSidecar(source: string, raw: string): Sidecar {
  try {
    const v = JSON.parse(raw) as Partial<Sidecar>;
    if (v && Array.isArray(v.anchors)) {
      return { source: v.source ?? source, anchors: v.anchors as Anchor[] };
    }
  } catch {
    /* corrupt sidecar → treat as no annotations */
  }
  return emptySidecar(source);
}

export function serializeSidecar(sidecar: Sidecar): string {
  return JSON.stringify(sidecar, null, 2) + "\n";
}

/** Short, URL/link-safe anchor id derived from page + a counter + text hash.
 *  Deterministic given inputs (no Math.random) so tests are stable. */
export function makeAnchorId(page: number, text: string, seq: number): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  const hash = (h >>> 0).toString(36).slice(0, 4);
  return `p${page}-${seq}-${hash}`;
}

export async function loadSidecar(
  vaultPath: string,
  rawStem: string,
  source: string,
): Promise<Sidecar> {
  const path = sidecarPath(vaultPath, rawStem);
  const file = await ipc.readFile(path).catch(() => null);
  if (!file) return emptySidecar(source);
  return parseSidecar(source, file.raw);
}

export async function saveSidecar(
  vaultPath: string,
  rawStem: string,
  sidecar: Sidecar,
): Promise<void> {
  try {
    await ipc.createFolder(`${vaultPath}/wiki`, ".annotations");
  } catch {
    /* already exists */
  }
  await ipc.writeFile(sidecarPath(vaultPath, rawStem), serializeSidecar(sidecar));
}
