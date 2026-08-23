// Resurface picks (Q4 item 10) — dormant wiki pages that echo today's daily
// note, recomputed by the distill chain after every full run (lib/distill.ts).
// Follows the reflect-suggestion pattern (reflectStore.ts): module store +
// localStorage-persisted ignore set, NOT the write_proposal pipeline — picks
// are open-this-page suggestions recomputed per run, so file persistence buys
// nothing (plan scope decision 1).
//
// The similarity floor is self-tuning: shows and accepts accumulate in a
// persisted window, and once 10+ picks have been shown, a low accept rate
// raises the floor (fewer, better picks) while a high one lowers it. The
// window resets whenever the floor moves, so each floor is judged on its own
// picks.

import { create } from "zustand";
import type { ResurfaceCandidate } from "../lib/ipc";

export interface ResurfacePick {
  page: string; // vault-relative, wiki/ only
  stem: string;
  score: number; // cosine vs the daily-note seed
  snippet: string;
  lastOpen: number | null; // unix secs; null = never recorded
}

/** IPC row (snake_case serde output) -> store pick. */
export function toPick(c: ResurfaceCandidate): ResurfacePick {
  return {
    page: c.page,
    stem: c.stem,
    score: c.score,
    snippet: c.snippet,
    lastOpen: c.last_open,
  };
}

const FLOOR_KEY = "myco.resurface.floor.v1";
const SNOOZED_KEY = "myco.resurface.snoozed.v1";
const IGNORED_KEY = "myco.resurface.ignored.v1";
// Not in the plan's key list, but the tuning window must survive restarts:
// resurface runs at most a few times a day, so an in-memory window would
// almost never reach the 10-shown threshold.
const STATS_KEY = "myco.resurface.stats.v1";

const MAX_IGNORED = 500; // bounded so localStorage cannot grow forever
const DEFAULT_FLOOR = 0.7;
const FLOOR_MIN = 0.6;
const FLOOR_MAX = 0.85;
const PICK_CAP = 2;
const SNOOZE_DAYS = 7;
const TUNE_MIN_SHOWN = 10;

/** Days since the unix epoch — snooze granularity. */
export function unixDay(ms: number = Date.now()): number {
  return Math.floor(ms / 86_400_000);
}

/** Ignore/snooze filter + score-ordered cap — pure, exported for tests.
 * A page is snoozed while its until-day is still in the future; an expired
 * entry (until <= today) is eligible again. */
export function applyFilters(
  cands: ResurfacePick[],
  ignored: ReadonlySet<string>,
  snoozed: Record<string, number>,
  today: number,
  cap: number,
): ResurfacePick[] {
  return cands
    .filter((c) => !ignored.has(c.page) && !((snoozed[c.page] ?? 0) > today))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
}

/** Self-tuning floor step — pure, exported for tests. Under 10 shown the
 * window has no signal yet; otherwise a <0.2 accept rate raises the floor by
 * 0.03 (max 0.85) and a >0.5 rate cuts it by 0.02 (min 0.60). Rounded to two
 * decimals so repeated steps stay on clean values. */
export function nextFloor(current: number, shown: number, accepted: number): number {
  if (shown < TUNE_MIN_SHOWN) return current;
  const rate = accepted / shown;
  const round2 = (x: number): number => Math.round(x * 100) / 100;
  if (rate < 0.2) return Math.min(FLOOR_MAX, round2(current + 0.03));
  if (rate > 0.5) return Math.max(FLOOR_MIN, round2(current - 0.02));
  return current;
}

// --- persistence (loaders/savers per linkSuggestions.ts's shape) -------------

function loadIgnored(): Set<string> {
  try {
    const raw = localStorage.getItem(IGNORED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function saveIgnored(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(IGNORED_KEY, JSON.stringify([...keys].slice(-MAX_IGNORED)));
  } catch {
    /* quota or disabled — the ignore just won't persist */
  }
}

function loadSnoozed(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SNOOZED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveSnoozed(snoozed: Record<string, number>, today: number): void {
  try {
    // Expired entries are dead weight — dropping them on every save bounds
    // the record without a schedule.
    const live = Object.fromEntries(
      Object.entries(snoozed).filter(([, until]) => until > today),
    );
    localStorage.setItem(SNOOZED_KEY, JSON.stringify(live));
  } catch {
    /* quota or disabled */
  }
}

function loadFloor(): number {
  try {
    const v = Number(localStorage.getItem(FLOOR_KEY));
    return Number.isFinite(v) && v >= FLOOR_MIN && v <= FLOOR_MAX ? v : DEFAULT_FLOOR;
  } catch {
    return DEFAULT_FLOOR;
  }
}

function saveFloor(floor: number): void {
  try {
    localStorage.setItem(FLOOR_KEY, String(floor));
  } catch {
    /* quota or disabled */
  }
}

interface FloorStats {
  shown: number;
  accepted: number;
}

function loadStats(): FloorStats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return { shown: 0, accepted: 0 };
    const parsed = JSON.parse(raw) as Partial<FloorStats>;
    return {
      shown: typeof parsed.shown === "number" ? parsed.shown : 0,
      accepted: typeof parsed.accepted === "number" ? parsed.accepted : 0,
    };
  } catch {
    return { shown: 0, accepted: 0 };
  }
}

function saveStats(stats: FloorStats): void {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    /* quota or disabled */
  }
}

// --- store -------------------------------------------------------------------

interface ResurfaceState {
  /** Today's picks — max 2, post ignore/snooze filter. */
  picks: ResurfacePick[];
  computedAt: number | null;
  /** Self-tuning similarity floor, persisted. */
  floor: number;
  /** Apply ignore/snooze + cap over a fresh candidate batch, self-tune the
   * floor from the accumulated window first, and record the new shows. */
  refreshFrom(candidates: ResurfacePick[]): void;
  /** Mark a shown pick accepted (counter only — navigation is the caller's
   * job, same split as reflect's orphan rows). */
  open(page: string): void;
  /** Hide the page for a week. */
  snooze(page: string): void;
  /** Never show the page again. */
  ignore(page: string): void;
}

export const useResurfaceStore = create<ResurfaceState>((set, get) => ({
  picks: [],
  computedAt: null,
  floor: loadFloor(),

  refreshFrom(candidates) {
    // Tune on the window accumulated so far — BEFORE counting this batch,
    // which was fetched under the current floor and opens the next window
    // when the floor moves.
    const stats = loadStats();
    const tuned = nextFloor(get().floor, stats.shown, stats.accepted);
    let window = stats;
    if (tuned !== get().floor) {
      saveFloor(tuned);
      set({ floor: tuned });
      window = { shown: 0, accepted: 0 };
    }
    const picks = applyFilters(
      candidates,
      loadIgnored(),
      loadSnoozed(),
      unixDay(),
      PICK_CAP,
    );
    saveStats({ shown: window.shown + picks.length, accepted: window.accepted });
    set({ picks, computedAt: Date.now() });
  },

  open(page) {
    // Only a currently-shown pick counts as an accept — anything else would
    // let ordinary navigation inflate the accept rate.
    if (!get().picks.some((p) => p.page === page)) return;
    const stats = loadStats();
    saveStats({ shown: stats.shown, accepted: stats.accepted + 1 });
  },

  snooze(page) {
    const today = unixDay();
    const snoozed = loadSnoozed();
    snoozed[page] = today + SNOOZE_DAYS;
    saveSnoozed(snoozed, today);
    set({ picks: get().picks.filter((p) => p.page !== page) });
  },

  ignore(page) {
    const next = new Set(loadIgnored());
    next.add(page);
    saveIgnored(next);
    set({ picks: get().picks.filter((p) => p.page !== page) });
  },
}));
