// Archiving a deck removes the row whose button held focus; focus must land
// on a neighbour, not <body>. Plain objects stand in for the DOM (node env,
// as refocusAfterLater's test does).
import { describe, expect, it, vi } from "vitest";
import {
  intervalLabel,
  refocusAfterArchive,
  reviewFocus,
  reviewGrades,
  reviewKey,
  whenLabel,
} from "./PageStudy";
import { STRINGS } from "../lib/i18n";
import { daysBetween, initState } from "../lib/fsrs";
import { gradeCard, type Card } from "../lib/cards";
import { today } from "../stores/studyStore";

function focusable(): { focused: number; focus: () => void } {
  const el = { focused: 0, focus: () => void (el.focused += 1) };
  return el;
}

const doc = (rows: unknown[], browse: unknown): Document =>
  ({ querySelectorAll: () => rows, querySelector: () => browse }) as unknown as Document;

describe("refocusAfterArchive", () => {
  it("focuses the row now in the archived one's place, or the last row", () => {
    const rows = [focusable(), focusable()];
    refocusAfterArchive(1, doc(rows, null));
    expect(rows.map((r) => r.focused)).toEqual([0, 1]);
    // The last row was archived: the one above it takes focus.
    refocusAfterArchive(2, doc(rows, null));
    expect(rows.map((r) => r.focused)).toEqual([0, 2]);
  });

  it("falls back to the empty state's button once no deck is left", () => {
    const browse = focusable();
    refocusAfterArchive(0, doc([], browse));
    expect(browse.focused).toBe(1);
  });
});

describe("the deck row's ungrounded flag", () => {
  // No plural forms in the app yet: the English copy must read right for 1.
  it("reads right in English for a single card", () => {
    expect(STRINGS.en.st_ungrounded.replace("{n}", "1")).not.toMatch(/\b1 \w+ cards\b/);
  });
});

describe("review grades", () => {
  it("are Forgot (FSRS Again) and Remembered (Good), or all four in fine mode", () => {
    expect(reviewGrades(false)).toEqual([1, 3]);
    expect(reviewGrades(true)).toEqual([1, 2, 3, 4]);
  });

  it("label each button with the interval lib/fsrs schedules after it", () => {
    const T = "2026-01-01";
    const fresh: Card = { front: "q", back: "a", sourceRef: "[[n]]", state: null };
    const good = daysBetween(T, initState(3, T).due);
    expect(good).toBeGreaterThan(1);
    expect(intervalLabel(fresh, 1, T, "ko")).toBe("내일");
    expect(intervalLabel(fresh, 3, T, "ko")).toBe(`${good}일 후`);
    expect(intervalLabel(fresh, 3, T, "en")).toBe(`in ${good} days`);
    // A card reviewed before: the label follows its own state, not a new card's.
    const seen: Card = { ...fresh, state: { ...initState(3, T), stability: 60 } };
    expect(intervalLabel(seen, 3, initState(3, T).due, "en")).toMatch(/month/);
  });

  it("say days, then months, then years", () => {
    expect(whenLabel(1, "en")).toBe("tomorrow");
    expect(whenLabel(4, "ja")).toBe("4 日後");
    expect(whenLabel(45, "ko")).toBe("2개월 후");
    expect(whenLabel(800, "en")).toBe("in 2 years");
    // Eleven and a half months is a year, and a span, not "next month/year".
    expect(whenLabel(355, "ko")).toBe("1년 후");
    expect(whenLabel(31, "en")).toBe("in 1 month");
  });
});

describe("reviewKey", () => {
  const body = { tagName: "BODY", closest: () => null, ownerDocument: { querySelector: () => null } };
  // Plain objects stand in for the event and its target (node env).
  const ev = (key: string, over: Record<string, unknown> = {}) =>
    ({
      key,
      repeat: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      isComposing: false,
      defaultPrevented: false,
      target: body,
      ...over,
    }) as unknown as Parameters<typeof reviewKey>[0];
  const two = reviewGrades(false);
  const four = reviewGrades(true);

  it("Space shows the answer", () => {
    expect(reviewKey(ev(" "), false, two)).toBe("reveal");
    // Revealed, Space is the focused button's own (Remembered holds focus).
    expect(reviewKey(ev(" "), true, two)).toBeNull();
    // A focused control keeps its own Space: the flip button flips itself.
    expect(reviewKey(ev(" ", { target: { ...body, tagName: "BUTTON" } }), false, two)).toBeNull();
  });

  it("1/2 grade Forgot/Remembered, 1–4 in fine mode, only once revealed", () => {
    expect(reviewKey(ev("1"), true, two)).toBe(1);
    expect(reviewKey(ev("2"), true, two)).toBe(3);
    expect(reviewKey(ev("3"), true, two)).toBeNull();
    expect(reviewKey(ev("2"), true, four)).toBe(2);
    expect(reviewKey(ev("4"), true, four)).toBe(4);
    expect(reviewKey(ev("1"), false, two)).toBeNull();
  });

  it("leaves typing, chords, held keys and open dialogs alone", () => {
    expect(reviewKey(ev("1", { target: { ...body, tagName: "INPUT" } }), true, two)).toBeNull();
    expect(reviewKey(ev("1", { target: { ...body, tagName: "DIV", isContentEditable: true } }), true, two)).toBeNull();
    expect(reviewKey(ev("1", { metaKey: true }), true, two)).toBeNull();
    expect(reviewKey(ev("1", { repeat: true }), true, two)).toBeNull();
    expect(reviewKey(ev(" ", { isComposing: true }), false, two)).toBeNull();
    expect(reviewKey(ev("1", { defaultPrevented: true }), true, two)).toBeNull();
    const modal = { ...body, ownerDocument: { querySelector: () => ({}) } };
    expect(reviewKey(ev("1", { target: modal }), true, two)).toBeNull();
  });

  // Study can sit in a split pane: a key pressed in the other pane, or on
  // <body> while both panes show, is not the review's to grade.
  it("takes keys only from its own pane, and from <body> only with no split", () => {
    const flip = { ...body, tagName: "BUTTON" };
    const elsewhere = { ...body, tagName: "BUTTON" };
    const pane = { contains: (n: unknown) => n === flip };
    expect(reviewKey(ev("1", { target: flip }), true, two, { root: pane })).toBe(1);
    expect(reviewKey(ev("1", { target: elsewhere }), true, two, { root: pane })).toBeNull();
    expect(reviewKey(ev(" "), false, two, { root: pane, split: true })).toBeNull();
    expect(reviewKey(ev("2"), true, two, { root: pane, split: true })).toBeNull();
    expect(reviewKey(ev(" "), false, two, { root: pane, split: false })).toBe("reveal");
  });
});

describe("reviewFocus", () => {
  it("is the flip button, then Remembered, then the end card after the last grade", () => {
    expect(reviewFocus(true, false, 0)).toBe("flip");
    expect(reviewFocus(true, true, 0)).toBe("remembered");
    expect(reviewFocus(false, false, 2)).toBe("done");
    // Nothing due on open: the empty card takes no focus from the page.
    expect(reviewFocus(false, false, 0)).toBeNull();
  });
});

describe("today in a review", () => {
  // The user's calendar day: at 02:00 in Seoul, UTC is still on yesterday,
  // and a card forgotten then must come back on the user's tomorrow.
  it("is the local date, so Forgot at 02:00 KST is due the local tomorrow", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Seoul";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T02:00:00+09:00"));
    try {
      expect(today()).toBe("2026-10-02");
      const fresh: Card = { front: "q", back: "a", sourceRef: "[[n]]", state: null };
      expect(gradeCard(fresh, 1, today()).state?.due).toBe("2026-10-03");
    } finally {
      vi.useRealTimers();
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});
