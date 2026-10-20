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

/** Serialize local calendar days to UTC seconds at the retrieval boundary.
 * The exclusive end is the next local midnight, including 23/25-hour DST days. */
export function queryDateRange(range: DateRange): DateRange & { startEpoch: number; endEpoch: number } {
  const [start, end] = [range.start, range.end].map((day) => {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!parts) throw new Error("invalid query date range");
    const date = new Date(+parts[1], +parts[2] - 1, +parts[3]);
    if (fmt(date) !== day) throw new Error("invalid query date range");
    return date;
  });
  if (start > end) throw new Error("invalid query date range");
  return {
    ...range,
    startEpoch: start.getTime() / 1000,
    endEpoch: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).getTime() / 1000,
  };
}

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
/** Same local date one month earlier through today; clamp to the prior month's last day. */
const rollingMonth = (now: Date): DateRange => {
  const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), lastDay));
  return span(start, startOfDay(now));
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
  {
    re: /(?:\bfrom\s+|\bbetween\s+)?(\d{4})-(\d{2})-(\d{2})\s*(?:부터|から|to\b|through\b|until\b|and\b|\.\.|~|–|—)\s*(\d{4})-(\d{2})-(\d{2})(?:까지|まで)?/i,
    build: (_n, m) => {
      const start = explicitDay(+m[1], +m[2], +m[3]);
      const end = explicitDay(+m[4], +m[5], +m[6]);
      return start && end && start.start <= end.end ? { start: start.start, end: end.end } : null;
    },
  },
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
  {
    re: /(?:최근|지난)\s*(?:한\s*달|1\s*(?:달|개월))\s*(?:동안|간)?(?:에는|엔|에)?/,
    build: rollingMonth,
  },
  {
    re: /(?:최근|지난)\s*(?:일\s*주일|1\s*주일|7\s*일)\s*(?:동안|간)?(?:에는|엔|에)?/,
    build: (n) => span(shiftDays(n, -6), startOfDay(n)),
  },
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
  const literals = [...question.matchAll(/`[^`]*`|"[^"\n]*"/g)]
    .map((match) => [match.index!, match.index! + match[0].length]);
  for (const rule of [...EXPLICIT, ...TABLE[lang]]) {
    // Rejected literals must not hide a later time anchor of the same shape.
    const matcher = new RegExp(rule.re.source, `${rule.re.flags}g`);
    for (const m of question.matchAll(matcher)) {
      if (literals.some(([start, end]) => m.index >= start && m.index < end)) continue;
      // A date inside an identifier, filename or path is an exact search term,
      // not a request to filter by when the record was written.
      const before = question[m.index - 1] ?? "";
      const after = question.slice(m.index + m[0].length);
      if (EXPLICIT.includes(rule) &&
          (/[A-Za-z0-9_./-]/.test(before) || /^[A-Za-z0-9_/-]|^\.[A-Za-z]/.test(after))) continue;
      const range = rule.build(now, m);
      if (!range) continue;
      const cleaned = `${question.slice(0, m.index)} ${question.slice(m.index + m[0].length)}`
        .replace(/\s+/g, " ")
        .trim();
      return { range, cleaned };
    }
  }
  return { range: null, cleaned: question };
}
