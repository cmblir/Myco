import { describe, expect, it } from "vitest";
import { isTextSize, readScale, TEXT_SIZES } from "./textSize";

describe("readScale", () => {
  it("keeps today's reading size for the system choice and for medium", () => {
    // Desktop has no confirmed OS text size to follow yet (UX S22), so
    // "follow the system" means the size the app already ships.
    expect(readScale("system")).toBe(1);
    expect(readScale("medium")).toBe(1);
  });

  it("orders small < medium < large", () => {
    expect(readScale("small")).toBeLessThan(1);
    expect(readScale("large")).toBeGreaterThan(1);
  });
});

describe("isTextSize", () => {
  it("accepts every choice and nothing else", () => {
    for (const s of TEXT_SIZES) expect(isTextSize(s)).toBe(true);
    for (const bad of ["huge", "", null, 3, undefined]) expect(isTextSize(bad)).toBe(false);
  });
});
