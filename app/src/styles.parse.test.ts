// The TS gates never read styles.css, so a bad merge seam (an unclosed block)
// only surfaced in `vite build`. postcss ships with vite; parsing the sheet
// once here makes the gate fail where the merge happened.
//
// The other two tests are the design-vocabulary gate. Before them the sheet
// carried 10 different raw border-radius literals and 10 off-scale font-size
// literals, so every screen invented its own roundness and its own small
// text — the measured reason the app read as several apps stitched together.
// A cleanup without a gate re-scatters within a sprint, so the scale is
// enforced here rather than written down somewhere.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

// Every stylesheet the app ships, not just the big one: the shared UI layer
// (styles/ui.css) is exactly where a second vocabulary would take root, so it
// is held to the same scale. A new sheet must be added here or it escapes the
// gate — which is how the sheet under it drifted in the first place.
const SHEETS = [
  "styles.css",
  "styles/ui.css",
  "styles/everyday.css",
  "styles/intake.css",
  "styles/settings-navigation.css",
  "styles/myco-motion.css",
  "styles/graph-look-controls.css",
] as const;
const sources = SHEETS.map((rel) => ({
  rel,
  css: readFileSync(resolve(__dirname, rel), "utf8"),
}));
const roots = () =>
  sources.map(({ rel, css }) => ({
    rel,
    root: postcss.parse(css, { from: rel }),
  }));

/** The radius scale: --r-sm 6 · --r-md 10 · --r-lg 16 · --r-pill 999. */
const RADIUS_SCALE = /^var\(--r-(?:sm|md|lg|pill)\)$/;
/**
 * Radii that conform to hardware, not to the scale: the tray popover matches
 * the radius window-vibrancy rounds the native NSVisualEffectView to
 * (tray.rs), and the notch panel's radius grows with its width so the card
 * reads as pushed out of the Mac's cutout. Both are measured against
 * something physical — a scale step would visibly mismatch it. Anything new
 * here needs the same kind of justification, not just a taste preference.
 */
const RADIUS_GEOMETRY = /^var\(--r-(?:tray|notch|notch-open|notch-wide)\)$/;
/** `0` for a square corner, `50%` for a circle, `inherit` to follow a parent. */
const RADIUS_KEYWORDS = new Set(["0", "50%", "inherit"]);

/** The type scale, in px. Tokens --fs-11 … --fs-42 carry the same numbers. */
const TYPE_SCALE = new Set([11, 12.5, 14, 17, 22, 30, 42]);

const location = (decl: postcss.Declaration) => {
  const selector =
    "selector" in decl.parent!
      ? (decl.parent as postcss.Rule).selector
      : `@${(decl.parent as postcss.AtRule).name}`;
  return `${decl.source?.start?.line}: ${selector.replace(/\s+/g, " ")} { ${decl.prop}: ${decl.value} }`;
};

describe("the app's stylesheets", () => {
  it("parse as CSS", () => {
    expect(() => roots()).not.toThrow();
  });

  it("take every border-radius from the scale", () => {
    const offScale: string[] = [];
    for (const { rel, root } of roots())
      root.walkDecls(/^border-(?:.+-)?radius$/, (decl) => {
      // var() never contains a space, so the corner list splits on whitespace;
      // a `var(--r-md, 8px)` fallback splits into halves and fails, which is
      // the point — a literal in a fallback is still a literal.
        const corners = decl.value.trim().split(/\s+/);
        const onScale = corners.every(
          (corner) =>
            RADIUS_KEYWORDS.has(corner) ||
            RADIUS_SCALE.test(corner) ||
            RADIUS_GEOMETRY.test(corner),
        );
        if (!onScale) offScale.push(`${rel} ${location(decl)}`);
      });
    expect(offScale, `${offScale.length} off-scale radii`).toEqual([]);
  });

  it("take every font-size from the type scale", () => {
    const offScale: string[] = [];
    // The `font` shorthand sets a size too, so it cannot be a way around the
    // scale. Its grammar puts the size first of the two possible lengths
    // (`<size>[/<line-height>]`), so the first px number is the size and a px
    // line-height after it is none of this test's business.
    for (const { rel, root } of roots())
      root.walkDecls(/^font(-size)?$/, (decl) => {
        const px = [...decl.value.matchAll(/(-?[\d.]+)px/g)].map((m) =>
          Number(m[1]),
        );
        // No px at all: a token, `inherit`, or a relative unit (rem/em/%).
        const sizes = decl.prop === "font" ? px.slice(0, 1) : px;
        if (!sizes.every((size) => TYPE_SCALE.has(size)))
          offScale.push(`${rel} ${location(decl)}`);
      });
    expect(offScale, `${offScale.length} off-scale font sizes`).toEqual([]);
  });
});

describe("Navigation count badges", () => {
  it("centres tabular digits in a compact badge independent of the row line height", () => {
    const declarations: Record<string, string> = {};
    postcss.parse(sources[0].css).walkRules(".nav-badge", (rule) => {
      rule.walkDecls((decl) => void (declarations[decl.prop] = decl.value));
    });
    expect(declarations).toMatchObject({
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
      "line-height": "1",
      "font-variant-numeric": "tabular-nums",
      "white-space": "nowrap",
    });
  });
});

// A button that cannot be pressed has to read so (UX S26). The kit's .u-btn
// dims when disabled; the older .btn family had no disabled rule at all, so
// Ask's "질문하기" with an empty field looked and pointed like a live one.
describe("Disabled buttons", () => {
  const top = (rel: string, selector: string) => {
    const out = new Map<string, string>();
    postcss.parse(sources.find((s) => s.rel === rel)!.css).walkRules((rule) => {
      if (rule.parent?.type === "root" && rule.selectors.includes(selector))
        rule.walkDecls((d) => void out.set(d.prop, d.value));
    });
    return out;
  };

  it("dim the .btn family as the kit does, under a not-allowed cursor", () => {
    const kit = top("styles/ui.css", ".u-btn:disabled").get("opacity");
    for (const sel of [".btn:disabled", ".btn-primary:disabled"]) {
      const rule = top("styles.css", sel);
      expect([sel, rule.get("opacity")]).toEqual([sel, kit]);
      expect([sel, rule.get("cursor")]).toEqual([sel, "not-allowed"]);
    }
  });
});

// UX S22: the text size setting moves one variable, --read-scale (App sets it
// from uiStore.textSize). A reading surface sized in raw px would ignore it.
describe("Reading text size", () => {
  const sizes = new Map<string, string>();
  postcss.parse(sources[0].css).walkRules((rule) => {
    if (rule.parent?.type !== "root") return;
    rule.walkDecls("font-size", (d) => {
      for (const sel of rule.selectors) sizes.set(sel, d.value);
    });
  });

  it.each([
    ".prose",
    ".prose h1",
    ".prose h2",
    ".prose h3",
    ".myco-editor.live .cm-content",
    ".myco-editor.live .live-h1",
    ".myco-editor.live .live-h2",
    ".myco-editor.live .live-h3",
    ".ask-body",
  ])("%s scales with --read-scale", (sel) => {
    expect(sizes.get(sel)).toMatch(/^calc\(var\(--fs-\d+\) \* var\(--read-scale\)\)$/);
  });

  it("starts at 1, so nothing moves until the user picks a size", () => {
    const root = new Map<string, string>();
    postcss
      .parse(sources[0].css)
      .walkRules(":root", (rule) => rule.walkDecls((d) => void root.set(d.prop, d.value)));
    expect(root.get("--read-scale")).toBe("1");
  });
});

// CM measures a Live block widget (lib/blocks/live.ts) by its border box.
// A margin on it, or a child's margin collapsing through it (the TOC list's
// 8px), is height CM never sees: every line below sits lower than CM's
// height map, and a click there lands on the line under it.
describe("Live block widgets", () => {
  it("keep every margin inside the box CM measures", () => {
    const decls = new Map<string, string>();
    postcss
      .parse(sources[0].css)
      .walkRules(".myco-editor.live .cm-block-widget", (rule) =>
        rule.walkDecls((d) => void decls.set(d.prop, d.value)),
      );
    expect(decls.get("margin")).toBe("0");
    expect(decls.get("display")).toBe("flow-root");
  });
});

// The help panel stands above its button (bottom: 60px). With the Markdown
// keys it grew taller than the smallest window the app allows (tauri.conf
// 800×500), and its head and ✕ went off the top with nothing to scroll.
describe("Help panel", () => {
  const decls = (selector: string) => {
    const out = new Map<string, string>();
    postcss.parse(sources[0].css).walkRules((rule) => {
      // The base rule; a touch screen lifts it in its own media block.
      if (rule.parent?.type === "root" && rule.selector === selector)
        rule.walkDecls((d) => void out.set(d.prop, d.value));
    });
    return out;
  };

  it("is never taller than the window and scrolls inside itself", () => {
    const panel = decls(".help-widget__panel");
    expect(panel.get("bottom")).toBe("60px");
    // The last declaration wins: dvh, with the vh before it as the fallback.
    expect(panel.get("max-height")).toBe("calc(100dvh - 80px)");
    expect(panel.get("overflow-y")).toBe("auto");
  });

  it("keeps its head, and the close button, in view while it scrolls", () => {
    const head = decls(".help-widget__head");
    expect(head.get("position")).toBe("sticky");
    // The panel has no top padding, so `top: 0` is its top edge in every engine.
    expect(head.get("top")).toBe("0");
    expect(decls(".help-widget__panel").get("padding")).toMatch(/^0 /);
    expect(head.get("background")).toBe("inherit");
  });
});

// The activity PNGs are opaque squares with a dark ground baked in; only the
// 50% radius makes them round. On hover the tray row used to give the icon a
// filter (glow + brightness) and a scale of its own, and that hover is where
// the owner saw a square on the 제안된 링크 logo. Hover and focus feedback
// belong to the row; the icon stays a plain clipped circle.
describe("Activity icons", () => {
  const all = () => roots().flatMap(({ rel, root }) => {
    const rules: { rel: string; rule: postcss.Rule }[] = [];
    root.walkRules((rule) => void rules.push({ rel, rule }));
    return rules;
  });

  it("are a clipped circle", () => {
    const decls = new Map<string, string>();
    for (const { rule } of all())
      if (rule.selector === ".activity-icon")
        rule.walkDecls((d) => void decls.set(d.prop, d.value));
    expect(decls.get("border-radius")).toBe("50%");
    expect(decls.get("overflow")).toBe("hidden");
  });

  it("take no hover or focus styling of their own", () => {
    const onIcon: string[] = [];
    for (const { rel, rule } of all())
      for (const sel of rule.selectors)
        if (/:(?:hover|focus|focus-visible|focus-within|active)\b.*\.activity-icon/.test(sel))
          onIcon.push(`${rel} ${rule.source?.start?.line}: ${sel}`);
    expect(onIcon).toEqual([]);
  });
});

// Home's static band uses the existing theme surface and text tokens.
describe("Home's quiet band", () => {
  const hex = (h: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
    if (!m) throw new Error(`not a #rrggbb colour: ${h}`);
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  };
  const lum = (rgb: readonly number[]) => {
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: readonly number[], b: readonly number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const main = postcss.parse(sources[0].css);
  const everyday = postcss.parse(
    sources.find((s) => s.rel === "styles/everyday.css")!.css,
  );
  const tokens = (selector: string) => {
    const out = new Map<string, string>();
    main.walkRules((rule) => {
      if (rule.selector === selector)
        rule.walkDecls(/^--/, (d) => void out.set(d.prop, d.value));
    });
    return out;
  };
  const light = tokens(":root");
  const dark = new Map([...light, ...tokens('[data-theme="dark"]')]);
  const decl = (selector: string, prop: string) => {
    let value: string | undefined;
    everyday.walkRules((rule) => {
      if (rule.selector === selector)
        rule.walkDecls(prop, (d) => void (value = d.value));
    });
    if (value === undefined) throw new Error(`${selector} sets no ${prop}`);
    return value;
  };
  const resolve = (value: string, theme: Map<string, string>) =>
    hex(value.replace(/^var\((--[\w-]+)\)$/, (_, name) => theme.get(name) ?? ""));

  it("keeps the text on it AA: every text line sits on its own opaque pill", () => {
    const pill = ".home-band .home-ask__greet,\n.home-band .home-ask__keys";
    const texts = [
      ".home-ask__greet",
      ".home-ask__greet strong",
      ".home-ask__keys",
    ];
    const failing: string[] = [];
    for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
      const ground = resolve(decl(pill, "background"), theme);
      for (const sel of texts) {
        const ratio = contrast(resolve(decl(sel, "color"), theme), ground);
        if (ratio < 4.5) failing.push(`${name} ${sel}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failing).toEqual([]);
  });

  it("uses a static theme surface without a canvas backdrop rule", () => {
    expect(decl(".home-band", "background")).toBe("var(--bg-soft)");
    const canvasRules: string[] = [];
    everyday.walkRules((rule) => {
      if (rule.selector.includes("home-band") && rule.selector.includes("vp-canvas"))
        canvasRules.push(rule.selector);
    });
    expect(canvasRules).toEqual([]);
  });
});

// Home's ask box (PageOverview HomeAsk). Its key hint names Enter and
// Cmd+Enter, which a touch keyboard does not have; the box grows with its
// text (HomeAsk sets the height) up to four lines, then scrolls.
describe("Home's ask box", () => {
  const everyday = postcss.parse(
    sources.find((s) => s.rel === "styles/everyday.css")!.css,
  );
  const decls = (media: string | null, selector: string) => {
    const out = new Map<string, string>();
    everyday.walkRules((rule) => {
      const at = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule).params : null;
      if (at === media && rule.selectors.includes(selector))
        rule.walkDecls((d) => void out.set(d.prop, d.value));
    });
    return out;
  };

  it("shows the key hint only where a pointer hovers", () => {
    expect(decls("(hover: none)", ".home-ask__keys").get("display")).toBe("none");
  });

  it("stops growing at four of its own lines, then scrolls", () => {
    const box = decls(null, ".home-ask__input");
    const padBlock = box.get("padding")!.split(/\s+/)[0];
    expect(box.get("max-height")).toBe(
      `calc(4 * ${box.get("line-height")}em + 2 * ${padBlock} + 2px)`,
    );
    expect(box.get("border")).toMatch(/^1px /);
    expect(box.get("overflow-y")).toBe("auto");
  });
});

// The Ask abstain card in a narrow column (UX S30): at 375px a 112px orb
// beside a 30px title broke "이 질문에 답할 근거가…" two or three syllables a
// line. Measured on the card itself, so a split pane narrows it too.
describe("Abstain card", () => {
  const NARROW = "(max-width: 480px)";
  const decls = (container: string | null, selector: string) => {
    const out = new Map<string, string>();
    postcss.parse(sources[0].css).walkRules((rule) => {
      const at = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule) : null;
      const where = at?.name === "container" ? at.params : at ? `@${at.name}` : null;
      if (where === container && rule.selectors.includes(selector))
        rule.walkDecls((d) => void out.set(d.prop, d.value));
    });
    return out;
  };

  it("is the size container its narrow rules measure", () => {
    expect(decls(null, ".ask-abstain").get("container-type")).toBe("inline-size");
  });

  it("drops the orb and sets the title at 22px when narrow", () => {
    expect(decls(NARROW, ".ask-orb").get("display")).toBe("none");
    expect(decls(NARROW, ".ask-abstain h2").get("font-size")).toBe("22px");
  });

  it("breaks Korean between words, never inside one", () => {
    expect(decls(null, ".ask-abstain").get("word-break")).toBe("keep-all");
  });
});

// The Graph page's folding rails (PageGraph, GraphRailToggle). Where each rail
// and each fold tab sits is decided by the band a window falls in, so the
// rules that place them are pinned here; the widths they give the stage are
// measured in the browser.
describe("Graph rails", () => {
  const BAND = "(max-width: 1240px) and (min-width: 821px)";
  const decls = (media: string | null, selector: string) => {
    const out = new Map<string, string>();
    postcss.parse(sources[0].css).walkRules((rule) => {
      const at = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule).params : null;
      if (at === media && rule.selectors.includes(selector))
        rule.walkDecls((d) => void out.set(d.prop, d.value));
    });
    return out;
  };

  it("keep the legend in the left column at 821–1240px when the gaps rail folds", () => {
    // It lives under the gaps rail there; a column of its own on the right
    // moved it across the page and the stage 236px left, no wider.
    const legend = decls(BAND, ".u-page.graph-page.graph-page--legend-only .u-page__rail--right");
    expect([legend.get("grid-column"), legend.get("grid-row")]).toEqual(["1", "1"]);
    const main = decls(BAND, ".u-page.graph-page.graph-page--legend-only .u-page__main");
    expect([main.get("grid-column"), main.get("grid-row")]).toEqual(["2", "1"]);
    const body = decls(BAND, ".u-page.graph-page.graph-page--legend-only .u-page__body");
    expect(body.get("grid-template-columns")).toBe("var(--rail-w) minmax(0, 1fr)");
  });

  it("fold the legend to the left edge at 821–1240px, where it lives", () => {
    const tab = decls(BAND, ".graph-railtab--legend");
    expect([tab.get("left"), tab.get("right")]).toEqual(["0", "auto"]);
  });

  it("step the inspector and help in past the legend's tab only where it is on the right", () => {
    for (const sel of [
      ".graph-canvas-wrap.has-legend-tab .graph-inspector",
      ".graph-canvas-wrap.has-legend-tab .graph-help",
    ]) {
      expect(decls(null, sel).size).toBe(0);
      expect(decls("(min-width: 1241px)", sel).get("right")).toBe("40px");
    }
  });

  it("offer no fold at 820px and under, where the stacked rails get no height", () => {
    // The tab would expand a 0px rail and hand focus to a clipped chevron.
    expect(decls("(max-width: 820px)", ".graph-page [data-rail-toggle]").get("display")).toBe("none");
  });
});

// The Ask page's 기록 (UX S36). An opened past answer (1,000px and more for
// five quoted notes) used to be read inside the list's 20rem scroll box,
// inside a page that scrolls too, and its question scrolled out of the box.
describe("Ask history", () => {
  const decls = (selector: string) => {
    const out = new Map<string, string>();
    postcss.parse(sources.find((s) => s.rel === "styles/intake.css")!.css).walkRules((rule) => {
      if (rule.selector === selector) rule.walkDecls((d) => void out.set(d.prop, d.value));
    });
    return out;
  };

  it("keeps a long folded list compact, and lets an opened answer grow with the page", () => {
    expect(decls(".ask-history__list").get("max-height")).toBe("20rem");
    const opened = decls(".ask-history__list:has(.ask-hrow[open])");
    expect(opened.get("max-height")).toBe("none");
    // An overflow-auto box stays the scroller a sticky question sticks to.
    expect(opened.get("overflow-y")).toBe("visible");
  });

  it("keeps an opened answer's question in view while it is read", () => {
    // Only where :has uncaps the list: inside the capped box (Safari < 15.4)
    // a question stuck a topbar's height down would leave a gap above it.
    let at: string | null = null;
    postcss.parse(sources.find((s) => s.rel === "styles/intake.css")!.css).walkRules((rule) => {
      if (rule.selector === ".ask-hrow[open] > summary" && rule.parent?.type === "atrule")
        at = `@${(rule.parent as postcss.AtRule).name} ${(rule.parent as postcss.AtRule).params}`;
    });
    expect(at).toBe("@supports selector(:has(*))");
    const summary = decls(".ask-hrow[open] > summary");
    expect(summary.get("position")).toBe("sticky");
    // The page scrolls under the sticky topbar: at 0 it hid there.
    expect(summary.get("top")).toBe("var(--top-h)");
    // Opaque, or the passages scroll through it.
    expect(summary.get("background")).toBe("var(--bg)");
  });
});

// Touch targets (UX S47). An iPad or a touch laptop is a coarse pointer at a
// desktop width, so the 44px rules key on the pointer as well as the phone
// width. Small drawn controls keep their size and get an invisible ::after
// hit box; stacked rows grow instead, since overlapping hit boxes would hand
// a tap on one row's edge to its neighbour.
describe("Touch targets", () => {
  const TOUCH = "(max-width: 768px), (any-pointer: coarse)";
  const decls = (media: string, selector: string) => {
    const out = new Map<string, string>();
    for (const { root } of roots())
      root.walkRules((rule) => {
        const at = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule).params : null;
        if (at === media && rule.selectors.includes(selector))
          rule.walkDecls((d) => void out.set(d.prop, d.value));
      });
    return out;
  };

  it.each([".icon-btn", ".ngl-add", ".nav-item", ".qbtn", ".cmd-row", ".nav-group-toggle", ".u-segment__btn"])(
    "%s is 44px tall on a coarse pointer, not only on a phone",
    (sel) => {
      expect(decls(TOUCH, sel).get("min-height")).toBe("44px");
    },
  );

  it("grows the editor's completion rows (/ and [[) to 44px", () => {
    expect(decls(TOUCH, '.cm-tooltip-autocomplete li[role="option"]').get("min-height")).toBe("44px");
  });

  it("gives small drawn controls a 44px hit box without redrawing them", () => {
    const sel = ":where(.pill, .btn, .day-links__note, .ask-cite, .live-task)";
    expect(decls(TOUCH, sel).get("position")).toBe("relative");
    const hit = decls(TOUCH, `${sel}::after`);
    expect(hit.get("width")).toBe("max(100%, 44px)");
    expect(hit.get("height")).toBe("max(100%, 44px)");
    expect(hit.get("position")).toBe("absolute");
  });

  it("hides keyboard hints where nothing hovers (a touch screen)", () => {
    for (const sel of [".kbd", ".qbtn .qkbd", ".cmd-foot > :not(.cmd-foot__n)"])
      expect([sel, decls("(hover: none)", sel).get("display")]).toEqual([sel, "none"]);
  });
});

// Viewport, safe areas and input text (UX S48). iOS reports 0 for every
// safe-area inset unless the page opts in with viewport-fit=cover; a 100vh
// box there is taller than the visible area once the toolbar shows; and
// WebKit zooms the page into any input under 16px when it gets focus.
describe("Phone viewport", () => {
  it("opts into the safe areas", () => {
    const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
    expect(html).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/);
  });

  it("follows every 100vh with a 100dvh, the vh kept as the fallback", () => {
    const bare: string[] = [];
    for (const { rel, root } of roots())
      root.walkDecls((decl) => {
        if (!decl.value.includes("100vh")) return;
        const next = decl.next();
        const ok =
          next?.type === "decl" &&
          next.prop === decl.prop &&
          next.value === decl.value.replace(/100vh/g, "100dvh");
        if (!ok) bare.push(`${rel} ${location(decl)}`);
      });
    expect(bare).toEqual([]);
  });

  it("sets text inputs at 16px on a coarse pointer, so focus never zooms", () => {
    let found: postcss.Declaration | undefined;
    for (const { root } of roots())
      root.walkAtRules("media", (at) => {
        if (at.params !== "(any-pointer: coarse)") return;
        at.walkRules((rule) => {
          if (rule.selectors.includes("textarea") && rule.selectors.includes("select"))
            rule.walkDecls("font-size", (d) => void (found = d));
        });
      });
    expect(found?.value).toBe("1rem");
    expect(found?.important).toBe(true);
  });

  it("gives the help button 44px and lifts it off the home indicator", () => {
    const at = (media: string | null, sel: string) => {
      const out = new Map<string, string>();
      for (const { root } of roots())
        root.walkRules((rule) => {
          const m = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule).params : null;
          if (m === media && rule.selectors.includes(sel))
            rule.walkDecls((d) => void out.set(d.prop, d.value));
        });
      return out;
    };
    const touch = at("(max-width: 768px), (any-pointer: coarse)", ".help-widget__fab");
    expect([touch.get("width"), touch.get("height")]).toEqual(["44px", "44px"]);
    expect(at(null, ".help-widget__fab").get("bottom")).toContain("env(safe-area-inset-bottom");
  });
});

// The phone shell (UX S50): a short top bar that never scrolls sideways, a
// bottom bar under the thumb, and the ⌘K box at the bottom over the keyboard.
describe("Phone shell", () => {
  const PHONE = "(max-width: 768px)";
  const at = (media: string | null, sel: string) => {
    const out = new Map<string, string>();
    for (const { root } of roots())
      root.walkRules((rule) => {
        const m = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule).params : null;
        if (m === media && rule.selectors.includes(sel))
          rule.walkDecls((d) => void out.set(d.prop, d.value));
      });
    return out;
  };

  it("drops back/forward and the model chip from the phone top bar", () => {
    expect(at(PHONE, ".topbar-history").get("display")).toBe("none");
    expect(at(PHONE, ".model-chip-wrap").get("display")).toBe("none");
  });

  it("shows the bottom bar only on a phone, 44px items over the home indicator", () => {
    expect(at(null, ".phone-tabbar").get("display")).toBe("none");
    const bar = at(PHONE, ".phone-tabbar");
    expect(bar.get("display")).toBe("grid");
    expect(bar.get("padding-bottom")).toContain("env(safe-area-inset-bottom");
    expect(at(null, ".phone-tabbar__item").get("min-height")).toBe("44px");
  });

  it("puts the ⌘K box at the bottom, above the keyboard, results over it", () => {
    const overlay = at(PHONE, ".cmd-overlay");
    expect(overlay.get("place-items")).toBe("end center");
    expect(overlay.get("padding-bottom")).toContain("var(--kb-h");
    expect(at(PHONE, ".cmd-input").get("order")).toBe("3");
  });
});
