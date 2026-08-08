// The dashboard's arithmetic. Pure throughout: it takes the mtime list the
// backend already produces and returns numbers. Nothing here touches the DOM
// or IPC, so the whole of the dashboard's logic is testable in one file.

/** Per-day counts, oldest first. Both arrays are the same length. */
export interface DayBuckets {
  /** Files the user wrote. */
  authored: number[];
  /** Files the machine brought in — sweeps, drops, ingest reports. */
  ingested: number[];
}

// Top-level folders nobody hand-writes. `raw/` is immutable source material and
// `ingest-reports/` is generated per run; `tasks.rs` already skips raw, _inbox
// and sessions for the same reason. Counting these as authored would make the
// heartbeat read as the user's work when it is the sweeper's.
const INGESTED_FOLDERS = new Set(["sessions", "_inbox", "raw", "ingest-reports"]);

/** Whether a VAULT-RELATIVE path belongs to the machine-written side. */
export function isIngested(relPath: string): boolean {
  const top = relPath.split("/")[0] ?? "";
  return INGESTED_FOLDERS.has(top);
}

/** Local `YYYY-MM-DD` day index: whole days between two local calendar dates.
 *  Compared as calendar days rather than by dividing seconds, because a
 *  seconds-based difference crosses DST boundaries an hour early or late. */
function daysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Bucket `entries` ([absolute path, unix seconds]) into the last `days` local
 *  days, oldest first, split by who wrote them.
 *
 *  `now` is a parameter so tests can pin it. Local-day based for the same
 *  reason `taskLine.today()` is: a UTC boundary files a late-evening edit under
 *  the next day, which shows the user's work on a day they did not work. */
export function bucketByDay(
  entries: [string, number][],
  vaultRoot: string,
  days: number,
  now: Date,
): DayBuckets {
  const authored = new Array<number>(days).fill(0);
  const ingested = new Array<number>(days).fill(0);
  const prefix = vaultRoot.endsWith("/") ? vaultRoot : `${vaultRoot}/`;

  for (const [path, mtime] of entries) {
    if (!path.startsWith(prefix)) continue; // not ours — never guess at it
    const age = daysBetween(new Date(mtime * 1000), now);
    // Outside the window in either direction is dropped, not clamped: clamping
    // would pile all of history onto the oldest bar, and a clock-skewed future
    // mtime would write past the end of the array.
    if (age < 0 || age >= days) continue;
    const slot = days - 1 - age;
    if (isIngested(path.slice(prefix.length))) ingested[slot]++;
    else authored[slot]++;
  }
  return { authored, ingested };
}
