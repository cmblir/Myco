# Follow-ups after the 10-03 decisions

1. **Stale raw/ proposals.** B1 ("no run touches raw/") left older `archive-batch` proposals that
   say they will move N raw/ files. Approving one now fails with an English error.
   - On the next run, and when the Feedback page loads, every pending `archive-batch` proposal is
     marked done without moving anything.
   - Its card no longer offers Approve. It reads "더 이상 필요 없어요 — 원본은 그대로 둡니다" (en/ja too).
   - The apply path never surfaces English for it.
   - Tests cover all of this.
2. **Dead code.** `runDigest` in `app/src/lib/digests.ts` has no caller. The owner said to delete
   unused code, so it goes, along with its tests and anything only it used.
3. **Settings lede.** `set_distill_lede` still talks about archiving what is already covered. Reword
   it in en/ko/ja to match what distill does now: score inflow, quarantine machine sessions,
   digests, archive digested sessions, and never change raw/.
