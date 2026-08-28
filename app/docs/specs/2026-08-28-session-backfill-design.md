# Session backfill — turning the archive into wiki knowledge

**Date:** 2026-08-28 · **Status:** approved, implementing · **Scope:** app (Rust + React)

## The problem, measured

On the owner's real vault:

| measure | value |
|---|---|
| conversations in the import ledger | 1,423 (claude-code 1,074 · codex 349) |
| session documents under `sessions/` | 1,428 (25 MB) |
| wiki pages | 92 |
| **distinct sources cited by the wiki** | **10** |

Import works. Wikification does not happen. The cause is structural, and the
distillation spec already recorded it as unbuilt: the automation loop's step 2
("session digest → `wiki/`") was never implemented, so a session's only
downstream effect is one summary line in `daily/`. Meanwhile auto-ingest — the
loop that *does* produce wiki pages — walks `_inbox/` only, and imported
sessions land in `sessions/`.

## What the archive actually contains

Size is a usable proxy for substance, and the distribution is lopsided:

| bucket | files |
|---|---|
| < 2 KB | 990 |
| 2–8 KB | 241 |
| 8–40 KB | 146 |
| 40–200 KB | 29 |
| > 200 KB | 22 (max 1.9 MB) |

So the backlog worth wikifying is **~175 documents**, not 1,423. That changes
the economics completely: a finite, affordable backfill instead of an open-ended
one. (1,397 of the 1,428 sit in `sessions/archive/` — already digested into
`daily/` and cold-archived. Digested is not wikified, so they stay eligible.)

## Approach

**Promote, don't rebuild.** A selected session is copied into `_inbox/`, and the
existing auto-ingest pass does the rest — retrieval grounding, the planner, the
writing agent, the WHY report, source archiving, the run log and its undo. No
second pipeline, no second set of guards to keep in sync.

Rejected alternatives:

- *Ingest straight from `sessions/`* — would duplicate `_inbox/`'s consumption,
  archiving and dedup rules in a second place, and the two would drift.
- *One "wikify everything" button* — 175 agent runs fired at once, with no
  ceiling and no way to judge quality after the first few.

## Selection

- **Floor 8 KB.** Below it a session is a handful of turns with no claim worth a
  page; 1,231 of 1,428 files are excluded by this alone.
- **Ceiling 200 KB.** Above it one ingest run is a bad deal even for a
  tool-capable provider. These are **reported as a distinct held bucket**, never
  silently skipped — the count is visible in the status so the ceiling is a
  decision the owner can revisit, not an invisible truncation.
- **Newest first.** Recent work is the most likely to be live and worth linking.
- **Never twice.** Promotions are recorded in `.myco/backfill.json`
  (`{"promoted": {"<vault-relative path>": <unix ts>}}`). Its own file, not
  `ledger.json`: the Rust ledger writer drops unknown keys on save, so anything
  added there would be erased by the next in-app import.

`sessions/` is an archive and stays one — promotion **copies**.

## Pace and cost

The owner presses a button for the next batch (default 10). Auto-ingest then
drains `_inbox/` at its own interval, under its existing budget. The roadmap's
open question — "acceptable token cost ceiling per backfill run" — is answered
by batch size: the ceiling is per press, chosen by the person paying for it.

## Surfaces

- `backfill_status()` → `{ total, promoted, eligible, too_small, too_large }`
- `promote_sessions(limit)` → `{ promoted: [rel…], remaining }`
- A card on the Ingest page: counts, batch size, "promote the next N", and the
  held-too-large count stated plainly.

## Testing

Rust unit tests over a temp vault: the floor and ceiling bucket correctly,
newest-first ordering holds, a promoted file is not offered twice, a copy leaves
the archive intact, and a corrupt state file reads as empty rather than
aborting the run.

## Deliberately not in v1

Near-duplicate collapsing across sessions (the size floor already removes the
bulk of the repetition), splitting an oversized session into parts, and any
automatic/scheduled promotion. Automation before the first 20 pages have been
read would be automating an unproven quality bar.
