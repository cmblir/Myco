// Vault image assets: the file name a pasted image gets under `assets/`, the
// paste-able types, and how a markdown `src` maps onto a vault path so the
// preview can hand it to Tauri's asset protocol.

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

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
