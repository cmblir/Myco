# Distill honesty: proposals that need a writer, and the auto-distill trigger

Owner, 2026-10-02, with a screenshot of the proposals page (a "Map candidate: attention-mechanism" card
at "적용 실패 — 재시도" under a red English `Error: no local chat model is bundled …`): "제안 격리 안되고
있고, 학습도 자동학습 켰는데 안되는데?"

## What is wrong (verified 2026-10-02 against the code and, read-only, the owner's vault)

1. **Applying a topic map cannot work, and the card says it failed.**
   - Applying a `draft-map` proposal calls `draftMap` → `complete({ task: "generate" })` directly
     (`distillStore.ts` apply, `maps.ts` draftMap).
   - `roleFor("generate")` chooses between the query and ingest roles only. Both are `builtin-local`
     (extractive), so `complete()` throws `CHAT_MODEL_MISSING`. The connected Claude/Gemini/Codex CLIs
     are not assigned to any role.
   - `apply` rewrote the file `pending` → `approved` before the call, so the card is stuck on "적용
     실패 — 재시도". Retry fails the same way.
   - The raw English error reaches the Korean UI through `String(err)`.
   - It is the only generate call with no gate. Reflect, digests, lint, study and audio all check
     first or fall back.
2. **The "자동 정리" (auto-distill) toggle runs nothing.**
   - e11fb45e (2026-09-06) deleted `lib/scheduleTimer.ts` and `lib/idle.ts` as dead code. With them
     went the idle + backlog ≥ `count_trigger` trigger (`maybeRunCountTrigger`, a 60 min cooldown),
     which was live: vault reports show hourly runs on 09-04/05.
   - Since then only manual paths call `runDistillGuarded` (Overview, Settings, tray). Settings still
     says it runs on its own.
3. **`run()` archives top-level `raw/` files to `raw/archive/`.** Two moves happened on 10-02. The
   project rule is that a vault's `raw/` is immutable, and owner decision B1 on these moves is open.

## Decisions

1. **Apply checks before it writes.**
   - In `distillStore.apply`, a `draft-map` whose generate role cannot write
     (`canGenerate((await getActiveModel("generate")).provider)` is false, as `study.ts` checks):
     - writes nothing (a pending file stays pending);
     - calls no model;
     - sets no error.
   - Instead the card shows a localized line: "주제 지도를 쓰려면 글을 쓰는 모델이 필요해요" / "Writing a
     topic map needs a model that can write". Beside it is a "모델 설정 →" button that opens Settings
     → Model, the pattern `PageQuery.tsx` already uses.
   - No confirm dialog opens for a map that cannot be written.
2. **A stuck card tells the truth.** An already-`approved` draft-map that cannot be written, which is
   the owner's card, shows the same line and button instead of "적용 실패 — 재시도". Once a writing
   model is set, the usual retry is back.
3. **`CHAT_MODEL_MISSING` is never shown in English.** The distill store maps it to the localized
   line, as `audioStore` does. Other errors still show.
4. **A stale error clears.** It clears on `refresh()` and on a tab switch, so the 격리 tab does not
   carry the 제안 tab's red line.
5. **The gates agree.** `applyApprovedDraftMaps` (`distill.ts`) and the ActivityChip guidance check
   the generate role, which is the role `draftMap` calls, not the query role.
6. **The auto-distill trigger is back.**
   - It fires only when all of these hold:
     - `DistillConfig.enabled`;
     - the app has been idle (no pointer or key activity) for `idle_minutes`;
     - the backlog is at least `count_trigger`.
   - It then runs `runDistillGuarded` at most once per 60 min, and only while the app runs.
   - It is one small module plus one hook in `App.tsx`. Restore `idle.ts` and `maybeRunCountTrigger`
     from `e11fb45e^` where they fit. The `schedules.json` path stays deleted, since it was dead.
7. **An automatic run never touches `raw/`.**
   - The trigger's runs skip `run()`'s `raw/` archive pass, through an explicit flag on the IPC
     call.
   - Manual runs keep today's behaviour until the owner decides B1.
   - A Rust test pins that a run with the flag leaves every `raw/` file in place, byte for byte.
8. **Settings text stays truthful.** The "자동 정리" description says what now runs: when it runs,
   and that automatic runs leave `raw/` alone.

## Not in this slice (owner decisions)

- **Quarantine calibration.** On this vault the gate quarantines nothing. Generic wiki stems (`claude`,
  `mcp`, `index`, `log`) lift almost every session to Summary through the entity floor. The band
  [p5, (p5+p25)/2) is 0.002–0.058 wide, and the rest are Rejected in place with no UI.
- **A fallback to a connected CLI** when both roles are extractive, which would spend subscription
  usage without asking.
- **Assigning a writing provider.** The owner does it in Settings → Model, and it fixes the map and
  makes ingest write real pages.
- **Ingest throughput** (one item per 60 min pass).

## Acceptance

- vitest:
  - apply with no writer: no file write, no model call, no error, and the needs-writer state is set;
  - apply with a writer: unchanged;
  - an approved, unwritable card shows the needs-writer line and not the failed line;
  - `CHAT_MODEL_MISSING` is mapped;
  - the error clears on refresh and on a tab switch;
  - both gates use the generate role;
  - the trigger fires, and does not fire when disabled, not idle, under the count, or in cooldown;
  - the trigger passes the no-`raw/` flag.
- cargo: a run with the flag leaves `raw/` untouched and still archives everything else it would;
  `cargo fmt`, `clippy -D warnings` and `cargo test` pass.
- Browser (`?mock=1`): 2× screenshots, looked at, of the proposals page with a draft-map that cannot
  be written, both pending and approved, in ko + light and en + dark.
