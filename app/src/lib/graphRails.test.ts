import { describe, expect, it } from "vitest";
import { PANE_RAILS_MIN_PX, gestureHintDue, markGestureHintSeen, railKey, railsFoldInPane } from "./graphRails";

interface Target {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (sel: string) => unknown;
  ownerDocument?: {
    querySelector: (sel: string) => unknown;
    defaultView: { matchMedia: (query: string) => { matches: boolean } };
  };
}

/** A document with, or without, an open modal somewhere in it, at a window width. */
const doc = ({ modal = false, width = 1280 } = {}): Target["ownerDocument"] => ({
  querySelector: (sel) => (modal && sel === '[aria-modal="true"]' ? {} : null),
  defaultView: {
    matchMedia: (query) => {
      const max = /^\(max-width: (\d+)px\)$/.exec(query);
      return { matches: !!max && width <= Number(max[1]) };
    },
  },
});

const press = (
  key: string,
  target: Target | null = { tagName: "BODY" },
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat: boolean }> = {},
) => ({
  key,
  repeat: mods.repeat ?? false,
  metaKey: mods.metaKey ?? false,
  ctrlKey: mods.ctrlKey ?? false,
  altKey: mods.altKey ?? false,
  target: target as EventTarget | null,
});

describe("railKey — the [ and ] rail shortcuts", () => {
  it("folds the gaps rail on [ and the legend on ]", () => {
    expect(railKey(press("["))).toBe("gaps");
    expect(railKey(press("]"))).toBe("legend");
  });

  it("works from a focused button or the canvas, not only the page body", () => {
    expect(railKey(press("[", { tagName: "BUTTON" }))).toBe("gaps");
    expect(railKey(press("]", { tagName: "CANVAS" }))).toBe("legend");
    expect(railKey(press("[", null))).toBe("gaps");
  });

  it("does nothing while the user is typing — the graph search box included", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(railKey(press("[", { tagName }))).toBeNull();
      expect(railKey(press("]", { tagName }))).toBeNull();
    }
    expect(railKey(press("[", { tagName: "DIV", isContentEditable: true }))).toBeNull();
  });

  it("stays out of a modal over the graph (the Tidy sheet, a prompt)", () => {
    const inModal = { tagName: "BUTTON", closest: (sel: string) => (sel === '[aria-modal="true"]' ? {} : null) };
    expect(railKey(press("[", inModal))).toBeNull();
    const outside = { tagName: "BUTTON", closest: () => null };
    expect(railKey(press("[", outside))).toBe("gaps");
  });

  it("stays out of an open modal when a click on its text dropped focus to <body>", () => {
    expect(railKey(press("[", { tagName: "BODY", ownerDocument: doc({ modal: true }) }))).toBeNull();
    expect(railKey(press("]", { tagName: "BODY", ownerDocument: doc({ modal: true }) }))).toBeNull();
    expect(railKey(press("[", { tagName: "BODY", ownerDocument: doc() }))).toBe("gaps");
  });

  it("toggles once per press, not on every auto-repeat of a held key", () => {
    expect(railKey(press("[", undefined, { repeat: true }))).toBeNull();
    expect(railKey(press("]", undefined, { repeat: true }))).toBeNull();
  });

  it("offers no fold at 820px and under, where the stacked rails get no height", () => {
    expect(railKey(press("[", { tagName: "BODY", ownerDocument: doc({ width: 820 }) }))).toBeNull();
    expect(railKey(press("]", { tagName: "BODY", ownerDocument: doc({ width: 400 }) }))).toBeNull();
    expect(railKey(press("[", { tagName: "BODY", ownerDocument: doc({ width: 821 }) }))).toBe("gaps");
  });

  it("leaves modified chords to the app and the system (⌘[ is Back)", () => {
    expect(railKey(press("[", undefined, { metaKey: true }))).toBeNull();
    expect(railKey(press("]", undefined, { ctrlKey: true }))).toBeNull();
    expect(railKey(press("[", undefined, { altKey: true }))).toBeNull();
  });

  it("ignores every other key", () => {
    for (const key of ["{", "}", "f", "Escape", "Enter"]) expect(railKey(press(key))).toBeNull();
  });
});

describe("railsFoldInPane", () => {
  it("leaves the rails alone outside a split pane", () => {
    expect(railsFoldInPane(null)).toBe(false);
  });

  it("folds them in a pane too narrow for two rails and a stage (UX S42)", () => {
    // A 1280px window's split pane: 520px, where both rails left the stage 15px.
    expect(railsFoldInPane(520)).toBe(true);
    expect(railsFoldInPane(PANE_RAILS_MIN_PX - 1)).toBe(true);
  });

  it("keeps them in a pane wide enough for both", () => {
    expect(railsFoldInPane(PANE_RAILS_MIN_PX)).toBe(false);
    expect(railsFoldInPane(1200)).toBe(false);
  });
});

describe("gesture hint", () => {
  const store = (): Pick<Storage, "getItem" | "setItem"> => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  };

  it("is due once: the first visit shows it, later ones do not", () => {
    const s = store();
    expect(gestureHintDue(s)).toBe(true);
    markGestureHintSeen(s);
    expect(gestureHintDue(s)).toBe(false);
  });

  it("stays away where storage throws (it could never be dismissed for good)", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(gestureHintDue(broken)).toBe(false);
    expect(() => markGestureHintSeen(broken)).not.toThrow();
    expect(gestureHintDue(null)).toBe(false);
  });
});
