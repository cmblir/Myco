// The notch surface's state → display mapping. Only the pure parts are tested:
// this repo's vitest is node-only (see vitest.config.ts), so there is no DOM to
// render into — which is exactly why describeNotch exists as a function rather
// than a pile of ternaries inside the JSX.
//
// What this guards: the ten design-sheet states each land on the right lip
// copy and the right cap tone, and the colour rule holds — purple only while
// something is alive, amber only on a refusal, green only when finished.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import NotchPanel, {
  CANCELLED_DWELL_MS,
  DONE_DWELL_MS,
  MOCK_FRAMES,
  clampPercent,
  clock,
  describeNotch,
  type NotchPanelProps,
  type NotchState,
} from "./NotchPanel";
import { STRINGS } from "../lib/i18n";
import { EMPTY_CAPTION } from "../lib/liveCaption";
import { useUIStore } from "../stores/uiStore";

// The real mascot reads matchMedia through useSyncExternalStore, which has no
// server snapshot; the panel's markup only needs to know where it stands.
vi.mock("./NotchMascot", () => ({
  default: ({ placement }: { placement: string }) =>
    createElement("span", { className: "notch-mascot", "data-placement": placement }),
}));
// react-dom/server renders zustand's server snapshot — the store's INITIAL
// state, whatever setState did — so the panel reads a plain object here.
vi.mock("../stores/uiStore", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const state = { lang: "en", mascotEnabled: true };
  const useUIStore = Object.assign(
    <T,>(select: (s: typeof state) => T): T => select(state),
    {
      getState: () => state,
      setState: (patch: Partial<typeof state>) => void Object.assign(state, patch),
      // distillStore subscribes at import (a tab switch clears its error).
      subscribe: () => () => undefined,
    },
  );
  return { ...real, useUIStore };
});

const t = STRINGS.en;

describe("describeNotch", () => {
  it("S1 idle shows the bare dim cap and no label", () => {
    expect(describeNotch({ kind: "idle" }, t)).toEqual({
      lip: "",
      tone: "dim",
      open: false,
      dwellMs: null,
    });
  });

  it("S10 fallback also stays invisible while idle", () => {
    expect(describeNotch({ kind: "idle" }, t)).toEqual({
      lip: "",
      tone: "dim",
      open: false,
      dwellMs: null,
    });
  });

  it("S2 peek invites without accepting", () => {
    const view = describeNotch({ kind: "peek" }, t);
    expect(view.lip).toBe(t.notch_peek);
    expect(view.tone).toBe("live");
    expect(view.open).toBe(true);
  });

  it("S3 drag enter opens with the live tone", () => {
    const view = describeNotch(
      { kind: "dragging", name: "attention.pdf", meta: "PDF · 2.4 MB" },
      t,
    );
    expect(view.lip).toBe(t.notch_drop);
    expect(view.tone).toBe("live");
    expect(view.open).toBe(true);
  });

  it("S4 accepted opens with the live tone", () => {
    const view = describeNotch({ kind: "accepted", rel: "attention.pdf" }, t);
    expect(view.lip).toBe(t.notch_accepted);
    expect(view.tone).toBe("live");
    expect(view.open).toBe(true);
  });

  it("S5 running interpolates the padded clock into the lip", () => {
    const view = describeNotch(
      { kind: "running", percent: 72, detail: "self-attention", elapsedMs: 42_000 },
      t,
    );
    expect(view.lip).toBe("Ingesting · 00:42");
    expect(view.lip).not.toContain("{t}");
    expect(view.tone).toBe("live");
  });

  it("S6 done goes green and folds itself away after 4s", () => {
    const view = describeNotch({ kind: "done", summary: "3 pages" }, t);
    expect(view.tone).toBe("ok");
    expect(view.dwellMs).toBe(DONE_DWELL_MS);
    expect(DONE_DWELL_MS).toBe(4000);
  });

  it("S7 text capture opens with the live tone", () => {
    const view = describeNotch({ kind: "capture", text: "why OTP" }, t);
    expect(view.lip).toBe(t.notch_capture);
    expect(view.tone).toBe("live");
    expect(view.open).toBe(true);
  });

  it("S7 saved goes green and folds on S6's 4s clock", () => {
    const view = describeNotch({ kind: "captured", rel: "daily/2026-08-25.md" }, t);
    // Same sentence as Home's capture: both write to today's note (UX S39).
    expect(view.lip).toBe(t.home_captured);
    expect(view.tone).toBe("ok");
    expect(view.dwellMs).toBe(DONE_DWELL_MS);
  });

  it("S8 recording interpolates its own clock", () => {
    const view = describeNotch(
      {
        kind: "recording",
        elapsedMs: 7000,
        caption: EMPTY_CAPTION,
        noInput: false,
      },
      t,
    );
    expect(view.lip).toBe("Recording · 00:07");
    expect(view.tone).toBe("live");
  });

  it("a silent mic replaces the clock — the lip is the only place it shows", () => {
    // The complaint this whole pass answers: a muted or wrong mic looked
    // exactly like a working one, so a 13 s take could capture nothing.
    const view = describeNotch(
      {
        kind: "recording",
        elapsedMs: 7000,
        caption: EMPTY_CAPTION,
        noInput: true,
      },
      t,
    );
    expect(view.lip).toBe(t.notch_no_sound);
  });

  it("S8 cancelled goes amber and folds itself after 800ms", () => {
    const view = describeNotch({ kind: "cancelled" }, t);
    expect(view.lip).toBe(t.notch_cancelled);
    expect(view.tone).toBe("warn");
    expect(view.dwellMs).toBe(CANCELLED_DWELL_MS);
    expect(CANCELLED_DWELL_MS).toBe(800);
  });

  it("S8 saving names the stage on the lip, never 'Recording'", () => {
    // A ticking "Recording · 00:07" beside "Transcribing… 40%" reads as a mic
    // still running; the frozen clock stays in the body row.
    const view = describeNotch(
      {
        kind: "saving",
        elapsedMs: 7000,
        caption: EMPTY_CAPTION,
        stage: "transcribing",
        pct: 40,
      },
      t,
    );
    expect(view.lip).toBe(t.voice_stage_transcribing);
    expect(view.tone).toBe("live");
    expect(view.dwellMs).toBeNull();
    expect(
      describeNotch(
        {
          kind: "saving",
          elapsedMs: 7000,
          caption: EMPTY_CAPTION,
          stage: "saving",
          pct: 100,
        },
        t,
      ).lip,
    ).toBe(t.voice_stage_saving);
  });

  it("S9 rejection is the only amber state", () => {
    const view = describeNotch({ kind: "rejected", ext: ".epub" }, t);
    expect(view.lip).toBe(t.notch_rejected);
    expect(view.tone).toBe("warn");
    // A refusal is never silent: it has to open to say what would work.
    expect(view.open).toBe(true);
  });

  it("only the finished states — and the cancelled beat — self-collapse", () => {
    const dwelling = MOCK_FRAMES.filter(
      (f) => describeNotch(f.state, t).dwellMs !== null,
    );
    expect(dwelling.map((f) => f.state.kind)).toEqual([
      "done",
      "captured",
      "cancelled",
    ]);
  });

  it("every state but idle unfolds the body", () => {
    const collapsed = MOCK_FRAMES.filter(
      (f) => !describeNotch(f.state, t).open,
    );
    expect(collapsed.map((f) => f.state.kind)).toEqual(["idle", "idle"]);
  });

  it("translates every state in every language without leaving a placeholder", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      for (const frame of MOCK_FRAMES) {
        const view = describeNotch(frame.state, STRINGS[lang]);
        expect(view.lip).not.toContain("{");
        // Idle remains silent on both notched and notchless displays.
        if (frame.state.kind !== "idle") {
          expect(view.lip.length).toBeGreaterThan(0);
        } else {
          expect(view.lip).toBe("");
        }
      }
    }
  });
});

describe("MOCK_FRAMES", () => {
  it("walks the design sheet's states in order (plus S7's saved outcome)", () => {
    expect(MOCK_FRAMES.map((f) => f.state.kind)).toEqual([
      "idle",
      "peek",
      "dragging",
      "accepted",
      "running",
      "done",
      "capture",
      "captured",
      "recording",
      "saving",
      "cancelled",
      "rejected",
      "idle",
    ]);
    // S10 is the only pill frame.
    expect(MOCK_FRAMES.filter((f) => f.pill)).toHaveLength(1);
    expect(MOCK_FRAMES[MOCK_FRAMES.length - 1].pill).toBe(true);
  });

  it("covers every kind of the union", () => {
    const kinds: NotchState["kind"][] = [
      "idle",
      "peek",
      "dragging",
      "accepted",
      "running",
      "done",
      "capture",
      "captured",
      "recording",
      "saving",
      "cancelled",
      "rejected",
    ];
    const seen = new Set(MOCK_FRAMES.map((f) => f.state.kind));
    expect([...kinds].filter((k) => !seen.has(k))).toEqual([]);
  });
});

describe("clock", () => {
  it("zero-pads the minute so the lip does not shift on rollover", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(7000)).toBe("00:07");
    expect(clock(42_000)).toBe("00:42");
    expect(clock(600_000)).toBe("10:00");
    // Every reading is the same width until the hour mark.
    expect(clock(0)).toHaveLength(clock(599_000).length);
  });
});

describe("clampPercent", () => {
  it("keeps a meter width inside 0–100", () => {
    expect(clampPercent(72)).toBe(72);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(71.6)).toBe(72);
  });

  it("turns NaN into 0 rather than `width: NaN%`", () => {
    // A CSS length of NaN drops the whole declaration, leaving a full-width
    // bar that reads as 100% done.
    expect(clampPercent(Number.NaN)).toBe(0);
  });

  it("clamps an overflowing reading to full, not empty", () => {
    // Past-full means done, not stalled — 0 here would show a finished job as
    // a bar that never started.
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampPercent(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("the collapsed surface's markup", () => {
  beforeAll(() => {
    // readMockParams reads location at first render; node has none.
    vi.stubGlobal("location", { search: "" });
  });

  const render = (mascot: boolean, props: NotchPanelProps): string => {
    useUIStore.setState({ lang: "en", mascotEnabled: mascot });
    return renderToStaticMarkup(createElement(NotchPanel, props));
  };
  const waiting = (n: number): NotchPanelProps => ({
    collapsedWidth: 204,
    agenda: { total: n, rows: [] },
  });

  it.each([0, 1, 2, 28189])("keeps a collapsed surface undecorated with %i waiting decisions", (count) => {
    for (const mascot of [true, false]) {
      for (const pill of [true, false]) {
        const html = render(mascot, { ...waiting(count), pill });
        expect(html).not.toContain("notch-mascot");
        expect(html).not.toContain("notch-mark");
        expect(html).not.toContain("notch-cap");
        expect(html).not.toContain("notch-winged");
        expect(html).not.toContain("--notch-wing-w");
      }
    }
  });

  it("draws no myco while it is out roaming the screen, so there is never a second one", () => {
    const running: NotchState = { kind: "running", percent: 55, detail: "11/20", elapsedMs: 0 };
    for (const props of [waiting(3), { ...waiting(0), state: running }, { ...waiting(3), pill: true }]) {
      const html = render(true, { ...props, mascotAway: true });
      expect(html).not.toContain("notch-mascot");
      expect(html).not.toContain("notch-mark");
    }
    expect(render(true, { ...waiting(3), mascotAway: true })).not.toContain("notch-body");
    expect(render(true, { ...waiting(0), state: running, mascotAway: true })).toContain("notch-lip-label");
  });

  it("shows one myco inside the open card", () => {
    const html = render(true, { ...waiting(3), state: { kind: "peek" } });
    expect(html.match(/class="notch-mascot"/g)).toHaveLength(1);
    expect(html).toContain('data-placement="panel"');
    expect(html).not.toContain("notch-mark");
  });
});

// The mascot renders INSIDE .notch, so whatever animates the card animates
// the character too. Layout is measured in a browser; this pins the rules.
describe("the notch's stylesheet", () => {
  const root = postcss.parse(readFileSync(resolve(__dirname, "../styles.css"), "utf8"));

  it("unfurls the card by revealing it, never by scaling what is inside", () => {
    // A scaleY(0.3) unfurl flattened the mascot to a pancake for the first
    // ~90 ms of every open; only its own spring may squash it (decision 2).
    const props: string[] = [];
    root.walkAtRules("keyframes", (at) => {
      if (at.params === "notch-unfurl") at.walkDecls((d) => void props.push(d.prop));
    });
    expect(props).toContain("clip-path");
    expect(props).not.toContain("transform");
    expect(props).not.toContain("scale");
  });

  /** Declarations of the top-level rules listing `selector`. */
  const decls = (selector: string): Record<string, string> => {
    const out: Record<string, string> = {};
    root.walkRules((rule) => {
      if (rule.parent?.type !== "root" || !rule.selectors.includes(selector)) return;
      rule.walkDecls((d) => void (out[d.prop] = d.value));
    });
    return out;
  };

  it("folds the card and the mascot in the same frame", () => {
    // Collapsed, the ground is transparent at once; a card still shrinking
    // and a mascot still sliding home hung card-less over the app below for
    // ~240 ms. Only opening animates; the pill's black ground keeps its fold.
    expect(decls(".notch:not(.notch-open)").transition).toBe("none");
    expect(decls(".notch-mascot").transition).toBeUndefined();
    expect(decls(".notch.notch-open .notch-mascot").transition).toMatch(/^left 340ms/);
  });

  it("fades the cap glow back in after a clip, never pops it", () => {
    // Unmounted under a clip, the glow remounted with no transition, so the
    // still's first frame already showed it at full strength (accepted 0.6,
    // done 0.4). It stays mounted: a clip hides it at once, and when the clip
    // goes its own 240 ms transition brings it back.
    expect(decls(".notch-mascot-clip ~ .notch-mascot-glow")).toMatchObject({
      opacity: "0",
      transition: "none",
    });
    expect(decls(".notch-mascot-glow").transition).toMatch(/^opacity 240ms/);
  });

  it("keeps the collapsed hotspot transparent and cutout-wide", () => {
    expect(decls(".notch").width).toBe("var(--notch-collapsed)");
    expect(decls(".notch").background).toBe("transparent");
    expect(decls(".notch:not(.notch-open):not(.notch-pill)")["min-height"]).toBe(
      "calc(var(--notch-cutout, 0px) + 14px)",
    );
    expect(decls(".notch.notch-pill").background).toBeUndefined();
    expect(decls(".notch.notch-pill")["box-shadow"]).toBeUndefined();
    expect(decls(".notch.notch-pill.notch-open").background).toBe("#000");
  });

});
