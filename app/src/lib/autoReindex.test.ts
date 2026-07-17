import { describe, expect, it } from "vitest";
import { decidePoll, type AutoReindexState } from "./autoReindex";

// Auto-reindex is what makes the semantic layer describe the vault as it is
// rather than as it was at the last manual reindex. Everything interesting is in
// the guards: it must not fire on open, mid-edit, or on a vault the user never
// chose to index. (The two guards that are not decisions — an ingest in flight,
// a run already going — are checked in the hook against live store state.)

const FRESH: AutoReindexState = { seen: null, quietSince: null };
const INDEXED = 51;

/** Feed a sequence of polls and return the actions in order. */
function run(
  steps: { revision: number; now: number; indexedPages?: number }[],
  start: AutoReindexState = FRESH,
): string[] {
  let state = start;
  const out: string[] = [];
  for (const s of steps) {
    const r = decidePoll(state, {
      vault: "/v",
      revision: s.revision,
      now: s.now,
      indexedPages: s.indexedPages ?? INDEXED,
    });
    state = r.next;
    out.push(r.action);
  }
  return out;
}

describe("decidePoll", () => {
  it("does not reindex just because a vault was opened", () => {
    // Opening a vault is not an edit. The first poll only takes a baseline, and
    // a still vault stays still no matter how long we watch it.
    expect(run([
      { revision: 1, now: 0 },
      { revision: 1, now: 10_000 },
      { revision: 1, now: 60_000 },
    ])).toEqual(["wait", "wait", "wait"]);
  });

  it("reindexes once the vault has been quiet after a change", () => {
    expect(run([
      { revision: 1, now: 0 }, // baseline
      { revision: 2, now: 4_000 }, // an edit — starts the quiet window
      { revision: 2, now: 8_000 }, // 4s of quiet: too soon
      { revision: 2, now: 15_000 }, // 11s of quiet: go
    ])).toEqual(["wait", "wait", "wait", "reindex"]);
  });

  it("does not reindex while the vault is still changing", () => {
    // Someone typing: every poll sees a different vault. Reindexing here would
    // fight the editor for the model.
    const steps = [{ revision: 1, now: 0 }];
    for (let i = 2; i < 12; i++) steps.push({ revision: i, now: i * 4_000 });
    expect(run(steps).filter((a) => a === "reindex")).toEqual([]);
  });

  it("reindexes only once per change, not every poll after", () => {
    const steps = [
      { revision: 1, now: 0 },
      { revision: 2, now: 4_000 },
      { revision: 2, now: 20_000 }, // fires
      { revision: 2, now: 24_000 },
      { revision: 2, now: 60_000 },
    ];
    expect(run(steps)).toEqual(["wait", "wait", "reindex", "wait", "wait"]);
  });

  it("never builds the first index — that stays a deliberate action", () => {
    // An empty index means the user has not asked for one, and building it is
    // minutes of work plus a 769 MB model load.
    expect(run([
      { revision: 1, now: 0, indexedPages: 0 },
      { revision: 2, now: 4_000, indexedPages: 0 },
      { revision: 2, now: 20_000, indexedPages: 0 },
      { revision: 2, now: 40_000, indexedPages: 0 },
    ])).toEqual(["wait", "wait", "wait", "wait"]);
  });

  it("picks up the next change after skipping an unindexed vault", () => {
    // Skipping must not wedge the state machine: index the vault by hand, edit
    // again, and it should behave.
    let state = FRESH;
    const step = (revision: number, now: number, indexedPages: number) => {
      const r = decidePoll(state, { vault: "/v", revision, now, indexedPages });
      state = r.next;
      return r.action;
    };
    step(1, 0, 0);
    step(2, 4_000, 0);
    expect(step(2, 20_000, 0)).toBe("wait"); // no index yet
    step(3, 24_000, INDEXED); // user indexed by hand, then edited
    expect(step(3, 40_000, INDEXED)).toBe("reindex");
  });

  it("treats a vault switch as a fresh baseline", () => {
    const mid: AutoReindexState = { seen: { vault: "/other", revision: 9 }, quietSince: 0 };
    const r = decidePoll(mid, { vault: "/v", revision: 1, now: 99_999, indexedPages: INDEXED });
    // Another vault's quiet window must not fire against this one, however long
    // ago it started.
    expect(r.action).toBe("wait");
    expect(r.next).toEqual({ seen: { vault: "/v", revision: 1 }, quietSince: null });
  });

  it("handles a change during the quiet window by restarting it", () => {
    expect(run([
      { revision: 1, now: 0 },
      { revision: 2, now: 4_000 }, // window opens
      { revision: 3, now: 8_000 }, // changed again — window restarts here
      { revision: 3, now: 12_000 }, // only 4s since the restart
      { revision: 3, now: 19_000 }, // 11s since the restart
    ])).toEqual(["wait", "wait", "wait", "wait", "reindex"]);
  });
});
