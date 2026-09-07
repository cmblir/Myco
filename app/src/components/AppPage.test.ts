// The page frame. pageGridTemplate is the whole layout decision — which grid
// template a given rail combination produces — so it is covered directly; the
// rest is static markup (see ui.test.ts for why there is no live DOM here).

import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppPage, pageGridTemplate } from "./AppPage";
import { Rail, RailRow } from "./Rail";

describe("pageGridTemplate", () => {
  it("is a single body column with no rails", () => {
    expect(pageGridTemplate(false, false)).toBe("minmax(0, 1fr)");
  });

  it("puts a left rail before the body", () => {
    expect(pageGridTemplate(true, false)).toBe("var(--rail-w) minmax(0, 1fr)");
  });

  it("puts a right rail after the body", () => {
    expect(pageGridTemplate(false, true)).toBe("minmax(0, 1fr) var(--rail-w)");
  });

  it("brackets the body with both rails", () => {
    expect(pageGridTemplate(true, true)).toBe(
      "var(--rail-w) minmax(0, 1fr) var(--rail-w)",
    );
  });

  it("always leaves the body the only flexible column", () => {
    for (const [left, right] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const template = pageGridTemplate(left, right);
      expect(template.match(/minmax\(0, 1fr\)/g)).toHaveLength(1);
      expect(template.match(/var\(--rail-w\)/g) ?? []).toHaveLength(
        Number(left) + Number(right),
      );
    }
  });
});

describe("AppPage", () => {
  it("renders the title as the page's one h1", () => {
    const html = renderToStaticMarkup(
      h(AppPage, { title: "Provenance" }, "body"),
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Provenance");
    expect(html).toContain("body");
  });

  it("omits every optional slot rather than rendering an empty one", () => {
    const html = renderToStaticMarkup(h(AppPage, { title: "T" }));
    expect(html).not.toContain("u-page__eyebrow");
    expect(html).not.toContain("u-page__tools");
    expect(html).not.toContain("u-page__bar");
    expect(html).not.toContain("u-page__note");
    expect(html).not.toContain("u-page__rail");
  });

  it("renders eyebrow, tools, bar and note when given them", () => {
    const html = renderToStaticMarkup(
      h(AppPage, {
        eyebrow: "Tools",
        title: "T",
        tools: h("button", {}, "Run"),
        bar: h("div", {}, "filters"),
        note: "One line.",
      }),
    );
    for (const cls of [
      "u-page__eyebrow",
      "u-page__tools",
      "u-page__bar",
      "u-page__note",
    ]) {
      expect(html).toContain(cls);
    }
    expect(html).toContain("One line.");
  });

  it("hands the body grid its columns as --page-cols, not as an inline template", () => {
    // Inline `grid-template-columns` would outrank the media query that stacks
    // the rails on a narrow window; a custom property does not.
    const html = renderToStaticMarkup(
      h(AppPage, { title: "T", leftRail: h(Rail, { title: "Filters" }) }),
    );
    expect(html).toContain("--page-cols:var(--rail-w) minmax(0, 1fr)");
    expect(html).not.toContain("grid-template-columns");
    expect(html.match(/u-page__rail/g)).toHaveLength(1);
  });

  it("orders both rails around the body", () => {
    const html = renderToStaticMarkup(
      h(AppPage, {
        title: "T",
        leftRail: "L",
        rightRail: "R",
        children: "MID",
      }),
    );
    expect(html.indexOf("L")).toBeLessThan(html.indexOf("MID"));
    expect(html.indexOf("MID")).toBeLessThan(html.indexOf("R"));
  });

  it("reuses the app's existing page shells, so a migrated page keeps its column", () => {
    expect(renderToStaticMarkup(h(AppPage, { title: "T" }))).toContain(
      'class="workspace u-page"',
    );
    expect(
      renderToStaticMarkup(h(AppPage, { title: "T", wide: true })),
    ).toContain('class="workspace-wide u-page u-page--wide"');
  });

  it("keeps the sized body row — the rule that stops rails collapsing", () => {
    // Asserted against the stylesheet because the rule lives in CSS, not in
    // markup: without it the grid's items are content-height and a short rail
    // shrinks beside a tall body.
    const css = readFileSync(
      new URL("../styles/ui.css", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(
      /\.u-page__body\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/,
    );
  });
});

describe("Rail", () => {
  it("renders a titled panel, with the count only when given one", () => {
    expect(renderToStaticMarkup(h(Rail, { title: "Runs" }))).not.toContain(
      "u-rail__count",
    );
    const counted = renderToStaticMarkup(
      h(Rail, { title: "Runs", count: 20 }, "rows"),
    );
    expect(counted).toContain("Runs");
    expect(counted).toContain("20");
    expect(counted).toContain("rows");
  });
});

describe("RailRow", () => {
  it("is a plain row with no handler, and a real button with one", () => {
    const plain = renderToStaticMarkup(h(RailRow, {}, "x"));
    expect(plain).toContain("<div");
    expect(plain).not.toContain("<button");

    const clickable = renderToStaticMarkup(
      h(RailRow, { onClick: () => undefined }, "x"),
    );
    expect(clickable).toContain("<button");
    expect(clickable).toContain('type="button"');
    // Keyboard reachable: a real button, never taken out of the tab order.
    expect(clickable).not.toContain("tabindex");
  });

  it("marks the active row for assistive tech, not only in colour", () => {
    const html = renderToStaticMarkup(
      h(RailRow, { onClick: () => undefined, active: true }, "x"),
    );
    expect(html).toContain("is-active");
    expect(html).toContain('aria-current="true"');
  });
});
