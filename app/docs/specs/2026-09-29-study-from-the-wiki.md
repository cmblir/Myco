# Study from the wiki: extractive cards, plus two owner fixes

Owner, 2026-09-29, asked "학습에 카드가 생기는 원리가 뭐야? 지금 이 학습은 우리 위키 기반으로
나에게 정보를 줘야하는데 이상하게 주고 있어". The same day they also asked about the missing theme
and a square behind the logo on hover.

## What happens today (measured)

- Cards come from "Make cards" in the Reader. `PageReader` calls `generateCards`
  (lib/study.ts), which asks the chat model for a JSON array of `{front, back, sourceRef}`. The
  quiz mode does the same through `generateQuiz`.
- The only model the default install has is the small local one. The real vault's only deck,
  `cards/2026-07-12.md`, shows the result. Its cards are "What is the purpose of this tool? ??
  It's a command-line tool for generating flashcards from text…": generic prose about the
  generator, not about the note, with no `sourceRef`.
- That breaks myco's rule for Ask and ingest: vault text is quoted verbatim, never invented
  (Decision Q8 in the block-editor roadmap; extractive Ask; extractive ingest).

## Part 1 — extractive cards (no model)

New pure module `lib/extractiveCards.ts`, `cardsFromNote(md, stem, opts)` → `Card[]`. Every
front and back is built only from the note's own text:

1. **Definition card** — for a note with a lead paragraph, typically the concept, entity or
   technique pages.
   - front: `[[<title>]] — 무엇인가요?`. The frame is an i18n template (`t.st_def_front`), en/ko/ja.
   - back: the first non-heading paragraph, verbatim, cut whole-line to ≤ 280 chars by
     `quoteBody`.
2. **Cloze cards** — from sentences that carry a `[^src-*]` citation, or a `**bold**` or
   `[[wikilink]]` term.
   - front: the sentence verbatim, with that one term replaced by `＿＿＿`.
   - back: the term, then the full sentence.
   - At most 6 per note, taken in document order. Skip sentences under 30 or over 240
     characters, list scaffolding, code, tables and frontmatter.
3. **Heading card** — for each H2 with body text under it.
   - front: `<title> › <heading>` (template `t.st_section_front`).
   - back: the first paragraph under that heading, verbatim, ≤ 280 chars.

Every card's `sourceRef` is `[[stem#Heading]]` for the section it came from (`[[stem]]` for the
lead). The review UI shows that source as a link that opens the note at the heading. A note
that yields nothing gets "이 노트에서는 카드를 만들 수 없어요 — 인용·굵은 글씨·위키링크가 있는 문장이
필요합니다".

"Make cards" works like this:
- It opens a preview sheet listing the proposed cards with checkboxes, then saves the checked
  ones to `cards/<stem>.md`. It no longer goes to a date-named deck: one deck per note, so a
  card's deck says where it came from.
- It dedupes against cards already in that deck, comparing the normalised front.
- No model call happens anywhere on this path.

The quiz uses the same extractive idea:
- A cloze sentence becomes a multiple-choice question.
- The correct answer is the removed term.
- The distractors are other bold or wikilinked terms from the same deck or a neighbouring
  note (linked from it). The explanation is the full sentence. No model call.
- With fewer than two distractors the question is skipped.

`generateCards` and `generateQuiz` stay in lib/study.ts, used only when a real chat provider
is configured and the user turns on "AI로 카드 만들기 (실험적)" in Settings → 학습. That toggle is
off by default. Even then each model card must quote a span that occurs verbatim in the note:
check it with a normalised substring test, and drop cards that fail.

## Part 2 — clean up the model-made deck

Study's deck list marks a deck whose cards have no `sourceRef`, or whose back text does not
occur in any vault note, as "근거 없는 카드 N장".
- A deck-level action "보관하기" moves it to `cards/archive/` through `move_path`, so it is
  reversible by moving it back.
- It shows no due count and is excluded from "due today" on Home.

## Part 3 — owner fixes

- **Theme / living background.**
  - Settings → 테마 (라이트, 다크, 시스템) exists and works.
  - The living background chosen under Settings → 개요 배경 renders only inside Home's collapsed
    "관리 도구" section (VaultPulse). That is why it looks gone.
  - Home gets the chosen background as a quiet full-width band behind the greeting and the
    ask box. It uses the same overviewThemes engine at reduced opacity. The text stays AA over
    it in both themes, and the band respects `prefers-reduced-motion`: static frame, no
    animation.
  - Settings → 개요 배경 lede says it shows on Home.
- **Square behind the logo on hover (top bar).** The owner's screenshot shows a row "제안된 링크
  196" with a round logo image; on hover a square box appears behind or around the logo. Find
  the component (the i18n string for 제안된 링크, the notch or tray panel row), then:
  - make the icon container match the round logo (`border-radius: 50%`, `overflow: hidden`, no
    square hover background);
  - put the row's hover feedback on the row, not on the icon;
  - check the same for every row with that icon.

## Acceptance

- vitest:
  - `cardsFromNote` on fixtures (a concept note, a note with citations, a note with nothing
    quotable): every front and back is a substring of the source after normalisation. The
    frames come from the i18n templates only.
  - dedupe works;
  - quiz distractors come from other terms and the answer is correct;
  - the "근거 없는 카드" detection works;
  - the model path drops cards whose quote is not in the note.
- Browser (?mock=1, ko + en):
  - "Make cards" on a mock concept note previews extractive cards and saves them to
    `cards/<stem>.md`;
  - Study reviews them with a source link that opens the note at the heading;
  - the mock gets a junk deck, which is flagged and can be archived;
  - Home shows the living background band in light and dark with reduced motion on and off;
  - the notch or tray row icon shows no square on hover.
- Checked at 1280×900 and 1024×700.
