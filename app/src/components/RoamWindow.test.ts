// The roam window's view: one myco at the frame's spot and, while the job
// counts, the bubble beside it. Node-only like every suite here, so the
// markup is rendered to a string and the stylesheet read with postcss.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MockDesk, RoamStage } from "./RoamWindow";
import { ROAM_MYCO_PX } from "../lib/roam";
import type { RoamFrame } from "../lib/roam";

// The real mascot reads matchMedia through useSyncExternalStore, which has no
// server snapshot; the stage only decides where it stands and what it does.
vi.mock("./NotchMascot", () => ({
  default: ({ kind, placement }: { kind: string; placement: string }) =>
    createElement("span", {
      className: "notch-mascot",
      "data-placement": placement,
      "data-kind": kind,
    }),
  // No enter clip shipped: the procedural way home.
  resolveShipped: () => null,
}));

const frame: RoamFrame = {
  x: 300,
  y: 800,
  act: "running",
  sx: 1,
  sy: 1,
  progress: { done: 11, total: 20 },
};
const render = (f: RoamFrame, width = 1512): string =>
  renderToStaticMarkup(createElement(RoamStage, { frame: f, width }));

describe("the roaming preview's menu bar", () => {
  it("shows no resting mascot or count after the walk has disappeared", () => {
    const html = renderToStaticMarkup(createElement(MockDesk));
    expect(html).toContain('class="roam-mock-cutout"');
    expect(html).not.toContain("roam-mock-wing");
    expect(html).not.toContain("notch-mascot");
    expect(html).not.toContain("roam-bubble");
  });

  it("preserves the walking character and its job count below the menu", () => {
    const html = renderToStaticMarkup(
      createElement(MockDesk, null, createElement(RoamStage, { frame, width: 1512 })),
    );
    expect(html.match(/class="notch-mascot"/g)).toHaveLength(1);
    expect(html).toContain('data-placement="roam"');
    expect(html).toContain(">11/20</span>");
    expect(html).not.toContain("roam-mock-wing");
  });
});

describe("RoamStage", () => {
  it("stands one myco on the frame's spot, its feet at (x, y)", () => {
    const html = render(frame);
    expect(html.match(/class="notch-mascot"/g)).toHaveLength(1);
    expect(html).toContain('data-placement="roam"');
    expect(html).toContain('data-kind="running"');
    expect(html).toContain(
      `translate(${300 - ROAM_MYCO_PX / 2}px, ${800 - ROAM_MYCO_PX}px) rotate(0deg) skewX(0deg) scale(1, 1)`,
    );
  });

  it("leans a hop into the travel and trails the cap, from the feet", () => {
    expect(render({ ...frame, act: "hop", lean: 4.5, lag: 2 })).toContain(
      "rotate(4.5deg) skewX(2deg) scale(1, 1)",
    );
  });

  it("squashes and stretches the whole sprite", () => {
    expect(render({ ...frame, sx: 0.8, sy: 1.25 })).toContain(
      "scale(0.8, 1.25)",
    );
  });

  it("keeps a separate contact shadow on the ground during a hop", () => {
    const html = render({ ...frame, y: 770, groundY: 800 });
    expect(html).toContain('class="roam-shadow"');
    expect(html).toContain("translate(300px, 797px) translate(-50%, -50%)");
    expect(html.indexOf('class="roam-shadow"')).toBeLessThan(html.indexOf('class="roam-myco"'));
  });

  it("shrinks and fades the shadow with lift, and fades it out on return", () => {
    const shadowStyle = (f: RoamFrame) => render(f).match(/class="roam-shadow" style="([^"]+)"/)?.[1];
    expect(shadowStyle(frame)).toContain("scale(1, 1)");
    expect(shadowStyle({ ...frame, y: 770, groundY: 800 })).not.toContain("scale(1, 1)");
    expect(shadowStyle({ ...frame, act: "enter", y: 0, groundY: 160 })).toContain("opacity:0");
  });

  it("counts the steps in a bubble while the job reports them", () => {
    expect(render(frame)).toContain('<span class="roam-bubble"');
    expect(render(frame)).toContain(">11/20</span>");
    expect(render({ ...frame, progress: null })).not.toContain("roam-bubble");
  });

  it("puts the bubble on myco's left at a stop by the right edge, so it stays on screen", () => {
    // roamPlan's right-most stop: width - ROAM_EDGE - myco's half.
    const html = render({ ...frame, x: 1512 - 48 }, 1512);
    expect(html).toContain('class="roam-bubble roam-bubble-left"');
    expect(html).toContain(
      `translate(${1512 - 48 - ROAM_MYCO_PX / 2}px, ${800 - ROAM_MYCO_PX}px) translateX(-100%)`,
    );
    // Away from the edge it stays on the right.
    expect(render(frame)).toContain(`translate(${300 + ROAM_MYCO_PX / 2}px, ${800 - ROAM_MYCO_PX}px)"`);
  });

  it("is decoration only: hidden from assistive tech, the notch text is the status", () => {
    expect(render(frame)).toMatch(/^<div class="roam" aria-hidden="true"/);
  });
});

describe("the roam window's stylesheet", () => {
  const root = postcss.parse(
    readFileSync(resolve(__dirname, "../styles.css"), "utf8"),
  );
  const decls = (selector: string): Record<string, string> => {
    const out: Record<string, string> = {};
    root.walkRules((rule) => {
      if (rule.parent?.type !== "root" || !rule.selectors.includes(selector))
        return;
      rule.walkDecls((d) => void (out[d.prop] = d.value));
    });
    return out;
  };

  it("paints nothing but myco: the window is see-through and takes no pointer", () => {
    expect(decls("html.roam-window body").background).toBe("transparent");
    expect(decls(".roam")["pointer-events"]).toBe("none");
  });

  it("mirrors the bubble's gap when it sits on myco's left", () => {
    expect(decls(".roam-bubble-left").margin).toBe("6px 2px 0 0");
  });

  it("draws myco at the roam size", () => {
    expect(decls('.notch-mascot[data-placement="roam"]')).toMatchObject({
      width: `${ROAM_MYCO_PX}px`,
      height: `${ROAM_MYCO_PX}px`,
    });
  });

  it("paints the contact shadow without an extra animation or blur", () => {
    const shadow = decls(".roam-shadow");
    expect(shadow.background).toContain("radial-gradient");
    expect(shadow.filter).toBeUndefined();
    expect(shadow.animation).toBeUndefined();
  });
});
