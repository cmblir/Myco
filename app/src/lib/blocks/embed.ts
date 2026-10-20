// Note embed: `![[note#Heading]]` / `![[note]]` alone on its line shows the
// target section, read-only, under a header that links to it. The section
// comes from the host (BlockCtx.loadEmbed, lib/embedLoad.ts: the vault's
// wikilink resolution and Preview's renderer); a missing note or heading
// says "Section not found". Preview writes the header and an empty body
// (renderStatic) that the Viewer fills the same way (hydrateBlocks). An
// embed inside the embedded section shows its header only, so embeds never
// recurse. `^block-id` anchors are not supported.

import { imageExtFor } from "../assets";
import {
  escapeHtml,
  matchWikilinkAt,
  parsePdfTarget,
  wikilinkBase,
} from "../wikilinks";
import type { BlockCtx, BlockSpec } from "./index";
import { drawMath } from "./math";
import { drawMermaids } from "./mermaid";

export interface EmbedTarget {
  note: string;
  /** null = the whole note. */
  heading: string | null;
}

export interface EmbedModel extends EmbedTarget {
  /** As written between `![[` and `|` / `]]`; the header links to it. */
  target: string;
  label: string;
}

/** `note#Heading` → its note and heading; null for this note's own
 *  `#Heading` (no note to embed). */
export function embedTarget(target: string): EmbedTarget | null {
  const note = wikilinkBase(target);
  if (!note) return null;
  const hash = target.indexOf("#");
  return {
    note,
    heading: (hash < 0 ? "" : target.slice(hash + 1).trim()) || null,
  };
}

function header(p: EmbedModel): HTMLElement {
  const head = document.createElement("div");
  head.className = "md-embed-head";
  const a = document.createElement("a");
  a.className = "myco-wikilink";
  a.href = "#";
  a.dataset.link = p.target;
  a.textContent = p.label;
  head.append(a);
  return head;
}

/** Fill an embed's body: loading, then the section or "not found". */
export async function fillEmbed(
  body: HTMLElement,
  target: EmbedTarget,
  { t, loadEmbed }: Pick<BlockCtx, "t" | "loadEmbed">,
): Promise<void> {
  body.className = "md-embed-body is-loading";
  body.textContent = t?.rd_embed_loading ?? "Loading…";
  let html: string | null = null;
  try {
    html = (await loadEmbed?.(target.note, target.heading)) ?? null;
  } catch (err) {
    console.warn(`embed "${target.note}" could not be read`, err);
  }
  if (html === null) {
    body.className = "md-embed-body is-missing";
    body.textContent = t?.rd_embed_missing ?? "Section not found";
    return;
  }
  body.className = "md-embed-body";
  // Preview's renderer output (vault text escaped, `html: false`) — the HTML
  // the Viewer sets — not vault text itself.
  body.innerHTML = html;
  drawMermaids(body, t);
  void drawMath(body);
}

export const EMBED: BlockSpec<EmbedModel> = {
  id: "embed",
  // The Lezer Image node an image embed has too: `parse` tells them apart.
  match: { node: "Image", token: "note_embed" },
  template: "![[note#Heading]]",
  parse(src) {
    if (!src.startsWith("![[")) return null;
    const m = matchWikilinkAt(src, 1);
    if (!m || m.end !== src.length) return null;
    if (imageExtFor("", m.target) || parsePdfTarget(m.target)) return null;
    const t = embedTarget(m.target);
    if (!t) return null;
    const label =
      m.display !== m.target
        ? m.display
        : t.heading
          ? `${t.note} › ${t.heading}`
          : t.note;
    return { ...t, target: m.target, label };
  },
  fromToken: (token) =>
    typeof token.meta?.embed === "string" ? EMBED.parse(token.meta.embed) : null,
  renderStatic: (p) =>
    `<div class="md-embed" data-embed="${escapeHtml(p.target)}"><div class="md-embed-head"><a data-link="${escapeHtml(p.target)}" class="myco-wikilink" href="#">${escapeHtml(p.label)}</a></div><div class="md-embed-body"></div></div>\n`,
  mount(el, p, ctx) {
    // `prose`: the section reads as in Preview.
    el.classList.add("md-embed", "prose");
    const body = document.createElement("div");
    el.append(header(p), body);
    return fillEmbed(body, p, ctx);
  },
  estimatedHeight: () => 120,
};
