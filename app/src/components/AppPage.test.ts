// The page frame. pageGridTemplate is the whole layout decision — which grid
// template a given rail combination produces — so it is covered directly; the
// rest is static markup (see ui.test.ts for why there is no live DOM here).

import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppPage, focusIsIdle, focusPageHeading, PAGE_EDITOR, pageGridTemplate } from "./AppPage";
import { Rail, RailGroup, RailRow } from "./Rail";

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

  // UX S28 rule 2: a route change whose control unmounted (Home's ask box,
  // the wizard's last step) left focus on <body>; the page starts at its
  // title instead of the top of the document.
  it("lets a route change hand focus to the page title when it was on <body>", () => {
    const html = renderToStaticMarkup(h(AppPage, { title: "Ask" }));
    expect(html).toContain('<h1 class="u-page__title" tabindex="-1">');
    const title = { focused: 0, focus: () => void (title.focused += 1) };
    const body = {};
    const doc = (active: unknown) =>
      ({ activeElement: active, body, querySelector: () => title }) as unknown as Document;
    const el = (tagName: string, extra: object = {}) => ({
      tagName,
      isContentEditable: false,
      closest: () => null,
      ...extra,
    });
    focusPageHeading(doc(body));
    expect(title.focused).toBe(1);
    // A field being typed in keeps its focus.
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) focusPageHeading(doc(el(tag)));
    focusPageHeading(doc(el("DIV", { isContentEditable: true })));
    expect(title.focused).toBe(1);
  });

  // ⌘K to the graph handed focus back to the sidebar button that opened the
  // palette, so the next Tab walked the sidebar again (audit flow13 "GRAPH TAB").
  it("takes focus off the control that moved the page, but never out of a dialog", () => {
    const title = { focused: 0, focus: () => void (title.focused += 1) };
    const doc = (active: unknown) =>
      ({ activeElement: active, body: {}, querySelector: () => title }) as unknown as Document;
    const button = (inDialog: boolean) => ({
      tagName: "BUTTON",
      isContentEditable: false,
      closest: (sel: string) => (inDialog && sel.includes("dialog") ? {} : null),
    });
    focusPageHeading(doc(button(false)));
    expect(title.focused).toBe(1);
    focusPageHeading(doc(button(true)));
    expect(title.focused).toBe(1);
  });

  it("says when the page has no title yet, so a lazy route can be waited for", () => {
    const doc = (heading: unknown) =>
      ({ activeElement: null, body: {}, querySelector: () => heading }) as unknown as Document;
    expect(focusPageHeading(doc(null))).toBe(false);
    expect(focusPageHeading(doc({ focus: () => undefined }))).toBe(true);
  });

  // Opening a note from Home unmounts the clicked row, the route change parks
  // focus on the reader's title, and the editor mounting a moment later must
  // still take it, or the first keystrokes go nowhere (review of 4fd01986).
  it("counts focus parked on the page title as idle, so the editor can take it", () => {
    const body = {};
    const doc = (active: unknown) => ({ activeElement: active, body }) as unknown as Document;
    const el = (isHeading: boolean) => ({ matches: (sel: string) => isHeading && sel === ".route-fade h1" });
    expect(focusIsIdle(doc(body))).toBe(true);
    expect(focusIsIdle(doc(null))).toBe(true);
    expect(focusIsIdle(doc(el(true)))).toBe(true);
    expect(focusIsIdle(doc(el(false)))).toBe(false);
  });

  // Enter on a tree row: when the note editor mounts before the route change
  // runs, it finds focus still on the row and leaves it, so the route change
  // must hand focus to the editor itself, not park it on the title.
  it("hands focus to a note editor already on the page instead of the title", () => {
    const editor = { focused: 0, focus: () => void (editor.focused += 1) };
    const title = { focused: 0, focus: () => void (title.focused += 1) };
    const doc = {
      activeElement: null,
      body: {},
      querySelector: (sel: string) => (sel === PAGE_EDITOR ? editor : title),
    } as unknown as Document;
    expect(focusPageHeading(doc)).toBe(true);
    expect(editor.focused).toBe(1);
    expect(title.focused).toBe(0);
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

  it("puts a wide page's stage right after the header in source order (UX S44)", () => {
    // Tab order follows the DOM: the graph's canvas sat behind the question
    // bar and every gaps-rail row, 40 Tabs from the find field.
    const html = renderToStaticMarkup(
      h(AppPage, {
        title: "T",
        wide: true,
        tools: "TOOLS",
        bar: "BAR",
        note: "NOTE",
        leftRail: "LEFT",
        rightRail: "RIGHT",
        children: "STAGE",
      }),
    );
    const at = (s: string) => html.indexOf(s);
    expect(at("TOOLS")).toBeLessThan(at("STAGE"));
    expect(at("STAGE")).toBeLessThan(at("LEFT"));
    expect(at("LEFT")).toBeLessThan(at("BAR"));
    expect(at("STAGE")).toBeLessThan(at("NOTE"));
  });

  it("keeps a wide page's visual order with CSS order, not source order", () => {
    const css = readFileSync(new URL("../styles/ui.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.u-page--wide \.u-page__body \{[^}]*order: 1;/);
    expect(css).toMatch(/\.u-page--wide \.u-page__rail:not\(\.u-page__rail--right\) \{[^}]*order: -1;/);
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

// The three rails in the app — the reader's, the graph's gaps, the graph's
// legend — are this one part now, so the branches they each rely on are
// covered here rather than in three places.
describe("Rail collapse, footer and groups", () => {
  const noop = (): void => undefined;

  it("is a plain header until it is given a toggle", () => {
    const html = renderToStaticMarkup(h(Rail, { title: "Legend" }, "rows"));
    expect(html).toContain("<header");
    expect(html).not.toContain("aria-expanded");
    expect(html).toContain("rows");
  });

  it("becomes a real toggle button, and open=false hides the list", () => {
    const open = renderToStaticMarkup(
      h(Rail, { title: "Legend", open: true, onToggle: noop }, "rows"),
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("rows");

    const shut = renderToStaticMarkup(
      h(Rail, { title: "Legend", open: false, onToggle: noop }, "rows"),
    );
    expect(shut).toContain('aria-expanded="false"');
    // Collapsed means gone, not merely hidden: a screen reader must not read
    // 71 cluster rows out of a rail the user closed.
    expect(shut).not.toContain("rows");
  });

  it("takes a ratio as a count, because 3/9 is a count too", () => {
    expect(
      renderToStaticMarkup(h(Rail, { title: "Sources", count: "3/9" })),
    ).toContain("3/9");
  });

  it("pins the footer under the list, and drops it when collapsed", () => {
    const html = renderToStaticMarkup(
      h(Rail, { title: "Legend", footer: "KEY" }, "rows"),
    );
    expect(html).toContain("u-rail__foot");
    expect(html.indexOf("rows")).toBeLessThan(html.indexOf("KEY"));
    expect(
      renderToStaticMarkup(
        h(Rail, { title: "L", open: false, onToggle: noop, footer: "KEY" }),
      ),
    ).not.toContain("KEY");
  });

  it("renders a group as a labelled toggle whose body is its children", () => {
    const open = renderToStaticMarkup(
      h(
        RailGroup,
        { label: "Orphans", count: 8, open: true, onToggle: noop },
        "row",
      ),
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("Orphans");
    expect(open).toContain("8");
    expect(open).toContain("row");
    expect(
      renderToStaticMarkup(
        h(RailGroup, { label: "Orphans", open: false, onToggle: noop }, "row"),
      ),
    ).not.toContain("row");
  });
});

describe("RailRow actions", () => {
  const noop = (): void => undefined;

  it("never nests a button inside a button", () => {
    // The row cannot be the button once it carries actions — invalid markup,
    // and the actions would be unclickable. onClick moves to the label.
    const html = renderToStaticMarkup(
      h(
        RailRow,
        {
          onClick: noop,
          title: "notes/a.md",
          actions: h("button", { type: "button" }, "open"),
        },
        "a",
      ),
    );
    expect(html.startsWith("<div")).toBe(true);
    expect(html).toContain("u-rail__label");
    expect(html).toContain("u-rail__acts");
    expect(html).toContain('title="notes/a.md"');
    expect(html.match(/<button/g)).toHaveLength(2);
    // Siblings, not nested: nothing between the first <button> and its
    // </button> may open another one.
    const inside = html.slice(
      html.indexOf("<button") + "<button".length,
      html.indexOf("</button>"),
    );
    expect(inside).not.toContain("<button");
  });

  it("still labels a row with actions when it is not clickable", () => {
    const html = renderToStaticMarkup(
      h(RailRow, { actions: h("button", { type: "button" }, "ask") }, "a"),
    );
    expect(html).toContain('<span class="u-rail__label"');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});
