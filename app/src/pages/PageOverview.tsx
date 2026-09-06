// Overview — the harvest queue first (what becomes wiki today), then the link
// suggestions and what moved recently. The old landing hero, stat tiles and
// "jump back in" cards are gone: they sold the product to someone who already
// owns it and changed nothing about what to do next. The customizable board
// is demoted below, not deleted yet (a later wave).

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { reflectDoneLine, useReflectStore } from "../stores/reflectStore";
import type { ReflectSuggestion } from "../stores/reflectStore";
import { useDistillStore } from "../stores/distillStore";
import {
  backlogTrend,
  formatRunOutcome,
  lastDigestOutcome,
  lastMonthlyOutcome,
  lastWeeklyOutcome,
  lastFullTierOutcome,
  lastMapDraftOutcome,
  lastRunLabel,
  llmStepsWaiting,
  pendingShrank,
  runDistillGuarded,
} from "../lib/distill";
import type { RunReport } from "../lib/distill";
import { ipc } from "../lib/ipc";
import LinkSuggestions from "../components/LinkSuggestions";
import HarvestQueue from "../components/HarvestQueue";
import RecentNotes from "../components/RecentNotes";
import VaultHistoryBanner from "../components/VaultHistoryBanner";
import MorningBand from "../components/MorningBand";
import OverviewBoard from "../components/OverviewBoard";
import { useFocusTarget } from "../lib/useFocusTarget";

export default function PageOverview({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const [mtimes, setMtimes] = useState<[string, number][]>([]);

  // Morning-Report baseline: mark this visit AFTER MorningBand snapshots the
  // previous stamp (its useState initializer runs during render, before this
  // effect fires).
  useEffect(() => {
    useUIStore.getState().stampVisit();
  }, []);

  useEffect(() => {
    if (!currentVault) return;
    let cancelled = false;
    // One read per vault change — the dashboard does not poll. Failure is
    // quiet and degrades to "no activity yet" rather than an error state.
    ipc
      .fileMtimes(currentVault.path)
      .then((rows) => {
        if (!cancelled) setMtimes(rows);
      })
      .catch(() => {
        if (!cancelled) setMtimes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentVault]);

  return (
    <div className="workspace">
      <VaultHistoryBanner t={t} />
      <MorningBand t={t} />
      <HarvestQueue t={t} />
      <LinkSuggestions t={t} />
      <RecentNotes t={t} entries={mtimes} vaultRoot={currentVault?.path ?? ""} />

      {/* Demoted below the queue, not deleted yet. Keyed on the vault:
          OverviewBoard mounts at boot before a vault is open and returns null,
          which permanently strands useContainerWidth's one-shot ResizeObserver
          attach on a null ref (width stuck at its 1280 default — the off-pane
          widget bug). Remounting on vault open gives the hook a first commit
          where the measured div really exists. */}
      <OverviewBoard key={currentVault?.path ?? "no-vault"} t={t} />

      <div className="ov-bands">
        {currentVault ? (
          <section>
            <div className="section-head">
              <div className="section-title">{t.s_distill ?? "Distill"}</div>
            </div>
            <div className="card-grid">
              <DistillCard t={t} />
            </div>
          </section>
        ) : null}
      </div>

      <ReflectPanel t={t} />
    </div>
  );
}

// Read-only reflect pass (FEAT-06): a manual trigger plus a home for the
// suggestions the scheduler (or this button) produces. Shares reflectStore, so
// a run kicked here or by the scheduler shows up wherever the panel renders.
// The pass itself stays read-only; APPLYING a finding is always a click, and
// only the unresolved-wikilink kind has a safe mechanical fix (create the
// missing page — in bulk, like the suggested-links accept-all). Orphans get an
// open button, not a fake fix.
function ReflectPanel({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const setRoute = useUIStore((s) => s.setRoute);
  const stage = useReflectStore((s) => s.stage);
  const mode = useReflectStore((s) => s.mode);
  const suggestions = useReflectStore((s) => s.suggestions);
  const report = useReflectStore((s) => s.report);
  const runReflect = useReflectStore((s) => s.runReflect);
  const createMissingPages = useReflectStore((s) => s.createMissingPages);
  const markSeen = useReflectStore((s) => s.markSeen);
  const dismiss = useReflectStore((s) => s.dismiss);
  const ignore = useReflectStore((s) => s.ignore);
  const running = stage === "running";
  // How many findings the run itself produced — the completion line must keep
  // reporting the RUN's number even after applying findings removes rows.
  const [finished, setFinished] = useState<number | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{
    created: number;
    failed: string | null;
  } | null>(null);
  // "N reflect suggestions" in the activity popover points HERE.
  const focusRef = useFocusTarget<HTMLElement>("reflect");
  const missing = suggestions.filter((s) => s.kind === "unresolved");
  const doneLine = reflectDoneLine({ stage, mode, found: finished }, t);

  // A finished run is "seen" as soon as this panel is on screen (the
  // PageIngest/PageQuery idiom) — that is what clears the activity surfaces'
  // standing "N reflect suggestions" row, and it also freezes the count the
  // completion line reports.
  useEffect(() => {
    if (stage === "running") {
      setFinished(null);
      return;
    }
    if (stage === "done" || stage === "error") {
      setFinished(useReflectStore.getState().suggestions.length);
      markSeen();
    }
  }, [stage, markSeen]);

  // Same store action for one row and for all of them — one creation path.
  async function create(items?: ReflectSuggestion[]): Promise<void> {
    if (bulk) return;
    const total = items ? items.length : missing.length;
    setResult(null);
    setBulk({ done: 0, total });
    setResult(await createMissingPages(items, (done) => setBulk({ done, total })));
    setBulk(null);
  }

  return (
    // tabIndex: the activity row that names this section moves keyboard focus
    // here after scrolling it into view (useFocusTarget).
    <section
      className="card"
      ref={focusRef}
      tabIndex={-1}
      style={{ marginTop: 24, padding: 16, background: "var(--bg-soft)" }}
    >
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 8, gap: 8 }}
      >
        <div className="section-title" style={{ fontSize: 14 }}>
          {t.rf_title}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn"
            onClick={() => {
              setResult(null); // a new run's list, not the last run's tally
              void runReflect();
            }}
            disabled={!currentVault || running || !!bulk}
          >
            <Icon name="sparkles" size={14} />{" "}
            {running ? t.rf_running : t.rf_run}
          </button>
          {missing.length > 0 || bulk ? (
            <button
              type="button"
              className="btn"
              disabled={!!bulk || running}
              onClick={() => void create()}
            >
              <Icon name="plus" size={13} />{" "}
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
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
        {t.rf_lede}
      </p>
      {running ? (
        <div
          className="row muted"
          style={{ gap: 8, fontSize: 12.5, alignItems: "center" }}
        >
          <span className="ingest-chip-spinner" /> {t.rf_running}
        </div>
      ) : null}
      {doneLine ? (
        // Completion line, like the distill card's outcome line: it stays
        // until the run is dismissed, so a run started from the topbar chip
        // or the tray does not finish invisibly here. Extractive runs are
        // labeled inside it — link-graph facts, not model judgment.
        <div
          className="row"
          style={{
            color: "#16a34a",
            gap: 6,
            fontSize: 12,
            marginTop: 6,
            alignItems: "center",
            flexWrap: "wrap",
          }}
          data-testid="ov-reflect-done"
        >
          <Icon name="info" size={12} />
          <span>{doneLine}</span>
        </div>
      ) : null}
      {result && stage === "done" ? (
        <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 0" }}>
          {t.rf_create_result.replace("{n}", String(result.created))}
          {result.failed
            ? ` — ${t.rf_create_failed.replace("{target}", result.failed)}`
            : ""}
        </p>
      ) : null}
      {stage === "done" ? (
        suggestions.length > 0 ? (
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
            {suggestions.map((s, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {s.text}
                {s.kind === "unresolved" ? (
                  <button
                    type="button"
                    className="icon-btn"
                    style={{
                      display: "inline-flex", // .icon-btn is display:flex — inline keeps the action on the finding's own line
                      verticalAlign: "middle",
                      padding: 2,
                      marginLeft: 6,
                    }}
                    disabled={!!bulk}
                    aria-label={t.rf_create_one}
                    title={t.rf_create_one}
                    onClick={() => void create([s])}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                ) : null}
                {s.kind === "orphan" ? (
                  <button
                    type="button"
                    className="icon-btn"
                    style={{
                      display: "inline-flex", // .icon-btn is display:flex — inline keeps the action on the finding's own line
                      verticalAlign: "middle",
                      padding: 2,
                      marginLeft: 6,
                    }}
                    aria-label={t.rf_open_page}
                    title={t.rf_open_page}
                    onClick={() => setRoute(`page:${s.page}`)}
                  >
                    <Icon name="arrowR" size={13} />
                  </button>
                ) : null}
                {/* An orphan stays an orphan and a dangling link stays
                    dangling, so every run re-reports the same findings until
                    the user acts — this is how a finding you have decided
                    about stops coming back. */}
                <button
                  type="button"
                  className="icon-btn"
                  style={{
                    display: "inline-flex",
                    verticalAlign: "middle",
                    padding: 2,
                    marginLeft: 4,
                  }}
                  disabled={!!bulk}
                  aria-label={t.rf_ignore_one ?? "Stop reporting this"}
                  title={t.rf_ignore_one ?? "Stop reporting this"}
                  onClick={() => ignore([s])}
                >
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            {t.rf_empty}
          </p>
        )
      ) : null}
      {stage === "error" && report ? (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            margin: "4px 0 0",
            color: "#dc2626",
          }}
        >
          {report}
        </pre>
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
  const lang = useUIStore((s) => s.lang);
  const status = useDistillStore((s) => s.status);
  const refresh = useDistillStore((s) => s.refresh);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  // Phase B, Task 6: whether the latest full-tier ingest or draft-map pass
  // for this vault skipped its LLM step for lack of a connected provider
  // (lastFullTierOutcome/lastMapDraftOutcome — module maps in distill.ts,
  // written by runDistillGuarded). Re-checked on the same refresh the card
  // already does (mount + after "Distill now"), rather than polled
  // separately.
  const [llmQueued, setLlmQueued] = useState(false);
  // Outcome of the last run started FROM THIS CARD — inline feedback for the
  // "지금 증류" click (an empty-backlog run resolves faster than the topbar
  // chip can register). Cleared when the next run starts.
  const [outcome, setOutcome] = useState<{ report: RunReport; days: number; weeks: number; months: number } | null>(null);
  // Previous observed pending count, so "shrinking" is only claimed when the
  // count actually went down between observations (pendingShrank).
  const prevPending = useRef<number | null>(null);
  const [shrank, setShrank] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Card-local state must not leak across a vault switch: one vault's
  // completion line or pending-trend would show over another vault's card.
  useEffect(() => {
    setOutcome(null);
    setRunError(null);
    setShrank(false);
    prevPending.current = null;
  }, [currentVault?.path]);

  async function refreshAll(): Promise<void> {
    await refresh();
    if (!currentVault) return;
    // The session digest no longer waits on a provider (builtin-local digests
    // extractively — see sessionDigest.ts), so only full-tier ingest and
    // draft maps, which genuinely need generation, feed this note.
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
    try {
      const report = await runDistillGuarded(currentVault.path);
      if (report === null) {
        setBusy(true);
        return;
      }
      setOutcome({
        report,
        days: lastDigestOutcome.get(currentVault.path)?.daysDigested ?? 0,
        weeks: lastWeeklyOutcome.get(currentVault.path)?.bucketsRolledUp ?? 0,
        months: lastMonthlyOutcome.get(currentVault.path)?.bucketsRolledUp ?? 0,
      });
      await refreshAll();
    } catch (e) {
      // A failed run showing NOTHING reads as "the button is broken".
      setRunError(String(e));
    } finally {
      setRunning(false);
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
          {t.ov_distill_llm_queued ?? "LLM steps waiting — connect a provider"}
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
          style={{ color: "#16a34a", fontSize: 12, marginTop: 6 }}
          data-testid="ov-distill-report"
        >
          {formatRunOutcome(outcome.report, outcome.days, outcome.weeks, t, outcome.months)}
        </div>
      ) : null}
      {runError ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 6 }}>
          {runError}
        </div>
      ) : null}
      {busy ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {t.set_distill_busy ?? "A distill run is already in progress."}
        </div>
      ) : null}
    </div>
  );
}
