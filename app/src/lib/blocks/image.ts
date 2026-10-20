// Image block: `![alt](assets/x.png)` and Obsidian's `![[x.png|300]]`, with
// Obsidian's size suffix (`|300`, `|300x200`) as the width. The src only
// ever reaches the page through imageUrl (the asset protocol), never raw.

import { imageExtFor, imageUrl } from "../assets";
import { escapeHtml, matchWikilinkAt } from "../wikilinks";
import type { BlockSpec } from "./index";

export interface ImageModel {
  src: string;
  alt: string;
  title?: string;
  width?: number;
  height?: number;
}

const SIZE_RE = /^(\d+)(?:x(\d+))?$/;
// `![alt](url)`, `![alt](<url>)`, `![alt](url "title")` — one node's text.
const MD_IMAGE_RE =
  /^!\[([\s\S]*)\]\(\s*(<[^<>\n]*>|\S+?)(?:\s+("[^"]*"|'[^']*'|\([^()]*\)))?\s*\)$/;
// markdown-it's validateLink: these schemes never load, except raster data.
const BAD_PROTO_RE = /^(?:vbscript|javascript|file|data):/;
const GOOD_DATA_RE = /^data:image\/(?:gif|png|jpeg|webp);/;

/** `text|300` → alt + width; an embed's bare `300` is a size too. */
function sized(text: string, bare: boolean): Omit<ImageModel, "src"> {
  const bar = text.lastIndexOf("|");
  const m = SIZE_RE.exec(
    (bar >= 0 ? text.slice(bar + 1) : bare ? text : "").trim(),
  );
  if (!m) return { alt: text };
  return {
    alt: bar >= 0 ? text.slice(0, bar).trim() : "",
    width: Number(m[1]),
    ...(m[2] ? { height: Number(m[2]) } : {}),
  };
}

/** `![[target|display]]`: a bare name lives in `assets/`, as pasted. */
function embed(target: string, display: string): ImageModel {
  const s = sized(display === target ? "" : display, true);
  return {
    src: /[\\/]/.test(target) ? target : `assets/${target}`,
    ...s,
    alt: s.alt || target,
  };
}

function withSrc(
  src: string,
  rest: Omit<ImageModel, "src">,
): ImageModel | null {
  const scheme = src.trim().toLowerCase();
  if (BAD_PROTO_RE.test(scheme) && !GOOD_DATA_RE.test(scheme)) return null;
  return { src, ...rest };
}

export const IMAGE: BlockSpec<ImageModel> = {
  id: "image",
  match: { node: "Image", token: "image" },
  template: "![alt](assets/x.png)",
  parse(src) {
    if (src.startsWith("![[")) {
      const m = matchWikilinkAt(src, 1);
      return m && m.end === src.length && imageExtFor("", m.target)
        ? embed(m.target, m.display)
        : null;
    }
    const m = MD_IMAGE_RE.exec(src);
    if (!m) return null;
    const url = m[2].startsWith("<") ? m[2].slice(1, -1) : m[2];
    return withSrc(url, {
      ...sized(m[1], false),
      ...(m[3] ? { title: m[3].slice(1, -1) } : {}),
    });
  },
  fromToken(token, text) {
    // The embed rule keeps its source: it reads exactly as Live parses it.
    if (typeof token.meta?.embed === "string")
      return IMAGE.parse(token.meta.embed);
    const title = token.attrGet("title");
    return withSrc(token.attrGet("src") ?? "", {
      ...sized(text, false),
      ...(title ? { title } : {}),
    });
  },
  renderStatic(p, { env }) {
    const attr = (k: string, v: string | number | undefined) =>
      v === undefined ? "" : ` ${k}="${escapeHtml(String(v))}"`;
    return (
      `<img src="${escapeHtml(imageUrl(p.src, env))}" alt="${escapeHtml(p.alt)}"` +
      attr("title", p.title) +
      attr("width", p.width) +
      attr("height", p.height) +
      ">"
    );
  },
  mount(el, p, { env }) {
    const img = document.createElement("img");
    img.alt = p.alt;
    if (p.title) img.title = p.title;
    if (p.width) img.width = p.width;
    if (p.height) img.height = p.height;
    const done = new Promise<void>((resolve) => {
      img.addEventListener("load", () => resolve(), { once: true });
      // A missing file shows its path, so the block stays visible to click.
      img.addEventListener(
        "error",
        () => {
          const path = document.createElement("span");
          path.className = "live-block-broken";
          path.textContent = p.src;
          img.replaceWith(path);
          resolve();
        },
        { once: true },
      );
    });
    img.src = imageUrl(p.src, env);
    el.append(img);
    return done;
  },
  estimatedHeight: (p) => p.height ?? 200,
};
