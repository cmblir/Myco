# Feature 7 — Automated Recurring Research & Digests — Design

Date: 2026-07-09
Priority: 7. Depends on: none (richer with #1 semantic retrieval and #4 agent, but
independent). Enables scheduled, unattended knowledge upkeep.
Scope: `automation/` (Python harness + new digest runner), `app/src-tauri` (Rust:
schedule store, run-now command, notifications, optional launchd install),
`app/src/pages` (a "Schedules" area — Settings tab or a small route),
`app/src/components`, `app/src/lib/i18n.ts`.

## Problem / opportunity

Memex answers questions only one-shot (`PageQuery`) and ingests only when the user
drops a file. There is no way to say "keep watching this for me." Khoj's most-loved
differentiator is *automations*: scheduled queries that produce personal
newsletters/digests and smart notifications. Memex already has the two hard pieces —
an unattended runner (`automation/autoingest.py`, launchd/cron-schedulable) and a
Q&A path over the wiki — so recurring digests are mostly wiring, not new capability.

## Decisions (settled)

- **Digests are plain markdown notes** written into the vault (default `digests/`,
  configurable per schedule; `daily/` allowed). No lock-in, git-tracked, readable in
  Reader/Obsidian.
- **Generation reuses the existing LLM stack** (bundled model works offline; cloud
  providers opt-in with keychain keys) and, for "what changed" digests, `git log`/
  diff over the vault (already exposed via `git_log`).
- **Unattended runs reuse the `automation/` harness** (hardened toolset, JSONL log,
  rollback) rather than inventing a second runner.

## Open sub-decisions (finalize at implementation)

- **Scheduler: launchd/cron (unattended, app closed) vs in-app timer (app open).**
  Recommendation: BOTH tiers — persist schedules to disk; an in-app `setInterval`/
  timer fires them while the app is open (like `autoIngest`/`autoReflect` already
  do), and an opt-in "Install background schedule" writes a launchd plist / cron
  entry invoking the Python runner so digests still run when the app is closed.
  Confirm whether app-closed runs are in scope for v1 or defer launchd install.
- **Notifications opt-in** (default off) via the Tauri notification plugin; confirm
  copy + permission flow.
- **Schedule persistence:** a `schedules.json` in `settings_dir()` (Rust-owned,
  atomic write, mirrored by a zustand store) vs per-vault. Recommendation:
  per-vault file so schedules travel with the project.

## Architecture

### A. Schedule model (Rust `src-tauri/src/schedules.rs` — new)
- `Schedule { id, title, kind, prompt, cadence, output_dir, provider/model,
  notify: bool, last_run, enabled }`.
  - `kind`: `query` (free prompt over the wiki), `changed` (git diff summary since
    last run), `stale` (surface orphan/under-cited/contradictory pages — reuse
    `graphGaps`/MCP `contradictions`/`trust_report`), `topic` (digest new sources
    matching a topic — uses #1 semantic search when present, else keyword).
  - `cadence`: `daily | weekly:<dow> | monthly:<dom> | every:<n>h`.
- IPC: `list_schedules, upsert_schedule, delete_schedule, run_schedule_now(id),
  install_background_schedule(id, on)`.
- Persisted to `<vault>/.memex/schedules.json` (atomic write, path-traversal-safe).

### B. Digest runner (`automation/digest.py` — new; shares helpers with autoingest)
- `python -m automation.digest --vault <path> --schedule <id>`: loads the schedule,
  builds the prompt (for `changed`, prepends `git log`/`git diff --stat` since
  `last_run`; for `topic`, gathers candidate pages), runs the configured model with
  the same hardened tool policy (Read/Grep/Glob only; never Bash), writes
  `digests/<YYYY-MM-DD>-<slug>.md` with frontmatter (`kind`, `schedule`, source
  citations `[^src-*]` where applicable), appends to the JSONL run log, updates
  `last_run`. Failure → no partial note + logged, next run retries.
- The app's in-app timer invokes the same logic via a Rust command (so app-open runs
  don't require Python), sharing the digest-prompt builder; the Python entrypoint is
  for launchd/cron (app-closed).

### C. In-app scheduling (`app/src/lib/schedules.ts` + `scheduleStore.ts` — new)
- Mirror `autoIngest.ts`/`autoReflect.ts`: on app start, a single timer checks due
  schedules (cadence vs `last_run`) and calls `run_schedule_now`. Live status +
  spinner in a topbar chip (reuse the `IngestChip`/`LintChip` pattern).

### D. UI (`PageSettings.tsx` new "Schedules" tab, or a small route)
- List schedules; add/edit form: title, kind, prompt/topic, cadence, output dir,
  model (reuse `ModelSelect`), notify toggle, enable toggle, "Run now" button,
  "Install background schedule" (launchd) toggle. Last-run timestamp + link to the
  latest digest note.

### E. Notifications
- Add `tauri-plugin-notification`; on a completed run with `notify`, post a native
  notification ("Weekly digest ready — 3 sources, 5 changed pages") linking to the
  note (opens it in Reader). Opt-in, permission requested on first enable.

## Constraints fit
- Local-first: bundled model runs digests offline; cloud opt-in via keychain. No
  telemetry. Outputs are plain markdown in the vault (git-tracked, no lock-in).
  `raw/` untouched (read-only). Unattended runs use the existing hardened,
  Bash-free tool policy.

## Error handling
- Missing model/provider → schedule marked errored, surfaced in the UI, retried next
  cadence; never crash the app timer. Git-unavailable vault → `changed` kind falls
  back to mtime scan. launchd install failure → clear message, in-app timer still
  works.

## Testing / verification
- Rust unit: cadence "is-due" math (daily/weekly/monthly/every-n-h vs last_run),
  schedules.json round-trip, path-safe output dir.
- Python: digest.py builds the right prompt per kind; writes a well-formed note;
  updates last_run; failure leaves no partial file.
- Playwright: create a schedule, "Run now" → a digest note appears in the vault and
  in Reader; notify toggle posts a (mocked) notification; disable stops it.
- `tsc -b`, `eslint`, `vitest run` clean; existing tests pass.

## Rollout
Ship app-open scheduling first (no OS integration risk); gate "Install background
schedule" (launchd/cron) behind an explicit opt-in with a clear explanation that it
runs the Python runner while the app is closed.
