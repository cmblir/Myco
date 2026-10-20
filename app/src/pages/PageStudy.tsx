// PageStudy — the spaced-repetition study route. Lists decks (cards/<deck>.md)
// with due counts, runs a due-card review loop (front → reveal → grade → FSRS
// advance → persist), and a generated multiple-choice quiz mode. All state
// round-trips to plain markdown on disk via the card store.

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import { TODAY_REVIEW, useStudyStore, today } from "../stores/studyStore";
import { gradeCard, nextReview, todayQueue, type Card, type DeckCards } from "../lib/cards";
import { daysBetween, type Grade } from "../lib/fsrs";
import {
  archiveDeck,
  loadCountedDecks,
  loadDeck,
  saveGrade,
  deckNameFromPath,
  type DeckSummary,
} from "../lib/cardStore";
import { notice } from "../lib/notice";
import { studyDeckMessage } from "../lib/studyDeckMessage";
import { generateQuotedQuiz, modelStudyOn, type QuizQuestion } from "../lib/study";
import { parseSourceRef, quizFromCards, termsOf } from "../lib/extractiveCards";
import { ipc } from "../lib/ipc";
import { setPendingAnchor } from "../lib/pendingAnchor";
import AppPage from "../components/AppPage";
import MascotClip from "../components/MascotClip";
import { SURFACE_CLIPS } from "../lib/mascotClips";
import { Button, Segment } from "../components/ui";

type Mode = "review" | "quiz";

/** After archiving the deck in row `i`, keyboard focus goes to the row now in
 *  its place (the last one when it was last) or, with no deck left, to the
 *  empty state's button — never back to <body>. */
export function refocusAfterArchive(
  i: number,
  doc: Pick<Document, "querySelectorAll" | "querySelector">,
): void {
  const rows = doc.querySelectorAll<HTMLElement>(".deck-row__open");
  const target =
    rows.length > 0
      ? rows[Math.min(i, rows.length - 1)]
      : doc.querySelector<HTMLElement>(".study-browse");
  target?.focus();
}

/** The grade buttons, left to right: Forgot (FSRS Again) and Remembered
 *  (Good) by default; Settings → Study "Grade in detail" brings back all four. */
export function reviewGrades(fine: boolean): readonly Grade[] {
  return fine ? [1, 2, 3, 4] : [1, 3];
}

/** "tomorrow", "in 4 days", "in 2 months", "in 1 year": Intl words it per
 *  language. Only days say "tomorrow"; a month or year out is a span, not
 *  "next month" on the calendar. */
export function whenLabel(days: number, lang: string): string {
  if (days < 30) {
    return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(days, "day");
  }
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "always" });
  const months = Math.round(days / 30);
  if (months < 12) return rtf.format(months, "month");
  return rtf.format(Math.max(1, Math.round(days / 365)), "year");
}

/** When the card comes back if graded `g` today, as lib/fsrs schedules it. */
export function intervalLabel(card: Card, g: Grade, today: string, lang: string): string {
  const due = gradeCard(card, g, today).state?.due ?? today;
  return whenLabel(daysBetween(today, due), lang);
}

type KeyTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  ownerDocument?: Pick<Document, "querySelector"> | null;
} | null;

/** What a keydown does in a review: Space shows the answer, 1–n grade with
 *  the n buttons once it shows. Null for anything else: a held key, a chord,
 *  an IME composition, typing in a field, an open dialog, and Space while a
 *  control has focus (the flip button flips itself; once revealed,
 *  Remembered holds focus and Space presses it). Only keys from the review's
 *  own pane (`root`) count, and <body> only while no split shows another
 *  pane: a key pressed there is not the review's to grade. */
export function reviewKey(
  e: Pick<
    KeyboardEvent,
    "key" | "repeat" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "defaultPrevented"
  > & { target: EventTarget | null },
  revealed: boolean,
  grades: readonly Grade[],
  scope: { root?: Pick<Node, "contains"> | null; split?: boolean } = {},
): "reveal" | Grade | null {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.defaultPrevented) {
    return null;
  }
  const el = e.target as KeyTarget;
  const tag = el?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) {
    return null;
  }
  if ((el?.ownerDocument ?? globalThis.document)?.querySelector('[aria-modal="true"]')) {
    return null;
  }
  const onBody = !tag || tag === "BODY" || tag === "HTML";
  if (onBody ? scope.split : !scope.root?.contains(e.target as Node)) return null;
  if (e.key === " ") {
    return !revealed && onBody ? "reveal" : null;
  }
  const n = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
  return revealed && n > 0 && n <= grades.length ? grades[n - 1] : null;
}

/** What holds focus in a review: the flip button on a new card, Remembered
 *  once the answer shows, and the end card after the last of `graded`
 *  grades, so a grade never leaves focus on <body>. Null when nothing was
 *  due on open: the empty card takes no focus from the page. */
export function reviewFocus(
  hasCard: boolean,
  revealed: boolean,
  graded: number,
): "flip" | "remembered" | "done" | null {
  if (hasCard) return revealed ? "remembered" : "flip";
  return graded > 0 ? "done" : null;
}

export default function PageStudy({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const decks = useStudyStore((s) => s.decks);
  const dueTotal = useStudyStore((s) => s.dueTotal);
  const refresh = useStudyStore((s) => s.refresh);
  const loading = useStudyStore((s) => s.loading);
  const loadError = useStudyStore((s) => s.error);
  // A deck file's path, or TODAY_REVIEW for the queue across every deck.
  const [deckPath, setDeckPath] = useState<string | null>(null);

  // Ritual-card deep link (Q4 item 11; Home's Start review sends
  // TODAY_REVIEW): consume uiStore.studyDeck once on mount and clear it, so
  // the next plain Study visit starts at the deck list.
  useEffect(() => {
    const deep = useUIStore.getState().studyDeck;
    if (deep) {
      setDeckPath(deep);
      useUIStore.getState().setStudyDeck(null);
    }
  }, []);

  // Refresh due counts on mount and whenever the vault (its cards) changes.
  useEffect(() => {
    void refresh();
  }, [refresh, currentVault?.path]);

  const onBack = (): void => {
    setDeckPath(null);
    void refresh();
  };
  if (!deckPath && (loadError || loading)) {
    return (
      <AppPage eyebrow={t.nav_tools} title={t.st_title} note={t.st_lede}>
        {loadError ? (
          <div className="card" role="alert" data-testid="study-load-error" style={{ padding: 20 }}>
            <p>{t.st_load_failed}</p>
            <details><summary>{t.eb_details}</summary><pre style={{ whiteSpace: "pre-wrap" }}>{loadError}</pre></details>
            <Button onClick={() => void refresh()}>{t.q_retry}</Button>
          </div>
        ) : <p className="muted" role="status">{t.st_loading}</p>}
      </AppPage>
    );
  }
  if (!deckPath) {
    return (
      <DeckList
        t={t}
        decks={decks}
        dueTotal={dueTotal}
        onOpen={setDeckPath}
        onRefresh={refresh}
      />
    );
  }
  if (deckPath === TODAY_REVIEW) {
    return <TodayReview t={t} vaultPath={currentVault?.path ?? ""} onBack={onBack} />;
  }
  return (
    <DeckStudy
      key={deckPath}
      t={t}
      vaultPath={currentVault?.path ?? ""}
      deckPath={deckPath}
      onBack={onBack}
    />
  );
}

/** Today's review (UX S34): the due cards of every deck that counts, in one
 *  session, so it holds the number Home and the top of Study show. */
function TodayReview({
  t,
  vaultPath,
  onBack,
}: {
  t: Strings;
  vaultPath: string;
  onBack: () => void;
}): JSX.Element {
  const [decks, setDecks] = useState<DeckCards[] | null>(null);
  useEffect(() => {
    let alive = true;
    // The summaries Home counted from; the cards are read fresh from disk.
    void loadCountedDecks(useStudyStore.getState().decks).then((d) => {
      if (alive) setDecks(d);
    });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <AppPage
      eyebrow={t.nav_tools}
      title={t.st_today_title}
      tools={
        <Button variant="quiet" onClick={onBack}>
          <Icon name="arrowL" size={13} /> {t.st_all_decks}
        </Button>
      }
    >
      {decks === null ? (
        <p className="muted" style={{ paddingTop: 24 }}>
          {t.st_loading}
        </p>
      ) : (
        <ReviewSession t={t} vaultPath={vaultPath} decks={decks} />
      )}
    </AppPage>
  );
}

function DeckList({
  t,
  decks,
  dueTotal,
  onOpen,
  onRefresh,
}: {
  t: Strings;
  decks: DeckSummary[];
  dueTotal: number;
  onOpen: (path: string) => void;
  onRefresh: () => Promise<void>;
}): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  // Spec 2026-09-29 Part 2: a deck of model prose leaves every list and count
  // for cards/archive/ — a move, so moving it back restores it.
  async function archive(d: DeckSummary): Promise<void> {
    const vault = useVaultStore.getState().currentVault;
    if (!vault) return;
    const i = decks.indexOf(d);
    try {
      await archiveDeck(vault.path, d.path);
      await useVaultStore.getState().refreshTree();
      await onRefresh();
      // Its row (and the button that held focus) is gone once the list repaints.
      requestAnimationFrame(() => refocusAfterArchive(i, document));
      notice.ok(t.st_archived.replace("{name}", d.name));
    } catch (err) {
      notice.warn(t.st_archive_failed, { sub: String(err) });
    }
  }
  return (
    <AppPage
      eyebrow={t.nav_tools}
      title={t.st_title}
      note={t.st_lede}
      // Refresh was a right-aligned row above the deck list; it is the page's
      // one action, so it belongs on the header row with every other page's.
      tools={
        decks.length === 0 ? undefined : (
          <Button variant="quiet" onClick={() => void onRefresh()}>
            <Icon name="revert" size={13} /> {t.st_refresh}
          </Button>
        )
      }
    >
      {decks.length === 0 ? (
        <div className="card" style={{ padding: 24, marginTop: 8 }}>
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            <Icon name="sparkles" size={16} />
            <b>{t.st_no_decks}</b>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            {t.st_generate_hint}
          </p>
          <button
            className="btn study-browse"
            style={{ marginTop: 12 }}
            onClick={() => setRoute("overview")}
          >
            {t.st_browse_pages}
          </button>
        </div>
      ) : (
        <div className="col" style={{ gap: 10, marginTop: 8 }}>
          {/* The same count and words as Home's line, so the two agree. */}
          {dueTotal > 0 ? (
            <div className="card study-today">
              <span className="study-today__count">
                {t.ritual_due.replace("{n}", String(dueTotal))}
              </span>
              <Button variant="primary" onClick={() => onOpen(TODAY_REVIEW)}>
                {t.ritual_start}
              </Button>
            </div>
          ) : null}
          {decks.map((d) => (
            <div key={d.path} className="card deck-row">
              <button
                type="button"
                className="deck-row__open"
                onClick={() => onOpen(d.path)}
              >
                <Icon name="book" size={18} />
                <span className="deck-row__name">{d.name}</span>
                <span className="muted deck-row__meta">
                  {(t.st_total ?? "{n} cards").replace("{n}", String(d.total))}
                </span>
                {d.ungrounded > 0 ? (
                  <span className="deck-flag" title={t.st_ungrounded_hint}>
                    {t.st_ungrounded.replace("{n}", String(d.ungrounded))}
                  </span>
                ) : null}
                {d.due > 0 ? (
                  <span className="study-due-pill">
                    {(t.st_due ?? "{n} due").replace("{n}", String(d.due))}
                  </span>
                ) : d.ungrounded > 0 ? null : (
                  <span className="muted deck-row__meta">{t.st_no_due}</span>
                )}
              </button>
              {d.ungrounded > 0 ? (
                <Button
                  variant="quiet"
                  className="deck-row__archive"
                  // Every row has one: the name says which deck it moves.
                  aria-label={`${t.st_archive}: ${d.name}`}
                  title={t.st_archive_hint}
                  onClick={() => void archive(d)}
                >
                  {t.st_archive}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </AppPage>
  );
}

function DeckStudy({
  t,
  vaultPath,
  deckPath,
  onBack,
}: {
  t: Strings;
  vaultPath: string;
  deckPath: string;
  onBack: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>("review");
  const [cards, setCards] = useState<Card[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const name = deckNameFromPath(deckPath);

  useEffect(() => {
    let alive = true;
    setCards(null);
    setReadFailed(false);
    void loadDeck(deckPath).then(
      (c) => { if (alive) setCards(c); },
      () => { if (alive) setReadFailed(true); },
    );
    return () => {
      alive = false;
    };
  }, [deckPath, readAttempt]);

  return (
    <AppPage
      eyebrow={t.nav_tools}
      title={name}
      // Back and the mode switch were their own row above the title; both are
      // page actions, so they join the header row every other page uses.
      tools={
        <>
          <Button variant="quiet" onClick={onBack}>
            <Icon name="arrowL" size={13} /> {t.st_all_decks}
          </Button>
          <Segment
            // The old .segmented had no accessible name at all. `q_mode` is
            // the existing generic "Mode" string — no new i18n key needed.
            label={t.q_mode}
            value={mode}
            onChange={setMode}
            options={[
              {
                value: "review",
                label: t.st_review,
                icon: <Icon name="book" size={12} />,
              },
              {
                value: "quiz",
                label: t.st_quiz,
                icon: <Icon name="spark" size={12} />,
              },
            ]}
          />
        </>
      }
    >
      {readFailed ? (
        <div role="alert" className="study-deck-error">
          <p>{t.st_deck_read_failed}</p>
          <Button onClick={() => setReadAttempt((attempt) => attempt + 1)}>{t.q_retry}</Button>
        </div>
      ) : cards === null ? (
        <p className="muted" style={{ paddingTop: 24 }}>
          {t.st_loading}
        </p>
      ) : mode === "review" ? (
        <ReviewSession
          t={t}
          vaultPath={vaultPath}
          decks={[{ path: deckPath, cards }]}
          onPersist={(d) => setCards(d.cards)}
        />
      ) : (
        <QuizSession t={t} vaultPath={vaultPath} cards={cards} />
      )}
    </AppPage>
  );
}

const GRADE_CLASS: Record<Grade, string> = {
  1: "grade-again",
  2: "grade-hard",
  3: "grade-good",
  4: "grade-easy",
};

function ReviewSession({
  t,
  vaultPath,
  decks,
  onPersist,
}: {
  t: Strings;
  vaultPath: string;
  decks: DeckCards[];
  /** A deck's cards after a grade, before the write to disk lands. */
  onPersist?: (deck: DeckCards) => void;
}): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const fine = useUIStore((s) => s.fineGrades);
  const grades = reviewGrades(fine);
  // Snapshot the due queue once when the session starts. Grading advances an
  // index through it; `current` holds each deck's latest cards, which a grade
  // is written into and the end screen reads the next review from. New cards
  // (no state) are always due — see cards.dueCards.
  const [queue] = useState(() => todayQueue(decks, today()));
  const [current, setCurrent] = useState(decks);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  // Deck writes run one after another in grade order: two grades of one deck
  // racing to disk could otherwise land the older file last.
  const writes = useRef<Promise<void>>(Promise.resolve());
  const rootRef = useRef<HTMLDivElement>(null);
  const flipRef = useRef<HTMLButtonElement>(null);
  const rememberedRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  // State, not a ref: the end screen shows before the last write fails.
  const [unsaved, setUnsaved] = useState(false);
  const total = queue.length;
  const item = queue[idx];

  function grade(g: Grade): void {
    const deck = item && current.find((d) => d.path === item.deck);
    if (!item || !deck) return;
    const updated = gradeCard(item.card, g, today());
    // Replace the graded card in its deck by identity (front is unique
    // within a deck), persist, and advance.
    const next = {
      path: deck.path,
      cards: deck.cards.map((c) => (c.front === item.card.front ? updated : c)),
    };
    setCurrent(current.map((d) => (d.path === next.path ? next : d)));
    onPersist?.(next);
    setRevealed(false);
    setIdx((i) => i + 1);
    writes.current = writes.current.then(() =>
      saveGrade(vaultPath, next.path, updated, item.card).then(
        (saved) => {
          if (!saved) {
            setUnsaved(true);
            notice.warn(t.st_deck_changed);
          }
        },
        (err: unknown) => {
          // The session goes on; the grade is in memory, not on disk.
          setUnsaved(true);
          notice.warn(studyDeckMessage(err, t));
        },
      ),
    );
  }

  const focusOn = reviewFocus(Boolean(item), revealed, idx);
  useEffect(() => {
    if (focusOn === "flip") flipRef.current?.focus();
    else if (focusOn === "remembered") rememberedRef.current?.focus();
    else if (focusOn === "done") doneRef.current?.focus();
  }, [focusOn, idx]);

  // The sidebar badge and Home count from the store: recount once this
  // session's writes land — at the end, and when it is left halfway.
  const ended = !item && total > 0;
  useEffect(() => {
    if (ended) void writes.current.then(() => useStudyStore.getState().refresh());
  }, [ended]);
  useEffect(() => {
    const pending = writes;
    return () => void pending.current.then(() => useStudyStore.getState().refresh());
  }, []);

  // Re-subscribed every render so the handler sees this render's card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!item) return;
      // The pane Study is in: a split's other pane has keys of its own.
      const root = rootRef.current;
      const act = reviewKey(e, revealed, grades, {
        root: root?.closest(".workspace-pane, .route-fade") ?? root,
        split: useUIStore.getState().splitRoute !== null,
      });
      if (act === null) return;
      e.preventDefault();
      if (act === "reveal") setRevealed(true);
      else grade(act);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!item) {
    const upcoming = nextReview(current, today());
    const next = upcoming
      ? t.st_next_review
          .replace("{when}", whenLabel(daysBetween(today(), upcoming.date), lang))
          .replace("{n}", String(upcoming.count))
      : null;
    return (
      <AllDone
        t={t}
        reviewed={total || undefined}
        next={unsaved ? t.st_save_failed : next}
        celebrate={total > 0 && !unsaved}
        doneRef={doneRef}
      />
    );
  }

  const card = item.card;
  const gradeLabel = (g: Grade): string =>
    fine
      ? [t.st_grade_again, t.st_grade_hard, t.st_grade_good, t.st_grade_easy][g - 1]
      : g === 1
        ? t.st_grade_forgot
        : t.st_grade_remembered;
  return (
    <div ref={rootRef} className="col" style={{ gap: 16, marginTop: 8 }}>
      <div className="muted" style={{ fontSize: 12.5 }}>
        {(t.st_progress ?? "{done} / {total}")
          .replace("{done}", String(idx + 1))
          .replace("{total}", String(total))}
      </div>
      <div className="card study-card" style={{ padding: 28, minHeight: 160 }}>
        <div className="study-front">{card.front}</div>
        {revealed ? (
          <>
            <hr className="study-sep" />
            <div className="study-back">{card.back}</div>
            {card.sourceRef ? (
              <div className="muted study-src" style={{ marginTop: 12 }}>
                <Icon name="quote" size={12} /> {t.st_source}:{" "}
                <SourceLink sourceRef={card.sourceRef} />
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {revealed ? (
        <div className="row study-grades" style={{ gap: 8 }}>
          {grades.map((g, i) => (
            <button
              key={g}
              ref={g === 3 ? rememberedRef : undefined}
              className={`btn study-grade ${GRADE_CLASS[g]}`}
              aria-keyshortcuts={String(i + 1)}
              onClick={() => grade(g)}
            >
              <span>{gradeLabel(g)}</span>
              <span className="study-grade__next">
                {intervalLabel(card, g, today(), lang)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <button
          ref={flipRef}
          className="btn btn-primary study-flip"
          aria-keyshortcuts="Space"
          onClick={() => setRevealed(true)}
        >
          {t.st_flip}
        </button>
      )}
      <p className="muted study-keys">
        {t.st_keys_hint.replace("{n}", String(grades.length))}
      </p>
    </div>
  );
}

/** A card's `[[stem#Heading]]` as a link that opens the note at that
 *  heading; any other source (a `[^src-*]` citation) stays plain text. */
function SourceLink({ sourceRef }: { sourceRef: string }): JSX.Element {
  // Subscribed to the tree so the link turns live once it has loaded.
  useVaultStore((s) => s.fileTree);
  const resolve = useVaultStore((s) => s.resolveWikilink);
  const ref = parseSourceRef(sourceRef);
  const path = ref ? resolve(ref.stem) : null;
  if (!ref || !path) return <span>{sourceRef}</span>;
  return (
    <button
      type="button"
      className="study-src-link"
      onClick={() => {
        if (ref.heading) setPendingAnchor(path, ref.heading);
        useUIStore.getState().setRoute(`page:${path}`);
      }}
    >
      {ref.heading ? `${ref.stem} › ${ref.heading}` : ref.stem}
    </button>
  );
}

function AllDone({
  t,
  reviewed,
  next,
  celebrate,
  doneRef,
}: {
  t: Strings;
  reviewed?: number;
  /** "Next review tomorrow: 3 due", or null when nothing is scheduled. */
  next: string | null;
  /** A session just ended with every grade saved: MYCO celebrates once.
   *  Nothing due, or a failed save, is no occasion. */
  celebrate?: boolean;
  /** Takes focus after the last grade, so it is read out, not lost. */
  doneRef?: RefObject<HTMLDivElement>;
}): JSX.Element {
  return (
    <div
      ref={doneRef}
      tabIndex={-1}
      className="card study-done"
      style={{ padding: 32, marginTop: 16 }}
    >
      {celebrate ? (
        // The clip frame keeps room around the character; -12px lines the
        // character up with the title's check mark.
        <div style={{ margin: "0 0 8px -12px" }}>
          <MascotClip {...SURFACE_CLIPS.studyDone} />
        </div>
      ) : null}
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <Icon name="check" size={18} />
        <b>{t.st_all_done}</b>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        {reviewed
          ? (t.st_done_sub ?? "Reviewed {n} cards.").replace(
              "{n}",
              String(reviewed),
            )
          : t.st_no_due}
      </p>
      {next ? <p className="study-next">{next}</p> : null}
    </div>
  );
}

/** Distractor pool for the extractive quiz: the bold and wikilinked terms of
 *  the notes the deck's cards came from — a wikilink there names a
 *  neighbouring note. A note that is gone or unreadable adds nothing. */
async function notesTerms(cards: Card[]): Promise<string[]> {
  const resolve = useVaultStore.getState().resolveWikilink;
  const stems = new Set(cards.flatMap((c) => parseSourceRef(c.sourceRef)?.stem ?? []));
  const pools = await Promise.all(
    [...stems].map(async (stem) => {
      const path = resolve(stem);
      if (!path) return [];
      try {
        return termsOf((await ipc.readFile(path)).raw);
      } catch {
        return []; // the quiz still runs on the deck's own terms
      }
    }),
  );
  return pools.flat();
}

function QuizSession({
  t,
  vaultPath,
  cards,
}: {
  t: Strings;
  vaultPath: string;
  cards: Card[];
}): JSX.Element {
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);

  // The opt-in model path reads the deck's own cards as its source note.
  const sourceMarkdown = useMemo(
    () => cards.map((c) => `${c.front}\n${c.back} ${c.sourceRef}`).join("\n\n"),
    [cards],
  );

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const useModel = await modelStudyOn(useUIStore.getState().aiCards);
      const q = useModel
        ? await generateQuotedQuiz(vaultPath, sourceMarkdown, 5)
        : quizFromCards(cards, await notesTerms(cards));
      if (q.length === 0) {
        setError(useModel ? t.st_quiz_empty : t.st_quiz_none);
      } else {
        setQuestions(q);
        setIdx(0);
        setPicked(null);
        setScore(0);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (cards.length === 0) {
    return (
      <p className="muted" style={{ paddingTop: 24 }}>
        {t.st_quiz_needs_cards}
      </p>
    );
  }

  if (!questions) {
    return (
      <div className="card" style={{ padding: 24, marginTop: 8 }}>
        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          {t.st_quiz_intro}
        </p>
        {error ? (
          <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p>
        ) : null}
        <button
          className="btn btn-primary"
          onClick={() => void generate()}
          disabled={busy}
        >
          {busy ? t.st_generating : t.st_gen_quiz}
        </button>
      </div>
    );
  }

  if (idx >= questions.length) {
    return (
      <div className="card study-done" style={{ padding: 32, marginTop: 16 }}>
        <div className="row" style={{ gap: 8, marginBottom: 6 }}>
          <Icon name="check" size={18} />
          <b>{t.st_quiz_done}</b>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          {(t.st_quiz_score ?? "Score: {score} / {total}")
            .replace("{score}", String(score))
            .replace("{total}", String(questions.length))}
        </p>
        <button
          className="btn"
          style={{ marginTop: 12 }}
          onClick={() => setQuestions(null)}
        >
          {t.st_gen_quiz}
        </button>
      </div>
    );
  }

  const q = questions[idx];
  const answered = picked !== null;
  return (
    <div className="col" style={{ gap: 16, marginTop: 8 }}>
      <div className="muted" style={{ fontSize: 12.5 }}>
        {(t.st_progress ?? "{done} / {total}")
          .replace("{done}", String(idx + 1))
          .replace("{total}", String(questions.length))}
      </div>
      <div className="card" style={{ padding: 24 }}>
        <div style={{ fontWeight: 600, marginBottom: 14 }}>{q.question}</div>
        <div className="col" style={{ gap: 8 }}>
          {q.choices.map((choice, i) => {
            const isCorrect = i === q.answer;
            const cls = answered
              ? isCorrect
                ? " quiz-correct"
                : i === picked
                  ? " quiz-wrong"
                  : ""
              : "";
            return (
              <button
                key={i}
                className={"btn quiz-choice" + cls}
                style={{ justifyContent: "flex-start", textAlign: "left" }}
                disabled={answered}
                onClick={() => {
                  setPicked(i);
                  if (isCorrect) setScore((s) => s + 1);
                }}
              >
                {choice}
              </button>
            );
          })}
        </div>
        {answered ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              {picked === q.answer ? (
                <b style={{ color: "var(--ok)" }}>{t.st_correct}</b>
              ) : (
                <b style={{ color: "var(--danger)" }}>{t.st_wrong}</b>
              )}
            </div>
            {q.explanation ? (
              <p className="muted" style={{ fontSize: 12.5 }}>
                {q.explanation}
              </p>
            ) : null}
            {q.sourceRef ? (
              <div className="muted study-src" style={{ marginTop: 6 }}>
                <Icon name="quote" size={11} /> {t.st_source}:{" "}
                <SourceLink sourceRef={q.sourceRef} />
              </div>
            ) : null}
            <button
              className="btn btn-primary"
              style={{ marginTop: 12 }}
              onClick={() => {
                setPicked(null);
                setIdx((i) => i + 1);
              }}
            >
              {t.st_next}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
