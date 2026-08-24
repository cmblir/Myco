// Recurrence rules (`🔁 every week`). Pure date arithmetic: completing a
// recurring task asks this module for the next occurrence's dates.
//
// Only the rules below are understood. An unrecognized rule parses to null and
// the caller leaves the text in the line untouched — dropping a rule the app
// cannot read would silently lose something the user wrote, and the same line
// still works in Obsidian Tasks.

import { parseIsoDate, today } from "./taskLine";
import type { TaskMeta } from "./taskLine";

export interface Recurrence {
  unit: "day" | "week" | "month" | "year";
  /** How many units per interval; `every week` is 1. */
  count: number;
}

const RULE_RE = /^every\s+(?:(\d+)\s+)?(day|week|month|year)s?$/i;

/** `every 2 weeks` → `{unit:"week",count:2}`, or null when unsupported. */
export function parseRecurrence(rule: string): Recurrence | null {
  const m = RULE_RE.exec(rule.trim());
  if (!m) return null;
  const count = m[1] === undefined ? 1 : Number(m[1]);
  if (!Number.isInteger(count) || count < 1) return null;
  return { unit: m[2].toLowerCase() as Recurrence["unit"], count };
}

/** Months keep the day of the month where it exists and clamp where it does
 *  not: Jan 31 + 1 month is Feb 28, not Mar 3. Feb 29 + 1 year clamps the same
 *  way in a non-leap year. */
function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), lastDay));
}

/** Advance one `YYYY-MM-DD[THH:MM]` by the rule, keeping any time suffix — the
 *  next occurrence of a 14:00 task is still at 14:00. */
function advance(iso: string, rule: Recurrence): string {
  const date = parseIsoDate(iso);
  if (!date) return iso;
  const next =
    rule.unit === "day"
      ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + rule.count)
      : rule.unit === "week"
        ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + rule.count * 7)
        : addMonths(date, rule.unit === "year" ? rule.count * 12 : rule.count);
  return today(next) + iso.slice(10);
}

/** The next occurrence of `meta`: every date it carries advanced by its own
 *  `🔁` rule, the done date cleared.
 *
 *  Null when there is nothing to schedule — no rule, an unreadable rule, or a
 *  rule with no date to advance. A rule alone cannot produce a date out of
 *  thin air, so such a task simply stays completed. */
export function nextOccurrence(meta: TaskMeta): TaskMeta | null {
  const rule = parseRecurrence(meta.recur);
  if (!rule) return null;
  if (!meta.start && !meta.scheduled && !meta.due) return null;
  return {
    ...meta,
    start: meta.start ? advance(meta.start, rule) : "",
    scheduled: meta.scheduled ? advance(meta.scheduled, rule) : "",
    due: meta.due ? advance(meta.due, rule) : "",
    doneAt: "",
  };
}
