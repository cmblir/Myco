// Relative-date parsing for time-aware Ask (Q4 item 8): "이번 주에 뭐 결정했지"
// carries a date window the retriever should honor. Pure and clock-injected;
// the range feeds semantic_search's dated-tier filter.
import type { Lang } from "./i18n";

export interface DateRange {
  /** YYYY-MM-DD inclusive, local time. */
  start: string;
  end: string;
}

export interface TimeParse {
  range: DateRange | null;
  /** The question with the matched time phrase removed, whitespace collapsed. */
  cleaned: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DD` in local time — `toISOString()` would print the UTC day
 * (same pitfall as queryIntent.ts `localDate`). */
const fmt = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const shiftDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Monday of the ISO week containing `d` (weeks start Monday, matching weekly/ buckets). */
const monday = (d: Date): Date => shiftDays(d, -((d.getDay() + 6) % 7));

const span = (a: Date, b: Date): DateRange => ({ start: fmt(a), end: fmt(b) });
const dayRange = (d: Date): DateRange => span(d, d);
/** Full calendar month; `month1` is 1-based. `new Date(y, month1, 0)` = its last day. */
const monthRange = (year: number, month1: number): DateRange =>
  span(new Date(year, month1 - 1, 1), new Date(year, month1, 0));
/** Named month ("8월", "August", "8月"): this year, or last year when it lies in the future. */
const namedMonth = (now: Date, month1: number): DateRange | null =>
  month1 >= 1 && month1 <= 12
    ? monthRange(month1 > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear(), month1)
    : null;
const prevMonth = (now: Date): DateRange => {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return monthRange(d.getFullYear(), d.getMonth() + 1);
};
const thisWeek = (now: Date): DateRange => span(monday(startOfDay(now)), startOfDay(now));
const lastWeek = (now: Date): DateRange => {
  const mon = shiftDays(monday(startOfDay(now)), -7);
  return span(mon, shiftDays(mon, 6));
};

interface Rule {
  re: RegExp;
  /** null = not actually a date (invalid month/day, modal "may") — keep scanning. */
  build: (now: Date, m: RegExpExecArray) => DateRange | null;
}

const explicitDay = (y: number, mo: number, d: number): DateRange | null => {
  const date = new Date(y, mo - 1, d);
  const valid = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
  return valid ? dayRange(date) : null;
};

// Explicit tokens beat relative words, so they sit ahead of every lang table.
const EXPLICIT: Rule[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/, build: (_n, m) => explicitDay(+m[1], +m[2], +m[3]) },
  {
    re: /\b(\d{4})-(\d{2})\b(?!-)/,
    build: (_n, m) => (+m[2] >= 1 && +m[2] <= 12 ? monthRange(+m[1], +m[2]) : null),
  },
];

// Optional trailing particle so "이번 주에" cleans away whole. `(?!말)` keeps
// 주말(weekend) out; 매주/주간 never match because 이번/지난/저번 is required.
const KO_P = "(?:에는|엔|에)?";
const KO: Rule[] = [
  { re: /오늘/, build: (n) => dayRange(startOfDay(n)) },
  { re: /어제/, build: (n) => dayRange(shiftDays(n, -1)) },
  { re: /그저께/, build: (n) => dayRange(shiftDays(n, -2)) },
  { re: new RegExp(`이번\\s*주(?!말)${KO_P}`), build: thisWeek },
  { re: new RegExp(`(?:지난|저번)\\s*주(?!말)${KO_P}`), build: lastWeek },
  {
    re: new RegExp(`이번\\s*달${KO_P}`),
    build: (n) => span(new Date(n.getFullYear(), n.getMonth(), 1), startOfDay(n)),
  },
  { re: new RegExp(`지난\\s*달${KO_P}`), build: prevMonth },
  { re: new RegExp(`(\\d{1,2})월${KO_P}`), build: (n, m) => namedMonth(n, +m[1]) },
  { re: new RegExp(`올해${KO_P}`), build: (n) => span(new Date(n.getFullYear(), 0, 1), startOfDay(n)) },
];

const MONTHS_EN = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const EN: Rule[] = [
  { re: /\btoday\b/i, build: (n) => dayRange(startOfDay(n)) },
  { re: /\byesterday\b/i, build: (n) => dayRange(shiftDays(n, -1)) },
  { re: /\bthis week\b/i, build: thisWeek },
  { re: /\blast week\b/i, build: lastWeek }, // \b already rejects "weekend"
  {
    re: /\bthis month\b/i,
    build: (n) => span(new Date(n.getFullYear(), n.getMonth(), 1), startOfDay(n)),
  },
  { re: /\blast month\b/i, build: prevMonth },
  {
    re: new RegExp(`\\b(?:in\\s+)?(${MONTHS_EN.join("|")})\\b`, "i"),
    build: (n, m) => {
      // Bare lowercase "may" is almost always the modal verb, not the month.
      if (m[1] === "may" && !/^in\s/i.test(m[0])) return null;
      return namedMonth(n, MONTHS_EN.indexOf(m[1].toLowerCase()) + 1);
    },
  },
];

const JA_P = "(?:には|に|は)?";
const JA: Rule[] = [
  { re: /今日/, build: (n) => dayRange(startOfDay(n)) },
  { re: /昨日/, build: (n) => dayRange(shiftDays(n, -1)) },
  { re: /今週/, build: thisWeek },
  { re: /先週/, build: lastWeek },
  { re: /今月/, build: (n) => span(new Date(n.getFullYear(), n.getMonth(), 1), startOfDay(n)) },
  { re: /先月/, build: prevMonth },
  { re: new RegExp(`(\\d{1,2})月${JA_P}`), build: (n, m) => namedMonth(n, +m[1]) },
];

const TABLE: Record<Lang, Rule[]> = { ko: KO, en: EN, ja: JA };

/** First matching rule wins (explicit YYYY-MM(-DD) first, then `lang`'s table).
 * No match: `range: null` and `cleaned` is the question byte-for-byte. */
export function parseTimeQuery(question: string, now: Date, lang: Lang): TimeParse {
  for (const rule of [...EXPLICIT, ...TABLE[lang]]) {
    const m = rule.re.exec(question);
    if (!m) continue;
    const range = rule.build(now, m);
    if (!range) continue;
    const cleaned = `${question.slice(0, m.index)} ${question.slice(m.index + m[0].length)}`
      .replace(/\s+/g, " ")
      .trim();
    return { range, cleaned };
  }
  return { range: null, cleaned: question };
}
