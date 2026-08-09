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

/** Sparkline bar heights (0..100) for each day, one series per key.
 *
 *  Each series is scaled against its OWN peak, not a shared one: `authored`
 *  and `ingested` measure different things in different units — the user's
 *  writing vs. machine intake — so their bar HEIGHTS were never meant to be
 *  compared against each other. Height shows each series' own shape across
 *  the week; absolute magnitudes are the caller's job (the `n / m` caption
 *  in VaultPulse.tsx). A shared peak flattens `authored` to invisible on the
 *  real vault, where a day's `ingested` (the session-file sweep) runs 1000+
 *  against `authored`'s 0-50. */
export function sparkHeights(buckets: DayBuckets): DayBuckets {
  const authoredPeak = Math.max(1, ...buckets.authored);
  const ingestedPeak = Math.max(1, ...buckets.ingested);
  return {
    authored: buckets.authored.map((n) => (n / authoredPeak) * 100),
    ingested: buckets.ingested.map((n) => (n / ingestedPeak) * 100),
  };
}

/** Ambient motion is capped here because the data behind it is ordinal. Tens of
 *  particles read as "many"; hundreds would claim a precision that
 *  "153 wikilinks" does not carry. */
export const PARTICLE_MAX = 28;
const PARTICLE_MIN = 3;
const PULSE_IDLE_MS = 6000;
const PULSE_BUSY_MS = 1800;
const GLOW_MIN = 0.15;
const GLOW_MAX = 0.5;

/** The three CSS custom properties the ambient layer runs on. */
export interface MotionVars {
  /** How many particle elements to render. */
  particles: number;
  /** One heartbeat, in milliseconds. */
  pulseMs: number;
  /** Opacity of the connective glow. */
  glow: number;
}

/** Coerce anything the callers might hand us into a usable number. A NaN
 *  reaching a custom property kills the animation silently — far harder to
 *  notice than a wrong but visible value. */
function safe(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

/** Turn vault counts into the ambient layer's three variables.
 *
 *  `links` drives particle COUNT, `authoredWeek` (files the user touched in the
 *  window) drives pulse RATE, `resolvedRatio` (0..1) drives glow. */
export function motionVars(
  links: number,
  authoredWeek: number,
  resolvedRatio: number,
): MotionVars {
  // log1p so an order-of-magnitude bigger vault is a few more dots, not ten
  // times as many. log1p(1000) ≈ 6.9, so /7 lands a very large vault at the cap.
  const spread = clamp(Math.log1p(safe(links)) / 7, 0, 1);
  const particles = Math.round(PARTICLE_MIN + spread * (PARTICLE_MAX - PARTICLE_MIN));

  // Ten authored files in the window is already "busy" — this is a personal
  // vault, not a team repo.
  const busy = clamp(safe(authoredWeek) / 10, 0, 1);
  const pulseMs = Math.round(PULSE_IDLE_MS - busy * (PULSE_IDLE_MS - PULSE_BUSY_MS));

  const glow = GLOW_MIN + clamp(safe(resolvedRatio), 0, 1) * (GLOW_MAX - GLOW_MIN);

  return { particles, pulseMs, glow };
}

/** One row of the "recently moved" list. */
export interface RecentEntry {
  /** Vault-relative path, e.g. `wiki/self-attention.md`. */
  rel: string;
  /** Unix seconds. */
  mtime: number;
}

/** The `limit` most recently touched files the USER wrote, newest first.
 *
 *  Ingested folders are excluded because they would be the entire list: the
 *  sweep rewrites every session file daily, so without this filter the newest
 *  1029 entries are all machine writes. */
export function recentAuthored(
  entries: [string, number][],
  vaultRoot: string,
  limit: number,
): RecentEntry[] {
  const prefix = vaultRoot.endsWith("/") ? vaultRoot : `${vaultRoot}/`;
  return entries
    .filter(([p]) => p.startsWith(prefix))
    .map(([p, mtime]) => ({ rel: p.slice(prefix.length), mtime }))
    .filter((r) => !isIngested(r.rel))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}
