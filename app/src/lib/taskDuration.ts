// Estimates as a duration token (`90m` `1.5h` `2d` `1w`). A day is a WORKING
// day and a week five of them — an estimate is effort, not elapsed wall time,
// so "2d" must not silently mean 48 hours.

const WORK_DAY_MIN = 8 * 60;
const WORK_WEEK_MIN = 5 * WORK_DAY_MIN;
const UNIT_MIN: Record<string, number> = {
  m: 1,
  h: 60,
  d: WORK_DAY_MIN,
  w: WORK_WEEK_MIN,
};
const TOKEN_RE = /^(\d+(?:\.\d+)?)([mhdw])$/;

/** Minutes, or null when `s` is not a duration token. */
export function parseDuration(s: string): number | null {
  const m = TOKEN_RE.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * UNIT_MIN[m[2]]);
}

/** The shortest token that represents `minutes` exactly, largest unit first. */
export function formatDuration(minutes: number): string {
  for (const unit of ["w", "d", "h"] as const) {
    const size = UNIT_MIN[unit];
    if (minutes >= size) {
      const n = minutes / size;
      // One decimal only: 1.5h reads, 1.4375d does not.
      const rounded = Math.round(n * 10) / 10;
      if (rounded * size === minutes) return `${rounded}${unit}`;
    }
  }
  return `${minutes}m`;
}
