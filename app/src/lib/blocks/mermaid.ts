// ```mermaid: a diagram drawn by mermaid (pinned 11.17.2 — docs/specs
// 2026-09-25 Q5), imported on the first diagram shown, so the initial bundle
// never carries it. securityLevel "strict": mermaid sanitizes every label
// (DOMPurify) and binds no click handlers or javascript: links, and a
// diagram's own %%{init}%% cannot lift it (mermaid keeps securityLevel among
// its `secure` keys). The theme follows the app's (<html data-theme>) and a
// drawn diagram redraws when it flips. Both views draw one element: the
// source as code until the diagram is in, and a diagram mermaid cannot read
// keeps its source under mermaid's message — never a throw.

import type { Mermaid } from "mermaid";
import type { Strings } from "../i18n";
import { escapeHtml } from "../wikilinks";
import type { BlockSpec } from "./index";
import { fenced, textForm } from "./fencePanel";

/** What mermaid is initialized with, the theme aside. */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  // Mermaid would otherwise append its error diagram to <body>.
  suppressErrorRendering: true,
} as const;

/** Pure: mermaid's theme for the app's `data-theme`. */
export const mermaidTheme = (
  appTheme: string | undefined,
): "dark" | "default" => (appTheme === "dark" ? "dark" : "default");

/** Pure: the box both views draw into; vault text escaped. */
export function mermaidHtml(src: string): string {
  return `<div class="md-mermaid"><pre><code>${escapeHtml(src)}</code></pre></div>\n`;
}

let lib: Promise<Mermaid> | undefined;
let libTheme = "";
let seq = 0;
// ponytail: keyed by theme + source, 64 kept; a re-render of the same note
// (a ticked box) redraws from here with no mermaid run.
const drawn = new Map<string, string>();

async function svgOf(src: string, theme: "dark" | "default"): Promise<string> {
  const key = `${theme}\n${src}`;
  const hit = drawn.get(key);
  if (hit !== undefined) return hit;
  const mermaid = await (lib ??= import("mermaid").then((m) => m.default));
  if (libTheme !== theme) {
    mermaid.initialize({ ...MERMAID_CONFIG, theme });
    libTheme = theme;
  }
  const { svg } = await mermaid.render(`myco-mermaid-${++seq}`, src);
  drawn.set(key, svg);
  if (drawn.size > 64) drawn.delete(drawn.keys().next().value as string);
  return svg;
}

const pageTheme = () => mermaidTheme(document.documentElement.dataset.theme);

const XLINK = "http://www.w3.org/1999/xlink";
/** What markdown.ts link_open opens outside the app. */
const EXTERNAL_RE = /^(https?:|mailto:)/i;

/** A diagram's links (`click A href "…"`, which strict mode still draws as
 *  `<a xlink:href>`) never navigate the webview: an http(s) or mailto one
 *  becomes `data-external`, which Preview's Viewer and Live's widget open in
 *  the OS browser, and every href goes. */
export function unlinkSvg(root: ParentNode): void {
  for (const a of root.querySelectorAll("a")) {
    const href =
      a.getAttribute("href") ?? a.getAttributeNS(XLINK, "href") ?? "";
    if (EXTERNAL_RE.test(href)) a.setAttribute("data-external", href);
    a.removeAttribute("href");
    a.removeAttributeNS(XLINK, "href");
  }
}

let watching = false;
/** Redraw the drawn diagrams in the page when the app's theme flips. */
function watchTheme(): void {
  if (watching) return;
  watching = true;
  new MutationObserver(() => {
    for (const box of document.querySelectorAll<HTMLElement>(
      ".md-mermaid.is-drawn",
    ))
      if (box.dataset.theme !== pageTheme()) void drawMermaid(box);
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

/** Draw a mermaidHtml box (Live's widget, Preview's element). Resolves once
 *  the diagram or its error is in; never rejects. */
export async function drawMermaid(
  box: HTMLElement,
  t?: Partial<Strings>,
): Promise<void> {
  const src = box.querySelector(":scope > pre")?.textContent ?? "";
  const theme = pageTheme();
  // Also marks the box taken: hydrate skips it, a newer draw wins.
  box.dataset.theme = theme;
  watchTheme();
  let out = box.querySelector<HTMLElement>(":scope > .md-mermaid-out");
  if (!out) {
    out = document.createElement("div");
    out.className = "md-mermaid-out";
    // Above the source: an error reads first, its source under it.
    box.prepend(out);
  }
  try {
    const svg = await svgOf(src, theme);
    if (box.dataset.theme !== theme) return;
    box.classList.remove("is-error");
    box.classList.add("is-drawn");
    // Mermaid's own SVG, sanitized under securityLevel "strict" — not vault
    // text itself.
    out.innerHTML = svg;
    unlinkSvg(out);
  } catch (err) {
    if (box.dataset.theme !== theme) return;
    box.classList.remove("is-drawn");
    box.classList.add("is-error");
    out.setAttribute("role", "note");
    const why = err instanceof Error ? err.message : String(err);
    out.textContent = `${t?.mm_err ?? "Mermaid could not draw this diagram"}\n${why}`;
  }
}

/** Each drawn box's redraws: the last one asked for and the newest one
 *  shown, so a slow render never covers a newer one. */
const redraws = new WeakMap<HTMLElement, { asked: number; shown: number }>();

/** Live's open panel: draw `src` into a drawn box, keeping the newest
 *  diagram that drew while mermaid cannot read `src`. Resolves to what the
 *  panel says under the code — mermaid's message, "" once `src` drew — or
 *  null when a newer redraw has the last word. */
export async function redrawMermaid(
  box: HTMLElement,
  src: string,
  t?: Partial<Strings>,
): Promise<string | null> {
  const seq = redraws.get(box) ?? { asked: 0, shown: 0 };
  redraws.set(box, seq);
  const n = ++seq.asked;
  const out = box.querySelector<HTMLElement>(":scope > .md-mermaid-out");
  // The source a theme flip redraws from.
  const pre = box.querySelector(":scope > pre");
  if (pre) pre.textContent = src;
  const theme = pageTheme();
  box.dataset.theme = theme;
  try {
    const svg = await svgOf(src, theme);
    if (n > seq.shown && out && box.dataset.theme === theme) {
      seq.shown = n;
      // Mermaid's own SVG, sanitized under securityLevel "strict".
      out.innerHTML = svg;
      unlinkSvg(out);
    }
    return n === seq.asked ? "" : null;
  } catch (err) {
    if (n !== seq.asked) return null;
    const why = err instanceof Error ? err.message : String(err);
    return `${t?.mm_err ?? "Mermaid could not draw this diagram"}\n${why}`;
  }
}

/** Draw the diagrams Preview rendered under `root` that are not drawn yet. */
export function drawMermaids(root: ParentNode, t?: Partial<Strings>): void {
  for (const box of root.querySelectorAll<HTMLElement>(
    ".md-mermaid:not([data-theme])",
  ))
    void drawMermaid(box, t);
}

export const MERMAID: BlockSpec<string> = {
  id: "mermaid",
  match: { fence: "mermaid" },
  slash: {
    label: "mermaid",
    name: "sl_mermaid",
    icon: "◇",
    aliases: [
      "diagram",
      "flowchart",
      "다이어그램",
      "흐름도",
      "図",
      "フローチャート",
    ],
    section: "advanced",
    open: true,
    // A flowchart to edit, its labels in the UI's language.
    sample: (t) => "```mermaid\n" + t.mm_sample + "\n```",
  },
  template:
    "```mermaid\nflowchart LR\n  A[Idea] --> B{Worth keeping?}\n  B -->|Yes| C[Write a note]\n  B -->|No| D[Let it go]\n```",
  parse: (body) => body,
  renderStatic: mermaidHtml,
  // The code beside its live diagram; a parse error goes under the code and
  // the last good diagram stays.
  ...fenced<string>({
    name: (t) => t?.sl_mermaid ?? "Diagram",
    draw(box, src, ctx, _edit, report) {
      const drawn = box.querySelector<HTMLElement>(
        ":scope > .md-mermaid.is-drawn",
      );
      if (report && drawn)
        return redrawMermaid(drawn, src, ctx.t).then((m) => {
          if (m !== null) report(m);
        });
      // mermaidHtml's output, vault text escaped — the HTML Preview sets.
      box.innerHTML = mermaidHtml(src);
      return drawMermaid(box.firstElementChild as HTMLElement, ctx.t);
    },
    form: (body, ctx) =>
      textForm(ctx.t?.mm_f_code ?? "Diagram code", body, { rows: 6 }),
  }),
  estimatedHeight: () => 240,
};
