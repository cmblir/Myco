// The Ask page's 기록 (UX S36): the search over past turns and the "asked
// when" label. Pure; the log itself lives in the app data dir (ask_history.rs)
// and queryStore owns reading and appending it.

import type { Lang } from "./i18n";
import type { AskRecord } from "./ipc";

/** All [[wikilink]] targets in `text`, alias stripped, order kept, deduped. */
export function extractWikilinks(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const target = (m[1].split("|")[0] ?? "").trim();
    const key = target.toLowerCase();
    if (target && !seen.has(key)) {
      seen.add(key);
      out.push(target);
    }
  }
  return out;
}

/** `records` newest first, keeping those where every word of `query` is in
 *  the question, the answer or a cited note's stem (case-insensitive). */
export function matchHistory(records: readonly AskRecord[], query: string): AskRecord[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return records
    .filter((r) => {
      const hay = [r.q, r.a, ...r.cited].join("\n").toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .reverse();
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "3분 전", "어제", "지금": Intl words it per language. */
export function askedAgo(at: number, now: number, lang: Lang): string {
  const secs = Math.max(0, (now - at) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const unit = UNITS.find(([, s]) => secs >= s);
  return unit ? rtf.format(-Math.floor(secs / unit[1]), unit[0]) : rtf.format(0, "second");
}
