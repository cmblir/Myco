// The Settings shortcut recorder. Every string this produces has to be one
// Rust's `spotlight::plan_shortcut` accepts (global-hotkey's parser) — the
// Rust-side test `the_default_shortcut_parses` covers the other end of the
// same contract.

import { describe, expect, it } from "vitest";
import { accelFromEvent, formatAccel } from "./shortcutAccel";

const press = (
  code: string,
  mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {},
): Parameters<typeof accelFromEvent>[0] => ({
  code,
  ctrlKey: mods.ctrlKey ?? false,
  altKey: mods.altKey ?? false,
  shiftKey: mods.shiftKey ?? false,
  metaKey: mods.metaKey ?? false,
});

describe("accelFromEvent", () => {
  it("builds the default option+space", () => {
    expect(accelFromEvent(press("Space", { altKey: true }))).toBe("Alt+Space");
  });

  it("orders modifiers stably regardless of which are held", () => {
    expect(
      accelFromEvent(
        press("KeyK", { metaKey: true, ctrlKey: true, shiftKey: true, altKey: true }),
      ),
    ).toBe("Control+Alt+Shift+Command+KeyK");
  });

  it("ignores a modifier pressed on its own — the combination is not finished", () => {
    for (const code of ["AltLeft", "ControlRight", "ShiftLeft", "MetaRight"]) {
      expect(accelFromEvent(press(code, { altKey: true }))).toBeNull();
    }
  });

  it("refuses a modifier-less key: it would swallow that key in every app", () => {
    expect(accelFromEvent(press("Space"))).toBeNull();
    expect(accelFromEvent(press("KeyK"))).toBeNull();
    expect(accelFromEvent(press(""))).toBeNull();
  });
});

describe("formatAccel", () => {
  it("shows mac glyphs without separators", () => {
    expect(formatAccel("Alt+Space", true)).toBe("⌥Space");
    expect(formatAccel("Control+Shift+KeyK", true)).toBe("⌃⇧K");
  });

  it("keeps words elsewhere and strips the Key/Digit prefix", () => {
    expect(formatAccel("Control+Shift+KeyK", false)).toBe("Control+Shift+K");
    expect(formatAccel("Alt+Digit1", false)).toBe("Alt+1");
  });

  it("renders an empty (disabled) shortcut as nothing", () => {
    expect(formatAccel("", true)).toBe("");
  });
});
