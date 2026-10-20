// Where a note embed's section comes from (lib/blocks/embed.ts): the vault
// store's wikilink resolution, the note's unsaved draft or else its file,
// and Preview's renderer with the embedded note's own image paths. Live's
// widget (Editor) and Preview (Viewer → hydrateBlocks) both read through
// here, so the two views show the same section.

import { convertFileSrc } from "@tauri-apps/api/core";
import { embedTarget, fillEmbed } from "./blocks/embed";
import { fillQuery, parseQuery } from "./blocks/query";
import { drawMath } from "./blocks/math";
import { drawMermaids } from "./blocks/mermaid";
import { STRINGS } from "./i18n";
import { ipc } from "./ipc";
import { markdownRenderer, stripFrontmatter } from "./markdown";
import { sectionBody } from "./outline";
import { escapeHtml } from "./wikilinks";
import { pendingDrafts, useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";

// Each embed's footnotes get ids of their own (markdown-it-footnote's
// docId): the page's `[1]` must not scroll to an embedded note's `fn1`.
let embedSeq = 0;

/** The section `![[note#heading]]` shows, as Preview's HTML (vault text
 *  escaped); null when the note or the heading is missing. */
export async function loadEmbed(
  note: string,
  heading: string | null,
): Promise<string | null> {
  const { resolveWikilink, currentVault } = useVaultStore.getState();
  const path = resolveWikilink(note);
  // A stem can name a non-note file too (`shot` → shot.png).
  if (!path || !/\.md$/i.test(path)) return null;
  const raw = pendingDrafts.get(path) ?? (await ipc.readFile(path)).raw;
  const body = stripFrontmatter(raw);
  const section = heading === null ? body : sectionBody(body, heading);
  if (section === null) return null;
  return markdownRenderer.render(section, {
    vaultRoot: currentVault?.path,
    noteDir: path.replace(/[\\/][^\\/]+$/, ""),
    toUrl: convertFileSrc,
    docId: `embed-${++embedSeq}`,
    strings: STRINGS[useUIStore.getState().lang] ?? STRINGS.en,
  });
}

/** Fill the block placeholders Preview rendered under `root`: embeds, query
 *  blocks (`notePath`, the page shown, is no row of its own queries) and an
 *  empty TOC's text, diagrams and math. The embeds inside a filled section stay a header link
 *  and its queries draw nothing, as in Live: embeds never recurse. Filled
 *  ones are left alone. Each section read goes into `bodies` by its
 *  `data-embed` target, for prefillEmbeds, and each query box drawn (not
 *  failed) into `boxes` by its query, for prefillQueries. */
export function hydrateBlocks(
  root: HTMLElement,
  bodies?: Map<string, string>,
  notePath?: string,
  boxes?: Map<string, string>,
): void {
  const t = STRINGS[useUIStore.getState().lang] ?? STRINGS.en;
  for (const el of root.querySelectorAll<HTMLElement>(".md-toc.is-empty:empty"))
    el.textContent = t.rd_toc_empty;
  drawMermaids(root, t);
  void drawMath(root);
  for (const el of root.querySelectorAll<HTMLElement>(
    ".md-query[data-query]:empty:not(.md-embed-body *)",
  ))
    void fillQuery(el, parseQuery(el.dataset.query ?? ""), {
      t,
      runQuery: (q) =>
        import("./queryLoad").then((m) => m.runQuery(q, notePath)),
    }).then(() => {
      if (!el.querySelector(".is-error"))
        boxes?.set(el.dataset.query ?? "", el.innerHTML);
    });
  for (const el of root.querySelectorAll<HTMLElement>(
    ".md-embed[data-embed]:not(.md-embed-body *)",
  )) {
    const body = el.querySelector<HTMLElement>(":scope > .md-embed-body");
    const key = el.dataset.embed ?? "";
    const target = embedTarget(key);
    if (body && target && !body.hasChildNodes())
      void fillEmbed(body, target, {
        t,
        loadEmbed: async (note, heading) => {
          const html = await loadEmbed(note, heading);
          if (html !== null) bodies?.set(key, html);
          return html;
        },
      });
  }
}

// renderStatic's placeholder (lib/blocks/embed.ts): header, then an empty body.
const EMPTY_EMBED =
  /(<div class="md-embed" data-embed="([^"]*)"><div class="md-embed-head">[\s\S]*?<\/div><div class="md-embed-body">)(<\/div>)/g;

/** Preview's `html` with the embed bodies already read (`bodies`, by
 *  target, from hydrateBlocks) written in, so a re-render is never laid out
 *  with empty embeds and reads nothing again. The bodies are loadEmbed's
 *  renderer output — vault text escaped — as fillEmbed sets them; an embed
 *  inside one stays empty. */
export function prefillEmbeds(html: string, bodies: ReadonlyMap<string, string>): string {
  if (!bodies.size) return html;
  const byAttr = new Map([...bodies].map(([k, v]) => [escapeHtml(k), v]));
  return html.replace(EMPTY_EMBED, (whole, open: string, attr: string, close: string) => {
    const body = byAttr.get(attr);
    return body === undefined ? whole : open + body + close;
  });
}

// renderStatic's placeholder (lib/blocks/query.ts): an empty box.
const EMPTY_QUERY = /<div class="md-query" data-query="([^"]*)"><\/div>/g;

/** Preview's `html` with the query boxes already drawn (`boxes`, by query,
 *  from hydrateBlocks) written in, as prefillEmbeds does for embeds: a
 *  re-render keeps the page's height and runs nothing again. A box is
 *  fillQuery's DOM, built with textContent only (vault text escaped). Run
 *  it before prefillEmbeds: a query in an embedded section draws nothing. */
export function prefillQueries(
  html: string,
  boxes: ReadonlyMap<string, string>,
): string {
  if (!boxes.size) return html;
  const byAttr = new Map([...boxes].map(([k, v]) => [escapeHtml(k), v]));
  return html.replace(EMPTY_QUERY, (whole, attr: string) => {
    const box = byAttr.get(attr);
    return box === undefined ? whole : whole.replace("></div>", `>${box}</div>`);
  });
}
