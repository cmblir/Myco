# Raw hygiene: one copy per source, and no unredacted raw

Found 2026-10-02 while measuring the distill gate on a clone of the owner's vault (see
`2026-10-02-machine-session-quarantine.md`). Both are data-safety bugs, and the project rule (a
vault's `raw/` is immutable) makes each one permanent once it happens.

## What is wrong (claims to verify with a failing test first)

1. **A retried ingest adds a raw copy every time.** `ingestStore.ts` writes `raw/<slug>.md` after
   the judge but before the model call. When the model call fails, the source stays in `_inbox/`
   and the next pass retries it, writing `raw/<slug>-2.md`, `-3.md`, …. A real case left 19 copies
   of one session (`raw/…-2` to `-22`, later archived). Because `raw/` is immutable, none of them
   can be cleaned up.
2. **The summary pass moves unredacted inbox items into `raw/`.** distill's summary pass
   (`distill.rs`, the Summary-tier move to `raw/archive/<month>/`) moves `_inbox` items without the
   secret/PII check that auto-ingest applies (`autoIngest.ts`, `redaction.ts`). A source that
   auto-ingest held for a secret can end up in immutable `raw/`. Manual runs only: automatic runs
   pass `leave_raw` and skip this move.

## Decisions

1. **One raw copy per source body.**
   - Before ingest writes a raw file, it checks for an existing `raw/` file with the same body:
     top level or `raw/archive/**`, matched by a content hash of the body as written.
   - If one exists, ingest reuses that path and writes nothing.
   - A retry never adds a file. A different body still gets its own file, as today.
2. **The summary pass honours the hold.**
   - An `_inbox` item that the redaction check flags is not moved. It stays in `_inbox/`, and the
     run's report counts it as held.
   - "Flags" means what auto-ingest holds: a secret always; PII when the vault's PII setting says
     to hold it.
   - The check is the same function auto-ingest uses, or a Rust port pinned to the same cases by a
     shared fixture. There are not two different rule sets.
3. **Nothing else about `raw/` changes.** Owner decision B1, the manual archive pass, is still open.
   Existing duplicate copies stay, because `raw/` is immutable. The report counts them and does not
   touch them.

## Acceptance

- **vitest:**
  - an ingest that fails twice and then succeeds leaves exactly one raw file;
  - two different bodies leave two files;
  - the reuse works when the copy is already in `raw/archive/`.
- **cargo:**
  - a Summary-tier `_inbox` item holding a fake secret (a synthetic test key) stays in `_inbox/`
    and is reported held;
  - a clean one moves as before;
  - PII follows the setting;
  - `cargo fmt`, `clippy -D warnings` and `cargo test` pass.
- **Clone count (read-only, on a fresh `cp -c` clone):** how many duplicate raw bodies exist today,
  and how many held items the new summary pass would leave. Counts only.
