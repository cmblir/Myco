// Overview — the vault's own state: counts, 7-day activity, what moved
// recently. The hero copy renders only for an empty vault, where it is the
// only true thing to show.

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useReflectStore } from "../stores/reflectStore";
import { useDistillStore } from "../stores/distillStore";
import {
  backlogTrend,
  formatRunOutcome,
  lastDigestOutcome,
  lastFullTierOutcome,
  lastMapDraftOutcome,
  lastRunLabel,
  llmStepsWaiting,
  pendingShrank,
  runDistillGuarded,
} from "../lib/distill";
import type { RunReport } from "../lib/distill";
import { ipc } from "../lib/ipc";
import type { FileNode } from "../lib/ipc";
import LinkSuggestions from "../components/LinkSuggestions";
import VaultPulse from "../components/VaultPulse";
import RecentNotes from "../components/RecentNotes";
import { bucketByDay } from "../lib/vaultPulse";

export default function PageOverview({ t }: { t: Strings }): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  const currentVault = useVaultStore((s) => s.currentVault);
  const fileTree = useVaultStore((s) => s.fileTree);
  const adjacency = useVaultStore((s) => s.adjacency);
  const [mtimes, setMtimes] = useState<[string, number][]>([]);

  useEffect(() => {
    if (!currentVault) return;
    let cancelled = false;
    // One read per vault change — the dashboard does not poll. Failure is
    // quiet and degrades to "no activity yet" rather than an error state: a
    // missing sparkline must not take the page's numbers down with it.
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

  const buckets = useMemo(
    () => bucketByDay(mtimes, currentVault?.path ?? "", 7, new Date()),
    [mtimes, currentVault],
  );

  const stats = useMemo(() => {
    const files = countFiles(fileTree);
    const links = adjacency
      ? Object.values(adjacency.forward).reduce((s, arr) => s + arr.length, 0)
      : 0;
    const unresolved = adjacency
      ? Object.values(adjacency.unresolved).reduce(
          (s, arr) => s + arr.length,
          0,
        )
      : 0;
    const total = links + unresolved;
    const resolvedRatio = total > 0 ? links / total : 0;
    return { files, links, resolvedRatio };
  }, [fileTree, adjacency]);

  const recentLeaves = useMemo(
    () => collectFiles(fileTree).slice(0, 6),
    [fileTree],
  );

  return (
    <div className="workspace">
      {stats.files === 0 ? (
        // For an empty vault this copy is the only true thing to show, and it
        // is the one moment it is genuinely useful. With pages present it is
        // product copy shown to someone who already uses the product.
        <header className="page-head">
          <div className="page-eyebrow">{t.ov_eyebrow}</div>
          <h1 className="page-title">{t.ov_title}</h1>
          <p className="page-lede">{t.ov_lede}</p>
        </header>
      ) : (
        <VaultPulse
          t={t}
          pages={stats.files}
          links={stats.links}
          buckets={buckets}
          resolvedRatio={stats.resolvedRatio}
        />
      )}

      <div className="row" style={{ marginTop: 20 }}>
        <button className="btn btn-primary" onClick={() => setRoute("ingest")}>
          <Icon name="upload" size={14} /> {t.ov_cta_ingest}
        </button>
        <button className="btn" onClick={() => setRoute("query")}>
          <Icon name="msg" size={14} /> {t.ov_cta_ask}
        </button>
      </div>

      <div className="ov-bands">
        {recentLeaves.length > 0 ? (
          <section>
            <div className="section-head">
              <div className="section-title">{t.ov_quick}</div>
            </div>
            <div className="card-grid">
              {recentLeaves.slice(0, 2).map((node) => (
                <button
                  key={node.path}
                  className="card"
                  style={{ textAlign: "left", cursor: "pointer" }}
                  onClick={() => setRoute(`page:${node.path}`)}
                >
                  <div className="row" style={{ marginBottom: 8 }}>
                    <span className="typebadge">
                      <span className="tb-dot t-overview"></span>
                      file
                    </span>
                  </div>
                  <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>
                    {node.name.replace(/\.md$/i, "")}
                  </div>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <RecentNotes t={t} entries={mtimes} vaultRoot={currentVault?.path ?? ""} />

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

      <LinkSuggestions t={t} />

      <ReflectPanel t={t} />
    </div>
  );
}

// Read-only reflect pass (FEAT-06): a manual trigger plus a home for the
// suggestions the scheduler (or this button) produces. Shares reflectStore, so
// a run kicked here or by the scheduler shows up wherever the panel renders.
function ReflectPanel({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const setRoute = useUIStore((s) => s.setRoute);
  const stage = useReflectStore((s) => s.stage);
  const suggestions = useReflectStore((s) => s.suggestions);
  const report = useReflectStore((s) => s.report);
  const runReflect = useReflectStore((s) => s.runReflect);
  const dismiss = useReflectStore((s) => s.dismiss);
  const running = stage === "running";

  return (
    <section
      className="card"
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
            onClick={() => void runReflect()}
            disabled={!currentVault || running}
          >
            <Icon name="sparkles" size={14} />{" "}
            {running ? t.rf_running : t.rf_run}
          </button>
          {stage === "done" || stage === "error" || stage === "blocked" ? (
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
      {stage === "blocked" ? (
        // Capability gap, not a failure — builtin-local can't generate (see
        // reflectStore.runReflect), so this is a calm muted line with a way
        // out, not the red error block below.
        <div
          className="row muted"
          style={{ gap: 6, fontSize: 12.5, alignItems: "center", flexWrap: "wrap" }}
        >
          <Icon name="info" size={12} />
          <span>{t.rf_blocked}</span>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: "2px 8px" }}
            onClick={() => setRoute("settings")}
          >
            {t.q_open_model_settings ?? "Model settings"} →
          </button>
        </div>
      ) : null}
      {stage === "done" ? (
        suggestions.length > 0 ? (
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
            {suggestions.map((s, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {s}
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
  const [outcome, setOutcome] = useState<{ report: RunReport; days: number } | null>(null);
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
          {formatRunOutcome(outcome.report, outcome.days, t)}
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

function countFiles(tree: FileNode[]): number {
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

function collectFiles(tree: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.kind === "file") out.push(node);
    else stack.push(...node.children);
  }
  return out;
}
