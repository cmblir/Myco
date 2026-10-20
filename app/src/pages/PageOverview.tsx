// Home starts with everyday actions. Workspace review and customization
// remain available in an explicit disclosure, including section deep links.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import {
  reflectStatus,
  suggestionKey,
  suggestionPath,
  useReflectStore,
} from "../stores/reflectStore";
import type { ReflectSuggestion } from "../stores/reflectStore";
import { useDistillStore } from "../stores/distillStore";
import {
  backlogTrend,
  formatRunOutcome,
  lastDigestOutcome,
  pendingEvidenceSources,
  lastMonthlyOutcome,
  lastWeeklyOutcome,
  lastFullTierOutcome,
  lastMapDraftOutcome,
  lastRunLabel,
  llmStepsWaiting,
  pendingShrank,
  runDistillGuarded,
  WorkflowRunError,
} from "../lib/distill";
import type { RunReport } from "../lib/distill";
import { workflowLabel, type WorkflowReceipt } from "../lib/workflowOutcome";
import { ipc } from "../lib/ipc";
import type { FileNode } from "../lib/ipc";
import AppPage from "../components/AppPage";
import EverydayHome from "../components/EverydayHome";
import HomeGuide from "../components/HomeGuide";
import HomeNotices from "../components/HomeNotices";
import { useNoticesStore } from "../stores/noticesStore";
import { useHarvestStore } from "../stores/harvestStore";
import { Button, IconButton } from "../components/ui";
import HomeManagement from "../components/HomeManagement";
import { bucketByDay } from "../lib/vaultPulse";
import RecentNotes from "../components/RecentNotes";
import { useFocusTarget } from "../lib/useFocusTarget";
import { askCopy, useQueryStore } from "../stores/queryStore";
import { setQueryPrefill } from "../lib/queryPrefill";
import { INTAKE_COPY } from "../lib/intakeCopy";
import { afterComposition, isComposingKey } from "../lib/ime";
import { today } from "../lib/taskLine";
import { captureToDaily, oneLine } from "../lib/dailyNote";

type MtimeRows = [string, number][];
type RecentState = "loading" | "ready" | "error";

/** One `file_mtimes` read for Home; returns the cancel for a superseded read.
 *  `rowsVault` names the vault whose rows are on screen. Only a different
 *  vault starts from no rows: file changes refresh the tree and re-run this
 *  read without briefly zeroing the week's statistics. */
export function readMtimes(
  vault: string,
  rowsVault: { current: string | null },
  pending: Promise<MtimeRows>,
  setRows: (rows: MtimeRows) => void,
  setState: (state: RecentState) => void,
): () => void {
  let cancelled = false;
  if (rowsVault.current !== vault) setRows([]);
  rowsVault.current = vault;
  setState("loading");
  pending.then(
    (rows) => {
      if (!cancelled) {
        setRows(rows);
        setState("ready");
      }
    },
    () => {
      if (!cancelled) setState("error");
    },
  );
  return () => {
    cancelled = true;
  };
}

export default function PageOverview({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const fileTree = useVaultStore((s) => s.fileTree);
  const adjacency = useVaultStore((s) => s.adjacency);
  const [mtimes, setMtimes] = useState<MtimeRows>([]);
  const [recentState, setRecentState] = useState<RecentState>("loading");
  const rowsVault = useRef<string | null>(null);
  const [recentRetry, setRecentRetry] = useState(0);
  const focusTarget = useUIStore((s) => s.focusTarget);
  const hasManagementTarget = focusTarget !== null &&
    ["links", "reflect", "contradictions"].includes(focusTarget.id);
  const [managementOpen, setManagementOpen] = useState(hasManagementTarget);
  const managementId = useId();
  // Reveal in the same commit as a section target, before its focus effect.
  const isManagementVisible = managementOpen || hasManagementTarget;
  const harvestCount = useHarvestStore((s) => s.data?.items.length ?? 0);
  const pendingProposals = useDistillStore((s) => s.status?.pending_proposals ?? 0);
  const lang = useUIStore((s) => s.lang);
  const reviewCount = new Intl.NumberFormat(lang).format(harvestCount + pendingProposals);

  // Activity links must reveal their destination before its focus effect runs.
  // Latched during render, not in an effect: that focus effect clears the
  // target through the store, whose synchronous re-render ran ahead of an
  // effect's setState and folded the tools shut again — unmounting the very
  // section it had just focused when Home was already open (the bell's
  // contradictions row).
  if (hasManagementTarget && !managementOpen) {
    setManagementOpen(true);
  }

  // The workspace statistics retain their numbers and seven-day activity.
  const buckets = useMemo(
    () => bucketByDay(mtimes, currentVault?.path ?? "", 7, new Date()),
    [mtimes, currentVault],
  );
  const pulse = useMemo(() => {
    const files = countTreeFiles(fileTree);
    const links = adjacency
      ? Object.values(adjacency.forward).reduce((s, arr) => s + arr.length, 0)
      : 0;
    return { files, links };
  }, [fileTree, adjacency]);

  // "While you were away" baseline: the PREVIOUS visit, snapshot during the
  // first render, before the stamp below replaces it. The notices count from
  // it while Home is open and from this visit once Home closes, so what was
  // shown here stops counting on the sidebar badge too (noticesStore). The
  // cleanup re-runs under StrictMode; the re-mount puts the snapshot back.
  const [visitedAt] = useState(() => useUIStore.getState().lastVisitAt);
  useEffect(() => {
    useUIStore.getState().stampVisit();
    const notices = useNoticesStore.getState();
    notices.setSince(visitedAt);
    return () => notices.setSince(useUIStore.getState().lastVisitAt);
  }, [visitedAt]);

  // Fresh notices on every visit, after the baseline above is set. The harvest
  // scan (cached per vault) feeds the folded tools' count before they open;
  // the sidebar used to load it for its Home badge, which is notices now.
  useEffect(() => {
    if (!currentVault) return;
    void useNoticesStore.getState().load(currentVault.path);
    void useHarvestStore.getState().load(currentVault.path);
  }, [currentVault]);

  useEffect(() => {
    if (!currentVault) {
      rowsVault.current = null;
      setMtimes([]);
      setRecentState("ready");
      return;
    }
    return readMtimes(
      currentVault.path,
      rowsVault,
      ipc.fileMtimes(currentVault.path),
      setMtimes,
      setRecentState,
    );
  }, [currentVault, fileTree, recentRetry]);

  const recentContent = recentState === "loading" ? (
    <p className="home-recent-status" role="status">{t.home_recent_loading}</p>
  ) : recentState === "error" ? (
    <div className="home-recent-status" role="alert">
      <span>{t.home_recent_error}</span>
      <Button onClick={() => setRecentRetry((n) => n + 1)}>{t.home_retry}</Button>
    </div>
  ) : (
    <RecentNotes
      t={t}
      entries={mtimes}
      vaultRoot={currentVault?.path ?? ""}
      meta={adjacency?.meta}
      adjacency={adjacency}
      limit={4}
    />
  );

  // One centred column at every width (spec 2026-10-02): no right rail. What
  // the rail used to report is the bell's popover.
  return (
    <AppPage
      title={t.nav_overview}
      className="home-page"
      tools={currentVault ? <HomeNotices t={t} /> : undefined}
    >
      {currentVault ? (
        <div className="home-band">
          <HomeAsk t={t} />
        </div>
      ) : null}
      <EverydayHome t={t} hasVault={Boolean(currentVault)} />
      <HomeGuide t={t} />
      {currentVault && !isManagementVisible ? recentContent : null}
      {currentVault ? (
        <section className="home-management">
          <button
            type="button"
            className="home-management-toggle"
            aria-expanded={isManagementVisible}
            aria-controls={managementId}
            onClick={() => {
              setManagementOpen(!isManagementVisible);
            }}
          >
            <Icon name={isManagementVisible ? "chevD" : "chevR"} size={18} />
            <span>
              <strong>{isManagementVisible ? t.home_hide_manage : t.home_manage}</strong>
              <small>{t.home_manage_hint}</small>
            </span>
            {harvestCount + pendingProposals > 0 ? (
              <span className="home-management-count">{t.home_ready.replace("{n}", reviewCount)}</span>
            ) : null}
          </button>
          <div id={managementId} hidden={!isManagementVisible} className="home-management-content">
            {isManagementVisible ? (
              <HomeManagement
                key={currentVault.path}
                t={t}
                vaultPath={currentVault.path}
                pulse={pulse}
                buckets={buckets}
                recent={recentContent}
                distill={<DistillCard t={t} />}
                reflect={<ReflectPanel t={t} />}
              />
            ) : null}
          </div>
        </section>
      ) : null}
    </AppPage>
  );
}

/** Fit the Home box's height to its text (and its placeholder, which wraps
 *  at phone width); everyday.css caps it at four lines. */
function fitToText(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

// The first keystroke on Home does something (UX S7): Enter asks the vault,
// Cmd/Ctrl+Enter appends the line to today's daily note through the same
// capture_note command the notch uses. Two buttons under the box do the same
// for anyone who does not know the keys, or has no Cmd key (UX S13).
export function HomeAsk({ t }: { t: Strings }): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const setRoute = useUIStore((s) => s.setRoute);
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  // React 18 runs this before paint after a keystroke, so the box never
  // shows a scrollbar for a frame while it grows.
  useEffect(() => fitToText(field.current), [text]);
  const keysId = useId();
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour >= 5 && hour < 12
      ? t.home_greet_morning
      : hour >= 12 && hour < 18
        ? t.home_greet_afternoon
        : t.home_greet_evening;

  // The ask runs in queryStore, so it survives this page unmounting and the
  // Ask page opens on the turn already in flight. With another answer still
  // running, the question waits in the Ask page's field instead of vanishing.
  function ask(question: string): void {
    const q = question.trim();
    if (!q) return;
    const query = useQueryStore.getState();
    if (query.busy) setQueryPrefill(q);
    else void query.ask(q, lang, askCopy(t));
    setRoute("query");
  }

  async function capture(value: string): Promise<void> {
    const line = value.trim();
    if (!line) return;
    if (await captureToDaily(line, t)) setText("");
  }

  // A button reads the field itself once any open composition commits: the
  // syllable still composing may not be in `text` yet. Enter keeps its
  // isComposingKey guard instead.
  function press(act: (value: string) => void): void {
    const el = field.current;
    if (el) afterComposition(el, composing.current, () => act(oneLine(el.value)));
  }

  return (
    <section className="home-ask" aria-label={t.home_ask}>
      <p className="home-ask__greet">
        <strong>{greeting}</strong>
        <time dateTime={today(now)}>
          {new Intl.DateTimeFormat(lang, {
            month: "long",
            day: "numeric",
            weekday: "long",
          }).format(now)}
        </time>
      </p>
      <textarea
        ref={field}
        rows={1}
        className="home-ask__input"
        value={text}
        placeholder={t.home_ask_ph}
        aria-label={t.home_ask_ph}
        aria-describedby={keysId}
        // A touch screen would raise its keyboard on every visit (UX S47).
        autoFocus={globalThis.matchMedia?.("(pointer: fine)").matches ?? false}
        onChange={(e) => setText(oneLine(e.target.value))}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || isComposingKey(e)) return;
          e.preventDefault();
          if (e.metaKey || e.ctrlKey) void capture(text);
          else ask(text);
        }}
      />
      <div className="home-ask__actions">
        <Button variant="primary" disabled={!text.trim()} onClick={() => press(ask)}>
          {t.home_ask_send}
        </Button>
        {/* Back to the box after a write: the emptied box turns this button
            off, which would drop keyboard focus to the page. */}
        <Button
          disabled={!text.trim()}
          onClick={() => press((v) => void capture(v).then(() => field.current?.focus()))}
        >
          {t.home_capture_send}
        </Button>
        <p id={keysId} className="home-ask__keys">{t.home_ask_keys}</p>
      </div>
      <div className="home-ask__chips">
        {INTAKE_COPY[lang].examples.map((example) => (
          <Button key={example} onClick={() => ask(example)}>
            {example}
          </Button>
        ))}
      </div>
    </section>
  );
}

// Read-only reflect pass (FEAT-06): a manual trigger plus a home for the
// suggestions the scheduler (or this button) produces. Shares reflectStore, so
// a run kicked here or by the scheduler shows up wherever the panel renders.
// The pass itself stays read-only; APPLYING a finding is always a click, and
// only the unresolved-wikilink kind has a safe mechanical fix (create the
// missing page — in bulk, like the suggested-links accept-all). Orphans get an
// open button, not a fake fix.
//
// The owner saw a finished run that never looked finished (spec 2026-10-02
// #5-8): the idle button wore a spinner-like glyph, and its list never went
// away. Now the button says idle or running, one line says done or failed,
// and every row leaves the list once it is acted on, until the card folds.
type ReflectBulk = { done: number; total: number } | null;
type ReflectCreateResult = { created: number; failed: string | null } | { error: string } | null;

/** Drive the panel's asynchronous creation callbacks independently of render. */
export function beginReflectCreation(
  items: ReflectSuggestion[] | undefined,
  setBulk: (value: ReflectBulk) => void,
  setResult: (value: ReflectCreateResult) => void,
): { finished: Promise<void>; cancel: () => void } {
  const state = useReflectStore.getState();
  const { currentVault, vaultToken } = useVaultStore.getState();
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const isCurrent = () => {
    const vault = useVaultStore.getState();
    return !cancelled && !vault.isOpeningVault && vault.currentVault?.path === currentVault?.path &&
      vault.vaultToken === vaultToken && useReflectStore.getState().origin === state.origin;
  };
  if (!currentVault || !state.origin || state.stage !== "done" || state.applying || !isCurrent() ||
      state.vault !== currentVault.path || state.vaultToken !== vaultToken ||
      items?.some((s) => !state.suggestions.includes(s))) {
    return { finished: Promise.resolve(), cancel };
  }
  const total = (items ?? state.suggestions).filter((s) => s.kind === "unresolved").length;
  setResult(null);
  setBulk({ done: 0, total });
  const finished = state.createMissingPages(items, (done) => {
    if (isCurrent()) setBulk({ done, total });
  }).then((result) => {
    if (isCurrent()) setResult(result);
  }, (error: unknown) => {
    if (isCurrent()) setResult({ error: error instanceof Error ? error.message : String(error) });
  }).finally(() => {
    if (isCurrent()) setBulk(null);
  });
  return { finished, cancel };
}

function ReflectPanel({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const vaultToken = useVaultStore((s) => s.vaultToken);
  const setRoute = useUIStore((s) => s.setRoute);
  const lang = useUIStore((s) => s.lang);
  const stage = useReflectStore((s) => s.stage);
  const mode = useReflectStore((s) => s.mode);
  const runVault = useReflectStore((s) => s.vault);
  const origin = useReflectStore((s) => s.origin);
  const suggestions = useReflectStore((s) => s.suggestions);
  const found = useReflectStore((s) => s.found);
  const finishedAt = useReflectStore((s) => s.finishedAt);
  const report = useReflectStore((s) => s.report);
  const runReflect = useReflectStore((s) => s.runReflect);
  const markSeen = useReflectStore((s) => s.markSeen);
  const dismiss = useReflectStore((s) => s.dismiss);
  const ignore = useReflectStore((s) => s.ignore);
  const drop = useReflectStore((s) => s.drop);
  const running = stage === "running";
  const [bulk, setBulk] = useState<ReflectBulk>(null);
  const [result, setResult] = useState<ReflectCreateResult>(null);
  // "N reflect suggestions" in the activity popover points HERE.
  const focusRef = useFocusTarget<HTMLElement>("reflect");
  const titleId = useId();
  const runRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Index of a row an action just took out; focus goes to the row now there.
  const refocus = useRef<number | null>(null);
  const creation = useRef<ReturnType<typeof beginReflectCreation> | null>(null);
  const missing = suggestions.filter((s) => s.kind === "unresolved");
  const status = reflectStatus({ stage, found, finishedAt, report }, t, lang);
  // Every row acted on, or none found: the card folds to its button.
  const folded = stage === "done" && suggestions.length === 0;

  useEffect(() => {
    creation.current?.cancel();
    creation.current = null;
    setBulk(null);
    setResult(null);
    refocus.current = null;
    return () => {
      creation.current?.cancel();
      creation.current = null;
    };
  }, [currentVault?.path, vaultToken, origin]);

  // A finished run is "seen" as soon as this panel is on screen (the
  // PageIngest/PageQuery idiom) — that is what clears the activity surfaces'
  // standing "N reflect suggestions" row.
  useEffect(() => {
    if (stage === "done" || stage === "error") markSeen();
  }, [stage, markSeen]);

  // The acted-on row is gone, and its button with it: keep keyboard focus in
  // the list (the row that moved up into its place), or on the run button
  // once the list is empty.
  useEffect(() => {
    const at = refocus.current;
    if (at === null) return;
    refocus.current = null;
    const rows = listRef.current?.querySelectorAll("li");
    const row = rows?.length ? rows[Math.min(at, rows.length - 1)] : null;
    (row?.querySelector("button") ?? runRef.current)?.focus();
  }, [suggestions]);

  // Same store action for one row and for all of them — one creation path.
  async function create(items?: ReflectSuggestion[]): Promise<void> {
    if (creation.current) return;
    const action = beginReflectCreation(items, setBulk, setResult);
    creation.current = action;
    await action.finished;
    if (creation.current === action) creation.current = null;
  }

  return (
    // tabIndex: the activity row that names this section moves keyboard focus
    // here after scrolling it into view (useFocusTarget).
    <section
      className="card home-reflect"
      ref={focusRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-testid="reflect-card"
    >
      <div className="home-reflect__head">
        <div id={titleId} className="section-title">
          {t.rf_title}
        </div>
        <div className="home-reflect__tools">
          {/* aria-disabled while running, not disabled: a disabled button
              drops the keyboard focus that pressed it. runReflect refuses a
              second run anyway. */}
          <button
            ref={runRef}
            type="button"
            className="btn"
            aria-disabled={running || undefined}
            onClick={() => {
              if (running) return;
              setResult(null); // a new run's list, not the last run's tally
              void runReflect();
            }}
            disabled={!currentVault || !!bulk}
          >
            {running ? (
              <span className="ingest-chip-spinner" aria-hidden="true" />
            ) : (
              <Icon name="spark" size={14} />
            )}
            {running ? t.rf_running : t.rf_run}
          </button>
          {missing.length > 0 || bulk ? (
            <button
              type="button"
              className="btn"
              disabled={!!bulk || running}
              onClick={() => void create()}
            >
              <Icon name="plus" size={13} />
              {bulk
                ? t.rf_create_progress
                    .replace("{done}", String(bulk.done))
                    .replace("{total}", String(bulk.total))
                : `${t.rf_create_missing} (${missing.length})`}
            </button>
          ) : null}
          {stage === "done" || stage === "error" ? (
            <button type="button" className="btn-ghost btn" onClick={dismiss}>
              <Icon name="x" size={12} /> {t.p_dismiss ?? "dismiss"}
            </button>
          ) : null}
        </div>
      </div>
      {folded ? null : <p className="home-reflect__lede">{t.rf_lede}</p>}
      {/* Always in the DOM, so done and failed are announced when they land. */}
      <div role="status" className="home-reflect__status">
        {status.tone === "done" ? (
          <p className="home-reflect__line is-done" data-testid="ov-reflect-done">
            <Icon name="check" size={14} />
            <span>{status.line}</span>
          </p>
        ) : null}
        {status.tone === "failed" ? (
          <>
            <p className="home-reflect__line is-failed">
              <Icon name="info" size={14} />
              <span>{status.line}</span>
            </p>
            {status.detail ? <pre className="home-reflect__detail">{status.detail}</pre> : null}
          </>
        ) : null}
        {folded ? <p className="home-reflect__empty">{t.rf_empty}</p> : null}
      </div>
      {result && stage === "done" ? (
        "error" in result ? (
          <p className="home-reflect__note" role="alert">{t.rf_failed} — {result.error}</p>
        ) : (
          <p className="home-reflect__note">
            {t.rf_create_result.replace("{n}", String(result.created))}
            {result.failed
              ? ` — ${t.rf_create_failed.replace("{target}", result.failed)}`
              : ""}
          </p>
        )
      ) : null}
      {stage === "done" && suggestions.length > 0 ? (
        <>
          {/* Extractive findings are link-graph facts, never model judgment. */}
          {mode === "extractive" ? <p className="home-reflect__note">{t.rf_extractive}</p> : null}
          <ul ref={listRef} className="home-reflect__list">
            {suggestions.map((s, i) => (
              <li key={s.kind === "unresolved" ? `${suggestionKey(s)}>${s.from}` : suggestionKey(s)}>
                {/* The row names the note; its title keeps the path. */}
                <span title={suggestionPath(s, runVault ?? "")}>{s.text}</span>
                <span className="home-reflect__acts">
                  {s.kind === "unresolved" ? (
                    <IconButton
                      disabled={!!bulk}
                      aria-label={t.rf_create_one}
                      title={t.rf_create_one}
                      onClick={() => {
                        refocus.current = i;
                        void create([s]);
                      }}
                    >
                      <Icon name="plus" size={14} />
                    </IconButton>
                  ) : null}
                  {s.kind === "orphan" ? (
                    <IconButton
                      aria-label={t.rf_open_page}
                      title={t.rf_open_page}
                      onClick={() => {
                        drop([s]);
                        setRoute(`page:${s.page}`);
                      }}
                    >
                      <Icon name="arrowR" size={14} />
                    </IconButton>
                  ) : null}
                  {/* An orphan stays an orphan and a dangling link stays
                      dangling, so every run re-reports the same findings until
                      the user acts — this is how a finding you have decided
                      about stops coming back. */}
                  <IconButton
                    disabled={!!bulk}
                    aria-label={t.rf_ignore_one}
                    title={t.rf_ignore_one}
                    onClick={() => {
                      refocus.current = i;
                      ignore([s]);
                    }}
                  >
                    <Icon name="x" size={13} />
                  </IconButton>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

// Overview's distill card (Task 9): backlog trend, pending-proposal count,
// last run, and a [지금 증류] button. The button MUST go through
// runDistillGuarded (not ipc.distillRun directly) — a due schedule or the
// idle-gated count trigger can be running at the same moment (see distill.ts).
function DistillCard({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const vaultToken = useVaultStore((s) => s.vaultToken);
  const lang = useUIStore((s) => s.lang);
  const status = useDistillStore((s) => s.status);
  const refresh = useDistillStore((s) => s.refresh);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  // Waiting steps can use the selected local model; a connection is optional.
  const [llmQueued, setLlmQueued] = useState(false);
  // Outcome of the last run started FROM THIS CARD — inline feedback for the
  // "지금 증류" click (an empty-backlog run resolves faster than the topbar
  // chip can register). Cleared when the next run starts.
  const [outcome, setOutcome] = useState<{ report: RunReport; days: number; weeks: number; months: number; pending: number } | null>(null);
  // Previous observed pending count, so "shrinking" is only claimed when the
  // count actually went down between observations (pendingShrank).
  const prevPending = useRef<number | null>(null);
  const [shrank, setShrank] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [workflowReceipt, setWorkflowReceipt] = useState<WorkflowReceipt | null>(null);

  // Card-local state must not leak across a vault switch: one vault's
  // completion line or pending-trend would show over another vault's card.
  useEffect(() => {
    setOutcome(null);
    setRunError(null);
    setWorkflowReceipt(null);
    setRunning(false);
    setBusy(false);
    setLlmQueued(false);
    setShrank(false);
    prevPending.current = null;
  }, [currentVault?.path, vaultToken]);

  function stillCurrent(): boolean {
    const state = useVaultStore.getState();
    return state.currentVault?.path === currentVault?.path && state.vaultToken === vaultToken && !state.isOpeningVault;
  }

  async function refreshAll(): Promise<void> {
    await refresh();
    if (!currentVault || !stillCurrent()) return;
    setLlmQueued(
      llmStepsWaiting(
        lastFullTierOutcome.get(currentVault.path),
        lastMapDraftOutcome.get(currentVault.path),
      ),
    );
  }

  useEffect(() => {
    if (!status) return;
    setShrank(pendingShrank(prevPending.current, status.pending_proposals));
    prevPending.current = status.pending_proposals;
  }, [status]);

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVault]);

  // Inline feedback covers runs started FROM THIS CARD; schedule- and
  // tray-initiated runs surface through the OS notification instead
  // (osNotify in distill.ts), so neither path ends invisibly.
  async function runNow(): Promise<void> {
    if (!currentVault || running) return;
    setRunning(true);
    setBusy(false);
    setOutcome(null);
    setRunError(null);
    setWorkflowReceipt(null);
    try {
      const report = await runDistillGuarded(currentVault.path);
      if (!stillCurrent()) return;
      if (report === null) {
        setBusy(true);
        return;
      }
      setOutcome({
        report,
        days: lastDigestOutcome.get(currentVault.path)?.daysDigested ?? 0,
        weeks: lastWeeklyOutcome.get(currentVault.path)?.bucketsRolledUp ?? 0,
        months: lastMonthlyOutcome.get(currentVault.path)?.bucketsRolledUp ?? 0,
        pending: pendingEvidenceSources(currentVault.path),
      });
      await refreshAll();
    } catch (e) {
      if (!stillCurrent()) return;
      if (e instanceof WorkflowRunError) {
        setWorkflowReceipt(e.receipt);
        try { await refreshAll(); }
        catch (refreshError) { if (stillCurrent()) setRunError(String(refreshError)); }
      } else setRunError(String(e));
    } finally {
      if (stillCurrent()) setRunning(false);
    }
  }

  const trend = status ? backlogTrend(status.last_backlogs) : "flat";
  const trendArrow = trend === "shrinking" ? "↓" : trend === "growing" ? "↑" : "→";
  const lastRun = status ? lastRunLabel(status.last_run, lang) : null;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ fontWeight: 600 }}>{t.s_distill ?? "Distill"}</div>
        <span aria-hidden="true" style={{ fontSize: 15 }}>
          {trendArrow}
        </span>
      </div>
      {status ? (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          {(t.set_distill_pending ?? "{n} pending proposals").replace(
            "{n}",
            String(status.pending_proposals),
          )}
          {shrank ? <> · {t.set_distill_trend_shrinking ?? "shrinking"}</> : null}
        </div>
      ) : null}
      <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
        {lastRun
          ? (t.ov_distill_last_run ?? "Last run {t}").replace("{t}", lastRun)
          : (t.ov_distill_never ?? "No runs yet")}
      </div>
      {llmQueued ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          {t.ov_distill_llm_queued}
        </div>
      ) : null}
      <button
        type="button"
        className="btn btn-primary"
        style={{ marginTop: 10 }}
        onClick={() => void runNow()}
        disabled={running || !currentVault}
        aria-busy={running}
      >
        {running
          ? (t.set_distill_running ?? "Distilling…")
          : (t.set_distill_run_now ?? "Distill now")}
      </button>
      {outcome ? (
        <div
          style={{ color: "var(--ok)", fontSize: 12, marginTop: 6 }}
          data-testid="ov-distill-report"
        >
          {formatRunOutcome(outcome.report, outcome.days, outcome.weeks, t, outcome.months, outcome.pending)}
        </div>
      ) : null}
      {workflowReceipt ? <DistillWorkflowResult t={t} receipt={workflowReceipt} /> : null}
      {runError ? (
        <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>
          {runError}
        </div>
      ) : null}
      {busy ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {t.set_distill_busy ??
            "A distill run or an inbox auto-ingest pass is already in progress."}
        </div>
      ) : null}
    </div>
  );
}

/** Render committed steps beside an explicit incomplete outcome and its cause. */
export function DistillWorkflowResult({ t, receipt }: { t: Strings; receipt: WorkflowReceipt }): JSX.Element {
  const stepLabels: Record<string, string> = {
    run: t.set_distill_step_run, digest: t.set_distill_step_digest,
    ingest: t.set_distill_step_ingest, maps: t.set_distill_step_maps,
    weekly: t.set_distill_step_weekly, monthly: t.set_distill_step_monthly,
    resurface: t.set_distill_step_resurface,
  };
  return (
    <div role={receipt.status === "failed" ? "alert" : "status"}
      style={{ color: "var(--ink-2)", fontSize: 12, marginTop: 6 }} data-testid="ov-distill-workflow">
      <strong>{workflowLabel(receipt.status, t)}</strong>
      {receipt.steps.length ? <ul style={{ margin: "4px 0", paddingInlineStart: 18 }}>
        {receipt.steps.map((step, index) => <li key={`${step.step}-${index}`}>
          {stepLabels[step.step.split(".")[0]] ?? step.step}: {step.status === "success" ? t.sv_done : workflowLabel(step.status, t)}
        </li>)}
      </ul> : null}
      {receipt.issues.map((issue, index) => <div key={`${issue.step}-${index}`}>{issue.error}</div>)}
      {receipt.issues.some(issue => issue.retryable) ? <div>{t.workflow_retry_hint}</div> : null}
    </div>
  );
}

/** File leaves in the tree — the pulse band's "pages" figure (restored with
 *  the band; same walk it used before the harvest queue took the hero slot). */
function countTreeFiles(tree: FileNode[] | null): number {
  if (!tree) return 0;
  let n = 0;
  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.kind === "file") n++;
    else stack.push(...node.children);
  }
  return n;
}
