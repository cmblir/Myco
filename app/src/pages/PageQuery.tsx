// Ask in plain language, with source links beside each answer. Search scope
// stays close to the question; model details, profile hints and ranking
// controls are optional. queryStore owns in-flight work across navigation.

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  askCopy,
  reasksOf,
  useQueryStore,
  type AskOpts,
  type ChatTurn,
} from "../stores/queryStore";
import type { ScoredChunk, TierWeights } from "../lib/ipc";
import { consumeQueryPrefill } from "../lib/queryPrefill";
import MascotClip from "../components/MascotClip";
import { SURFACE_CLIPS } from "../lib/mascotClips";
import { flattenMarkdown, stem } from "../lib/graphData";
import { displayName } from "../lib/displayName";
import { RELEVANCE_FLOOR } from "../lib/chat";
import { confidenceBand, sourceTier, type Citation } from "../lib/extractive";
import { ladderOf } from "../lib/ladder";
import Viewer from "../components/Viewer";
import AgentPanel from "../components/AgentPanel";
import AudioOverviewPanel from "../components/AudioOverviewPanel";
import { useAudioStore } from "../stores/audioStore";
import ThinkingGalaxy from "../components/ThinkingGalaxy";
import MiniGalaxy from "../components/MiniGalaxy";
import type { GalaxyLink, GalaxyNode } from "../components/MiniGalaxy";
import NodePreview from "../components/NodePreview";
import RetrievalStepper from "../components/RetrievalStepper";
import AbstainCard from "../components/AbstainCard";
import AskHistory from "../components/AskHistory";
import AskScopePicker from "../components/AskScope";
import { extractWikilinks } from "../lib/askHistory";
import SourceLadder, {
  TierPriorPanel,
  bandLabel,
  scopeLabel,
  tierLabel,
} from "../components/SourceLadder";
import { isComposingKey } from "../lib/ime";
import { captureToDaily, openCaptured, questionLine, type Captured } from "../lib/dailyNote";
import { loadProfile } from "../lib/profile";
import AppPage from "../components/AppPage";
import { Segment } from "../components/ui";
import { wikilinkBase } from "../lib/wikilinks";
import {
  answerMarkdown,
  passageSection,
  plainPassage,
  setReaderIntent,
} from "../lib/askLoop";
import { passageBlock } from "../lib/recallText";
import { useNoteInsertStore } from "../stores/noteInsertStore";
import { notice } from "../lib/notice";
import { INTAKE_COPY } from "../lib/intakeCopy";
import { BUILTIN_CHAT_MODEL } from "../lib/providers";
import { formatTicker } from "../lib/time";
import "../styles/intake.css";

/** Dismissible flag for the "set up your profile" hint below — same
 *  try/catch-guarded localStorage pattern as `App.tsx`'s onboarding flag
 *  (localStorage can be unavailable or full). */
const PROFILE_HINT_DISMISSED_KEY = "myco.profileHint.dismissed";

/** Pages an extractive answer quotes — formatExtractiveAnswer's `maxPages`,
 *  so the pills and the markdown answer (provider history) agree. */
const QUOTED_PAGES = 5;
/** Sources the rail lists; the rest open in a side sheet (UX S33). */
const RAIL_SOURCES = 3;

function localFallbackCopy(t: Strings, reason: NonNullable<ChatTurn["localFallback"]>): string {
  switch (reason) {
    case "status_timeout":
    case "time_budget":
      return t.q_local_fallback_timeout;
    case "model_unavailable":
      return t.q_local_fallback_unavailable;
    case "prompt_unavailable":
      return t.q_local_fallback_prompt;
    case "index_stale":
      return askCopy(t).extractiveStale;
    case "retrieval_failed":
      return askCopy(t).extractiveFailed;
    case "answer_incomplete":
      return t.q_local_fallback_incomplete;
    case "answer_rejected":
    case "response_rejected":
      return t.q_local_fallback_rejected;
    case "generation_failed":
    case "status_failed":
    case "synthesis_failed":
      return t.q_local_fallback_failed;
  }
}

export default function PageQuery({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const isOpeningVault = useVaultStore((s) => s.isOpeningVault);
  const fileTree = useVaultStore((s) => s.fileTree);
  const adjacency = useVaultStore((s) => s.adjacency);
  const openWikilink = useVaultStore((s) => s.openWikilink);
  const setRoute = useUIStore((s) => s.setRoute);
  const setSettingsTab = useUIStore((s) => s.setSettingsTab);
  const setCmdOpen = useUIStore((s) => s.setCmdOpen);
  const route = useUIStore((s) => s.route);
  const splitRoute = useUIStore((s) => s.splitRoute);
  const lang = useUIStore((s) => s.lang);
  const copy = INTAKE_COPY[lang];
  const questionRef = useRef<HTMLInputElement>(null);
  const askScope = useUIStore((s) => s.askScope);
  const setAskScope = useUIStore((s) => s.setAskScope);
  const weights = useUIStore((s) => s.askTierWeights);
  const setAskTierWeights = useUIStore((s) => s.setAskTierWeights);
  const settings = useSettingsStore((s) => s.settings);
  const [mode, setMode] = useState<"ask" | "agent">("ask");
  const [q, setQ] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Turn whose answer was just copied — its button reads "Copied" for a moment.
  const [copied, setCopied] = useState<number | null>(null);
  const turns = useQueryStore((s) => s.turns);
  const busy = useQueryStore((s) => s.busy);
  const startedAt = useQueryStore((s) => s.startedAt);
  const stage = useQueryStore((s) => s.stage);
  const askStore = useQueryStore((s) => s.ask);
  const harvest = useQueryStore((s) => s.harvest);
  const note = useQueryStore((s) => s.note);
  const retry = useQueryStore((s) => s.retry);
  const stop = useQueryStore((s) => s.stop);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!busy || startedAt === null || mode !== "ask") return;
    setNow(performance.now());
    const id = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(id);
  }, [busy, startedAt, mode]);
  const elapsed = busy && startedAt !== null
    ? t.q_elapsed.replace("{time}", formatTicker(now - startedAt))
    : undefined;
  const history = useQueryStore((s) => s.history);
  const historyError = useQueryStore((s) => s.historyError);
  const loadHistory = useQueryStore((s) => s.loadHistory);
  // A note of another vault (switched since) scopes nothing here.
  const noteScope = useQueryStore((s) =>
    currentVault && s.noteScope?.path.startsWith(`${currentVault.path}/`) ? s.noteScope : null,
  );
  const setNoteScope = useQueryStore((s) => s.setNoteScope);
  const lastTurnRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  // The composer is under the answers (UX S32): below the screen, a ↓ button
  // brings it back. Pinned in a narrow column, it never is.
  const [composerBelow, setComposerBelow] = useState(false);
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) =>
      setComposerBelow(!e.isIntersecting && e.boundingClientRect.top > 0),
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // "Set up your profile" hint (Phase B, Task 5): checked per vault, plus
  // whenever either pane's route changes (final-review item 10). Normal
  // navigation already re-checks for free — the primary pane is keyed by
  // route, so coming back from Settings remounts this page — but in SPLIT
  // view this page stays mounted while the profile editor saves in the other
  // pane; re-running on route/splitRoute catches leaving Settings there. A
  // profile saved externally (MCP) while sitting on Ask is still unseen
  // until any navigation — accepted, nothing short of polling covers it.
  const [needsProfile, setNeedsProfile] = useState(false);
  const [hintDismissed, setHintDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PROFILE_HINT_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const vaultPath = currentVault?.path;
    if (!vaultPath) return;
    let cancelled = false;
    void loadProfile(vaultPath).then((p) => {
      if (!cancelled) setNeedsProfile(p === null);
    });
    return () => {
      cancelled = true;
    };
  }, [currentVault?.path, route, splitRoute]);
  function dismissProfileHint(): void {
    try {
      localStorage.setItem(PROFILE_HINT_DISMISSED_KEY, "1");
    } catch {
      /* localStorage unavailable */
    }
    setHintDismissed(true);
  }

  // The 기록 list (UX S36), read from this device's log per vault.
  useEffect(() => {
    if (!isOpeningVault) void loadHistory();
  }, [currentVault?.path, isOpeningVault, loadHistory]);

  // A surface elsewhere (e.g. the graph's gap panel, ⌘K) may have drafted a
  // question for us — consume it once on mount, into a focused composer.
  useEffect(() => {
    consumeQueryPrefill(setQ, () => questionRef.current?.focus());
  }, []);
  // "Ask this note" (UX S37) lands in the composer, ready for the question —
  // also when Ask is already open beside the note.
  useEffect(() => {
    if (noteScope) requestAnimationFrame(() => questionRef.current?.focus());
  }, [noteScope]);

  // stem (lowercased filename minus extension) → absolute path; mirrors the
  // Rust link resolver, so answer citations resolve like real wikilinks.
  const stemMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of flattenMarkdown(fileTree))
      map.set(stem(p).toLowerCase(), p);
    return map;
  }, [fileTree]);

  // The pages retrieval chose, carried on the `thinking` stage — the model call
  // is the long wait, and "these are the notes it is answering from" is exactly
  // what a user wants to see during it.
  const retrieved = stage?.kind === "thinking" ? stage.stems : [];
  // Before retrieval has chosen anything there is nothing true to show, so the
  // animation runs on the vault's hubs — a backdrop, not a claim.
  const backdropPages = useMemo(
    () => [...stemMap.keys()].slice(0, 18),
    [stemMap],
  );
  const thinkingPages = retrieved.length ? retrieved : backdropPages;
  const thinkingLabel = ((): string => {
    if (stage?.kind === "thinking") {
      // Name the pages it is answering FROM when it has them — that is the
      // question this wait actually raises, and the model call is the long
      // part, so this is the label a user reads.
      return retrieved.length
        ? (t.q_answering_from ?? "answering from {n} pages…").replace(
            "{n}",
            String(retrieved.length),
          )
        : (t.q_answering ?? "answering…");
    }
    // "searching the wiki…" is a claim, so it is only made while retrieval is
    // ACTUALLY running. With no index there is nothing to search and no
    // retrieving stage is ever reported — saying it anyway (the old default)
    // described work that was not happening.
    if (stage?.kind === "retrieving")
      return t.q_thinking ?? "searching the wiki…";
    return t.q_answering ?? "answering…";
  })();

  const openByStem = (target: string): void => {
    const base = wikilinkBase(target);
    if (!base) return;
    const abs = stemMap.get(base.toLowerCase());
    if (abs) {
      setRoute(`page:${abs}`);
      return;
    }
    // Unresolved link: create the note and open it, instead of a silent no-op.
    void openWikilink(base).then((p) => {
      if (p) setRoute(`page:${p}`);
    });
  };
  // Vault-relative page (as retrieval hits carry it) → open in the reader;
  // with the quoted passage, the reader opens AT it (scrolled to, flashed).
  const openPage = (page: string, passage?: Passage): void => {
    if (!currentVault) return;
    const abs = `${currentVault.path}/${page}`;
    if (passage) setReaderIntent(abs, { kind: "show", ...passage });
    setRoute(`page:${abs}`);
  };
  // "Quote in note": into the open note at its caret (a note beside Ask in
  // the split pane), else appended to the last-opened note, else to the note
  // the user now picks in the ⌘K palette. Never a raw/ file.
  const quoteIntoNote = (block: string): void => {
    const insert = useNoteInsertStore.getState().insert;
    if (insert) return insert(block, true);
    const last = useVaultStore.getState().activeFile?.path;
    const root = currentVault ? `${currentVault.path}/` : "";
    if (
      last &&
      /\.md$/i.test(last) &&
      last.startsWith(root) &&
      !last.startsWith(`${root}raw/`)
    ) {
      setReaderIntent(last, { kind: "append", block });
      setRoute(`page:${last}`);
      return;
    }
    // The palette settles it: the note a row opens (a new one too) takes the
    // block; closing it any other way drops it (CommandBar, settlePick).
    setReaderIntent(null, { kind: "append", block });
    notice.info(t.q_quote_pick_note);
    setCmdOpen(true);
  };
  // The abstain card's re-asks: none while another question runs.
  const reask = (q: string, opts: AskOpts | undefined): (() => void) | undefined =>
    busy || !opts ? undefined : () => void askStore(q, lang, askCopy(t), opts);
  // Both recall-miss buttons (the abstain card's harvest, an answer's "not
  // what you expected"): the turn's `harvested` flag is the receipt, a failed
  // write says so and leaves the button live.
  const logMiss = (i: number): void => {
    harvest(i).catch((e: unknown) => notice.warn(t.q_miss_failed, { sub: String(e) }));
  };
  // The abstain card's "write it down" (UX S30): the question, as "질문: …",
  // through Home's capture path and its toast, whose Open shows the line.
  const writeDown = (question: string): Promise<Captured | null> =>
    captureToDaily(questionLine(question, t), t);
  // Written, the card's done button opens the note on that line: the
  // toast's Open is gone in four seconds.
  const openNoted = (written: Captured | undefined): (() => void) | undefined =>
    written && currentVault ? () => void openCaptured(currentVault.path, written) : undefined;
  const copyAnswer = (i: number, md: string): void => {
    navigator.clipboard.writeText(md).then(
      () => {
        setCopied(i);
        window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1500);
      },
      () => notice.warn(t.q_copy_failed),
    );
  };

  const motion = (): ScrollBehavior =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  useEffect(() => {
    // A new question: its turn at the top, so its answer reads from the first
    // passage (UX S32). Nothing to follow on arrival with no turns.
    if (turns.length === 0) return;
    lastTurnRef.current?.scrollIntoView({ behavior: motion(), block: "start" });
  }, [turns.length]);
  // Quoted passages beside their source ladder (not abstained, has hits).
  const laddered = (turn: ChatTurn): boolean =>
    !turn.abstained && !turn.localModel && Boolean(turn.hits?.length && currentVault);
  const stepperOf = (turn: ChatTurn, i: number): JSX.Element | null =>
    turn.trace ? (
      <RetrievalStepper
        t={t}
        trace={turn.trace}
        archivedOn={settings?.search_archived_sessions ?? false}
        lang={lang}
        id={`ask-trace-${i}`}
      />
    ) : null;
  const toComposer = (): void => {
    composerRef.current?.scrollIntoView({ behavior: motion(), block: "end" });
    questionRef.current?.focus({ preventScroll: true });
  };

  // The chat logic (activity routing, extractive path, provider call) lives in
  // queryStore.ask so it keeps running when this page unmounts. The page only
  // hands over the localized copy the store bakes into turns.
  async function ask(): Promise<void> {
    const question = q.trim();
    if (!question || !currentVault || busy || isOpeningVault) return;
    setQ("");
    await askStore(question, lang, askCopy(t), noteScope ? { note: noteScope } : undefined);
  }

  return (
    <AppPage
      // Asking, the page is the conversation: the head folds (UX S32).
      className={mode === "ask" && turns.length ? "is-asking" : undefined}
      eyebrow={t.nav_workspace}
      title={t.q_title}
      note={mode === "agent" ? (t.ag_lede ?? t.q_lede) : copy.askDescription}
      tools={
        <Segment
          label={t.q_mode ?? "Mode"}
          value={mode}
          onChange={setMode}
          options={[
            {
              value: "ask",
              label: t.q_mode_ask ?? "Ask",
              icon: <Icon name="msg" size={12} />,
            },
            {
              value: "agent",
              label: t.q_mode_agent ?? "Agent",
              icon: <Icon name="terminal" size={12} />,
            },
          ]}
        />
      }
    >
      {mode === "agent" ? (
        <AgentPanel t={t} />
      ) : (
        <AskHistory
          t={t}
          lang={lang}
          records={history}
          error={historyError}
          onOpenStem={openByStem}
        />
      )}

      {/* Turns, then the composer under them (UX S32); a fresh page has the
          composer first and its examples below, as before. The container is
          what the narrow rules measure: a split pane is narrow too. */}
      <div className="ask-flow">
        {turns.length ? (
          <div
            className="col"
            style={{
              marginTop: 12,
              marginBottom: 16,
              gap: 16,
              display: mode === "agent" ? "none" : "flex",
            }}
          >
            {turns.map((turn, i) => (
              <div
                key={i}
                ref={i === turns.length - 1 ? lastTurnRef : undefined}
                className="card ask-turn"
              >
                <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
                  <span className="typebadge">
                    <span
                      className="tb-dot"
                      style={{ background: "var(--ink)" }}
                    ></span>
                    {t.q_you ?? "you"}
                  </span>
                  <span style={{ fontWeight: 500 }}>{turn.q}</span>
                  {turn.note ? (
                    <span className="chip" title={turn.note.path}>
                      {t.q_note_scope_chip.replace("{note}", turn.note.title)}
                    </span>
                  ) : turn.scope ? (
                    <span className="chip">
                      {t.q_scope_chip.replace("{scope}", scopeLabel(t, turn.scope))}
                    </span>
                  ) : null}
                  {turn.followUp ? (
                    // Retrieval ran with the previous question in front (A2).
                    <span className="chip">
                      <Icon name="chevL" size={11} /> {t.q_followup_chip}
                    </span>
                  ) : null}
                  {turn.range ? (
                    // Time-aware Ask (mockup M5-c): the parsed window, promoted to
                    // a chip so the applied filter is visible, not implicit.
                    <span className="chip">
                      <Icon name="history" size={11} />{" "}
                      {(t.q_range_chip ?? "Period: {s} – {e}")
                        .replace("{s}", turn.range.start)
                        .replace("{e}", turn.range.end)}
                    </span>
                  ) : null}
                  {turn.localModel ? (
                    <span className="chip">{turn.localModel} · {t.s_provider_kind_local}</span>
                  ) : null}
                </div>
                {/* An answer with a ladder shows the stepper under the
                    ladder's own "search details" (UX S32: one per answer). */}
                {turn.trace && !laddered(turn) ? (
                  <details className="intake-disclosure ask-search-details">
                    <summary>{copy.searchDetails}</summary>
                    {stepperOf(turn, i)}
                  </details>
                ) : null}
                {turn.localFallback && turn.extractive && turn.a && !turn.localModel &&
                  !turn.error && !turn.stopped && !turn.abstained ? (
                  <div className="col" data-testid="ask-local-fallback" style={{ gap: 8, marginBlock: "0.75rem" }}>
                    <p className="muted" role="status" style={{ margin: 0, fontSize: "0.8125rem" }}>
                      {localFallbackCopy(t, turn.localFallback)}
                    </p>
                    {i === turns.length - 1 ? (
                      <button
                        type="button"
                        className="btn"
                        style={{ alignSelf: "flex-start", minHeight: "2.75rem" }}
                        disabled={busy || isOpeningVault || !currentVault}
                        onClick={() => void retry(i, lang, askCopy(t))}
                      >
                        {t.q_retry}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {turn.abstained ? (
                  // Abstention is the answer: the card, never a quoted passage.
                  // Its re-asks run the same question once, wider — over every
                  // scope, or without its period. The saved scope segment stays
                  // where the user put it.
                  <AbstainCard
                    t={t}
                    id={`ask-turn-${i}`}
                    indexedPages={turn.trace?.indexedPages ?? null}
                    floor={turn.floor ?? RELEVANCE_FLOOR}
                    misses={turn.nearMisses ?? []}
                    harvested={turn.harvested ?? false}
                    onHarvest={turn.followUp ? undefined : () => logMiss(i)}
                    noted={turn.noted ?? false}
                    onNote={turn.followUp ? undefined : () => void note(i, writeDown)}
                    onOpenNoted={openNoted(turn.notedIn)}
                    range={turn.range}
                    explanation={turn.abstainExplanation}
                    onWiden={reask(turn.q, reasksOf(turn).widen)}
                    onDropRange={reask(turn.q, reasksOf(turn).dropRange)}
                  />
                ) : laddered(turn) ? (
                  <ExtractiveAnswer
                    t={t}
                    id={`ask-turn-${i}`}
                    turn={turn}
                    weights={weights}
                    onOpenByStem={openByStem}
                    onOpenPage={openPage}
                    onQuote={quoteIntoNote}
                    searchDetails={stepperOf(turn, i)}
                  />
                ) : (
                  <div className="prose" style={{ marginTop: 8 }}>
                    {turn.error ? (
                      <>
                        <p style={{ color: "var(--danger)" }}>{turn.error}</p>
                        {/* Same question, same scope, in this turn's place: the
                            last turn only, whose context is the turns above it. */}
                        {i === turns.length - 1 ? (
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={() => void retry(i, lang, askCopy(t))}
                          >
                            {t.q_retry}
                          </button>
                        ) : null}
                      </>
                    ) : turn.stopped ? (
                      <div className="ask-stopped" role="status">
                        <b aria-hidden="true">■</b>
                        <span>
                          <strong>{t.q_stopped}</strong> · {t.q_stopped_sub}
                        </span>
                      </div>
                    ) : turn.a ? (
                      <Viewer content={turn.a} onLinkClick={openByStem} displayNames />
                    ) : (
                      <ThinkingGalaxy pages={thinkingPages} label={thinkingLabel}
                        elapsed={i === turns.length - 1 ? elapsed : undefined} />
                    )}
                  </div>
                )}
                {turn.activityCoverage && !turn.error && !turn.stopped ? (
                  <p className="muted" data-testid="ask-activity-coverage" style={{ fontSize: "0.8125rem", marginBlock: "0.75rem" }}>
                    {t.q_activity_coverage
                      .replace("{scanned}", new Intl.NumberFormat(lang).format(turn.activityCoverage.scannedPages))
                      .replace("{sources}", new Intl.NumberFormat(lang).format(turn.activityCoverage.sources))}
                    {turn.activityCoverage.incomplete ? ` · ${t.q_activity_limited}` : ""}
                  </p>
                ) : null}
                {turn.a && !turn.error && !turn.abstained ? (
                  <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                    {turn.hits?.length || (turn.localModel && turn.activityCoverage) ? (
                      // The answer as markdown: each passage a quote block with
                      // its `[[stem#Section]]` — the block "Quote in note" inserts.
                      <button
                        className="btn btn-ghost"
                        style={{ padding: "3px 8px", fontSize: 11.5 }}
                        aria-live="polite"
                        onClick={() =>
                          copyAnswer(
                            i,
                            turn.localModel ? turn.a : answerMarkdown(
                              turn.q,
                              ladderOf(turn.hits ?? [], weights).slice(0, QUOTED_PAGES),
                              turn.hits ?? [],
                            ),
                          )
                        }
                      >
                        {copied === i ? `✓ ${t.q_copied}` : t.q_copy_answer}
                      </button>
                    ) : null}
                    <MissButton t={t} harvested={turn.harvested ?? false} onLog={() => logMiss(i)} />
                  </div>
                ) : null}
                {turn.stale && !turn.extractive ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    <Icon name="info" size={12} />{" "}
                    {!turn.error ? <>{t.q_stale_index ??
                      "This answer used the whole vault instead of the search index, which is out of date after a model update."}{" "}</> : null}
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 12, padding: "2px 8px" }}
                      onClick={() => setRoute("settings")}
                    >
                      {t.q_open_model_settings ?? "Model settings"} →
                    </button>
                  </div>
                ) : null}
                {turn.retrievalFailed && !turn.extractive ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    <Icon name="info" size={12} />{" "}
                    {/* Deliberately vague about HOW the vault was read: the non-CLI
                        path inlines a whole-vault concat, while the CLI path injects
                        nothing and lets the CLI's own Read/Grep find the pages. */}
                    {!turn.error ? <>{t.q_retrieval_failed ??
                      "The search index could not be reached, so this answer skipped semantic search and read the vault directly instead. If it keeps happening, run “Reindex now” under Model settings."}{" "}</> : null}
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 12, padding: "2px 8px" }}
                      onClick={() => setRoute("settings")}
                    >
                      {t.q_open_model_settings ?? "Model settings"} →
                    </button>
                  </div>
                ) : null}
                {turn.a ? (
                  <AnswerGalaxy
                    t={t}
                    question={turn.q}
                    answer={turn.a}
                    stemMap={stemMap}
                    adjacency={adjacency}
                    onOpen={(abs) => setRoute(`page:${abs}`)}
                  />
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className="ask-jump">
          {mode === "ask" && turns.length && composerBelow ? (
            <button type="button" className="btn ask-jump__btn" onClick={toComposer}>
              <Icon name="chevD" size={14} /> {t.q_jump_to_question}
            </button>
          ) : null}
        </div>
        <div
          ref={composerRef}
          className="card ask-composer"
          style={{ display: mode === "agent" ? "none" : undefined }}
        >
          <div className="ask-composer__input">
            <Icon name="msg" size={20} />
            <input
              ref={questionRef}
              className="input"
              aria-label={t.q_title}
              placeholder={copy.askPlaceholder}
              value={q}
              aria-describedby="ask-scope"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingKey(e)) return;
                if (e.key === "Enter") void ask();
              }}
              disabled={busy || !currentVault || isOpeningVault}
            />
            {/* Native retrieval can wait on indexing or model work too. */}
            {busy ? (
              <button
                type="button"
                className="btn"
                aria-label={t.q_stop}
                title={t.q_stop}
                onClick={() => {
                  stop();
                  // The field is enabled again on the next render.
                  requestAnimationFrame(() => questionRef.current?.focus());
                }}
              >
                ■
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => void ask()}
                disabled={busy || !currentVault || isOpeningVault || !q.trim()}
              >
                {busy ? "…" : t.q_send}
              </button>
            )}
          </div>
          <div className="ask-composer__scope">
            {/* Which notes the question searches. Persisted like the other
                Ask prefs; the store reads it at ask time. */}
            {noteScope ? (
              // Over one note (UX S37): its name instead of the scope
              // choices, and ✕ back to them.
              <div className="ask-note-scope">
                <span id="ask-scope" className="ask-note-scope__chip" title={noteScope.path}>
                  <Icon name="file" size={12} />
                  <span className="ask-note-scope__name">
                    {t.q_note_scope_chip.replace("{note}", noteScope.title)}
                  </span>
                  <button
                    type="button"
                    aria-label={t.q_note_scope_clear}
                    title={t.q_note_scope_clear}
                    onClick={() => {
                      setNoteScope(null);
                      questionRef.current?.focus();
                    }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </span>
                <span className="ask-scope__hint">{t.q_note_scope_hint}</span>
              </div>
            ) : (
              <AskScopePicker t={t} scope={askScope} disabled={busy || isOpeningVault} onChange={setAskScope} />
            )}
          </div>
        </div>
        {mode === "ask" ? (
          <details
            className="intake-disclosure ask-options"
            data-testid="ask-options"
          >
            <summary>{copy.askOptions}</summary>
            {settings && mode === "ask" ? (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {settings.query_provider === "builtin-local" && settings.query_model !== BUILTIN_CHAT_MODEL
                  ? (t.q_via_retrieval ??
                    "via local semantic search — answers quote your notes verbatim (no model)")
                  : (t.q_via ?? "via {provider} · {model}")
                      .replace("{provider}", settings.query_provider)
                      .replace("{model}", settings.query_model)}
              </div>
            ) : null}
            {settings?.query_provider === "builtin-local" && mode === "ask" ? (
              <div
                className="q-builtin-note muted"
                style={{ fontSize: 12, marginTop: 4 }}
              >
                <Icon name="info" size={12} />{" "}
                {settings.query_model === BUILTIN_CHAT_MODEL ? t.q_builtin_note : t.q_builtin_extractive_note ??
                  "Answers show the top matching passages from your notes. For a synthesized answer, pick an AI provider under Model settings."}{" "}
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: "2px 8px" }}
                  onClick={() => {
                    setSettingsTab("model");
                    setRoute("settings");
                  }}
                >
                  {t.q_open_model_settings ?? "Model settings"} →
                </button>
              </div>
            ) : null}
            {mode === "ask" ? (
              // 고급: the tier-prior sliders. One panel for the page — it re-ranks
              // every ladder below live and is sent with the next question.
              <div style={{ marginTop: 6 }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: "2px 8px" }}
                  aria-expanded={advancedOpen}
                  aria-controls="ask-advanced"
                  onClick={() => setAdvancedOpen((o) => !o)}
                >
                  <Icon name={advancedOpen ? "chevD" : "chevR"} size={12} />{" "}
                  {t.q_prior_advanced}
                </button>
                {advancedOpen ? (
                  <div id="ask-advanced" style={{ marginTop: 8, maxWidth: 440 }}>
                    <TierPriorPanel
                      t={t}
                      id="ask-prior"
                      weights={weights}
                      onChange={setAskTierWeights}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {mode === "ask" && needsProfile && !hintDismissed ? (
              <div
                className="card"
                style={{
                  padding: 10,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  marginTop: 8,
                }}
              >
                <Icon name="info" size={14} />
                <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>
                  {t.ask_profile_hint ??
                    "Set up your profile so Ask can tailor answers to your role and interests."}
                </span>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: "2px 8px" }}
                  // The profile form lives on the Distill tab; settings opens on
                  // the model tab, where this CTA named nothing.
                  onClick={() => {
                    setSettingsTab("distill");
                    setRoute("settings");
                  }}
                >
                  {t.ask_profile_hint_cta ?? "Set up profile"} →
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: "2px 6px" }}
                  aria-label={t.ask_profile_hint_dismiss ?? "Dismiss"}
                  onClick={dismissProfileHint}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            ) : null}
          </details>
        ) : null}

        {mode === "ask" && turns.length === 0 && !busy ? (
          // Empty chat — MYCO keeps the blank space company (idle surface, so
          // the mascot is welcome here; it never interrupts a running chat).
          <div className="query-empty" style={{ marginTop: 24 }}>
            <MascotClip {...SURFACE_CLIPS.askEmpty} />
            <p className="muted">
              {t.q_empty ??
                "Ask the wiki anything — answers cite your own pages."}
            </p>
            <div className="ask-examples" aria-label={copy.askExamples}>
              <span className="ask-examples__label">{copy.askExamples}</span>
              {copy.examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="btn"
                  disabled={!currentVault}
                  onClick={() => {
                    setQ(example);
                    questionRef.current?.focus();
                  }}
                >
                  {example}
                  <Icon name="arrowR" size={14} />
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <AudioOverviewPanel t={t} />
    </AppPage>
  );
}

/** The quoted lines a citation opens the note at, and their section. */
interface Passage {
  section: string | null;
  quote: string;
}

// Extractive answer + its source ladder, side by side. Both derive from the
// same `ladderOf(turn.hits, weights)` rows, so the pills' numbers ARE the
// ladder's ranks and moving a prior slider re-orders both at once. `hot` is
// the page lit from either side — a pill or a ladder row, hover or focus.
/** Ghost action: log this question to the recall-miss eval set (Q4 item 5)
 *  when the answer missed what the user expected. An abstained turn offers
 *  the same log as its harvest button. aria-live, not role=status: the
 *  receipt is announced and the control is still a button. Logged, it is
 *  aria-disabled, not disabled: disabling the button being pressed drops
 *  keyboard focus to <body>; a second press logs nothing (harvest is once). */
export function MissButton({
  t,
  harvested,
  onLog,
}: {
  t: Strings;
  harvested: boolean;
  onLog: () => void;
}): JSX.Element {
  return (
    <button
      className="btn btn-ghost"
      style={{ padding: "3px 8px", fontSize: 11.5 }}
      aria-live="polite"
      aria-disabled={harvested}
      onClick={onLog}
    >
      {harvested ? `✓ ${t.q_miss_done}` : t.q_miss_btn}
    </button>
  );
}

export function ExtractiveAnswer({
  t,
  id,
  turn,
  weights,
  onOpenByStem,
  onOpenPage,
  onQuote,
  searchDetails,
}: {
  t: Strings;
  id: string;
  turn: ChatTurn;
  weights: TierWeights;
  onOpenByStem: (target: string) => void;
  onOpenPage: (page: string, passage?: Passage) => void;
  /** "Quote in note" with the passage as the editor's quote block. */
  onQuote: (block: string) => void;
  /** The turn's retrieval stepper, shown with the ladder's numbers under its
   *  one "search details" toggle (UX S32: the label was on the page twice). */
  searchDetails?: ReactNode;
}): JSX.Element {
  const [hot, setHot] = useState<string | null>(null);
  // UX S32: the first passage is read whole; the others open on request.
  const [allShown, setAllShown] = useState(false);
  const rows = useMemo(() => ladderOf(turn.hits ?? [], weights), [turn.hits, weights]);
  const quoted = rows.slice(0, QUOTED_PAGES);
  const hitsOf = (page: string): ScoredChunk[] =>
    (turn.hits ?? []).filter((h) => h.page === page);
  const passageOf = (r: { page: string; quote: string }): Passage => ({
    section: passageSection(r.quote, hitsOf(r.page)),
    quote: r.quote,
  });
  // Coverage complement: retrieved, ranked, but past the quote cap.
  const uncited: Citation[] = rows
    .slice(QUOTED_PAGES)
    .map((r) => ({ page: r.page, stem: r.stem, similarity: r.similarity }));
  const pct = (v: number | null): string =>
    v === null ? t.q_cite_sim_none : `${Math.round(v * 100)}%`;
  const hotHandlers = (page: string) => ({
    onMouseEnter: () => setHot(page),
    onMouseLeave: () => setHot(null),
    onFocus: () => setHot(page),
    onBlur: () => setHot(null),
  });
  return (
    <div className="ask-split">
      <div className="ask-answer">
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          <Icon name="info" size={12} />{" "}
          {t.q_extractive_label ?? "From your notes (top matches, verbatim)"}
        </div>
        <div className="ask-body" id={`${id}-body`}>
          {quoted.map((r, n) => {
            // The passage as the editor's quote block; null when nothing
            // quotable is left (a heading-only chunk) — then no button.
            const block = passageBlock(r.quote, hitsOf(r.page));
            // Folded, not cut: the words stay as they are, the box shows
            // three lines of them under the note's name.
            const folded = n > 0 && !allShown;
            return (
              <div
                key={r.page}
                className={`ask-sent${folded ? " is-folded" : ""}${hot === r.page ? " hot" : ""}`}
              >
                <div style={{ minWidth: 0 }}>
                  {folded ? <div className="ask-sent__note">{displayName(r.stem)}</div> : null}
                  {/* Plain paragraphs: the note's `# H1` and `[^n]` marks belong
                      to the note, not to the answer (UX audit A4). */}
                  <Viewer content={plainPassage(r.quote)} onLinkClick={onOpenByStem} displayNames />
                  {block && !folded ? (
                    <button
                      type="button"
                      className="btn btn-ghost ask-quote"
                      onClick={() => onQuote(block)}
                    >
                      <Icon name="quote" size={12} /> {t.q_quote_to_note}
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={`ask-cite${hot === r.page ? " hot" : ""}`}
                  aria-label={t.q_cite_aria
                    .replace("{n}", String(n + 1))
                    .replace("{stem}", displayName(r.stem))
                    .replace("{sim}", pct(r.similarity))
                    .replace("{tier}", tierLabel(t, r.tier))}
                  {...hotHandlers(r.page)}
                  onClick={() => onOpenPage(r.page, passageOf(r))}
                >
                  {n + 1}
                </button>
              </div>
            );
          })}
        </div>
        {quoted.length > 1 ? (
          <button
            type="button"
            className="btn btn-ghost ask-more"
            aria-expanded={allShown}
            aria-controls={`${id}-body`}
            onClick={() => setAllShown((o) => !o)}
          >
            <Icon name={allShown ? "chevD" : "chevR"} size={12} />{" "}
            {allShown
              ? t.q_fewer_passages
              : t.q_more_passages.replace("{n}", String(quoted.length - 1))}
          </button>
        ) : null}
        <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
          {t.q_ladder_hint}
        </p>
        {uncited.length ? <UncitedRow t={t} uncited={uncited} onOpen={onOpenPage} /> : null}
      </div>
      <aside className="ask-rail">
        <SourceLadder
          t={t}
          id={`${id}-ladder`}
          rows={rows}
          limit={RAIL_SOURCES}
          quoted={QUOTED_PAGES}
          floor={turn.floor ?? RELEVANCE_FLOOR}
          hot={hot}
          onHot={setHot}
          onOpen={(page) => {
            const row = rows.find((r) => r.page === page);
            onOpenPage(page, row && passageOf(row));
          }}
          details={searchDetails}
        />
      </aside>
    </div>
  );
}

// Coverage row: pages retrieval surfaced that the answer does NOT quote.
// Grounded answers' most common failure is omission — the citations can only
// show what backs the said, never what was considered and left out.
// Collapsed to one line by default (it is an audit surface, not a second
// answer); expanding shows dashed chips so the eye never reads them as
// citations. Clicking a chip opens the page.
function UncitedRow({
  t,
  uncited,
  onOpen,
}: {
  t: Strings;
  uncited: Citation[];
  onOpen: (page: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
      <button
        className="btn btn-ghost"
        style={{ fontSize: 12, padding: "2px 8px" }}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾" : "▸"}{" "}
        {(t.q_uncited_row ?? "Reviewed but not quoted · {n}").replace(
          "{n}",
          String(uncited.length),
        )}
      </button>
      {open ? (
        <ul
          aria-label={t.q_uncited_row ?? "Reviewed but not quoted"}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            listStyle: "none",
            margin: "6px 0 0",
            padding: 0,
          }}
        >
          {uncited.map((c) => (
            <li key={c.page}>
              <button
                className="chip"
                title={c.page}
                style={{ borderStyle: "dashed", cursor: "pointer", opacity: 0.75 }}
                onClick={() => onOpen(c.page)}
              >
                <span style={{ fontWeight: 500 }}>{displayName(c.stem)}</span>
                <span>· {bandLabel(t, confidenceBand(c.similarity))}</span>
                <span>· {tierLabel(t, sourceTier(c.page))}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Interactive mini galaxy of the pages an answer cites. Nodes are the
// resolved [[wikilinks]]; solid edges are the real links between those pages
// from the vault's adjacency. Click a star for an in-place preview.
function AnswerGalaxy({
  t,
  question,
  answer,
  stemMap,
  adjacency,
  onOpen,
}: {
  t: Strings;
  question: string;
  answer: string;
  stemMap: Map<string, string>;
  adjacency: ReturnType<typeof useVaultStore.getState>["adjacency"];
  onOpen: (absPath: string) => void;
}): JSX.Element | null {
  const [selected, setSelected] = useState<string | null>(null);
  const genAudio = useAudioStore((s) => s.generate);
  const audioBusy = useAudioStore((s) => s.generating);

  const nodes = useMemo<GalaxyNode[]>(() => {
    const out: GalaxyNode[] = [];
    for (const target of extractWikilinks(answer).slice(0, 32)) {
      const abs = stemMap.get(target.toLowerCase());
      if (!abs) continue; // unresolved citation — nothing to open
      out.push({
        id: abs,
        label: stem(abs),
        bright: true,
      });
    }
    return out;
  }, [answer, stemMap]);

  const links = useMemo<GalaxyLink[]>(() => {
    if (!adjacency) return [];
    const ids = new Set(nodes.map((n) => n.id));
    const out: GalaxyLink[] = [];
    for (const [src, targets] of Object.entries(adjacency.forward)) {
      if (!ids.has(src)) continue;
      for (const tgt of targets) {
        if (ids.has(tgt)) out.push({ a: src, b: tgt });
      }
    }
    return out;
  }, [adjacency, nodes]);

  if (nodes.length === 0) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 4 }}
      >
        <div className="section-title" style={{ fontSize: 13 }}>
          {t.q_sources_used} · {nodes.length}
        </div>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12.5 }}
          disabled={audioBusy}
          onClick={() =>
            void genAudio(question, nodes.map((n) => n.id))
          }
        >
          <Icon name="spark" size={12} />{" "}
          {audioBusy ? (t.au_generating ?? "…") : (t.au_title ?? "Audio overview")}
        </button>
      </div>
      <MiniGalaxy
        nodes={nodes}
        links={links}
        selected={selected}
        onSelect={setSelected}
        ariaLabel={t.q_sources_used}
        hubLabel={question}
      />
      {selected ? (
        <NodePreview
          t={t}
          absPath={selected}
          label={stem(selected)}
          onOpen={() => onOpen(selected)}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
