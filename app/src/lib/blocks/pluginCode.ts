// A plugin's fence (lib/plugins) whose renderer this build does not have —
// a `builtin:mermaid` fence before diagrams ship, say: its body as a plain
// code block with a line saying so, in Live and Preview alike. The file
// keeps the fence as written, so the renderer draws it once it is here.

import type { Strings } from "../i18n";
import { escapeHtml } from "../wikilinks";
import type { BlockSpec } from "./index";
import { fenced, textForm } from "./fencePanel";

const LINE_PX = 24; // one code line, and the note

function note(t: Strings | undefined, renderer: string): string {
  return (
    t?.pl_renderer_missing ??
    "This version has no {renderer} renderer, so the block shows as code."
  ).replace("{renderer}", renderer);
}

export function missingRenderer(
  lang: string,
  renderer: string,
): BlockSpec<string> {
  return {
    id: "plugin-code",
    match: { fence: lang },
    template: "```" + lang + "\n```",
    parse: (body) => body,
    renderStatic: (body, { env }) =>
      `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(body)}</code></pre>\n` +
      `<p class="md-plugin-note">${escapeHtml(note(env?.strings, renderer))}</p>\n`,
    // The fallback panel of any fence without one of its own: the body as
    // text, the result above it.
    ...fenced<string>({
      name: () => lang,
      draw(box, body, { t }) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = body;
        pre.append(code);
        const p = document.createElement("p");
        p.className = "md-plugin-note";
        p.textContent = note(t, renderer);
        box.replaceChildren(pre, p);
      },
      form: (body, ctx) => textForm(ctx.t?.fb_text ?? "Content", body),
    }),
    estimatedHeight: (body) =>
      (Math.max(1, body.split("\n").length - 1) + 1) * LINE_PX,
  };
}
