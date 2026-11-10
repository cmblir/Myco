# Owner decisions, 2026-10-03

The owner answered the open questions on 2026-10-03. Each answer is a decision for this slice.

1. **B1: no run touches `raw/`.** The owner went with the recommendation. Manual distill runs now
   leave `raw/` alone too: `leave_raw` is always on and the manual `raw/` archive pass is gone. The
   README, the Settings text and the tests follow.
2. **Codex approval-evaluation prompts are machine-made.** The first turn opens with
   `The following is the Codex agent history…`. These sessions are detected as `machine:agent`,
   using the same provenance check (`machine_session.rs`), with a synthetic fixture. Count them on a
   fresh clone: counts only.
3. **Apply the backlog proposals S31, S55 and S14.7.**
   - S31: citation footnotes render as numbers, and clicking one opens the source.
   - S55: on desktop, a plain click opens a rendered link.
   - S14.7: the answer-percentage change, as the backlog section proposes.
4. **Tasks.**
   - Durations and repeats are recognised in Korean: "2일" becomes `2d`, "매주" becomes `every week`
     (also 매일/매달/매년, N주/N시간). They are normalised before saving, and the Obsidian
     Tasks-compatible stored form is unchanged.
   - A time without 오전/오후 is recognised: 7–11시 is morning, 12시 is noon, and 1–6시 is
     afternoon.
   - A bare weekday ("토요일") means that day of the current week, Monday to Sunday, even if it has
     passed.
5. **The Home badge counts notice rows.** No change.
6. **Delete the code the removed Home rail left behind.** That is the `rail` zone in
   `board.ts`/`OverviewArrange.tsx`, `ovl_zone_rail`, `.ovl-rail-stack`, and anything else now
   unreachable, along with its tests.
7. **The full-screen check stays geometry-only.** No change.
8. **The Ask composer's placeholder is shorter**, so it fits the pinned one-row composer at 375 px in
   ko, en and ja.
9. **The sidebar tree semantics and focus-on-title stay as shipped.** No change.
