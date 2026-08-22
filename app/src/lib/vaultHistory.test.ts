import { describe, expect, it } from "vitest";
import { shouldOfferHistory, DISMISS_KEY } from "./vaultHistory";

describe("shouldOfferHistory", () => {
  it("offers when history is off and not dismissed", () => {
    expect(shouldOfferHistory({ gitPresent: false, enabled: false, dismissed: false })).toBe(true);
  });
  it("offers enable-only when a repo already exists but the flag is off", () => {
    expect(shouldOfferHistory({ gitPresent: true, enabled: false, dismissed: false })).toBe(true);
  });
  it("never offers once enabled or dismissed", () => {
    expect(shouldOfferHistory({ gitPresent: true, enabled: true, dismissed: false })).toBe(false);
    expect(shouldOfferHistory({ gitPresent: false, enabled: false, dismissed: true })).toBe(false);
  });
  it("exports a stable dismiss key", () => {
    expect(DISMISS_KEY).toBe("myco.vaultHistory.dismissed");
  });
});
