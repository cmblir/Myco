import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { fenceBlock } from "./index";
import { MERMAID, MERMAID_CONFIG, mermaidTheme, unlinkSvg } from "./mermaid";
import { liveBlocks } from "./live";
import { mycoMarkdown } from "../editorBlocks";
import { markdownRenderer } from "../markdown";

const { parser } = mycoMarkdown().language;
const lezer = (src: string) =>
  liveBlocks(parser.parse(src), Text.of(src.split("\n")));

const FLOW = "flowchart LR\n  A[Start] --> B{Go?}\n  B -->|Yes| C";
const fence = (body: string) => "```mermaid\n" + body + "\n```";

describe("```mermaid", () => {
  it("is the registry block its fence names", () => {
    expect(fenceBlock("mermaid")).toBe(MERMAID);
    expect(fenceBlock("mermaid  ")).toBe(MERMAID);
  });

  it("Preview draws its box with the source as code until mermaid is in", () => {
    const out = markdownRenderer.render(fence(FLOW));
    expect(out).toBe(
      '<div class="md-mermaid"><pre><code>flowchart LR\n  A[Start] --&gt; B{Go?}\n  B --&gt;|Yes| C\n</code></pre></div>\n',
    );
    expect(out).not.toContain("language-mermaid");
  });

  it("an unclosed fence stays code in both views", () => {
    const src = "```mermaid\nflowchart LR\n\nmore";
    expect(lezer(src)).toEqual([]);
    expect(markdownRenderer.render(src)).not.toContain("md-mermaid");
  });

  it("Live and Preview read the same diagram, nested in a callout too", () => {
    for (const src of [
      `# Plan\n\n${fence(FLOW)}\n\nend`,
      "> [!tip] Flow\n> ```mermaid\n> flowchart LR\n>   A --> B\n> ```",
      "- item\n\n  ```mermaid\n  graph TD\n    A --> B\n  ```",
    ]) {
      const [live] = lezer(src);
      expect(live.spec).toBe(MERMAID);
      const html = MERMAID.renderStatic!(live.parsed as string, {
        headings: [],
      });
      expect(markdownRenderer.render(src)).toContain(html);
    }
  });

  it("a script or javascript: payload in the fence is inert text", () => {
    const payload =
      'flowchart LR\n  A["<script>alert(1)</script>"] --> B["<img src=x onerror=alert(1)>"]\n  click A "javascript:alert(1)"';
    const out = markdownRenderer.render(fence(payload));
    expect(out).not.toMatch(/<script|<img|href=/i);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&quot;javascript:alert(1)&quot;");
  });

  it("mermaid runs strict (labels sanitized, no click handlers) in the app's theme", () => {
    expect(MERMAID_CONFIG).toMatchObject({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
    });
    expect(mermaidTheme("dark")).toBe("dark");
    expect(mermaidTheme("light")).toBe("default");
    expect(mermaidTheme(undefined)).toBe("default");
  });

  it("a diagram's `click A href` link opens outside, never in the webview", () => {
    // Stand-in anchors (node env, no DOM): mermaid's strict mode still
    // draws `<a xlink:href>` for `click A href "…"`.
    const XLINK = "http://www.w3.org/1999/xlink";
    const anchor = (attrs: Record<string, string>) => {
      const a = new Map(Object.entries(attrs));
      return {
        a,
        getAttribute: (n: string) => a.get(n) ?? null,
        getAttributeNS: (ns: string, n: string) =>
          ns === XLINK ? (a.get(`xlink:${n}`) ?? null) : null,
        setAttribute: (n: string, v: string) => void a.set(n, v),
        removeAttribute: (n: string) => void a.delete(n),
        removeAttributeNS: (ns: string, n: string) =>
          void (ns === XLINK && a.delete(`xlink:${n}`)),
      };
    };
    const links = [
      anchor({ "xlink:href": "https://example.com/" }),
      anchor({ href: "HTTP://x.y/z" }),
      anchor({ "xlink:href": "note.md", target: "_blank" }),
      anchor({ href: "mailto:a@example.com" }),
    ];
    unlinkSvg({ querySelectorAll: () => links } as unknown as ParentNode);
    expect(links.map((l) => Object.fromEntries(l.a))).toEqual([
      { "data-external": "https://example.com/" },
      { "data-external": "HTTP://x.y/z" },
      { target: "_blank" },
      { "data-external": "mailto:a@example.com" },
    ]);
  });
});
