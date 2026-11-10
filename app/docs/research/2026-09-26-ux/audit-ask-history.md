# myco UX audit — Ask (Query), History, Study, Feedback, Provenance

Key: `ask-history` · Tree: `~/prj/karpathy-editor-build` (commit 0f8eb86) · Vite on :5474 (killed at the end, port confirmed free)
Browser: Playwright chromium, `?mock=1&local=1` (extractive path — the product's identity) and `?mock=1` (anthropic-cli provider path), UI language **ko**, light + dark, 1280×900 and 1024×700.
Screenshots: `shots/ask-history/` (87 files). Logs: `ah-01.log` … `ah-05.log`. Scripts: `ah-0*.mjs`, helper `ask-history-lib.mjs`.
Console: **0 errors, 0 warnings** across all runs (every `ERRORS: []` in the logs).

Mock caveat: `?mock=1` matches tokens literally, so Korean particles ("attention은") make the mock abstain — a mock artifact, not a product bug. Everything below was checked against the component source; each finding cites a screenshot or `file:line`.

---

## 1. The LLM-wiki loop, end to end

| Step | Status | Evidence |
|---|---|---|
| Ask | Works. Input + scope segment + "답변 옵션" disclosure. | `01-ask-empty-ko-light.png` |
| Loading | Works but weak: input disabled, send button becomes an unlabeled "…", no stop, fixed-width dark canvas. | `02-ask-loading.png`, `26-ask-loading-dark.png` |
| Answer with verbatim quotes + sources | Works and is the strongest screen: quotes, numbered pills, source ladder, retrieval trace. | `03-ask-answer-ko-light.png`, `06-ask-cite-hot.png`, `27-ask-answer-dark.png` |
| Open source | Half: opens the note at the top, no highlight of the quoted lines, no "back to question". | `07-reader-from-cite.png`, `PageQuery.tsx:194-196` |
| Insert into a note | **Missing from the Ask side.** The only insert path is the editor's `/기록` picker, which is good. | `03b-ask-answer-full.png` (no action on any quote), `95-recall-results.png`, `98-recall-inserted.png` |
| Follow-up | **Dead end** in extractive mode: no context carry, "그건 왜 중요해?" abstains and offers to log it as a harvest gap. | `16-ask-followup.png`, `queryStore.ts:209-272` |
| Abstain | Best-in-class card (floor gauge, near misses, harvest receipt); two flaws: widen mutates the global scope, range questions lose the period in the copy. | `09-abstain-ko-light.png`, `10-abstain-harvested.png`, `11-abstain-widen-result.png`, `12-ask-range.png` |
| History navigation | Turns survive route changes (good) but **die on reload**; no recent-questions list; `q_recent` string exists but is unused. | `08-ask-back-turns-kept.png`, `104-after-reload.png`, `ah-05.log` |

---

## 2. Findings — Ask page

### A1. No way to take an answer into a note (high)
The turn card offers: cite pills, "검토했지만 인용하지 않음", "기대한 답이 아니었나요? 기록하기", "오디오 개요". No copy, no "노트에 넣기", no "새 노트로". A Notion AI / Obsidian Copilot user expects "Insert below / Copy / Save as page".
Evidence: `03b-ask-answer-full.png`; `PageQuery.tsx:435-574`. The building block already exists: `lib/editorRecall.ts::quoteBlock` (used by `RecallPicker.tsx:162-170`).
Proposal: per quote, a ghost "노트에 인용" that inserts `quoteBlock(r.quote, r.stem#section)` into the last-opened note (or a note picker), plus "답변 복사" at the card foot.

### A2. Follow-up questions have no context (high)
`queryStore.ask` on the builtin-local path retrieves with the raw question only (`queryStore.ts:216-223`); prior turns are only replayed on the provider path (`:300-306`). An anaphoric follow-up abstains and the AbstainCard's first CTA is "이 질문을 수확 대상으로" — logging "그건 왜 중요해?" as a knowledge gap is wrong.
Evidence: `16-ask-followup.png`.
Proposal: if the question is short/pronoun-led and a previous turn exists, retrieve with `prev.cleaned + " " + q` and show a chip "이전 질문 이어서"; suppress the harvest CTA for such turns.

### A3. Citation → note loses the passage (high)
`onOpenPage` routes to `page:<abs>` only; the hit's `section` is dropped. The reader opens at the top; the quoted lines are not highlighted; the topbar back arrow is the only way home.
Evidence: `07-reader-from-cite.png`; `PageQuery.tsx:194-196`, `SourceLadder.tsx:196`.
Proposal: route with a section anchor and flash-highlight the matched lines in Reader (Obsidian search-result behaviour); while a turn is active, show a "← 질문으로" chip in the reader header.

### A4. Quotes rendered as full markdown at 22px serif (medium-high)
A note's `# H1` becomes a 44px heading inside the answer; footnote definitions render as a "1. source-… ↩" list; `[1]` links point inside the quote. The ladder shows raw `# Transformer Architecture` and `[[brackets]]`.
Evidence: `03-ask-answer-ko-light.png`, `05-ask-ladder-details.png`; measured `headingFont: 44px, bodyFont: 22px` (`ah-05.log`); `styles.css:10161-10166`; `SourceLadder.tsx:216` (`{r.quote}` raw).
Proposal: strip leading headings and `[^…]:` definitions from quotes before `<Viewer>`; cap headings to body size inside `.ask-body`; in the ladder strip `#`/`[[ ]]` to plain text.

### A5. 1024-wide window: answer column 278px, rail 340px (high)
`.ask-split` collapses at `@media (max-width:1000px)` (`styles.css:10134`), but the sidebar takes 240px, so at a 1024 viewport the rail wins.
Evidence: `21-ask-answer-1024.png`; `ah-02.log` "answer col 278px, rail 340px, sidebar 240px".
Proposal: `container-type: inline-size` on `.ask-turn` and stack below ~720px container width; the ladder becomes a "출처 12" disclosure under the answer.

### A6. Loading state: unlabeled "…", no stop, focus lost (medium)
Send button text becomes "…" with no `aria-label` (`PageQuery.tsx:262-268`); input is disabled; nothing cancels a run (no abort in `queryStore.ts`); after the answer lands `document.activeElement` is `BODY` (measured twice).
Evidence: `02-ask-loading.png`; `ah-01.log`/`ah-05.log` "focus after answer: BODY".
Proposal: labeled spinner + "중지" (AbortController through `complete()`/`retrieveChunks`); keep the input enabled for the next question; refocus the input (or the new turn heading with `aria-live=polite`) when the answer lands.

### A7. ThinkingGalaxy is a fixed 640px dark canvas (low-medium)
`ThinkingGalaxy.tsx:10-11,174` — `W=640`, `maxWidth: W`; it is the only dark block on the light page and leaves a gap on the right of the turn.
Evidence: `02-ask-loading.png`, `26-ask-loading-dark.png`.
Proposal: width 100%, theme-aware backdrop (reuse the answer's violet radial glow), label as text status.

### A8. Retrieval stepper: "바닥선 −0", truncated tiles, jargon (medium)
`RetrievalStepper.tsx:78-81` renders `−${n}` → "−0". Tile subtitles are single-line ellipsis with a title tooltip only. Korean labels: "냉동" (archived), "바닥선", "계층 사전확률", "RRF", "상한".
Evidence: `04b-ask-trace-expanded.png`, `22-ask-trace-1024.png`; `i18n.ts:5186, 5207`.
Proposal: "0" when nothing rejected; let subtitles wrap; plain labels ("보관된 세션", "관련도 기준", "출처 종류별 가중치"), keep the parameter footer for the curious.

### A9. Two controls named "검색 세부정보" (medium)
Top disclosure = retrieval trace (`PageQuery.tsx:464`); rail bottom button = ladder score columns (`SourceLadder.tsx:258`). Same `copy.searchDetails`, different behaviour.
Evidence: `15-ask-sessions.png` (both visible).
Proposal: rail toggle → "점수 보기".

### A10. "세션까지 넓혀 다시 검색" flips the global scope and appends a duplicate turn (medium)
`PageQuery.tsx:486-493` calls `setAskScope("all")` (persisted) then asks again; the segment stays on 전체 for every later question.
Evidence: `11-abstain-widen-result.png`; `ah-01.log` "scope after widen: 전체; turns: 3".
Proposal: pass the scope to `ask()` explicitly without persisting; replace the abstained turn in place (or collapse it) instead of appending.

### A11. Abstain + time range ignores the period (medium)
When `abstained` is true the body copy `rangeEmpty` is never used (`queryStore.ts:228-250`) and `AbstainCard` receives no `range` (`AbstainCard.tsx:20-42`), so the subtitle says "색인된 51쪽 중…" for a "지난주" question.
Evidence: `12-ask-range.png`.
Proposal: pass `range`; subtitle "2026-09-14 – 09-20 기록 중…"; make the primary CTA "기간 없이 다시 검색".

### A12. "기대한 답이 아니었나요? 기록하기" gives no feedback (medium)
Ghost text-button, fire-and-forget (`PageQuery.tsx:515-531`); after click nothing changes (`ah-02.log` "miss button still present & unchanged"). The AbstainCard's harvest button has the right pattern (disabled "등록됨 · 1건" + receipt).
Evidence: `32-ask-provider-answer.png`, `33-ask-miss-clicked.png`.
Proposal: reuse the receipt pattern (`role=status`).

### A13. Provider answers have no sources panel (high)
Provider path: retrieved pages are shown only on the `thinking` stage and discarded at `finishTurn` (`queryStore.ts:274-310`); the answer renders as prose; a galaxy appears only if the model wrote `[[wikilinks]]`.
Evidence: `32-ask-provider-answer.png` (no sources at all); `PageQuery.tsx:151, 504-513, 563-572`.
Proposal: keep `stage.stems` on the turn as `contextPages` and render the same `SourceLadder` (no cosine) — every answer gets a source rail, which is the product's promise.

### A14. Ask history is not persisted; "최근 질문" is dead copy (high)
`useQueryStore` is a plain `create` (no persist) — reload drops all turns (`ah-05.log` "before=2, after=0"). Unused ko keys: `q_recent`(최근 질문), `q_ladder_title`, `q_answer`, `q_wiki`, `q_raw`, `q_cite_list_label`, `q_builtin_note` (0 usages outside i18n.ts). No "새 대화".
Evidence: `104-after-reload.png`; `queryStore.ts:154`.
Proposal: persist the last N turns per vault (`.myco/ask-history.json`), show "최근 질문" chips in the empty state, add "새 대화"; delete dead keys.

### A15. Example prompts do not match the extractive mode (medium)
"내 노트의 핵심 내용을 정리해줘 / 서로 연결되는 아이디어가 있어? / 다음에 더 알아볼 만한 주제는 뭐야?" are synthesis prompts; the options panel says "모델 미사용". Clicking fills the input but does not submit.
Evidence: `100-example-filled.png`; `intakeCopy.ts:66-70`; `PageQuery.tsx:415-432`.
Proposal: in builtin-local, generate retrieval-style examples from hub titles ("BPE가 뭐야?", "지난주에 결정한 것"); submit on click.

### A16. AnswerGalaxy labels collide; galaxy shown for non-content answers (low-medium)
Labels overlap ("attention" hub over "attention-mechanism"); "참조된 소스 · 15" appears under a file-mtime listing.
Evidence: `29c-answer-galaxy-dark.png`, `102-audio-overview-local.png`, `13b-ask-meta-files.png`; `PageQuery.tsx:563-572`.
Proposal: label collision avoidance (show ≤6 labels, rest on hover); skip the galaxy for activity/meta turns.

### A17. Audio overview: enabled without a provider, panel out of view (low)
Button not gated (`PageQuery.tsx:787-797`); `audioStore.ts:77-84` fails after the click when no provider can generate; the panel mounts after all turns (`PageQuery.tsx:578`), below the fold.
Evidence: `102-audio-overview-local.png` (nothing visible near the button after clicking).
Proposal: disable with tooltip when `!canGenerate`; anchor the panel to the requesting turn or scroll to it.

### A18. Cite pill placement (medium)
The pill sits at the top-right of a 618px-tall quote (`pillTop: 9px`, `ah-05.log`), far from the reading end; Perplexity/Notion put the marker after the last sentence.
Evidence: `03-ask-answer-ko-light.png`.
Proposal: inline the pill after the last line, or a left-gutter number aligned to the first line with the whole row as the hover target (already `.ask-sent.hot`).

### A19. Small consistency items on Ask
- Uncited row uses "▸/▾" glyphs while other disclosures use Icon chevrons/`<details>` (`PageQuery.tsx:689`, `102-audio-overview-local.png`).
- Ladder hint "인용 번호에 마우스를 올리거나…" printed under every answer (`PageQuery.tsx:644-646`, `15-ask-sessions.png`).
- Session quotes render `[User] … [lead] … [[TASK_DONE]]` markup verbatim (`15-ask-sessions.png`); strip role tags in the quote view.
- Options row: "프로필을 설정하면 Ask가…" — "Ask" untranslated (`i18n.ts:5156`).

---

## 3. Findings — other pages

### H1. History: destructive undo with no confirm, opaque run labels (medium)
"이 실행 되돌리기" calls `undoDistillRun` directly (`PageHistory.tsx:135-149`, `234-244`); `ah-03.log` "confirm dialog after undo click: 0". It shares the `.btn` style with "WHY 리포트". Rows are titled by raw id `digest-1755740000` (`:215`) with a symbol line "→ 3 · + 2 · ✕ 1" and no legend; report rows say "Ingest 보고서 열기" (`i18n ing_open_report`) while runs say "WHY 리포트" for the same artifact.
Evidence: `40-history.png`, `41b-history-run-open.png`, `42-history-report-open.png`.
Proposal: `confirmAction` (already used on Feedback/Quarantine) + danger-ghost style; title "다이제스트 실행 · 2시간 전", id as mono subtitle; spell counts; one label "보고서 열기".

### S1. Study: no keyboard grading, danger-styled "다시", raw source ids (medium)
Pressing 3 after reveal does nothing (`ah-03.log`); grades are click-only (`PageStudy.tsx:288-310`). "다시" is red-outlined (`52-study-card-back.png`). Source line shows `[^src-attention-is-all-you-need]` (`:279-283`) and quiz `[^src-1]` (`:485-489`).
Proposal: Space/Enter flips, 1–4 grades; neutral grade buttons with a colored dot; resolve `sourceRef` to the raw title via `provenanceStore` and link it.

### F1. Feedback: naming, segment placement, stacked ledes, silent dismiss (medium)
Nav "정리 제안" (`i18n.ts:4933`) vs page title "수확함" (`:4942`) vs code fallback "Harvest box" (`Sidebar.tsx:314`). Segment is in the `bar` slot under the title (`PageFeedback.tsx:198-216`) while Query/Study put segments in the header `tools` slot. `note={t.pf_lede}` is static, so the quarantine tab shows two ledes (`64-feedback-quarantine.png`). Card expand is a bare chevron button, title not clickable (`:253-262`). "무시" has no confirm/undo (`ah-03.log` "dialog=0, cards 3 -> 2").
Proposal: one name; segment → `tools`; `note` per tab; header as the disclosure button; undo toast on dismiss.

### P1. Provenance: raw-markdown lint report, unlabeled slider, no filter (medium)
Lint report is a `<pre>` of markdown (`PageProvenance.tsx:117-131`, `74-provenance-lint-report.png`) while every other report uses `<Viewer>`; the report card is inserted above the stats and pushes the table. Range input has no accessible name (`:170-178`). The threshold only recolors rows; no "임계값 미만만 보기" filter or sort (`70b-provenance.png`, 51 rows).
Proposal: `<Viewer>`; `aria-label`; filter + sort by coverage.

### C1. Terminology drift across pages (medium)
- 메모 vs 노트: "내 메모에 질문하기" (`i18n.ts:4069`), nav "내 메모" (`:3710`), `q_empty` "관련 메모" (`:3819`) vs "저장한 노트" (`intakeCopy.ts:60`), tier "내가 쓴 노트" (`:5147`).
- Ask / 묻기 / 질문: `ask_profile_hint` "Ask가" (`:5156`), `rd_src_weight` "묻기가" (`:4651`), nav "질문".
- vault / 볼트: `p_open_vault`, `h_open_vault`, `p_scanning` use "vault" (`:4610, 5370, 4611`) vs "볼트" in `rd_src_scanning`, `qz_restore`, `q_abstain_title` (`:4644, 4973, 5213`).
- Ingest: `h_empty` "Ingest를 실행하면" (`:4386`), "Ingest 보고서 열기" vs nav "자료 추가".
- OnThisDay: "지난 해의 9월 26일" (`:4730-4732`, `99-onthisday.png`) → "지난해 오늘 (9월 26일)".
Proposal: glossary + a vitest over the ko table rejecting `vault|Ask|Ingest` in user-facing strings.

### C2. Breadcrumb missing for Study / Feedback (low)
`Topbar.tsx:514-534` has no branch for `study`/`feedback`/`tasks`; the crumb falls back to "myco" (`50-study-decks.png`, `60-feedback-proposals.png`) while History/Provenance show their names (`40-history.png`, `70b-provenance.png`).

### K1. ⌘K palette: a question is a dead end (medium)
Typing "attention이 뭐야?" shows "결과 없음"; Enter does nothing (`35-spotlight-ask.png`, `ah-05.log` "palette rows: []"); `CommandBar.tsx:178` only offers navigation to the Ask page. Notion and Obsidian Copilot surface "Ask AI: <query>" as a row.
Proposal: when there are no results or the query ends with "?", first row "질문하기: {q}" → `setQueryPrefill` + route.

### R1. RecallPicker (editor `/기록`) — works well; polish (low)
Near-miss list mirrors the AbstainCard, Tab cycles scope, keys footer, verbatim quote with `— [[stem#section]]` (`98-recall-inserted.png`). The embed button reads "![[ ]]" (`RecallPicker.tsx:292-305`) — an icon + "임베드" would be clearer.

---

## 4. Missing-state matrix (idle / loading / empty / error / success)

| Surface | idle | loading | empty | error | success |
|---|---|---|---|---|---|
| Ask | ok (mascot + examples) | weak (A6, A7) | abstain card ok | red text only (`PageQuery.tsx:506-507`), no retry | ok |
| History | — | "…" placeholder only (`PageHistory.tsx:273-275`) | ok card | inline red string | no receipt after undo |
| Study | — | "불러오는 중…" | ok | quiz error red text | ok |
| Feedback | — | "불러오는 중…" | ok | red string | green summary line |
| Provenance | — | "vault 스캔 중…" text | ok | red card | lint: raw pre |

---

## 5. Keyboard / a11y notes
- Tab order on Ask: input → scope segment → 답변 옵션 → examples → help FAB → (body) → sidebar (`ah-01.log`). Send button is skipped only while disabled (fine). Focus ring visible on input and send (`101-focus-send.png`).
- Cite pills, ladder rows, stepper are real buttons with labels — good.
- Confirm dialog traps focus and closes on Esc (`62-feedback-confirm.png`, `ah-03.log` "dialog after Esc: 0").
- Gaps: unlabeled "…" send button while busy; range input on Provenance without a name; no keyboard grading in Study; focus dropped to `body` after an answer.

## 6. What I did not verify
- Real provider streaming/latency (mock CLI reply is instant, so `31-ask-provider-loading.png` shows the finished state).
- `audioStore` gating in production (`canGenerate`) — inferred from `audioStore.ts:77-84`, not exercised; the mock generates a transcript.
- IME composition on Enter (code handles it via `isComposingKey`; not driven from Playwright).
