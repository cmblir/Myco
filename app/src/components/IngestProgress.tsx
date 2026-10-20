// Live "mission control" panel shown while an ingest run is in flight.
// Streams real claude activity (operational transparency beats a blind
// spinner): pulsing orb + current action headline, a constellation of files
// the model has touched so far, a scrolling activity feed, counters, and a
// cancel button. All data comes from ingestStore so the panel resumes
// seamlessly after navigating away and back.

import { memo, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { IconName } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { formatTicker } from "../lib/time";
import { defaultSelection } from "../lib/planGate";
import type { PlanItem } from "../lib/ingestPlan";
import { runElapsedMs, useIngestStore } from "../stores/ingestStore";
import type { IngestEvent, IngestStage } from "../stores/ingestStore";
import IngestMiniGraph from "./IngestMiniGraph";
import { workflowLabel, type WorkflowStatus } from "../lib/workflowOutcome";

// Only the tail of the capped 500-event feed is rendered. Rendering all 500
// rows on every stream event was the ingest lag: 500 React elements rebuilt
// per event, inside a live region WebKit then re-serialised in full. The feed
// is append-only and auto-scrolled to the newest row, so the older rows are
// off-screen history — a count stands in for them. Slicing costs three lines;
// a virtualiser would need scroll math and a dependency for the same result.
const FEED_ROWS = 120;

const TOOL_ICONS: Record<string, IconName> = {
  Read: "book",
  Write: "edit",
  Edit: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  Bash: "terminal",
};

// Decision colours for the ingest-plan telemetry: new (green), extend (blue),
// fold-in (amber), nothing-to-do (muted) — colour is backed by the text label
// too, so the meaning never rests on colour alone (WCAG 1.4.1).
const DECISION_BG: Record<string, string> = {
  ADD: "rgba(22,163,74,0.12)",
  UPDATE: "rgba(37,99,235,0.12)",
  MERGE: "rgba(217,119,6,0.14)",
  NOOP: "var(--bg-soft)",
};
const DECISION_FG: Record<string, string> = {
  ADD: "var(--c-entity)",
  UPDATE: "var(--accent, #2563eb)",
  MERGE: "var(--c-technique)",
  NOOP: "var(--ink-3)",
};

/** A plan decision as the user reads it: 고침 / 새로 만듦 / 합침 / 이미 있음,
 *  never the planner's op code (UX S14). An unknown code stays as it came. */
export function decisionLabel(t: Strings, decision: string): string {
  const labels: Record<string, string> = {
    UPDATE: t.ing_dec_update,
    ADD: t.ing_dec_add,
    MERGE: t.ing_dec_merge,
    NOOP: t.ing_dec_noop,
  };
  return labels[decision] ?? decision;
}

function describe(ev: IngestEvent): string {
  if (ev.kind === "tool") {
    const target = ev.detail ?? "";
    return `${ev.tool} ${target}`.trim();
  }
  if (ev.kind === "init") return ev.text ? `model: ${ev.text}` : "session started";
  return ev.text ?? "";
}

export default function IngestProgress({ t }: { t: Strings }): JSX.Element {
  const stage = useIngestStore((s) => s.stage);
  const workflowStatus = useIngestStore((s) => s.workflowStatus);
  const events = useIngestStore((s) => s.events);
  const readCount = useIngestStore((s) => s.readCount);
  const writeCount = useIngestStore((s) => s.writeCount);
  const model = useIngestStore((s) => s.model);
  const startedAt = useIngestStore((s) => s.startedAt);
  const finishedAt = useIngestStore((s) => s.finishedAt);
  const gateAt = useIngestStore((s) => s.gateAt);
  const candidates = useIngestStore((s) => s.candidates);
  const plan = useIngestStore((s) => s.plan);
  const cancelIngest = useIngestStore((s) => s.cancelIngest);

  const running =
    stage === "writing-raw" ||
    stage === "plan-gate" ||
    stage === "claude" ||
    stage === "indexing";
  // Paused on the user's decision: cancel stays live, but nothing is being
  // written, so it must not read (or pulse, or tick) as working (UX S35).
  const waiting = stage === "plan-gate";

  // 1 Hz elapsed ticker while the run works; the gate holds it still.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || waiting) return;
    // Catch up at once: `now` is from before the gate, so the first second
    // after it would otherwise clamp to 0:00.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, waiting]);

  // Auto-scroll the feed to the newest entry.
  const feedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const last = events.length > 0 ? events[events.length - 1] : null;
  const warmup = feedIdleLine(stage, t, workflowStatus);
  const currentAction = last ? describe(last) : warmup;
  // Frozen at the final duration once the run ends — the panel stays up as
  // the run's result view.
  const elapsed = formatTicker(
    runElapsedMs({ stage, startedAt, finishedAt, gateAt }, now),
  );
  const title = waiting
    ? t.ing_gate_title
    : running
      ? t.ing_live_title
      : workflowStatus && workflowStatus !== "success"
        ? workflowLabel(workflowStatus, t)
      : stage === "done"
        ? t.ing_success_title
        : stage === "cancelled"
          ? t.ing_cancelled
          : t.ing_chip_error;

  const visibleEvents =
    events.length > FEED_ROWS ? events.slice(-FEED_ROWS) : events;
  const earlier = events.length - visibleEvents.length;

  return (
    // No live region on the wrapper: it used to announce the whole panel —
    // 500 feed rows plus a 1 Hz ticker — on every event. Only the current
    // action line is announced now.
    <div className="ingest-live">
      <div className="ingest-live-hero">
        <div
          className={"ingest-orb" + (running && !waiting ? "" : " idle")}
          aria-hidden="true"
        >
          <span className="ingest-orb-ring r1" />
          <span className="ingest-orb-ring r2" />
          <span className="ingest-orb-core" />
        </div>
        <div className="ingest-live-headline">
          {/* At done and cancelled the page's card carries the title. */}
          {pageCardCarriesTitle(stage) ? null : (
            <div className="ingest-live-title">{title}</div>
          )}
          <div
            className="ingest-live-action"
            title={currentAction}
            role="status"
            aria-live="polite"
          >
            {currentAction}
          </div>
          {pageCardCarriesTitle(stage) ? null : (
            <div className="ingest-live-meta muted">
              {model ? `${model} · ` : ""}
              {waiting ? `${t.ing_gate_paused} · ` : ""}
              {elapsed}
            </div>
          )}
        </div>
        {running ? (
          <button
            className="btn ingest-cancel"
            onClick={cancelIngest}
            disabled={stage !== "claude" && stage !== "plan-gate"}
          >
            <Icon name="x" size={13} /> {t.ing_cancel}
          </button>
        ) : null}
      </div>

      {/* The decision goes first: it is the only thing waiting on the user. */}
      {waiting && plan.length > 0 ? <PlanGateCard t={t} plan={plan} /> : null}

      <IngestMiniGraph t={t} />

      {waiting && plan.length > 0 ? null : plan.length > 0 ? (
        <div className="card" data-testid="ingest-plan" style={{ padding: "10px 12px" }}>
          <div className="section-title" style={{ fontSize: 13, marginBottom: 2 }}>
            <Icon name="sparkles" size={12} />{" "}
            {(t.ing_plan ?? "Ingest plan ({n})").replace("{n}", String(plan.length))}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            {t.ing_plan_hint ??
              "What the source will change — the agent follows this, updating existing pages instead of duplicating."}
          </div>
          <div className="col" style={{ gap: 5 }}>
            {plan.map((p, i) => (
              <div
                key={i}
                className="row"
                style={{ gap: 7, alignItems: "baseline", fontSize: 12.5, flexWrap: "wrap" }}
              >
                <span
                  className="chip"
                  style={{
                    flexShrink: 0,
                    fontSize: 11,
                    fontWeight: 600,
                    background: DECISION_BG[p.decision] ?? "var(--bg-soft)",
                    color: DECISION_FG[p.decision] ?? "var(--ink-3)",
                  }}
                >
                  {decisionLabel(t, p.decision)}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  {p.subject}
                  {p.target ? (
                    <span className="muted"> → {p.target}</span>
                  ) : null}
                  {p.reason ? (
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {" "}
                      · {p.reason}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : candidates.length > 0 ? (
        <div className="card" data-testid="ingest-candidates" style={{ padding: "10px 12px" }}>
          <div
            className="section-title"
            style={{ fontSize: 13, marginBottom: 2 }}
          >
            <Icon name="link" size={12} />{" "}
            {(t.ing_grounded ?? "Matched {n} existing page(s) to update").replace(
              "{n}",
              String(candidates.length),
            )}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            {t.ing_grounded_hint ??
              "The source was steered to these pages so it updates them instead of duplicating."}
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {candidates.map((c) => (
              <span
                key={c.page}
                className="chip"
                style={{ background: "var(--bg-soft)", fontSize: 12 }}
                title={`${c.page} · ${c.score.toFixed(2)}`}
              >
                {c.stem}
                <span className="muted" style={{ marginLeft: 4 }}>
                  {c.score.toFixed(2)}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card ingest-feed-card">
        <div className="section-title" style={{ fontSize: 13.5, marginBottom: 6 }}>
          {t.ing_live_activity}
        </div>
        <div className="ingest-feed" ref={feedRef}>
          {events.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>
              {warmup}
            </div>
          ) : (
            <>
              {earlier > 0 ? (
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {t.ing_live_earlier.replace("{n}", String(earlier))}
                </div>
              ) : null}
              {visibleEvents.map((ev) => (
                <FeedRow key={ev.seq} ev={ev} />
              ))}
            </>
          )}
        </div>
        <div className="ingest-live-stats">
          <span className="chip">
            <Icon name="book" size={11} /> {readCount} {t.ing_live_reads}
          </span>
          <span className="chip">
            <Icon name="edit" size={11} /> {writeCount} {t.ing_live_writes}
          </span>
          <span className="chip">
            <Icon name="history" size={11} /> {elapsed}
          </span>
        </div>
      </div>
    </div>
  );
}

/** The page shows one card per terminal state; at done and cancelled that
 *  card has the title, so the panel drops its own and the frozen ticker.
 *  The terminal page cards carry their own workflow title. */
export function pageCardCarriesTitle(stage: IngestStage): boolean {
  return stage === "done" || stage === "cancelled" || stage === "error";
}

/** The live line (and empty feed) before any stream event. At the gate the
 *  run waits on the user, so it says so: "Starting Claude…" would be false,
 *  and a blank polite live region announces nothing. */
export function feedIdleLine(stage: IngestStage, t: Strings, status?: WorkflowStatus | null): string {
  if (status && status !== "success") return workflowLabel(status, t);
  return stage === "plan-gate" ? t.ing_gate_waiting : t.ing_live_warmup;
}

// Plan gate card (mockup M4-b): the run is paused at stage "plan-gate" — one
// checkbox per plan item (NOOP pre-unchecked, dimmed at 60% when off), primary
// "apply {n}" resolves the gate with the reviewed selection, ghost "everything
// as planned" resolves with the default (all non-NOOP). Mounted only while the
// gate is open, so the initial selection is computed once on mount.
function PlanGateCard({ t, plan }: { t: Strings; plan: PlanItem[] }): JSX.Element {
  const resolvePlanGate = useIngestStore((s) => s.resolvePlanGate);
  const skipPlanGate = useIngestStore((s) => s.skipPlanGate);
  const sourceText = useIngestStore((s) => s.sourceText);
  const [sel, setSel] = useState<boolean[]>(() => defaultSelection(plan));
  const n = sel.filter(Boolean).length;
  // What "apply all" applies: skipPlanGate's default selection.
  const all = defaultSelection(plan).filter(Boolean).length;
  // The run just paused on this card, usually below the page's other
  // sections — bring it into view once. "nearest", not "start": aligning it
  // to the top scrolled the rail (and its active step) under the sticky
  // topbar, and no scroll margin helps with the hero between the two.
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div
      ref={ref}
      className="card"
      data-testid="ingest-plan-gate"
      style={{ padding: "10px 12px" }}
    >
      <div className="section-title" style={{ fontSize: 13, marginBottom: 2 }}>
        {t.ingest_gate_title}
      </div>
      {plan.some((p) => p.decision === "NOOP") ? (
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
          {t.ingest_gate_noop_hint}
        </div>
      ) : null}
      <div className="col" style={{ gap: 5 }}>
        {plan.map((p, i) => (
          <label
            key={i}
            className="row"
            style={{
              gap: 7,
              alignItems: "baseline",
              fontSize: 12.5,
              flexWrap: "wrap",
              cursor: "pointer",
              opacity: sel[i] ? 1 : 0.6,
            }}
          >
            <input
              type="checkbox"
              checked={sel[i] ?? false}
              onChange={() =>
                setSel((s) => s.map((v, j) => (j === i ? !v : v)))
              }
              style={{ flexShrink: 0 }}
            />
            <span
              className="chip"
              style={{
                flexShrink: 0,
                fontSize: 11,
                fontWeight: 600,
                background: DECISION_BG[p.decision] ?? "var(--bg-soft)",
                color: DECISION_FG[p.decision] ?? "var(--ink-3)",
              }}
            >
              {decisionLabel(t, p.decision)}
            </span>
            <span style={{ minWidth: 0, flex: 1 }}>
              {p.subject}
              {p.target ? <span className="muted"> → {p.target}</span> : null}
              {p.reason ? (
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {" "}
                  · {p.reason}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn btn-primary" onClick={() => resolvePlanGate(sel)}>
          {t.ingest_gate_apply.replace("{n}", String(n))}
        </button>
        <button className="btn btn-ghost" onClick={skipPlanGate}>
          {t.ingest_gate_all.replace("{n}", String(all))}
        </button>
      </div>
      {/* The form that held the text is hidden while the run is up; the
          text stays here, folded, for checking the plan against it. */}
      {sourceText.trim() ? (
        <details className="intake-disclosure" style={{ marginTop: 10 }}>
          <summary>{t.ing_gate_source}</summary>
          <pre
            // Scrolls when long; focusable so a keyboard can scroll it too.
            tabIndex={0}
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "inherit",
              fontSize: 12.5,
              margin: "8px 0 0",
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {sourceText}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

// memo + a stable `ev` identity from the store means an append re-renders one
// row, not the whole feed.
const FeedRow = memo(function FeedRow({ ev }: { ev: IngestEvent }): JSX.Element {
  const icon: IconName =
    ev.kind === "tool"
      ? (TOOL_ICONS[ev.tool ?? ""] ?? "bolt")
      : ev.kind === "text"
        ? "msg"
        : ev.kind === "init"
          ? "bolt"
          : "info";
  const time = new Date(ev.at).toLocaleTimeString(undefined, {
    hour12: false,
  });
  return (
    <div className={`ingest-feed-row kind-${ev.kind}`}>
      <span className="ingest-feed-time">{time}</span>
      <Icon name={icon} size={12} />
      <span className="ingest-feed-text">{describe(ev)}</span>
    </div>
  );
});
