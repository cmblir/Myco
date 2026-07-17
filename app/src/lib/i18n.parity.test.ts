// en is the source of truth for UI copy; ko and ja must not silently fall
// behind it. They did: ja was missing ~99 keys and rendered English for the
// graph inspector, Views, Zotero import and more, on an app whose default
// language is Korean. Nothing caught it because lookup falls back per-language
// to English, so a missing key just quietly shows English.
//
// This fails the moment a new en key lands without a ko/ja translation, naming
// the offenders — so the gap cannot reopen one key at a time.

import { describe, expect, it } from "vitest";
import { STRINGS } from "./i18n";

const enKeys = new Set(Object.keys(STRINGS.en));

function missingAgainstEn(lang: "ko" | "ja"): string[] {
  const have = new Set(Object.keys(STRINGS[lang]));
  return [...enKeys].filter((k) => !have.has(k)).sort();
}

function extraNotInEn(lang: "ko" | "ja"): string[] {
  const have = Object.keys(STRINGS[lang]);
  return have.filter((k) => !enKeys.has(k)).sort();
}

describe("i18n parity with en", () => {
  it.each(["ko", "ja"] as const)("%s translates every en key", (lang) => {
    expect(missingAgainstEn(lang)).toEqual([]);
  });

  it.each(["ko", "ja"] as const)("%s has no key that en lacks", (lang) => {
    // A stray key in a locale is dead weight (and usually a rename that missed
    // en) — catch it too.
    expect(extraNotInEn(lang)).toEqual([]);
  });
});
