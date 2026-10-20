import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadEmbed, prefillEmbeds, prefillQueries } from "./embedLoad";
import { ipc } from "./ipc";
import { markdownRenderer } from "./markdown";
import { pendingDrafts, useVaultStore } from "../stores/vaultStore";

const NOTE = "/v/wiki/topic.md";
const RAW =
  "---\ntype: concept\n---\n# Topic\n\nIntro <b>x</b>.\n\n## Part\n\nPart body ![a](./img.png)\n\n## Next\n\nnext";

describe("loadEmbed", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pendingDrafts.clear();
    useVaultStore.setState({
      currentVault: null,
      fileTree: [
        {
          kind: "directory",
          name: "wiki",
          path: "/v/wiki",
          children: [
            { kind: "file", name: "topic.md", path: NOTE },
            { kind: "file", name: "shot.png", path: "/v/wiki/shot.png" },
          ],
        },
      ],
    });
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: NOTE,
      raw: RAW,
      content: RAW,
      frontmatter: null,
    });
  });

  it("renders the heading's section, escaped, without the frontmatter", async () => {
    const html = await loadEmbed("Topic", "part");
    expect(html).toContain("<p>Part body");
    expect(html).not.toContain("Intro");
    expect(html).not.toContain("next");
    expect(await loadEmbed("topic", null)).toContain(
      "<p>Intro &lt;b&gt;x&lt;/b&gt;.</p>",
    );
  });

  it("is null for a missing note, a missing heading or a file that is no note", async () => {
    expect(await loadEmbed("nope", null)).toBeNull();
    expect(await loadEmbed("topic", "Nope")).toBeNull();
    expect(await loadEmbed("shot", null)).toBeNull();
  });

  it("gives the section's footnotes ids of their own, apart from the page's", async () => {
    pendingDrafts.set(NOTE, "## Part\n\nClaim[^a].\n\n[^a]: src");
    const one = await loadEmbed("topic", "Part");
    const two = await loadEmbed("topic", "Part");
    expect(one).not.toContain('id="fn1"');
    expect(one).toMatch(/id="fn-embed-\d+-1"/);
    expect(one?.match(/id="fn[^"]+"/)?.[0]).not.toBe(
      two?.match(/id="fn[^"]+"/)?.[0],
    );
  });

  it("reads the note's unsaved draft before its file", async () => {
    pendingDrafts.set(NOTE, "## Part\n\ndraft text");
    expect(await loadEmbed("topic", "Part")).toContain("draft text");
    expect(ipc.readFile).not.toHaveBeenCalled();
  });
});

// A Read-mode tick re-renders the page. Embed bodies set empty and refilled
// later collapsed the page for a moment (the scroll clamped to the top) and
// re-read every embed; the bodies already filled come back in the new HTML.
describe("prefillEmbeds", () => {
  const body = (html: string, target: string): string | undefined =>
    new RegExp(
      `data-embed="${target}"><div class="md-embed-head">.*?</div><div class="md-embed-body">(.*?)</div></div>`,
    ).exec(html)?.[1];

  it("writes each filled body back into the new HTML, by its target", () => {
    const html = markdownRenderer.render(
      '![[welcome]]\n\n> ![[a"b#H]]\n\n![[other]]\n\n- [ ] one\n',
    );
    const out = prefillEmbeds(
      html,
      new Map([
        ["welcome", "<p>w</p>"],
        ['a"b#H', "<p>h</p>"],
      ]),
    );
    expect(body(out, "welcome")).toBe("<p>w</p>");
    expect(body(out, "a&quot;b#H")).toBe("<p>h</p>");
    expect(body(out, "other")).toBe("");
    // Everything else is the renderer's HTML as it was.
    expect(out.replace("<p>w</p>", "").replace("<p>h</p>", "")).toBe(html);
  });

  it("leaves an embed inside a filled body a header: embeds never recurse", () => {
    const inner = markdownRenderer.render("text\n\n![[welcome]]\n");
    const html = markdownRenderer.render("![[welcome]]");
    const out = prefillEmbeds(html, new Map([["welcome", inner]]));
    expect(out).toBe(
      html.replace('<div class="md-embed-body"></div>', `<div class="md-embed-body">${inner}</div>`),
    );
    // The inner embed's body stays empty.
    expect(out.match(/<div class="md-embed-body"><\/div>/g)).toHaveLength(1);
  });

  it("is the HTML itself with nothing filled yet", () => {
    const html = markdownRenderer.render("![[welcome]]");
    expect(prefillEmbeds(html, new Map())).toBe(html);
  });
});

// The same tick redrew every query block from empty ("Running the query…"),
// so the page lost its height and the reader their scroll; the boxes drawn
// already come back in the new HTML, and nothing is run again.
describe("prefillQueries", () => {
  it("writes each drawn box back into the new HTML, by its query", () => {
    const html = markdownRenderer.render(
      '```myco-query\ntag:ml\n```\n\n> ```myco-query\n> "a<b" x\n> ```\n\n```myco-query\nother\n```\n\n- [ ] one\n',
    );
    const out = prefillQueries(
      html,
      new Map([
        ["tag:ml", "<div>m</div>"],
        ['"a<b" x', "<div>q</div>"],
      ]),
    );
    expect(out).toContain(
      '<div class="md-query" data-query="tag:ml"><div>m</div></div>',
    );
    expect(out).toContain(
      '<div class="md-query" data-query="&quot;a&lt;b&quot; x"><div>q</div></div>',
    );
    expect(out).toContain('<div class="md-query" data-query="other"></div>');
    // Everything else is the renderer's HTML as it was.
    expect(out.replace("<div>m</div>", "").replace("<div>q</div>", "")).toBe(
      html,
    );
  });

  it("before the embeds, so a query in an embedded section stays empty", () => {
    const inner = markdownRenderer.render("```myco-query\ntag:ml\n```\n");
    const html = markdownRenderer.render(
      "![[welcome]]\n\n```myco-query\ntag:ml\n```\n",
    );
    const out = prefillEmbeds(
      prefillQueries(html, new Map([["tag:ml", "<div>m</div>"]])),
      new Map([["welcome", inner]]),
    );
    expect(out.match(/<div>m<\/div>/g)).toHaveLength(1);
    expect(out).toContain(`<div class="md-embed-body">${inner}</div>`);
  });

  it("is the HTML itself with nothing drawn yet", () => {
    const html = markdownRenderer.render("```myco-query\ntag:ml\n```\n");
    expect(prefillQueries(html, new Map())).toBe(html);
  });
});
