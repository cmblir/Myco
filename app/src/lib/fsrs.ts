// FSRS (Free Spaced Repetition Scheduler) — a compact, dependency-free scheduler
// for Feature 3 (study artifacts). Pure math over a per-card {stability,
// difficulty} state; given a review grade it returns the next state + due date.
//
// This follows the FSRS-5 formulation (default weights). We assert BEHAVIOURAL
// invariants in tests (higher grade → longer interval, Again resets, difficulty
// stays in [1,10]) rather than exact reference constants, which is what actually
// matters for scheduling correctness.

/** 1 = Again (forgot), 2 = Hard, 3 = Good, 4 = Easy. */
export type Grade = 1 | 2 | 3 | 4;

export interface CardState {
  stability: number; // memory stability (days)
  difficulty: number; // 1..10
  reps: number; // successful-ish reviews
  lapses: number; // times graded Again
  /** ISO date (yyyy-mm-dd) the card is next due. */
  due: string;
  /** ISO date of the last review, or "" if never reviewed. */
  lastReview: string;
}

// FSRS-5 default weights (19).
const W = [
  0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616,
  0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034,
  0.6567,
];
const DECAY = -0.5;
const FACTOR = 19 / 81; // 0.9 ^ (1/DECAY) - 1
const REQUEST_RETENTION = 0.9;

const clampD = (d: number): number => Math.min(10, Math.max(1, d));

/** Days until retrievability falls to the request-retention target. */
export function intervalDays(stability: number): number {
  const i = (stability / FACTOR) * (Math.pow(REQUEST_RETENTION, 1 / DECAY) - 1);
  return Math.max(1, Math.round(i));
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First-ever review of a new card. */
export function initState(grade: Grade, today: string): CardState {
  const stability = Math.max(0.1, W[grade - 1]);
  const difficulty = clampD(W[4] - Math.exp(W[5] * (grade - 1)) + 1);
  const interval = grade === 1 ? 1 : intervalDays(stability);
  return {
    stability,
    difficulty,
    reps: grade === 1 ? 0 : 1,
    lapses: grade === 1 ? 1 : 0,
    due: addDays(today, interval),
    lastReview: today,
  };
}

/** Retrievability after `elapsed` days at the given stability. */
function retrievability(elapsed: number, stability: number): number {
  return Math.pow(1 + (FACTOR * elapsed) / stability, DECAY);
}

/** Advance a card's state after a graded review on `today` (ISO date). */
export function nextState(
  state: CardState,
  grade: Grade,
  today: string,
): CardState {
  const elapsed = state.lastReview
    ? Math.max(0, daysBetween(state.lastReview, today))
    : 0;
  const r = retrievability(elapsed, state.stability);

  // Difficulty update (mean-reverting toward the Good-grade anchor).
  const deltaD = -W[6] * (grade - 3);
  let difficulty = state.difficulty + deltaD * ((10 - state.difficulty) / 9);
  const d0Good = clampD(W[4] - Math.exp(W[5] * 2) + 1);
  difficulty = clampD(W[7] * d0Good + (1 - W[7]) * difficulty);

  let stability: number;
  if (grade === 1) {
    // Lapse: stability drops to the forget-stability.
    stability = Math.max(
      0.1,
      W[11] *
        Math.pow(difficulty, -W[12]) *
        (Math.pow(state.stability + 1, W[13]) - 1) *
        Math.exp(W[14] * (1 - r)),
    );
  } else {
    // Recall: stability grows, more so for easy grades and low retrievability.
    const hardPenalty = grade === 2 ? W[15] : 1;
    const easyBonus = grade === 4 ? W[16] : 1;
    const inc =
      Math.exp(W[8]) *
      (11 - difficulty) *
      Math.pow(state.stability, -W[9]) *
      (Math.exp(W[10] * (1 - r)) - 1) *
      hardPenalty *
      easyBonus;
    stability = state.stability * (1 + inc);
  }

  const interval = grade === 1 ? 1 : intervalDays(stability);
  return {
    stability,
    difficulty,
    reps: grade === 1 ? state.reps : state.reps + 1,
    lapses: grade === 1 ? state.lapses + 1 : state.lapses,
    due: addDays(today, interval),
    lastReview: today,
  };
}

/** Whole-day difference between two ISO dates (b - a). */
export function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}

/** A card is due when today ≥ its due date. */
export function isDue(state: CardState, today: string): boolean {
  return daysBetween(state.due, today) >= 0;
}
