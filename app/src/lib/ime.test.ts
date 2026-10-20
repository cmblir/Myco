import { describe, expect, it, vi } from "vitest";
import { afterComposition, isComposingKey } from "./ime";

// The app ships ko/ja locales, so every Enter handler on a text input meets an
// IME commit before it ever meets a real submit. These cases are the two
// browsers' actual behaviours, not hypotheticals.
const key = (over: Partial<KeyboardEvent>): { nativeEvent: KeyboardEvent } => ({
  nativeEvent: { key: "Enter", isComposing: false, keyCode: 13, ...over } as KeyboardEvent,
});

describe("isComposingKey", () => {
  it("catches the Chromium commit (isComposing set)", () => {
    expect(isComposingKey(key({ isComposing: true, keyCode: 229 }))).toBe(true);
  });

  it("catches the WebKit commit, where isComposing is already false", () => {
    // The case that makes this more than a spec detail: Tauri renders in
    // WKWebView on macOS, and there the committing Enter can arrive after
    // compositionend, leaving 229 as the only tell.
    expect(isComposingKey(key({ isComposing: false, keyCode: 229 }))).toBe(true);
  });

  it("lets a real Enter through", () => {
    expect(isComposingKey(key({}))).toBe(false);
  });

  it("lets a real Enter through right after a composition finished", () => {
    // Committing the candidate and then pressing Enter again is how a CJK user
    // actually submits — that second press must not be swallowed.
    expect(isComposingKey(key({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it("lets arrow keys through outside composition", () => {
    expect(isComposingKey(key({ key: "ArrowDown", keyCode: 40 }))).toBe(false);
    expect(isComposingKey(key({ key: "ArrowDown", keyCode: 229, isComposing: true }))).toBe(true);
  });

  it("accepts a raw KeyboardEvent as well as a React synthetic event", () => {
    const raw = { key: "Enter", isComposing: true, keyCode: 229 } as KeyboardEvent;
    expect(isComposingKey(raw)).toBe(true);
  });
});

// A button pressed while a Korean syllable is still composing must not read
// the field before the IME commits that syllable into it.
describe("afterComposition", () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("runs at once when nothing is composing", () => {
    const run = vi.fn();
    afterComposition(new EventTarget(), false, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("waits for compositionend, then runs once", async () => {
    const field = new EventTarget();
    const run = vi.fn();
    afterComposition(field, true, run);
    await settle();
    expect(run).not.toHaveBeenCalled();
    field.dispatchEvent(new Event("compositionend"));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    field.dispatchEvent(new Event("compositionend"));
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs only the last of several presses made during one composition", async () => {
    // Two presses must not write the line twice once the syllable commits.
    const field = new EventTarget();
    const first = vi.fn();
    const last = vi.fn();
    afterComposition(field, true, first);
    afterComposition(field, true, last);
    field.dispatchEvent(new Event("compositionend"));
    await settle();
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledTimes(1);
  });
});
