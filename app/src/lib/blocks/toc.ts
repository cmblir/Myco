// Table of contents: ```toc draws the page's outline as `[[#Heading]]`-style
// links (data-link="#…"), which both the Viewer and Live hand to the
// reader's link handler with the heading's body line (data-heading-line),
// so a name the page repeats (### Summary under each day) scrolls to its
// own heading. Not `data-line`: Preview finds headings by that. Only an
// empty fence is a TOC: one with text in it stays code, as Obsidian and
// GitHub show it, so nothing typed there is hidden.

import { escapeHtml } from "../wikilinks";
import type { BlockSpec } from "./index";

const ROW_PX = 30; // one outline row at Live's 17px/1.75

/** The heading line a clicked TOC row carries; none inside an embedded
 *  section, whose lines are the other note's. */
export function headingLine(link: HTMLElement): number | undefined {
  const line = link.dataset.headingLine;
  return line === undefined || link.closest(".md-embed-body")
    ? undefined
    : Number(line);
}

export const TOC: BlockSpec<object> = {
  id: "toc",
  match: { fence: "toc" },
  slash: {
    label: "toc",
    name: "sl_toc",
    icon: "≡",
    // Found on any UI language, like /오늘 for the date.
    aliases: ["contents", "outline", "index", "목차", "目次"],
    section: "advanced",
  },
  template: "```toc\n```",
  parse: (body) => (/\S/.test(body) ? null : {}),
  renderStatic(_, { headings }) {
    // The Viewer writes the empty state's text (hydrateBlocks): the
    // renderer has no UI strings.
    if (!headings.length) return '<nav class="md-toc is-empty"></nav>\n';
    const rows = headings.map(
      (h) =>
        `<li class="md-toc-${h.level}"><a data-link="#${escapeHtml(h.text)}" data-heading-line="${h.line}" class="myco-wikilink" href="#">${escapeHtml(h.text)}</a></li>`,
    );
    return `<nav class="md-toc"><ul>${rows.join("")}</ul></nav>\n`;
  },
  mount(el, _, { headings, t }) {
    const nav = document.createElement("nav");
    nav.className = "md-toc";
    if (!headings.length) {
      // As in Preview: the box says there is nothing to list yet.
      nav.classList.add("is-empty");
      nav.textContent = t?.rd_toc_empty ?? "No headings yet";
    } else {
      const list = document.createElement("ul");
      for (const h of headings) {
        const li = document.createElement("li");
        li.className = `md-toc-${h.level}`;
        const a = document.createElement("a");
        a.className = "myco-wikilink";
        a.href = "#";
        a.dataset.link = `#${h.text}`;
        a.dataset.headingLine = String(h.line);
        a.textContent = h.text;
        li.append(a);
        list.append(li);
      }
      nav.append(list);
    }
    el.append(nav);
  },
  estimatedHeight: (_, { headings }) => Math.max(1, headings.length) * ROW_PX,
  key: (_, { headings }) =>
    headings.map((h) => `${h.level} ${h.line} ${h.text}`).join("\n"),
};
