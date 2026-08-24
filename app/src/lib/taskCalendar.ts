// Month-grid bar layout. Pure: dates in, positions out — the calendar view
// renders whatever this returns and owns none of the arithmetic.
//
// A bar is laid out per week rather than per task, because that is how it is
// drawn: a task running Thursday to Tuesday is two segments in two rows, and
// the lane it sits in is only meaningful within one week's stack.

import { parseIsoDate, today } from "./taskLine";

export interface BarInput {
  key: string;
  /** "YYYY-MM-DD" or "" */
  start: string;
  due: string;
}

export interface BarSegment {
  key: string;
  weekIndex: number;
  /** 0..6 within the week */
  startCol: number;
  span: number;
  lane: number;
  continuesLeft: boolean;
  continuesRight: boolean;
}

export interface BarLayout {
  segments: BarSegment[];
  /** `"<weekIndex>:<col>"` → how many bars did not fit in that cell. */
  overflow: Record<string, number>;
}

export const MAX_LANES = 3;

interface Span {
  key: string;
  from: number; // index into `days`, may sit outside it
  to: number;
}

/** The grid indices a task occupies, or null when it has no place on the grid.
 *  Indices are deliberately left unclipped — the week loop does the clipping,
 *  and an endpoint outside the grid is exactly what makes a segment "continue".
 */
function spanOf(
  item: BarInput,
  at: (iso: string) => number | null,
): Span | null {
  const start = item.start ? at(item.start) : null;
  const due = item.due ? at(item.due) : null;
  if (due === null) {
    return start === null ? null : { key: item.key, from: start, to: start };
  }
  // A start later than its due is not a range the user meant — fall back to the
  // due day rather than inventing a backwards bar.
  if (start === null || start > due) {
    return { key: item.key, from: due, to: due };
  }
  return { key: item.key, from: start, to: due };
}

/** `maxLanes` is how many bars one week stacks before the rest are counted as
 *  overflow — the calendar raises it when the user expands a crowded month. */
export function layoutMonthBars(
  items: BarInput[],
  days: Date[],
  maxLanes: number = MAX_LANES,
): BarLayout {
  const index = new Map(days.map((d, i): [string, number] => [today(d), i]));
  const firstIso = today(days[0]);

  /** Grid index of an ISO date: a real column when the date is on the grid,
   *  otherwise a position just off either end (`-1` / `days.length`), or null
   *  when the string is not a date at all. ISO dates compare lexicographically,
   *  so no second parse is needed to decide which end. */
  const at = (iso: string): number | null => {
    const day = iso.slice(0, 10);
    const col = index.get(day);
    if (col !== undefined) return col;
    if (!parseIsoDate(day)) return null;
    return day < firstIso ? -1 : days.length;
  };

  const spans = items
    .map((it) => spanOf(it, at))
    .filter((s): s is Span => s !== null)
    // Longest first inside a start day, so the long bars settle into low lanes.
    .sort(
      (a, b) =>
        a.from - b.from ||
        b.to - b.from - (a.to - a.from) ||
        a.key.localeCompare(b.key),
    );

  const segments: BarSegment[] = [];
  const overflow: Record<string, number> = {};
  const weeks = Math.ceil(days.length / 7);

  for (let w = 0; w < weeks; w++) {
    const weekFrom = w * 7;
    const weekTo = weekFrom + 6;
    // lanes[lane] = the last column that lane is occupied through.
    const lanes: number[] = [];
    for (const s of spans) {
      if (s.to < weekFrom || s.from > weekTo) continue;
      const from = Math.max(s.from, weekFrom);
      const to = Math.min(s.to, weekTo);
      const startCol = from - weekFrom;
      const span = to - from + 1;
      let lane = lanes.findIndex(
        (occupiedThrough) => occupiedThrough < startCol,
      );
      if (lane === -1) lane = lanes.length;
      if (lane >= maxLanes) {
        // Counted, not drawn — and it must not claim a lane on the way out.
        for (let c = startCol; c < startCol + span; c++) {
          const cell = `${w}:${c}`;
          overflow[cell] = (overflow[cell] ?? 0) + 1;
        }
        continue;
      }
      lanes[lane] = startCol + span - 1;
      segments.push({
        key: s.key,
        weekIndex: w,
        startCol,
        span,
        lane,
        continuesLeft: s.from < weekFrom,
        continuesRight: s.to > weekTo,
      });
    }
  }
  return { segments, overflow };
}
