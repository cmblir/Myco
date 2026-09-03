// Viewer renders markdown content as HTML. The renderer emits `data-link`
// attributes on wikilink anchors; the parent attaches a delegated click
// handler to dispatch navigation.

import { useMemo } from "react";
import type { JSX, MouseEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { markdownRenderer, stripFrontmatter } from "../lib/markdown";
import { ipc } from "../lib/ipc";

export interface ViewerProps {
  content: string;
  /** With `notePath`, vault images render through the asset protocol. */
  vaultRoot?: string;
  notePath?: string;
  onLinkClick?: (target: string) => void;
}

export default function Viewer({
  content,
  vaultRoot,
  notePath,
  onLinkClick,
}: ViewerProps): JSX.Element {
  // `content` is the raw document (incl. frontmatter when editing source); the
  // preview hides the frontmatter block so it doesn't render as a stray table.
  const html = useMemo(
    () =>
      markdownRenderer.render(stripFrontmatter(content), {
        vaultRoot,
        noteDir: notePath?.replace(/[\\/][^\\/]+$/, ""),
        toUrl: convertFileSrc,
      }),
    [content, vaultRoot, notePath],
  );

  function handleClick(e: MouseEvent<HTMLDivElement>) {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    // External link / bare URL: open in the OS browser, don't navigate the app.
    const external = target.closest<HTMLElement>("[data-external]");
    if (external) {
      e.preventDefault();
      const href = external.getAttribute("data-external");
      if (href) void ipc.openExternal(href);
      return;
    }
    const linkTarget = target.closest<HTMLElement>("[data-link]");
    if (!linkTarget) return;
    e.preventDefault();
    const value = linkTarget.getAttribute("data-link");
    if (value) onLinkClick?.(value);
  }

  return (
    <div
      className="myco-viewer"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
