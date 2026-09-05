// en is the source of truth for UI copy; ko and ja must not silently fall
// behind it. They did: ja was missing ~99 keys and rendered English for the
// graph inspector, Views, Zotero import and more, on an app whose default
// language is Korean. Nothing caught it because most `Strings` keys were
// optional, so `Record<Lang, Strings>` accepted a locale with holes and lookup
// quietly fell back per-language to English.
//
// Every `Strings` key is required now, so a MISSING ko/ja value fails `tsc`
// and needs no runtime test. What remains here is the other direction: a key
// present in a locale but absent from en. Excess-property checks cover an
// object literal, but not a locale assembled by spread or import — this keeps
// that door shut by name.

import { describe, expect, it } from "vitest";
import { STRINGS } from "./i18n";

const enKeys = new Set(Object.keys(STRINGS.en));

function extraNotInEn(lang: "ko" | "ja"): string[] {
  const have = Object.keys(STRINGS[lang]);
  return have.filter((k) => !enKeys.has(k)).sort();
}

describe("i18n parity with en", () => {
  it.each(["ko", "ja"] as const)("%s has no key that en lacks", (lang) => {
    // A stray key in a locale is dead weight (and usually a rename that missed
    // en) — catch it too.
    expect(extraNotInEn(lang)).toEqual([]);
  });
});
