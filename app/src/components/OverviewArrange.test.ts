import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultOverviewLayout } from "../lib/board";
import { STRINGS } from "../lib/i18n";
import { OverviewZoneBlocks, type ArrangeControl, type OverviewNodes } from "./OverviewArrange";

const noop = (): void => undefined;
const control = (): ArrangeControl => ({
  layout: defaultOverviewLayout(), arranging: false, setArranging: noop,
  reset: noop, dragId: null, dragOver: null, startDrag: () => noop,
  move: noop, setSpan: noop, announcement: "",
});
const nodes: OverviewNodes = {
  pulse: h("section", null, "Statistics"), links: h("section", null, "Links"),
  harvest: null, recent: null, board: null, contradictions: null, reunions: null,
};

describe("OverviewZoneBlocks", () => {
  it("keeps anchor parents present before and after a saved layout loads", () => {
    const ctl = control();
    const stacked = renderToStaticMarkup(h(OverviewZoneBlocks, { ctl, nodes, t: STRINGS.en }));
    ctl.layout = { ...ctl.layout, items: ctl.layout.items.map((item) => ({ ...item, span: 6 })) };
    const boxed = renderToStaticMarkup(h(OverviewZoneBlocks, { ctl, nodes, t: STRINGS.en }));
    for (const html of [stacked, boxed]) {
      expect(html).toContain('data-testid="overview-zone-main"');
      expect(html).toContain('data-block="links"');
      expect(html).not.toContain('data-drop=');
      expect(html).not.toContain('class="ovl-grip"');
    }
    expect(stacked).toContain("is-stack");
    expect(boxed).not.toContain("is-stack");
  });

  it("keeps keyboard grips and drop targets confined to arrange mode", () => {
    const ctl = control();
    ctl.arranging = true;
    const html = renderToStaticMarkup(h(OverviewZoneBlocks, { ctl, nodes, t: STRINGS.en }));
    expect(html.match(/class="ovl-grip"/g)).toHaveLength(ctl.layout.items.length);
    expect(html).toContain('data-drop="links"');
    expect(html).toContain('data-grip="links"');
  });
});
