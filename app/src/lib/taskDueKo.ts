// Korean due-date phrases in a task's text — "치과 예약 내일 오후 3시" becomes
// the title "치과 예약" with a due of tomorrow 15:00. Pure and clock-injected;
// the composer previews the result as a chip and writes it on add.
//
// Only the phrases below are read: 오늘 / 내일 / 모레, 월요일…일요일 (that day
// of this week, Monday to Sunday, even when it has passed), 다음 주 X요일,
// each optionally followed by [오전/오후] N시 (반 | M분), or the time on its
// own (today). Without 오전/오후, 7–11시 is morning, 12시 noon and 1–6시
// afternoon — the hours people mean when they leave it out — and 13–23시 is
// read as written.

import { parseIsoDate, today } from "./taskLine";

export interface KoDue {
  /** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` when a time was given. */
  due: string;
  /** The text with the date phrase taken out, whitespace collapsed. */
  title: string;
}

/** getDay() index of each weekday syllable. */
const WEEKDAY: Record<string, number> = {
  일: 0,
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
};

/** [오전/오후] N시 (반 | M분); `s` suffixes the group names, which must be unique
 *  across the two places a time can stand. */
const time = (s: string): string =>
  String.raw`(?:(?<ampm${s}>오전|오후)\s*)?(?<hour${s}>\d{1,2})\s*시(?:\s*(?:(?<half${s}>반)|(?<min${s}>\d{1,2})\s*분))?`;
// A phrase starts the text or follows a space, and ends at the text's end, a
// space or punctuation — so "오늘날" and "3시간" are not dates. A trailing
// 까지/에 goes with the phrase, so "모레까지 제출" leaves "제출".
const PHRASE_RE = new RegExp(
  String.raw`(^|\s)(?:(?<day>오늘|내일|모레|다음\s*주\s*(?<nextWd>[월화수목금토일])요일|(?<wd>[월화수목금토일])요일)(?:\s+${time("")})?|${time("T")})(?:까지|에)?(?=$|[\s,.!?])`,
  "u",
);

const pad = (n: number): string => String(n).padStart(2, "0");

function dayOf(now: Date, g: Record<string, string | undefined>): Date {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (n: number): Date =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
  const toMonday = -((base.getDay() + 6) % 7);
  if (g.nextWd) return shift(toMonday + 7 + ((WEEKDAY[g.nextWd] + 6) % 7));
  if (g.wd) return shift(toMonday + ((WEEKDAY[g.wd] + 6) % 7));
  return shift(g.day === "내일" ? 1 : g.day === "모레" ? 2 : 0);
}

/** 24-hour `HH:MM`, or null for an hour or minute that is not on a clock.
 *  With no 오전/오후, 1–6시 and 12시 are afternoon, 7–11시 morning and
 *  13–23시 as written. */
function clock(
  ampm: string | undefined,
  hour: string,
  half?: string,
  min?: string,
): string | null {
  const h = Number(hour);
  const m = half ? 30 : Number(min ?? 0);
  if (m > 59) return null;
  if (!ampm && h >= 13 && h <= 23) return `${pad(h)}:${pad(m)}`;
  if (h < 1 || h > 12) return null;
  const pm = ampm ? ampm === "오후" : h <= 6 || h === 12;
  return `${pad((h % 12) + (pm ? 12 : 0))}:${pad(m)}`;
}

/** The due date a task's text names, or null when it names none. */
export function parseKoDue(text: string, now: Date): KoDue | null {
  const m = PHRASE_RE.exec(text);
  if (!m?.groups) return null;
  const g = m.groups;
  let time: string | null = null;
  if (g.hour) time = clock(g.ampm, g.hour, g.half, g.min);
  else if (g.hourT) time = clock(g.ampmT, g.hourT, g.halfT, g.minT);
  // An hour not on a clock (24시) is not a time; a day before it still
  // reads, and the hour stays in the title.
  let end = m.index + m[0].length;
  if ((g.hour || g.hourT) && !time) {
    if (!g.day) return null;
    end = m.index + m[1].length + g.day.length;
  }
  const date = today(dayOf(now, g));
  const title = (text.slice(0, m.index) + m[1] + text.slice(end))
    .replace(/\s+/g, " ")
    .trim();
  return { due: time ? `${date}T${time}` : date, title };
}

/** A due value as the app's language writes a date ("10월 4일 (토) 오후 3:00").
 *  Anything that is not a date comes back as written. */
export function formatDue(due: string, lang: string): string {
  const date = parseIsoDate(due);
  if (!date) return due;
  const t = /T(\d{2}):(\d{2})/.exec(due);
  if (t) date.setHours(Number(t[1]), Number(t[2]));
  return new Intl.DateTimeFormat(lang, {
    month: "short",
    day: "numeric",
    weekday: "short",
    ...(t ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}
