import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import GraphMoreMenu, { menuKey } from "./GraphMoreMenu";
import { STRINGS } from "../lib/i18n";

describe("GraphMoreMenu (UX S44)", () => {
  it("is one named button that says it opens a menu", () => {
    const html = renderToStaticMarkup(
      createElement(GraphMoreMenu, {
        t: STRINGS.ko,
        items: [
          { key: "help", label: STRINGS.ko.gr_help_btn, onSelect: vi.fn() },
        ],
      }),
    );
    expect(html).toContain(STRINGS.ko.gr_more_menu);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    // Closed: the items are not on the page (no Tab stops behind it).
    expect(html).not.toContain(STRINGS.ko.gr_help_btn);
  });

  it("is named in every language", () => {
    for (const lang of ["en", "ko", "ja"] as const)
      expect(STRINGS[lang].gr_more_menu).toBeTruthy();
  });
});

// Keys inside the open menu: arrows walk the items (wrapping), Esc closes
// and goes home, Tab closes and lets focus move on past the button.
describe("menuKey", () => {
  it("walks the items with the arrows, wrapping at both ends", () => {
    expect(menuKey("ArrowDown", 0, 3)).toBe(1);
    expect(menuKey("ArrowDown", 2, 3)).toBe(0);
    expect(menuKey("ArrowUp", 0, 3)).toBe(2);
  });

  it("closes on Esc and leaves on Tab", () => {
    expect(menuKey("Escape", 1, 3)).toBe("close");
    expect(menuKey("Tab", 1, 3)).toBe("leave");
  });

  it("ignores other keys", () => {
    expect(menuKey("a", 0, 3)).toBeNull();
  });
});

// The toolbar used to be eight unnamed icons. Only zoom out / fit / zoom in
// stay as icons; everything else is a named item in the menu.
describe("PageGraph toolbar", () => {
  const src = readFileSync(
    new URL("../pages/PageGraph.tsx", import.meta.url),
    "utf8",
  );
  const tools = src.slice(src.indexOf("tools={"), src.indexOf("bar={"));

  it("keeps no icon button outside the zoom trio", () => {
    expect(tools).not.toContain("<IconButton");
    expect(tools).toContain("<ZoomButtons");
    expect(tools).toContain("<GraphMoreMenu");
  });
});
