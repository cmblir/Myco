# Feature 3 — Study Artifacts (Flashcards / Quizzes / Spaced Repetition) — Design

Date: 2026-07-09
Priority: 3. Depends on: none (LLM generation only; benefits from #1 for deck
scoping by similarity). Enables active recall over the vault.
Scope: `app/src-tauri` (Rust: card store read/write, FSRS scheduling, IPC),
`app/src/pages` (new `PageStudy.tsx`), `app/src/components` (PageReader generate
action, review/quiz UI), `app/src/lib` (chat/generation, fsrs, cards store),
`app/src/stores`, `app/src/lib/i18n.ts`.

## Problem / opportunity

Memex turns sources into a cited wiki but offers no way to *retain* the knowledge.
Active recall + spaced repetition is the proven method, and Memex's pages are an
ideal substrate: they are already summarized, cross-linked, and — crucially —
**carry `[^src-*]` citations**, so every generated card/question can inherit a
verifiable source. NotebookLM (flashcards, quizzes) and RemNote (one-click "Create
AI Cards") prove the demand; the Obsidian `spaced-repetition-ai` plugin proves the
markdown + FSRS pattern. Memex can do it offline with its bundled model.

## Decisions (settled)

- **Generation source:** the existing LLM stack (bundled SEED works offline;
  Query/Ingest provider selection reused). One-click from a page.
- **Storage: plain markdown on disk** (no lock-in) — cards live as markdown so
  Obsidian/git/shell see them and review state round-trips losslessly.
- **Scheduling: FSRS** (Free Spaced Repetition Scheduler), implemented
  self-contained in TypeScript (the algorithm is ~150 lines of pure math — no
  dependency, matches the "no heavy dep" ethos and the app's TS-first UI logic).
- **Citations inherit:** each card stores the source `[^src-*]` / `[[stem]]` of the
  claim it was generated from, shown during review.

### Open sub-decisions (finalize at implementation)
1. **Card storage format** — two candidates:
   - (a) **Dedicated `cards/<deck>.md`** files, one card per block, Obsidian-
     `spaced-repetition`-compatible (`Q ?? A` or `#flashcard` + `<!--SR:...-->`
     scheduling comment). Pro: clean, deck-scoped, interoperable with the popular
     Obsidian SR plugin. Con: separate from the source page.
   - (b) **Inline in the source page** under a `## Cards` section with an
     HTML-comment SR trailer. Pro: co-located with content. Con: clutters wiki
     pages, conflicts with the ingest/lint pipeline.
   - **Recommendation: (a)** `cards/` folder, Obsidian-SR-compatible syntax +
     FSRS state in a fenced `<!--SR:...-->` trailer. Decide before building.
2. **Deck scoping** — per-page, per-tag, per-Louvain-community (needs graph), or
   manual decks. Recommendation: page + tag to start; community later.
3. **Anki export** — a `.apkg`/CSV export command? Defer to a follow-up; keep the
   markdown canonical.

## Architecture

### A. Generation (`app/src/lib/study.ts` — new, + reuse `chat.ts`)
- `generateCards(pageOrScope, opts) -> Card[]` — prompt the selected model over the
  page's markdown to emit N cards as strict JSON `{front, back, sourceRef}`, where
  `sourceRef` is copied from the nearest `[^src-*]`/`[[stem]]` in the source span.
  Bundled model path for offline; validate + de-dupe.
- `generateQuiz(scope, n) -> Question[]` — multiple-choice / short-answer with the
  correct answer + `sourceRef` + a one-line explanation.
- Generation runs as a background job with a progress chip (mirror `IngestChip`).

### B. Card store (`app/src-tauri` command + `app/src/lib/cards.ts`)
- Read/write `cards/*.md` via existing vault IPC (`read_file`/`write_file`, atomic).
- Parse/serialize the card block + SR trailer. `Card = { id, deck, front, back,
  sourceRef, fsrs: FsrsState }`.
- `FsrsState = { due, stability, difficulty, elapsedDays, scheduledDays, reps,
  lapses, state: New|Learning|Review|Relearning, lastReview }`.

### C. FSRS scheduler (`app/src/lib/fsrs.ts` — new, pure TS, no dep)
- `schedule(card, rating: Again|Hard|Good|Easy, now) -> FsrsState` implementing the
  open FSRS-4.5/6 update equations with default weights (weights configurable
  later). Pure + unit-testable.

### D. Review UI (new route `PageStudy.tsx` + sidebar entry)
- **Due queue:** scans `cards/`, computes due cards (`fsrs.due <= now`), presents
  one at a time — show front → reveal back → rate (Again/Hard/Good/Easy) → `schedule`
  → persist. Shows the inherited citation + a link to the source page.
- **Quiz mode:** runs a generated quiz, scores comprehension, links each question
  back to its source page.
- **Generate action** in `PageReader` ("Make cards" / "Quiz me") targeting the open
  page; also a scope picker (tag/deck) on `PageStudy`.
- Deck list + due counts; a small "N due" chip in the sidebar/topbar.

### E. i18n
en/ko/ja for the study route, ratings, generate actions, empty/all-done states.

## Constraints fit
- Cards are plain markdown on disk → no lock-in, git-versioned, Obsidian-readable;
  review state is human-readable. Generation works offline with the bundled model;
  cloud providers opt-in (keychain). No telemetry. `raw/` never touched — cards are
  generated from `wiki/` pages and written to `cards/`. Citations preserved so
  study stays source-grounded (the Memex differentiator).

## Error handling
- LLM emits malformed JSON → retry once, then skip with a surfaced count; never
  write partial cards.
- Corrupt SR trailer → treat card as New (never lose the card content); log.
- Missing source page for a card → still reviewable, citation shown as unresolved.

## Testing / verification
- Rust/TS unit: card block parse↔serialize round-trip (incl. SR trailer); FSRS
  schedule transitions (New→Learning→Review, lapse→Relearning) against reference
  vectors; due-queue selection by date.
- Generation: mock model output → N valid cards with sourceRef populated.
- Playwright: "Make cards" on a page creates `cards/*.md`; PageStudy shows a due
  card, rating advances it and persists; quiz scores; sidebar due-count updates.
- `tsc -b`, `eslint`, `vitest run` clean; existing tests pass.

## Rollout
Ship the review route + per-page generation first; tag/community deck scoping and
Anki export as follow-ups. No bundle-size impact (pure-TS FSRS, LLM already present).
