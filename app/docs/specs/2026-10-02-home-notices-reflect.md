# Home: notices instead of a side rail, and a Reflect that finishes

Owner, 2026-10-02, two screenshots of Home:

1. "홈 부분도 약간 이상한데, 우측에 다녀온 사이 의심 페이지들이 있으면서 화면이 쏠리는 증상이 있어. 이것들은 따로 홈에서
   알림 느낌으로 빼줘."
   - The right column holds three panels: "다녀오신 사이" (saying it was quiet), "의심 페이지 104" (raw
     English lint lines such as `source_count=2 but 3 distinct citations`, `invalid \`type\`:
     feature`, `missing frontmatter`), and "모순 0".
   - This column pushes the page off centre.
2. "리플렉트도 내가 눌렀는데 분명 계속 완료라고 나오고 밑에 계속 남아있어 이것도 정리가 되게끔 해주고 완료면 완료된 걸
   명확하게 표기해줘."
   - The Reflect card shows a spinner-like icon on "Reflect 실행" while its line says "Reflect 완료 —
     제안 8개 …".
   - The list stays under it indefinitely.
   - It lists managed files (`work/feedback/archive/…`, `audio/…`, `welcome.md`) as orphan pages.

## Decisions

### Notices

1. **Home is one centred column.** The side rail is gone at every width.
2. **One notices button in the Home title row.** It is a bell with a count badge of the items that
   need attention. It opens a popover (Esc, outside click and focus return, through the existing
   modal/popover patterns) listing one row per notice. With nothing to report it is shown with no
   badge, and its popover says so in one plain line. There is no empty panel on the page.
3. **What is a notice** (only when non-empty):
   - **Changes while you were away**: a count and a few named items, each opening its note.
     "Quiet" is not a notice.
   - **Pages to check** (today's "의심 페이지"): a count. The popover shows the first few with the
     problem in plain words (ko/en/ja), never the raw lint text. Examples: "출처 수와 인용 수가 달라요"
     for `source_count`, "종류(type) 값이 알 수 없는 값이에요", "노트 정보(머리말)가 없어요". Rows open the
     page, and "모두 보기" goes to the full list the app already has.
   - **Contradictions**: a count, only when > 0.
4. The sidebar's Home badge and the bell's count agree, or the difference is explained in code. This
   is S19's job, so the two are built together.

### Reflect

5. **States are unmistakable.**
   - Idle: the button has a plain icon, not anything that looks like a spinner.
   - Running: a spinner and "실행 중…".
   - Done: a check, "완료", the time, and the count ("완료 · 오후 9:42 · 제안 8개").
   - Failed: a clear error.
   - Clicking "Reflect 실행" while done starts a new run, and the old list is replaced, never
     appended.
6. **The list gets worked through.**
   - Each suggestion, when acted on, leaves the list: the page opens with →, the link or page is
     made with +, or it is dismissed with ×.
   - Dismissals are remembered per vault, so the same suggestion does not come back on the next run
     unless its facts change.
   - When the list is empty the card says "모두 정리했어요" and folds to its button.
   - "닫기" hides the results until the next run.
7. **Only the owner's notes are judged.** Orphan and missing-link suggestions skip managed areas
   (`vaultAreas.ts`: `work/`, `audio/`, `raw/`, `sessions/`, `cards/`, `ingest-reports/`, …), map
   pages, and `welcome.md`. This uses the same `classifyTopLevel` the sidebar uses, one source.
8. **Plain words.** "고아 페이지" becomes "아무 노트도 연결하지 않은 노트". Each row reads as one short line
   with its action, without the full path; a `title` attribute keeps the path.

## Acceptance

- vitest:
  - the notices model: kinds, counts and empty → none;
  - the lint-message → plain-words mapping, including unknown → a generic line;
  - the badge agreement;
  - the Reflect state machine: idle, running, done, failed and re-run replaces;
  - act-removes-row;
  - dismissal persistence;
  - the managed-area filter.
- Browser (`?mock=1`), with 2× screenshots looked at, in ko + light at 1280×900 and en + dark at
  1024×700:
  - Home is centred with no rail;
  - the bell with and without a badge, and its popover;
  - Reflect idle, running, done (with a list), done (list emptied) and failed.
