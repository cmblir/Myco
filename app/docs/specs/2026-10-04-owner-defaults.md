# Owner said "go with the recommendations", plus two bugs (2026-10-04)

## Bugs (owner screenshots)

1. **Skip link shows on overscroll.** In Settings, dragging or scrolling up past the top reveals a
   "본문으로 건너뛰기" tab. The skip link must be invisible until it has keyboard focus: use the
   visually-hidden pattern (clip, 1px), not an off-screen `top` that elastic overscroll exposes.
   It shows only on `:focus-visible`.
2. **Settings gear clipped.** The gear button in the sidebar header (S43) renders with its left
   edge cut off. It gets its full 32px+ hit box inside the header, with nothing overflowing or cut,
   at every sidebar width.

## Defaults the owner approved

1. In a short window (height ≤ 760 px), the workspace group starts folded. A stored choice still
   wins.
2. Graph: remove the duplicate in-canvas "graph settings" toggle. The More menu keeps the item. The
   left rail is then 6 Tabs from find.
3. Split view keeps opening on the graph. No change.
4. Status warnings stay folded into the summary line. No change.
5. Note info at narrow widths (< 960 px window): the rail opens as an overlay sheet over the note,
   with a scrim, Esc and focus return. It no longer covers the text inline.
6. The idle-walk skip rule stays. No change.
7. The lock/sleep veto on job roams stays. No change.
8. A quote brought into today's note also writes its footnote definition
   `[^src-<stem>]: raw/<rel>`, once per note, so the citation renders.
9. Cards: when the selected sentence has no bold or link term, the owner can pick the word to blank
   out (click a word in the preview), and it becomes a cloze.
10. "오늘 생긴 연결" stays today-only. No change.
11. Summary-tier inbox items stay in place. No change.
12. Web import decodes legacy charsets (EUC-KR, Shift_JIS, …) with `encoding_rs`, which is already
    in the lockfile. That makes it a direct dependency, in its own commit.
13. A host with any non-public address is still refused. No change.
14. Delete the unused schedule IPC wrappers and their mock cases. The Rust commands go too only if
    nothing else calls them (MCP and launchd included). Otherwise they stay and the report says why.
15. The Ask page title stays folded after the first question. No change.
16. "Ask this note" on phones: a button at the bottom of the note, done with the mobile bundle.

## Mobile bundle

S46–S54 from `app/docs/research/2026-10-01-ux-mobile/backlog.md`, web layer only, at narrow widths and
for coarse pointers. The desktop window's `minWidth: 800` stays.
