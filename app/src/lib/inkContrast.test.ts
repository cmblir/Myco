import { describe, expect, it } from "vitest";
import { isDarkInk } from "./inkContrast";

// A universe bubble's label used to be hardcoded near-white, for the dark cosmic
// backdrop. On the light theme that made the universe name — the one thing the
// multiverse view exists to tell you — an all-but-invisible smudge, while the
// labels inside the bubble (which do follow the theme) stayed crisp. The label
// now takes its ink from readTheme(); isDarkInk is what decides which way the
// contrasting glow behind it goes.
describe("isDarkInk", () => {
  it("reads the app's real ink values", () => {
    // graphTheme's own light/dark defaults.
    expect(isDarkInk("#111418")).toBe(true); // light theme → dark ink
    expect(isDarkInk("#e6e8eb")).toBe(false); // dark theme → light ink
  });

  it("accepts the rgb() form a computed style can return", () => {
    expect(isDarkInk("rgb(17, 20, 24)")).toBe(true);
    expect(isDarkInk("rgba(230, 232, 235, 0.9)")).toBe(false);
  });

  it("tolerates whitespace and case", () => {
    expect(isDarkInk("  #FFFFFF  ")).toBe(false);
    expect(isDarkInk("#000000")).toBe(true);
  });

  it("weights green over blue, as perceived luminance does", () => {
    // Pure blue is dark to the eye despite a high channel value; pure green is
    // not. A naive average would call both mid-grey and pick the wrong glow.
    expect(isDarkInk("#0000ff")).toBe(true);
    expect(isDarkInk("#00ff00")).toBe(false);
  });

  it("treats an unparseable colour as dark ink", () => {
    // Matches the light-theme default: if the CSS variable is missing or is a
    // form we do not parse, assume the common case rather than throw.
    expect(isDarkInk("")).toBe(true);
    expect(isDarkInk("var(--ink)")).toBe(true);
    expect(isDarkInk("oklch(0.2 0.1 240)")).toBe(true);
  });
});
