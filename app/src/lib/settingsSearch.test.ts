import { describe, expect, it } from "vitest";
import { STRINGS } from "./i18n";
import { matchSettings, SETTINGS_INDEX } from "./settingsSearch";

describe("matchSettings", () => {
  it("blank query lists every tab with every label", () => {
    const m = matchSettings(STRINGS.en, "");
    expect(m.size).toBe(8);
    expect(m.get("model")).toHaveLength(9);
  });

  it("narrows to the tab whose label contains the query", () => {
    const m = matchSettings(STRINGS.en, "spend");
    expect([...m.keys()]).toEqual(["model"]);
    expect(m.get("model")).toEqual(["Monthly spend guard"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(matchSettings(STRINGS.en, "  SPEND ")).toEqual(
      matchSettings(STRINGS.en, "spend"),
    );
  });

  it("searches labels, not key names", () => {
    expect(matchSettings(STRINGS.en, "budget").size).toBe(0);
  });

  it("matches the tab title itself", () => {
    expect(matchSettings(STRINGS.en, "language").get("lang")).toContain(
      STRINGS.en.s_lang,
    );
  });

  it("matches in the current UI language only", () => {
    expect(matchSettings(STRINGS.ko, "월 지출").get("model")).toEqual([
      "월 지출 가드",
    ]);
    expect(matchSettings(STRINGS.ko, "Monthly spend").has("model")).toBe(false);
  });

  it("normalizes decomposed Hangul", () => {
    expect(matchSettings(STRINGS.ko, "언어".normalize("NFD")).has("lang")).toBe(
      true,
    );
  });

  it("returns an empty map when nothing matches", () => {
    expect(matchSettings(STRINGS.en, "zz-no-such-setting").size).toBe(0);
  });

  it("every indexed key resolves to a non-empty string in en/ko/ja", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      for (const keys of Object.values(SETTINGS_INDEX)) {
        for (const k of keys) {
          expect(STRINGS[lang][k], `${lang}.${k}`).toBeTruthy();
        }
      }
    }
  });
});
