# Machine-session quarantine: set aside what no person wrote

Owner, 2026-10-02: "제안 격리 안되고 있고". Asked how quarantine should behave, the owner chose
"actually quarantine". Shown the measurement below, the owner chose "기계 세션 전부": quarantine every
machine-made session, and stop importing myco's own calls.

## What was measured (2026-10-02, on a copy-on-write clone of the owner's vault; the vault was not written)

- **The gate quarantines nothing.** Of 454 candidates (sessions 411, raw/ top level 32, _inbox 11),
  the gate as it runs today quarantines 0. Every candidate's similarity is below its nearest
  cluster's p5, so the natural tier is Reject for all 454. Generic wiki stems (`claude` 76 %, `mcp`,
  `agents`, `log`, `index`, …) then lift 347 of them to Summary through the entity floor.
- **Similarity cannot tell noise from work.** The best similarity rule (page-centroid scale,
  distinctive entities only, [p5, t_summary) band) quarantines 46 sessions:
  - 41 of them (89 %) are the owner's real work sessions, and 39 of those are the only copy;
  - 47 % of what it keeps is machine-made;
  - its size swings from 44 to 23 when one member of a 7-member cluster moves.
- **The noise is machine-made.** 235 of 411 sessions (57 %, 2.85 MB) no person wrote:

  | Kind | Sessions |
  |---|---|
  | myco's own model calls: the wiki review (`reflectStore`) | 59 |
  | myco's own model calls: `ingestPlan` | 20 |
  | myco's own model calls: `INGEST_PROMPT` | 17 |
  | myco's own model calls: the session-digest extraction | 10 |
  | Agent task prompts: the same task prompt repeated | 78 |
  | Agent task prompts: the "Distinguish instructions…" wrapper | 10 |
  | Daemon `hello` tests (`importers/mod.rs` names the kind) | 39 |
  | Empty once the harness blocks are stripped | 2 |

  myco's own transcripts quote the wiki, so similarity keeps them.
- **The root cause is the importer.** It imports the CLI runs myco itself launches as sessions.
- **Today's quarantine is not safe enough to fill.**
  - An expired quarantine is renamed into `.myco/trash/` after `quarantine_ttl_days` (30), and the
    trash is `remove_dir_all`ed 30 days later. That is permanent loss on a vault without git.
  - Restore sends the file to `_inbox/<name>`, not where it came from. Auto-ingest then takes it,
    and a real 08-13 case left 19 `raw/` copies of one session.
  - The Quarantine branch has no `raw/` guard.
  - A distill run and an auto-ingest pass hold different locks.

## Decisions

1. **Provenance decides, before any embedding.**
   - It is a pure check like `junk_reason`. It runs on `sessions/` items only.
   - A session is machine-made when, after the harness blocks are stripped, its first human turn is
     one of these:
     - one of myco's own prompts: the wiki review, the ingest plan, `INGEST_PROMPT`, the
       session-digest extraction, or any other prompt myco sends. The headers come from the same
       constants the senders use, one source;
     - an agent task prompt: the "Distinguish instructions…" wrapper, or a long first turn
       (≥ 200 chars) repeated verbatim across ≥ 3 sessions;
     - a daemon `hello` test;
     - nothing at all.
   - Such a session's tier is Quarantine, with reason `machine:<kind>` (`myco`, `agent`, `hello`,
     `empty`).
   - The check is cheap, so it is not held to the 50-item budget. One run sets them all aside.
2. **The rule is pinned to the measurement.**
   - On the clone, the check finds the measured 235 (± the sessions added since).
   - A spot check of the sessions it does NOT flag finds no myco prompt among them.
   - A spot check of the flagged ones finds no human work session.
   - The report gives counts and file names only, never content.
3. **myco stops importing its own calls.** The session importer skips a run whose first human turn
   is one of myco's own prompts. The same check and the same constants as decision 1 apply, plus a
   marker myco puts on the runs it launches where the CLI allows one. Verify which JSONL fields exist
   before relying on any. Agent task prompts and `hello` tests are still imported, and decision 1
   sets them aside.
4. **Similarity never quarantines a session.** For `sessions/` items the similarity band yields
   Summary or Reject as before. Only provenance quarantines a session.
5. **Nothing from `sessions/` is deleted without a click.**
   - When a quarantined session's TTL expires, it becomes a delete proposal (the Conservative path)
     and is not trashed.
   - Nothing that came from `sessions/` is ever purged from `.myco/trash/` automatically.
6. **Restore puts it back where it was.**
   - The sidecar records the original path.
   - Restore moves the file there, never to `_inbox/`.
   - It leaves an owner-kept mark, so later scans never quarantine it again.
7. **Quarantine never moves anything under `raw/`.** The guard sits in the Quarantine branch itself,
   whatever the tier.
8. **One lock.** A distill run and an in-app auto-ingest pass never run at the same time. Each skips
   while the other holds the lock. The out-of-process daemon (`automation/autoingest.py`) is out of
   scope, and the report says so.
9. **The ledger is re-scored.** A rule version in the ledger makes the 49 machine sessions already
   scored as Summary or Reject get scored again.
10. **The 격리 tab handles a batch.**
    - Items are grouped by reason with plain labels: "myco가 모델을 부른 기록", "에이전트 작업
      프롬프트", "연결 테스트", "빈 세션".
    - Each group gets "모두 되돌리기" and "모두 버리기". 버리기 sends files to the OS trash, as today.
    - Both actions need an in-page confirmation, not `confirm()`.
    - Every string is in en, ko and ja.

## Not in this slice (reported to the owner)

- The scale mismatch: candidates are a 2000-char Query vector, while thresholds come from page
  centroids.
- The map-anchor recalibration bug: p5/p25 are taken before the centroid is swapped for the map page.
- Degenerate clusters 12–14.
- The summary pass moves `_inbox` Summary items to `raw/archive/` without the redaction check that
  auto-ingest applies.
- Ingest writes `raw/` before the model call, so every failed retry adds an immutable copy.
- B1: `run()`'s manual `raw/` archive pass.

## Acceptance

- cargo:
  - provenance kinds, each with a synthetic fixture, no real content;
  - provenance runs before embedding and outside the budget;
  - sessions never get similarity quarantine;
  - TTL expiry of a session makes a proposal, and trash purge spares sessions;
  - restore goes to the original path and the owner-kept mark holds;
  - the `raw/` guard;
  - the ledger rule version re-scores;
  - the importer skips myco's own runs;
  - `cargo fmt`, `clippy -D warnings` and `cargo test` pass.
- vitest: the shared lock (distill skips while ingest runs and the reverse); the 격리 tab's grouping
  and batch actions, and their confirmation.
- Clone run (a harness on a fresh `cp -c` clone, never the vault): counts per kind against the
  measured 235, and the spot checks of decision 2.
- Browser (`?mock=1`): 2× screenshots of the 격리 tab with every group, and of a batch confirmation,
  in ko + light and en + dark.

## As built (2026-10-02)

The slice follows the decisions above, with these changes. Each was made so decision 2's spot checks
hold.

- **The "Distinguish instructions…" wrapper is stripped like a harness block, not flagged as `agent`.**
  Codex puts this wrapper around attachment requests. All 10 sessions that carry it were the owner's
  own requests, so flagging them would have quarantined human work.
- **`hello` also covers the daemon's `User: ping Assistant:` form** (13 sessions).
- **`empty` covers a transcript with no human-typed turn at all**, including an assistant-only
  transcript. A note with no turn markers is never judged.
- **The importer marker is Claude's `--session-id`.** myco gives every Claude run it launches its own
  session id and skips that run on import. The import skip requires exactly one human turn left
  after stripping the harness blocks (`turn_aborted` is one of them). So a person's session that
  opens by quoting a myco prompt is still imported.
- **`kept` lives in its own file, `.myco/distill-kept.json`.** Only the restore path writes it, under
  a short lock with an atomic rename, so a restore during a scan keeps its mark.
- **A group's "모두 버리기" sends paths to the OS trash in batches** (`trash_paths`, a few Finder calls)
  instead of one call per file. It refuses `raw/` and any path outside the vault.

Clone check at the final gate (412 sessions):

| Kind | Sessions |
|---|---|
| myco | 106 |
| agent | 76 |
| hello | 52 |
| empty | 6 |
| **Machine, total** | **240** |
| Human | 172 |

The scan embedded only 50, the budget. `raw/` (249 files) was unchanged. The 90 machine sessions the
ledger had already scored were re-judged.

Left unflagged, outside the rule: 16 Codex approval-evaluation prompts, 2 non-verbatim task-done
variants, 2 "Reply with exactly OK." tests, 2 teammate messages and 1 one-off test question.

The out-of-process daemon (`automation/autoingest.py`) does not take the lock.
