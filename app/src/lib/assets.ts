// Vault image assets: the file name a pasted image gets under `assets/`, the
// paste-able types, and how a markdown `src` maps onto a vault path so the
// preview can hand it to Tauri's asset protocol.

import type { Strings } from "./i18n";

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

/** Per-render context: lets an image map vault paths to webview URLs. */
export interface RenderEnv {
  vaultRoot?: string;
  /** Directory of the note being rendered; `./x` resolves against it. */
  noteDir?: string;
  /** Absolute vault path → URL the webview may load (Tauri's convertFileSrc). */
  toUrl?: (absPath: string) => string;
  /** UI strings for the text the renderer writes itself (an untitled
   *  callout's kind); absent = English. */
  strings?: Strings;
  /** `data-line` (0-based body line) on every block, not only headings. */
  sourceLines?: boolean;
  /** Unaliased links to an opaque session id read as `Claude Code · …`
   *  (lib/displayName). Only answers opt in (Ask, Spotlight): a note's own
   *  Preview, embeds and Live widgets keep the link text Live's lines show. */
  displayNames?: boolean;
  /** To-do boxes are live and name their body line (`data-task-line`): the
   *  reader's Preview writes a tick to the file. Elsewhere they are disabled. */
  tasks?: boolean;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** `YYYYMMDD-HHMMSS.ext` in local time. */
export function assetFileName(now: Date, ext: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${date}-${time}.${ext}`;
}

/** Allow-listed extension for a file by MIME type, else by name; null if neither. */
export function imageExtFor(mime: string, name: string): string | null {
  const byMime = MIME_EXT[mime.toLowerCase()];
  if (byMime) return byMime;
  const ext = /\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? "";
  return (IMAGE_EXTS as readonly string[]).includes(ext) ? ext : null;
}

/**
 * Absolute path for a markdown image `src`, or null to leave it alone:
 * scheme-prefixed → null; `./x` / `../x` relative to `noteDir`; `/x` and bare
 * `x` relative to `vaultRoot`; `%xx` decoded.
 */
export function resolveImageSrc(
  src: string,
  vaultRoot: string,
  noteDir: string,
): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(src);
  } catch {
    rel = src;
  }
  const base = /^\.\.?[\\/]/.test(rel) ? noteDir : vaultRoot;
  const parts = base.split(/[\\/]/);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** The URL an image `src` loads from: a vault path through `env.toUrl` (the
 *  asset protocol); a remote URL, or any src without an env, as written. */
export function imageUrl(src: string, env?: RenderEnv): string {
  if (!env?.vaultRoot || !env.toUrl) return src;
  const abs = resolveImageSrc(src, env.vaultRoot, env.noteDir ?? env.vaultRoot);
  return abs ? env.toUrl(abs) : src;
}
