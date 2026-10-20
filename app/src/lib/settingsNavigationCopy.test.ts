import { describe, expect, it } from "vitest";
import { SETTINGS_NAVIGATION_COPY } from "./settingsNavigationCopy";
import { STRINGS } from "./i18n";

describe("SETTINGS_NAVIGATION_COPY", () => {
  // The group starts closed: its hint is all that says Plugins is in it.
  it.each(["en", "ko", "ja"] as const)(
    "%s: the More settings hint names Plugins",
    (lang) => {
      expect(
        SETTINGS_NAVIGATION_COPY[lang].advancedHint.toLowerCase(),
      ).toContain(STRINGS[lang].s_plugins.toLowerCase());
    },
  );
});
