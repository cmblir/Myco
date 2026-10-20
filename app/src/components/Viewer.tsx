// Viewer renders markdown content as HTML. The renderer emits `data-link`
// attributes on wikilink anchors; the parent attaches a delegated click
// handler to dispatch navigation. Note embeds (`![[note#Heading]]`) render
// as placeholders that are filled once the HTML is in (lib/embedLoad.ts).

import { useEffect, useMemo, useRef } from "react";
import type { JSX, MouseEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { markdownRenderer, stripFrontmatter } from "../lib/markdown";
import { ipc } from "../lib/ipc";
import { hydrateBlocks, prefillEmbeds, prefillQueries } from "../lib/embedLoad";
import { headingLine } from "../lib/blocks/toc";
import { STRINGS } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { pluginFenceKey, usePluginStore } from "../stores/pluginStore";

export interface ViewerProps {
  content: string;
  /** With `notePath`, vault images render through the asset protocol. */
  vaultRoot?: string;
  notePath?: string;
  /** `line`: a TOC row's heading, 0-based in the body. */
  onLinkClick?: (target: string, line?: number) => void;
  /** Every block carries its body line (`data-line`) — the reader's Preview,
   *  where a citation lights the quoted paragraphs. */
  sourceLines?: boolean;
  /** An answer, not a note: name opaque session links (RenderEnv). */
  displayNames?: boolean;
  /** A to-do box was clicked: `line` is its 0-based body line. Without it
   *  the boxes render disabled. */
  onToggleTask?: (line: number) => void;
}

export default function Viewer({
  content,
  vaultRoot,
  notePath,
  onLinkClick,
  sourceLines,
  displayNames,
  onToggleTask,
}: ViewerProps): JSX.Element {
  // An untitled callout's kind reads in the UI's language.
  const lang = useUIStore((s) => s.lang);
  const tasks = !!onToggleTask;
  // The enabled plugins' fences, which the renderer reads from the block
  // registry: a change renders again.
  const fenceKey = usePluginStore(pluginFenceKey);
  // The sections this note's embeds showed, by target, and the boxes its
  // query blocks drew, by query: a re-render (a tick) writes them straight
  // back, so the page keeps its height — and the reader their scroll — and
  // nothing is read or run again. Per note.
  // ponytail: an embedded note changed elsewhere (or the vault, for a query)
  // shows on the next note opened here; invalidate by path if too stale.
  const embedCache = useRef<{
    note?: string;
    bodies: Map<string, string>;
    boxes: Map<string, string>;
  } | null>(null);
  if (!embedCache.current || embedCache.current.note !== notePath)
    embedCache.current = { note: notePath, bodies: new Map(), boxes: new Map() };
  const embedBodies = embedCache.current.bodies;
  const queryBoxes = embedCache.current.boxes;
  // `content` is the raw document (incl. frontmatter when editing source); the
  // preview hides the frontmatter block so it doesn't render as a stray table.
  const html = useMemo(
    () =>
      prefillEmbeds(
        prefillQueries(
          markdownRenderer.render(stripFrontmatter(content), {
            vaultRoot,
            noteDir: notePath?.replace(/[\\/][^\\/]+$/, ""),
            toUrl: convertFileSrc,
            strings: STRINGS[lang] ?? STRINGS.en,
            sourceLines,
            displayNames,
            tasks,
          }),
          queryBoxes,
        ),
        embedBodies,
      ),
    // fenceKey is read through the registry, not here (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, vaultRoot, notePath, lang, sourceLines, displayNames, tasks, embedBodies, queryBoxes, fenceKey],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  // The box a key or click ticked: the new HTML replaces it, focus follows.
  const tickedLine = useRef<string | null>(null);
  // React sets the HTML again only when it changes; each new set brings
  // the embed bodies not read yet (and an empty TOC's text) to fill.
  useEffect(() => {
    if (!rootRef.current) return;
    hydrateBlocks(rootRef.current, embedBodies, notePath, queryBoxes);
    const line = tickedLine.current;
    tickedLine.current = null;
    if (line !== null)
      rootRef.current
        .querySelector<HTMLElement>(`input[type=checkbox][data-task-line="${line}"]:not(.md-embed-body *)`)
        ?.focus({ preventScroll: true });
  }, [html, embedBodies, notePath, queryBoxes]);

  function handleClick(e: MouseEvent<HTMLDivElement>) {
    const target = e.target;
    // An Element, not only HTML: a diagram's link is an SVG <a>.
    if (!(target instanceof Element)) return;
    // A to-do's box: the file decides its state (re-rendered from it), so the
    // native flip is cancelled. An embed's boxes are another note's lines.
    if (
      onToggleTask &&
      target instanceof HTMLInputElement &&
      target.matches("input[type=checkbox][data-task-line]") &&
      !target.closest(".md-embed-body")
    ) {
      e.preventDefault();
      tickedLine.current = target.dataset.taskLine ?? null;
      onToggleTask(Number(target.dataset.taskLine));
      return;
    }
    // External link / bare URL: open in the OS browser, don't navigate the app.
    const external = target.closest<HTMLElement>("[data-external]");
    if (external) {
      e.preventDefault();
      const href = external.getAttribute("data-external");
      if (href) void ipc.openExternal(href);
      return;
    }
    const linkTarget = target.closest<HTMLElement>("[data-link]");
    if (linkTarget) {
      e.preventDefault();
      const value = linkTarget.getAttribute("data-link");
      if (value) onLinkClick?.(value, headingLine(linkTarget));
      return;
    }
    // `#fn1` / `#fnref1` (footnotes) and other in-page anchors: scroll inside
    // this viewer. Following the hash would navigate the webview, and several
    // viewers on one screen repeat the same ids, so look only in this one.
    const anchor = target.closest<HTMLElement>('a[href^="#"]');
    if (!anchor) return;
    e.preventDefault();
    const id = anchor.getAttribute("href")?.slice(1);
    if (!id) return;
    const to = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>("[id]"),
    ).find((el) => el.id === id);
    if (!to) return;
    to.scrollIntoView({ block: "center" });
    // Focus follows, as with a followed fragment: the next Tab starts at the
    // target (a footnote's ↩︎ back link), not back at the reference.
    if (!to.matches("a[href], button, input, select, textarea, [tabindex]"))
      to.setAttribute("tabindex", "-1");
    to.focus({ preventScroll: true });
  }

  return (
    <div
      ref={rootRef}
      className="myco-viewer"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
