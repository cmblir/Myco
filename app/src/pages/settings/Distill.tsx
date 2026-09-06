// Settings > Distill — the ontology run, its gate and budget, the profile it
// learns, vault history, PII handling and the archive tiers.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { Lang, Strings } from "../../lib/i18n";
import { useUIStore } from "../../stores/uiStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ipc } from "../../lib/ipc";
import type { RawAuditReport, RunSummary } from "../../lib/ipc";
import { formatRunLine } from "../../lib/runList";
import { stepLabel } from "../../components/ActivityChip";
import { SettingsCard } from "../../components/SettingsCard";
import {
  archiveBucketKey,
  backlogTrend,
  GATE_MIN_WIKI_PAGES,
  lastDigestOutcome,
  lastMonthlyOutcome,
  lastWeeklyOutcome,
  lastRunLabel,
  lastStopPoint,
  QUARANTINE_DIR,
  requestDistillStop,
  runDistillGuarded,
} from "../../lib/distill";
import type {
  ArchiveTree,
  BucketUsage,
  DistillConfig,
  DistillStatus,
  DistillStopPoint,
  GatePreset,
  Intensity,
  RunReport,
} from "../../lib/distill";
import { useDistillRunStore } from "../../stores/distillRunStore";
import { loadProfile, saveProfile } from "../../lib/profile";
import type { Profile } from "../../lib/profile";

// Ontology distillation (Task 8, Phase A). Edits DistillConfig — every field
// writes straight through setDistillConfig (no separate save button, matching
// AutoReflect/AutoIngest above). "Distill now" runs distill_run directly and
// shows the RunReport inline (no toast component exists in this app yet).
export function SettingsDistill({ t }: { t: Strings }): JSX.Element {
  const vaultPath = useVaultStore((s) => s.currentVault?.path);
  const lang = useUIStore((s) => s.lang);
  const [cfg, setCfg] = useState<DistillConfig | null>(null);
  const [status, setStatus] = useState<DistillStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<RunReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cooperative stop: `chainRunning` covers a chain started by ANY trigger
  // (schedule, count trigger, this button) — the Stop button must reach all
  // of them; `stopping` is this tab's own "stop already requested" latch.
  const chainRunning = useDistillRunStore((s) => s.running);
  const [stopping, setStopping] = useState(false);
  const [stoppedAfter, setStoppedAfter] = useState<DistillStopPoint | null>(
    null,
  );
  const [undoing, setUndoing] = useState(false);
  const [undoResult, setUndoResult] = useState<number | null>(null);
  // Q4 item 3 — past runs, each with its own undo button.
  const [runs, setRuns] = useState<RunSummary[]>([]);
  // Whether the latest session-digest pass for this vault ran EXTRACTIVELY
  // (builtin-local has no generative model, so it quotes instead of
  // summarizing — see sessionDigest.ts). Successor of Defect E's "skipped —
  // no provider" note: the step no longer skips, so the note now says what
  // ran instead. Same lastDigestOutcome map, same refresh occasions.
  const [digestExtractive, setDigestExtractive] = useState(false);
  // ROADMAP P1 — how many ISO weeks the latest run rolled up, counted here
  // the same way digested days are: the weekly step is a TS-side step, so it
  // is absent from RunReport and read from its own module-level map.
  const [weeksRolledUp, setWeeksRolledUp] = useState(0);
  // Same, one layer further up: months rolled up out of weekly/.
  const [monthsRolledUp, setMonthsRolledUp] = useState(0);

  useEffect(() => {
    if (!vaultPath) return;
    let cancelled = false;
    ipc
      .getDistillConfig(vaultPath)
      .then((c) => {
        if (!cancelled) setCfg(c);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    ipc
      .distillStatus(vaultPath)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => undefined);
    ipc
      .listDistillRuns(vaultPath, 10)
      .then((r) => {
        if (!cancelled) setRuns(r);
      })
      .catch(() => undefined);
    const digest = lastDigestOutcome.get(vaultPath);
    setDigestExtractive(
      digest?.mode === "extractive" && digest.daysDigested > 0,
    );
    setWeeksRolledUp(lastWeeklyOutcome.get(vaultPath)?.bucketsRolledUp ?? 0);
    setMonthsRolledUp(lastMonthlyOutcome.get(vaultPath)?.bucketsRolledUp ?? 0);
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  async function patch(p: Partial<DistillConfig>): Promise<void> {
    if (!vaultPath || !cfg) return;
    const next = { ...cfg, ...p };
    setCfg(next); // optimistic — setDistillConfig has no meaningful failure mode besides IO
    try {
      await ipc.setDistillConfig(vaultPath, next);
    } catch (e) {
      setError(String(e));
    }
  }

  // When the chain winds down — whatever started it (this button, a schedule,
  // the count trigger) — reset the stop latch and read where (if anywhere)
  // that run stopped. Deriving the confirmation here rather than in runNow()
  // is what makes it show for externally-triggered runs too.
  useEffect(() => {
    if (!chainRunning) {
      setStopping(false);
      if (vaultPath) setStoppedAfter(lastStopPoint.get(vaultPath) ?? null);
    }
  }, [chainRunning, vaultPath]);

  async function runNow(): Promise<void> {
    if (!vaultPath || running) return;
    setRunning(true);
    setError(null);
    setStoppedAfter(null);
    try {
      // Goes through the shared guard so this can't interleave with the
      // idle-gated count trigger or a due "distill" schedule running at the
      // same moment — an explicit click always wins the race by asking
      // first, but two runs never overlap.
      const r = await runDistillGuarded(vaultPath);
      if (r === null) {
        setError(t.set_distill_busy ?? "A distill run is already in progress.");
        return;
      }
      setReport(r);
      setStatus(await ipc.distillStatus(vaultPath));
      const digest = lastDigestOutcome.get(vaultPath);
      setDigestExtractive(
        digest?.mode === "extractive" && digest.daysDigested > 0,
      );
      setWeeksRolledUp(lastWeeklyOutcome.get(vaultPath)?.bucketsRolledUp ?? 0);
      setMonthsRolledUp(
        lastMonthlyOutcome.get(vaultPath)?.bucketsRolledUp ?? 0,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  // Important 3 fix + Q4 item 3: mechanical reversal via distill::undo —
  // the last-run button and every past-run row share this one path.
  async function undoRun(id: string): Promise<void> {
    if (!vaultPath || undoing) return;
    setUndoing(true);
    setError(null);
    setUndoResult(null);
    try {
      const n = await ipc.undoDistillRun(vaultPath, id);
      setUndoResult(n);
      setStatus(await ipc.distillStatus(vaultPath));
      setRuns(await ipc.listDistillRuns(vaultPath, 10));
    } catch (e) {
      setError(String(e));
    } finally {
      setUndoing(false);
    }
  }

  async function undoLastRun(): Promise<void> {
    if (!status?.last_run_id) return;
    await undoRun(status.last_run_id);
  }

  if (!cfg) {
    return <div className="muted">{t.set_distill_loading ?? "Loading…"}</div>;
  }

  const trend = status ? backlogTrend(status.last_backlogs) : "flat";
  const trendLabel =
    trend === "shrinking"
      ? (t.set_distill_trend_shrinking ?? "shrinking")
      : trend === "growing"
        ? (t.set_distill_trend_growing ?? "growing")
        : (t.set_distill_trend_flat ?? "flat");

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
          {t.s_distill ?? "Distill"}
        </h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.set_distill_lede ??
            "Periodically folds new pages into the wiki's ontology, archiving what's been absorbed and proposing merges for the rest."}
        </p>
      </div>

      <SettingsCard id="distill_enabled" className="card">
        <div
          className="row"
          style={{ justifyContent: "space-between", alignItems: "flex-start" }}
        >
          <div style={{ paddingRight: 16 }}>
            <div style={{ fontWeight: 600 }}>
              {t.set_distill_enabled_title ?? "Automatic distillation"}
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              {t.set_distill_enabled_desc ??
                "While myco is open and you're idle, distill the backlog on its own schedule."}
            </div>
          </div>
          <button
            role="switch"
            aria-checked={cfg.enabled}
            aria-label={t.set_distill_enabled_title ?? "Automatic distillation"}
            onClick={() => void patch({ enabled: !cfg.enabled })}
            style={{
              width: 44,
              height: 24,
              borderRadius: 12,
              border: "1px solid var(--line)",
              background: cfg.enabled ? "var(--ink)" : "var(--bg-soft)",
              position: "relative",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: cfg.enabled ? 22 : 2,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: cfg.enabled ? "var(--bg)" : "var(--ink-3)",
                transition: "left 150ms",
              }}
            />
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 500 }}>
            {t.set_distill_intensity ?? "Intensity"}
          </label>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            {(
              [
                ["conservative", t.set_distill_intensity_conservative],
                ["standard", t.set_distill_intensity_standard],
                ["aggressive", t.set_distill_intensity_aggressive],
              ] as [Intensity, string | undefined][]
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={"btn" + (cfg.intensity === v ? " btn-primary" : "")}
                onClick={() => void patch({ intensity: v })}
              >
                {label ?? v}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 500 }}>
            {t.set_distill_gate ?? "Gate preset"}
          </label>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            {(
              [
                ["strict", t.set_distill_gate_strict],
                ["normal", t.set_distill_gate_normal],
                ["loose", t.set_distill_gate_loose],
              ] as [GatePreset, string | undefined][]
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={
                  "btn" + (cfg.gate_preset === v ? " btn-primary" : "")
                }
                onClick={() => void patch({ gate_preset: v })}
              >
                {label ?? v}
              </button>
            ))}
          </div>
        </div>

        <div
          className="row"
          style={{ gap: 16, marginTop: 16, flexWrap: "wrap" }}
        >
          <DistillNumField
            label={t.set_distill_count_trigger ?? "Backlog count trigger"}
            value={cfg.count_trigger}
            min={0}
            onChange={(n) => void patch({ count_trigger: n })}
          />
          <DistillNumField
            label={t.set_distill_ttl ?? "Quarantine TTL (days)"}
            value={cfg.quarantine_ttl_days}
            min={1}
            onChange={(n) => void patch({ quarantine_ttl_days: n })}
          />
          <DistillNumField
            label={t.set_distill_budget ?? "Run budget (items)"}
            value={cfg.run_budget_items}
            min={1}
            onChange={(n) => void patch({ run_budget_items: n })}
          />
          <DistillNumField
            label={t.set_distill_idle_minutes ?? "Idle minutes"}
            value={cfg.idle_minutes}
            min={1}
            onChange={(n) => void patch({ idle_minutes: n })}
          />
          <DistillNumField
            label={t.set_distill_maturation ?? "Maturation (hours)"}
            value={cfg.maturation_hours}
            min={0}
            onChange={(n) => void patch({ maturation_hours: n })}
          />
          <DistillNumField
            label={t.set_distill_llm_digest_days ?? "Digest days per run"}
            value={cfg.llm_digest_days}
            min={0}
            onChange={(n) => void patch({ llm_digest_days: n })}
          />
          <DistillNumField
            label={
              t.set_distill_llm_ingest_budget ??
              "LLM item budget per run (ingest + map drafts combined)"
            }
            value={cfg.llm_ingest_budget}
            min={0}
            onChange={(n) => void patch({ llm_ingest_budget: n })}
          />
        </div>

        {/* profile_injection — the privacy toggle profile.md's own header
            comment points at ("Sent to configured AI providers when profile
            injection is on"); without this row it was config-file-only. */}
        <div
          className="row"
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid var(--line)",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div style={{ paddingRight: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {t.set_distill_profile_injection_title ?? "Profile injection"}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
              {t.set_distill_profile_injection_desc ??
                "Send profile.md to configured AI providers as Ask/ingest context. Off keeps the profile local-only."}
            </div>
          </div>
          <button
            role="switch"
            aria-checked={cfg.profile_injection}
            aria-label={
              t.set_distill_profile_injection_title ?? "Profile injection"
            }
            data-testid="profile-injection-toggle"
            onClick={() =>
              void patch({ profile_injection: !cfg.profile_injection })
            }
            style={{
              width: 44,
              height: 24,
              borderRadius: 12,
              border: "1px solid var(--line)",
              background: cfg.profile_injection
                ? "var(--ink)"
                : "var(--bg-soft)",
              position: "relative",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: cfg.profile_injection ? 22 : 2,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: cfg.profile_injection
                  ? "var(--bg)"
                  : "var(--ink-3)",
                transition: "left 150ms",
              }}
            />
          </button>
        </div>
      </SettingsCard>

      <SettingsProfile t={t} vaultPath={vaultPath} />

      <SettingsCard id="distill_status" className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div style={{ fontWeight: 600 }}>
            {t.set_distill_status_title ?? "Status"}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            {status
              ? (t.set_distill_backlog ?? "Backlog: {n}").replace(
                  "{n}",
                  String(status.backlog),
                )
              : "—"}
          </span>
        </div>
        {status ? (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            {(t.set_distill_pending ?? "{n} pending proposals").replace(
              "{n}",
              String(status.pending_proposals),
            )}{" "}
            · {trendLabel}
          </div>
        ) : null}
        {status && !status.gate_active ? (
          // Defect D fix: the cold-start gate (scan()'s early return) was
          // previously an eprintln!-only no-op — this is the plain-language
          // explanation with real numbers.
          <div
            style={{ fontSize: 12.5, marginTop: 6 }}
            data-testid="distill-gate-pending"
          >
            {(
              t.set_distill_gate_pending ??
              "Distill waiting: wiki pages {n}/{min}"
            )
              .replace("{n}", String(status.wiki_pages))
              .replace("{min}", String(GATE_MIN_WIKI_PAGES))}
          </div>
        ) : null}
        {digestExtractive ? (
          // The digest ran, but extractively (quotes, no LLM) — say so, and
          // name the setting that upgrades it to real summaries.
          <div
            style={{ fontSize: 12.5, marginTop: 6 }}
            data-testid="distill-digest-extractive"
          >
            {t.set_distill_digest_extractive ??
              "Session digest ran extractively (quoted highlights, no LLM). Connect a query provider under Settings → Model (Query) for summarized digests."}
          </div>
        ) : null}
        {weeksRolledUp > 0 ? (
          // The second compression layer's own count — the report line below
          // comes from RunReport, which the TS-side weekly step is not part of.
          <div
            className="muted"
            style={{ fontSize: 12.5, marginTop: 6 }}
            data-testid="distill-weekly-rollups"
          >
            {(
              t.set_distill_weekly_rollups ??
              "{n} weekly rollups written to weekly/"
            ).replace("{n}", String(weeksRolledUp))}
          </div>
        ) : null}
        {monthsRolledUp > 0 ? (
          // Third layer, reported on its own line: weekly and monthly count
          // different units, so summing them would say neither.
          <div
            className="muted"
            style={{ fontSize: 12.5, marginTop: 6 }}
            data-testid="distill-monthly-rollups"
          >
            {(
              t.set_distill_monthly_rollups ??
              "{n} monthly rollups written to monthly/"
            ).replace("{n}", String(monthsRolledUp))}
          </div>
        ) : null}
        {status && status.quarantined > 0 ? (
          // Defect G fix: quarantined items were moved with no indication
          // anywhere in the UI — read-only count + the folder path.
          <div
            className="muted"
            style={{ fontSize: 12.5, marginTop: 6 }}
            data-testid="distill-quarantine-count"
          >
            {(
              t.set_distill_quarantined ?? "{n} items awaiting review in {path}"
            )
              .replace("{n}", String(status.quarantined))
              .replace("{path}", QUARANTINE_DIR)}
          </div>
        ) : null}
        {status?.last_run_id ? (
          <div
            className="row"
            style={{
              gap: 10,
              marginTop: 6,
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span className="muted" style={{ fontSize: 12.5 }}>
              {status.last_run !== null
                ? (t.ov_distill_last_run ?? "Last run {t}").replace(
                    "{t}",
                    lastRunLabel(status.last_run, lang) ?? "",
                  )
                : null}
            </span>
            <button
              className="btn"
              onClick={() => void undoLastRun()}
              disabled={undoing || !vaultPath}
              aria-busy={undoing}
              data-testid="distill-undo-btn"
            >
              {undoing
                ? (t.set_distill_undoing ?? "Undoing…")
                : (t.set_distill_undo ?? "Undo this run")}
            </button>
          </div>
        ) : null}
        {undoResult !== null ? (
          <div
            style={{ color: "#16a34a", fontSize: 12, marginTop: 8 }}
            data-testid="distill-undo-result"
          >
            {(t.set_distill_undo_result ?? "Reversed {n} changes").replace(
              "{n}",
              String(undoResult),
            )}
          </div>
        ) : null}
        {runs.length > 0 ? (
          <div style={{ marginTop: 10 }} data-testid="distill-run-list">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              {t.set_runs_title ?? "Past runs"}
            </div>
            {runs.map((r) => (
              <div
                key={r.id}
                className="row"
                style={{
                  justifyContent: "space-between",
                  padding: "6px 0",
                  borderBottom: "1px solid var(--line-soft)",
                }}
              >
                <span
                  className="muted"
                  style={{ fontSize: 12.5, fontFamily: "var(--font-mono)" }}
                >
                  {r.id}
                </span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {formatRunLine(r, lang)}
                </span>
                <button
                  className="btn"
                  style={{ padding: "3px 8px", fontSize: 11.5 }}
                  onClick={() => void undoRun(r.id)}
                  disabled={undoing}
                  data-testid={`run-undo-${r.id}`}
                >
                  {t.set_distill_undo ?? "Undo this run"}
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button
            className="btn btn-primary"
            onClick={() => void runNow()}
            disabled={running || !vaultPath}
            aria-busy={running}
            data-testid="distill-run-btn"
          >
            {running
              ? (t.set_distill_running ?? "Distilling…")
              : (t.set_distill_run_now ?? "Distill now")}
          </button>
          {chainRunning && vaultPath ? (
            // Cooperative stop: sets a flag the chain checks BETWEEN steps
            // (requestDistillStop) — the in-flight LLM call always finishes,
            // hence "stopping after the current step", not "stopped".
            <button
              className="btn"
              onClick={() => {
                requestDistillStop(vaultPath);
                setStopping(true);
              }}
              disabled={stopping}
              data-testid="distill-stop-btn"
            >
              {stopping
                ? (t.set_distill_stopping ?? "Stopping after the current step…")
                : (t.set_distill_stop ?? "Stop")}
            </button>
          ) : null}
        </div>
        {stoppedAfter ? (
          <div
            className="muted"
            style={{ fontSize: 12, marginTop: 8 }}
            data-testid="distill-stopped"
          >
            {(t.set_distill_stopped ?? "Stopped after {step}").replace(
              "{step}",
              // stepLabel (shared with the activity chip + tray) names every
              // stop point — the old inline ternary mislabeled monthly/maps
              // as the ingest step.
              stepLabel(stoppedAfter, t),
            )}
          </div>
        ) : null}
        {report ? (
          <div
            style={{ color: "#16a34a", fontSize: 12, marginTop: 8 }}
            data-testid="distill-report"
          >
            {(
              t.set_distill_report ??
              "Archived {a}, trashed {tr}, {p} proposals — backlog now {b}"
            )
              .replace("{a}", String(report.archived))
              .replace("{tr}", String(report.trashed))
              .replace("{p}", String(report.proposals))
              .replace("{b}", String(report.backlog_after))}
          </div>
        ) : null}
        {error ? (
          <div style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}>
            {error}
          </div>
        ) : null}
      </SettingsCard>

      <SettingsArchive t={t} lang={lang} vaultPath={vaultPath} />

      <VaultHistoryToggle t={t} vaultPath={vaultPath} />

      <PiiModeCard t={t} />

      <RawAuditCard t={t} vaultPath={vaultPath} />
    </div>
  );
}

// Opt-in vault git history (Q4 item 1, mockup M2-b). Turning ON initializes
// the repo (idempotent, flips the flag Rust-side); turning OFF only stops
// commits — the repo stays.
// Opt-in vault git history (Q4 item 1, mockup M2-b). Turning ON initializes
// the repo (idempotent, flips the flag Rust-side); turning OFF only stops
// commits — the repo stays.
function VaultHistoryToggle({
  t,
  vaultPath,
}: {
  t: Strings;
  vaultPath?: string;
}): JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const loadSettings = useSettingsStore((s) => s.load);
  if (!settings) return null;
  const enabled = settings.vault_history_enabled;
  return (
    <SettingsCard id="distill_history" className="card">
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div style={{ paddingRight: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {t.vh_setting_title ?? "Vault history (git)"}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
            {t.vh_setting_desc ??
              "Creates a local git repo inside the vault. Agent commits and your edits are recorded as different authors. Nothing leaves this machine."}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={t.vh_setting_title ?? "Vault history (git)"}
          data-testid="vault-history-toggle"
          onClick={() => {
            if (enabled) {
              void update({ vault_history_enabled: false });
            } else if (vaultPath) {
              void ipc.initVaultHistory(vaultPath).then(() => loadSettings());
            }
          }}
          style={{
            width: 44,
            height: 24,
            borderRadius: 12,
            border: "1px solid var(--line)",
            background: enabled ? "var(--ink)" : "var(--bg-soft)",
            position: "relative",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: enabled ? 22 : 2,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: enabled ? "var(--bg)" : "var(--ink)",
              transition: "left 150ms ease",
            }}
          />
        </button>
      </div>
    </SettingsCard>
  );
}

// Q4 item 13, mockup M8-b — what happens when a raw/-bound source contains
// PII. Secrets are always refused; this segmented control only chooses the
// PII response (warn-only vs quarantine), backed by `pii_quarantine_enabled`.
// Q4 item 13, mockup M8-b — what happens when a raw/-bound source contains
// PII. Secrets are always refused; this segmented control only chooses the
// PII response (warn-only vs quarantine), backed by `pii_quarantine_enabled`.
function PiiModeCard({ t }: { t: Strings }): JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  if (!settings) return null;
  const quarantine = settings.pii_quarantine_enabled;
  return (
    <SettingsCard id="distill_pii" className="card">
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div style={{ paddingRight: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {t.set_pii_title ?? "When PII is detected"}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
            {t.set_pii_desc ??
              "With Quarantine, sources containing emails or phone numbers stay in _inbox instead of being written to permanent storage. Secrets like API keys are always blocked either way."}
          </div>
        </div>
        <div
          className="segmented"
          role="tablist"
          aria-label={t.set_pii_title ?? "When PII is detected"}
          data-testid="pii-mode-segmented"
        >
          <button
            className={!quarantine ? "active" : ""}
            onClick={() => void update({ pii_quarantine_enabled: false })}
          >
            {t.set_pii_warn ?? "Warn only"}
          </button>
          <button
            className={quarantine ? "active" : ""}
            onClick={() => void update({ pii_quarantine_enabled: true })}
          >
            {t.set_pii_quarantine ?? "Quarantine"}
          </button>
        </div>
      </div>
    </SettingsCard>
  );
}

// Q4 item 14, mockup M8-c — read-only audit of raw/ (current files + git
// history) for secrets and PII. Report only: the app never rewrites raw/;
// remediation is the documented external procedure. History-only hits have no
// file left on disk, so nothing here offers to open anything.
// Q4 item 14, mockup M8-c — read-only audit of raw/ (current files + git
// history) for secrets and PII. Report only: the app never rewrites raw/;
// remediation is the documented external procedure. History-only hits have no
// file left on disk, so nothing here offers to open anything.
function RawAuditCard({
  t,
  vaultPath,
}: {
  t: Strings;
  vaultPath?: string;
}): JSX.Element {
  const [report, setReport] = useState<RawAuditReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    if (!vaultPath || busy) return;
    setBusy(true);
    setError(null);
    ipc
      .scanRawAudit(vaultPath)
      .then(setReport)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  const hits = report
    ? [
        ...report.secret_hits.map((h) => ({ ...h, tier: "secret" })),
        ...report.pii_hits.map((h) => ({ ...h, tier: "pii" })),
      ]
    : [];
  return (
    <SettingsCard id="distill_audit" className="card">
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {t.set_audit_title ?? "raw/ secret audit"}
        </div>
        <button
          className="btn"
          onClick={run}
          disabled={busy || !vaultPath}
          data-testid="raw-audit-rescan"
        >
          {t.set_audit_rescan ?? "Rescan"}
        </button>
      </div>
      {report && hits.length === 0 ? (
        <div
          style={{ color: "#16a34a", fontSize: 12, marginTop: 8 }}
          data-testid="raw-audit-clean"
        >
          {(t.set_audit_clean ?? "{n} files · {m} in history — 0 secrets")
            .replace("{n}", String(report.files_scanned))
            .replace("{m}", String(report.history_files_scanned))}
        </div>
      ) : null}
      {hits.length > 0 ? (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
          data-testid="raw-audit-hits"
        >
          {hits.map((h) => (
            <div key={`${h.tier}:${h.rel}`} style={{ fontSize: 12 }}>
              <span>{h.rel}</span>
              <span className="muted"> — {h.patterns.join(", ")}</span>
              {h.in_history_only ? (
                <span className="chip" style={{ marginLeft: 6 }}>
                  {t.set_audit_history_only ?? "History only"}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {error ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}>
          {error}
        </div>
      ) : null}
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        {t.set_audit_note ??
          "The audit is read-only. The app never rewrites raw/; cleanup follows the documented procedure."}
      </div>
    </SettingsCard>
  );
}

/** Bytes in the viewer's locale — `Intl` picks the separator, not us. */
/** Bytes in the viewer's locale — `Intl` picks the separator, not us. */
function formatBytes(bytes: number, lang: Lang): string {
  const useMb = bytes >= 1_000_000;
  return new Intl.NumberFormat(lang, {
    style: "unit",
    unit: useMb ? "megabyte" : "kilobyte",
    maximumFractionDigits: 1,
  }).format(useMb ? bytes / 1_000_000 : bytes / 1000);
}

/**
 * ROADMAP P2 — archive storage panel. Measures `sessions/archive/` and
 * `daily/archive/`, and offers the two explicit actions over them: compress a
 * bucket older than N months into one zip, and restore a compressed bucket.
 * `raw/` is neither measured nor reachable from here (see archive_pack.rs).
 *
 * Measurement is on demand only — once when the tab mounts, and after an
 * action changes the numbers. Never on render.
 */
/**
 * ROADMAP P2 — archive storage panel. Measures `sessions/archive/` and
 * `daily/archive/`, and offers the two explicit actions over them: compress a
 * bucket older than N months into one zip, and restore a compressed bucket.
 * `raw/` is neither measured nor reachable from here (see archive_pack.rs).
 *
 * Measurement is on demand only — once when the tab mounts, and after an
 * action changes the numbers. Never on render.
 */
function SettingsArchive({
  t,
  lang,
  vaultPath,
}: {
  t: Strings;
  lang: Lang;
  vaultPath: string | undefined;
}): JSX.Element {
  const [usage, setUsage] = useState<BucketUsage[] | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [months, setMonths] = useState(3);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const measure = useMemo(
    () => async (): Promise<void> => {
      if (!vaultPath) return;
      setMeasuring(true);
      setError(null);
      try {
        setUsage(await ipc.archiveUsage(vaultPath));
      } catch (e) {
        setError(String(e));
      } finally {
        setMeasuring(false);
      }
    },
    [vaultPath],
  );

  useEffect(() => {
    void measure();
  }, [measure]);

  async function compress(): Promise<void> {
    if (!vaultPath) return;
    setBusy("compress");
    setError(null);
    setNote(null);
    setFailed([]);
    try {
      const r = await ipc.compressArchives(vaultPath, months);
      setFailed(r.failed);
      setNote(
        r.buckets === 0 && r.failed.length === 0
          ? (
              t.set_archive_nothing_old ?? "Nothing is older than {n} months."
            ).replace("{n}", String(months))
          : (
              t.set_archive_compressed ??
              "Compressed {buckets} buckets ({files} files), reclaimed {size}"
            )
              .replace("{buckets}", String(r.buckets))
              .replace("{files}", String(r.files))
              .replace("{size}", formatBytes(r.reclaimed, lang)),
      );
      await measure();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function restore(tree: ArchiveTree, bucket: string): Promise<void> {
    if (!vaultPath) return;
    setBusy(`${tree}/${bucket}`);
    setError(null);
    setNote(null);
    setFailed([]);
    try {
      const r = await ipc.restoreArchiveBucket(vaultPath, tree, bucket);
      setNote(
        (t.set_archive_restored ?? "Restored {n} files to {bucket}")
          .replace("{n}", String(r.files))
          .replace("{bucket}", bucket),
      );
      await measure();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const totals = (usage ?? []).reduce(
    (acc, b) => ({ files: acc.files + b.files, bytes: acc.bytes + b.bytes }),
    { files: 0, bytes: 0 },
  );

  return (
    <SettingsCard id="distill_archive" className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div style={{ fontWeight: 600 }}>
          {t.set_archive_title ?? "Archive storage"}
        </div>
        <button
          className="btn"
          onClick={() => void measure()}
          disabled={measuring || !vaultPath}
          aria-busy={measuring}
          data-testid="archive-measure-btn"
        >
          {measuring
            ? (t.set_archive_measuring ?? "Measuring…")
            : (t.set_archive_measure ?? "Measure")}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
        {t.set_archive_lede ??
          "Digested sessions and rolled-up daily notes are kept forever in sessions/archive/ and daily/archive/. Compressing an old bucket packs it into a single zip you can restore at any time. raw/ is never touched."}
      </p>

      {usage === null ? null : usage.length === 0 ? (
        <div
          className="muted"
          style={{ fontSize: 12.5, marginTop: 10 }}
          data-testid="archive-empty"
        >
          {t.set_archive_empty ?? "Nothing archived yet."}
        </div>
      ) : (
        <>
          <div
            style={{ fontSize: 12.5, marginTop: 10, fontWeight: 600 }}
            data-testid="archive-total"
          >
            {(
              t.set_archive_total ??
              "{files} files, {size} across {buckets} buckets"
            )
              .replace("{files}", String(totals.files))
              .replace("{size}", formatBytes(totals.bytes, lang))
              .replace("{buckets}", String(usage.length))}
          </div>
          <ul
            className="col"
            style={{ gap: 4, margin: "8px 0 0", padding: 0, listStyle: "none" }}
            data-testid="archive-buckets"
          >
            {usage.map((b) => (
              <li
                key={archiveBucketKey(b)}
                className="row"
                style={{ gap: 8, alignItems: "center", fontSize: 12.5 }}
              >
                <span className="muted" style={{ minWidth: 72 }}>
                  {b.tree === "sessions"
                    ? (t.set_archive_tree_sessions ?? "Sessions")
                    : b.tree === "weekly"
                      ? (t.set_archive_tree_weekly ?? "Weekly")
                      : (t.set_archive_tree_daily ?? "Daily")}
                </span>
                <span style={{ minWidth: 78 }}>{b.bucket}</span>
                <span className="muted" style={{ flex: 1 }}>
                  {b.files} · {formatBytes(b.bytes, lang)}
                  {b.packed ? ` · ${t.set_archive_packed ?? "compressed"}` : ""}
                </span>
                {b.packed ? (
                  <button
                    className="btn"
                    onClick={() => void restore(b.tree, b.bucket)}
                    disabled={busy !== null || !vaultPath}
                    aria-busy={busy === `${b.tree}/${b.bucket}`}
                  >
                    {busy === `${b.tree}/${b.bucket}`
                      ? (t.set_archive_restoring ?? "Restoring…")
                      : (t.set_archive_restore ?? "Restore")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      <div
        className="row"
        style={{ gap: 10, marginTop: 12, alignItems: "flex-end" }}
      >
        <DistillNumField
          label={(
            t.set_archive_older_than ?? "Compress buckets older than {n} months"
          ).replace("{n}", String(months))}
          value={months}
          min={1}
          onChange={setMonths}
        />
        <button
          className="btn"
          onClick={() => void compress()}
          disabled={busy !== null || !vaultPath}
          aria-busy={busy === "compress"}
          data-testid="archive-compress-btn"
        >
          {busy === "compress"
            ? (t.set_archive_compressing ?? "Compressing…")
            : (t.set_archive_compress ?? "Compress")}
        </button>
      </div>

      {note ? (
        <div
          style={{ color: "#16a34a", fontSize: 12, marginTop: 8 }}
          data-testid="archive-note"
        >
          {note}
        </div>
      ) : null}
      {failed.length > 0 ? (
        <div
          style={{ fontSize: 12, marginTop: 6 }}
          data-testid="archive-failed"
        >
          {(t.set_archive_failed ?? "Left untouched: {list}").replace(
            "{list}",
            failed.join("; "),
          )}
        </div>
      ) : null}
      {error ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}>
          {error}
        </div>
      ) : null}
    </SettingsCard>
  );
}

const EMPTY_PROFILE: Profile = {
  role: "",
  goals: [],
  interests: [],
  style: "",
};

/** `profile.md` editor (Phase B, Task 5) — lives in the Distill tab, not its
 *  own tab: the profile weights distillation priorities (identity layer,
 *  `ontology::admit`) and, per its own header comment written to disk, the
 *  same "Settings → 증류" surface, so a second top-level tab would just be a
 *  second place to look for the one thing this file already covers. Goals
 *  and interests are edited as one item per line — the round-trip with
 *  `profile.ts`'s bullet-list format happens on save/load, not per keystroke. */
/** `profile.md` editor (Phase B, Task 5) — lives in the Distill tab, not its
 *  own tab: the profile weights distillation priorities (identity layer,
 *  `ontology::admit`) and, per its own header comment written to disk, the
 *  same "Settings → 증류" surface, so a second top-level tab would just be a
 *  second place to look for the one thing this file already covers. Goals
 *  and interests are edited as one item per line — the round-trip with
 *  `profile.ts`'s bullet-list format happens on save/load, not per keystroke. */
function SettingsProfile({
  t,
  vaultPath,
}: {
  t: Strings;
  vaultPath: string | undefined;
}): JSX.Element | null {
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vaultPath) return;
    let cancelled = false;
    setLoaded(false);
    loadProfile(vaultPath)
      .then((p) => {
        if (!cancelled) setProfile(p ?? EMPTY_PROFILE);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  async function save(): Promise<void> {
    if (!vaultPath) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await saveProfile(vaultPath, profile);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const linesOf = (s: string): string[] =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  if (!vaultPath || !loaded) return null;

  return (
    <SettingsCard id="distill_profile" className="card">
      <div style={{ fontWeight: 600 }}>{t.set_profile_title ?? "Profile"}</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        {t.set_profile_lede ??
          "Personalizes distillation and Ask/ingest context. Written to profile.md; sent to configured AI providers when injection is on."}
      </p>
      <div className="col" style={{ gap: 12, marginTop: 12 }}>
        <div className="field">
          <label>{t.set_profile_role ?? "Role"}</label>
          <input
            className="input"
            value={profile.role}
            onChange={(e) => setProfile({ ...profile, role: e.target.value })}
          />
        </div>
        <div className="field">
          <label>{t.set_profile_goals ?? "Goals (one per line)"}</label>
          <textarea
            className="textarea"
            rows={3}
            value={profile.goals.join("\n")}
            onChange={(e) =>
              setProfile({ ...profile, goals: linesOf(e.target.value) })
            }
          />
        </div>
        <div className="field">
          <label>{t.set_profile_interests ?? "Interests (one per line)"}</label>
          <textarea
            className="textarea"
            rows={3}
            value={profile.interests.join("\n")}
            onChange={(e) =>
              setProfile({ ...profile, interests: linesOf(e.target.value) })
            }
          />
        </div>
        <div className="field">
          <label>{t.set_profile_style ?? "Working style"}</label>
          <input
            className="input"
            value={profile.style}
            onChange={(e) => setProfile({ ...profile, style: e.target.value })}
          />
        </div>
      </div>
      <div
        className="row"
        style={{ gap: 10, marginTop: 12, alignItems: "center" }}
      >
        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving
            ? (t.set_profile_saving ?? "Saving…")
            : (t.set_profile_save ?? "Save")}
        </button>
        {saved ? (
          <span className="muted" style={{ fontSize: 12 }}>
            {t.set_profile_saved ?? "Saved"}
          </span>
        ) : null}
      </div>
      {error ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}>
          {error}
        </div>
      ) : null}
    </SettingsCard>
  );
}

function DistillNumField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (n: number) => void;
}): JSX.Element {
  return (
    <div className="field" style={{ minWidth: 140 }}>
      <label style={{ fontSize: 12.5 }}>{label}</label>
      <input
        className="input"
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(Math.max(min, Number(e.target.value) || min))}
      />
    </div>
  );
}
