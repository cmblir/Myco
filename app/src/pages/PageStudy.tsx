// PageStudy — the spaced-repetition study route. Lists decks (cards/<deck>.md)
// with due counts, runs a due-card review loop (front → reveal → grade → FSRS
// advance → persist), and a generated multiple-choice quiz mode. All state
// round-trips to plain markdown on disk via the card store.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import { useStudyStore, today } from "../stores/studyStore";
import { dueCards, gradeCard, type Card } from "../lib/cards";
import type { Grade } from "../lib/fsrs";
import { loadDeck, saveDeck, deckNameFromPath } from "../lib/cardStore";
import { generateQuiz, type QuizQuestion } from "../lib/study";
import AppPage from "../components/AppPage";
import { Button, Segment } from "../components/ui";

type Mode = "review" | "quiz";

export default function PageStudy({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const decks = useStudyStore((s) => s.decks);
  const refresh = useStudyStore((s) => s.refresh);
  const [deckPath, setDeckPath] = useState<string | null>(null);

  // Ritual-card deep link (Q4 item 11): consume uiStore.studyDeck once on
  // mount and clear it, so the next plain Study visit starts at the deck list.
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

  if (!deckPath) {
    return (
      <DeckList t={t} decks={decks} onOpen={setDeckPath} onRefresh={refresh} />
    );
  }
  return (
    <DeckStudy
      key={deckPath}
      t={t}
      vaultPath={currentVault?.path ?? ""}
      deckPath={deckPath}
      onBack={() => {
        setDeckPath(null);
        void refresh();
      }}
    />
  );
}

function DeckList({
  t,
  decks,
  onOpen,
  onRefresh,
}: {
  t: Strings;
  decks: ReturnType<typeof useStudyStore.getState>["decks"];
  onOpen: (path: string) => void;
  onRefresh: () => Promise<void>;
}): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  return (
    <AppPage
      eyebrow={t.nav_study}
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
            className="btn"
            style={{ marginTop: 12 }}
            onClick={() => setRoute("overview")}
          >
            {t.st_browse_pages}
          </button>
        </div>
      ) : (
        <div className="col" style={{ gap: 10, marginTop: 8 }}>
          {decks.map((d) => (
            <button
              key={d.path}
              className="card deck-row"
              style={{
                padding: 16,
                display: "flex",
                alignItems: "center",
                gap: 12,
                textAlign: "left",
                cursor: "pointer",
              }}
              onClick={() => onOpen(d.path)}
            >
              <Icon name="book" size={18} />
              <span style={{ flex: 1, fontWeight: 600 }}>{d.name}</span>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {(t.st_total ?? "{n} cards").replace("{n}", String(d.total))}
              </span>
              {d.due > 0 ? (
                <span className="study-due-pill">
                  {(t.st_due ?? "{n} due").replace("{n}", String(d.due))}
                </span>
              ) : (
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {t.st_no_due}
                </span>
              )}
            </button>
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
  const name = deckNameFromPath(deckPath);

  useEffect(() => {
    let alive = true;
    void loadDeck(deckPath).then((c) => {
      if (alive) setCards(c);
    });
    return () => {
      alive = false;
    };
  }, [deckPath]);

  return (
    <AppPage
      eyebrow={t.nav_study}
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
      {cards === null ? (
        <p className="muted" style={{ paddingTop: 24 }}>
          {t.st_loading}
        </p>
      ) : mode === "review" ? (
        <ReviewSession
          t={t}
          vaultPath={vaultPath}
          deckName={name}
          cards={cards}
          onPersist={setCards}
        />
      ) : (
        <QuizSession t={t} vaultPath={vaultPath} cards={cards} />
      )}
    </AppPage>
  );
}

function ReviewSession({
  t,
  vaultPath,
  deckName,
  cards,
  onPersist,
}: {
  t: Strings;
  vaultPath: string;
  deckName: string;
  cards: Card[];
  onPersist: (cards: Card[]) => void;
}): JSX.Element {
  // Snapshot the due queue once when the session starts. Grading advances an
  // index through this queue; the full `cards` list is the mutation target we
  // persist. New cards (no state) are always due — see cards.dueCards.
  const [queue] = useState<Card[]>(() => dueCards(cards, today()));
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const total = queue.length;

  async function grade(g: Grade): Promise<void> {
    const card = queue[idx];
    const updated = gradeCard(card, g, today());
    // Replace the graded card in the full list by identity (front is unique
    // within a deck), persist, and advance.
    const next = cards.map((c) => (c.front === card.front ? updated : c));
    onPersist(next);
    try {
      await saveDeck(vaultPath, deckName, next);
    } catch {
      /* surfaced via the vault store elsewhere; keep the session usable */
    }
    setRevealed(false);
    setIdx((i) => i + 1);
  }

  if (total === 0) {
    return <AllDone t={t} />;
  }
  if (idx >= total) {
    return <AllDone t={t} reviewed={total} />;
  }

  const card = queue[idx];
  return (
    <div className="col" style={{ gap: 16, marginTop: 8 }}>
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
                <Icon name="quote" size={12} /> {t.st_source}: {card.sourceRef}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {revealed ? (
        <div className="row study-grades" style={{ gap: 8 }}>
          <button className="btn grade-again" onClick={() => void grade(1)}>
            {t.st_grade_again}
          </button>
          <button className="btn grade-hard" onClick={() => void grade(2)}>
            {t.st_grade_hard}
          </button>
          <button className="btn grade-good" onClick={() => void grade(3)}>
            {t.st_grade_good}
          </button>
          <button className="btn grade-easy" onClick={() => void grade(4)}>
            {t.st_grade_easy}
          </button>
        </div>
      ) : (
        <button
          className="btn btn-primary study-flip"
          onClick={() => setRevealed(true)}
        >
          {t.st_flip}
        </button>
      )}
    </div>
  );
}

function AllDone({
  t,
  reviewed,
}: {
  t: Strings;
  reviewed?: number;
}): JSX.Element {
  return (
    <div className="card study-done" style={{ padding: 32, marginTop: 16 }}>
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
    </div>
  );
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

  // Feed the deck's own cards to the generator as the source note — they are
  // already summarized, cited facts, so the quiz stays grounded and offline.
  const sourceMarkdown = useMemo(
    () => cards.map((c) => `${c.front}\n${c.back} ${c.sourceRef}`).join("\n\n"),
    [cards],
  );

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const q = await generateQuiz(vaultPath, sourceMarkdown, 5);
      if (q.length === 0) {
        setError(t.st_quiz_empty ?? "No questions generated.");
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
          <p style={{ color: "#dc2626", fontSize: 13 }}>{error}</p>
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
                <b style={{ color: "#16a34a" }}>{t.st_correct}</b>
              ) : (
                <b style={{ color: "#dc2626" }}>{t.st_wrong}</b>
              )}
            </div>
            {q.explanation ? (
              <p className="muted" style={{ fontSize: 12.5 }}>
                {q.explanation}
              </p>
            ) : null}
            {q.sourceRef ? (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                <Icon name="quote" size={11} /> {t.st_source}: {q.sourceRef}
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
