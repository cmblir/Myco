// Settings > Model — the query/ingest model pickers, the semantic index and
// the schedulers that run while the app is open.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../../lib/icons";
import type { Strings } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { ipc } from "../../lib/ipc";
import type { MycoSettings } from "../../lib/ipc";
import {
  CLI_DEFAULT,
  providerCanIngest,
  useEnabledProviders,
} from "../../lib/providers";
import type { ProviderDef } from "../../lib/providers";
import ModelSelect from "../../components/ModelSelect";
import {
  getBudgetThreshold,
  getUsage,
  setBudgetThreshold,
  DEFAULT_MONTHLY_THRESHOLD_USD,
} from "../../lib/budget";
import { SettingsCard } from "../../components/SettingsCard";
import { useReindexStore } from "../../stores/reindexStore";

export function SettingsModel({ t }: { t: Strings }): JSX.Element {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const enabled = useEnabledProviders();

  if (!settings) return <div className="muted">Loading…</div>;

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
          {t.s_model}
        </h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.s_model_lede}
        </p>
      </div>
      <ModelPicker
        t={t}
        rowId="model_query"
        label={t.s_model_query}
        providers={enabled}
        provider={settings.query_provider}
        model={settings.query_model}
        effort={settings.query_effort}
        onPick={(provider, model) =>
          void update({ query_provider: provider, query_model: model })
        }
        onPickEffort={(effort) => void update({ query_effort: effort })}
      />
      <ModelPicker
        t={t}
        rowId="model_ingest"
        label={t.s_model_ingest}
        // Ingest writes vault files; a text-only provider (builtin, HTTP APIs,
        // ollama) can only fail after the raw/ copy is already written — so it
        // is not offered here. A stored incapable choice still displays,
        // marked not-connected (ModelSelect never silently rewrites).
        providers={enabled.filter((p) => providerCanIngest(p.id))}
        provider={settings.ingest_provider}
        model={settings.ingest_model}
        effort={settings.ingest_effort}
        onPick={(provider, model) =>
          void update({ ingest_provider: provider, ingest_model: model })
        }
        onPickEffort={(effort) => void update({ ingest_effort: effort })}
      />
      <AutoImportSetting t={t} settings={settings} update={update} />
      <AutoIngestSetting t={t} settings={settings} update={update} />
      <AutoReflectSetting t={t} settings={settings} update={update} />
      <BudgetSetting t={t} />
      <EmbeddingsSetting t={t} />
    </div>
  );
}

// Semantic layer (Feature 1): index health + a manual reindex. Embeddings run
// offline via the bundled Gemma model. Powers semantic search, related notes,
// and graph similarity edges.
//
// The run itself lives in reindexStore, not here: it takes minutes, so it
// outlives this panel routinely, and state that dies with the panel let a second
// run start against the same index. This component renders the store's five
// states and re-attaches to a run already in flight.
function ModelPicker({
  t,
  rowId,
  label,
  providers,
  provider,
  model,
  effort,
  onPick,
  onPickEffort,
}: {
  t: Strings;
  /** Registry row id — "model_query" or "model_ingest". */
  rowId: string;
  label: string;
  providers: ProviderDef[];
  provider: string;
  model: string;
  effort: string;
  onPick: (provider: string, model: string) => void;
  onPickEffort: (effort: string) => void;
}): JSX.Element {
  return (
    <SettingsCard id={rowId} hideValue className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
          {provider} · {model}
          {effort && effort !== CLI_DEFAULT ? ` · ${effort}` : ""}
        </span>
      </div>
      <ModelSelect
        t={t}
        providers={providers}
        provider={provider}
        model={model}
        onPick={onPick}
        effort={effort}
        onPickEffort={onPickEffort}
      />
    </SettingsCard>
  );
}

// myco Pro signs in with the account created on the website (email + password);
// the app fetches and stores the account's access key automatically — the user
// never copies a key by hand. Settings is the single source of truth for the
// logged-in email + connection flag (the Rust login command persists both).
// Semantic layer (Feature 1): index health + a manual reindex. Embeddings run
// offline via the bundled Gemma model. Powers semantic search, related notes,
// and graph similarity edges.
//
// The run itself lives in reindexStore, not here: it takes minutes, so it
// outlives this panel routinely, and state that dies with the panel let a second
// run start against the same index. This component renders the store's five
// states and re-attaches to a run already in flight.
function EmbeddingsSetting({ t }: { t: Strings }): JSX.Element {
  const [status, setStatus] = useState<{
    indexed_pages: number;
    model: string;
  } | null>(null);
  const stage = useReindexStore((s) => s.stage);
  const done = useReindexStore((s) => s.done);
  const total = useReindexStore((s) => s.total);
  const page = useReindexStore((s) => s.page);
  const indexed = useReindexStore((s) => s.indexed);
  const error = useReindexStore((s) => s.error);
  const reindex = useReindexStore((s) => s.reindex);
  const busy = stage === "loading-model" || stage === "indexing";

  const refresh = (): void => {
    ipc
      .embeddingsStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  };
  useEffect(refresh, []);
  // Refresh the page count when a run finishes — including a run that finished
  // while this panel was unmounted.
  useEffect(() => {
    if (stage === "done") refresh();
  }, [stage]);

  const pct =
    stage === "indexing" && total > 0 ? Math.round((done / total) * 100) : 0;

  const label = (): string => {
    if (stage === "loading-model")
      return t.s_embeddings_loading_model ?? "Loading model…";
    if (stage === "indexing") {
      return `${t.s_embeddings_indexing ?? "Indexing…"} ${done}/${total}`;
    }
    return t.s_embeddings_reindex ?? "Reindex now";
  };

  return (
    <SettingsCard id="model_embeddings" hideValue className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div style={{ fontWeight: 600 }}>
          {t.s_embeddings ?? "Semantic search"}
        </div>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
          {status
            ? status.indexed_pages > 0
              ? `${status.indexed_pages} ${t.s_embeddings_indexed ?? "pages indexed"}`
              : (t.s_embeddings_empty ?? "Not indexed yet")
            : "—"}
        </span>
      </div>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
        {t.s_embeddings_lede ??
          "Build an on-device embedding index for semantic search, related notes, and graph similarity. Runs offline."}
      </p>
      <button
        className="btn"
        onClick={() => void reindex()}
        disabled={busy}
        data-testid="reindex-btn"
        aria-busy={busy}
      >
        {label()}
      </button>

      {/* A determinate bar once pages start arriving; the model load has no
          progress to report, so it stays a text state rather than a fake bar. */}
      {stage === "indexing" ? (
        <div style={{ marginTop: 10 }} data-testid="reindex-progress">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={t.s_embeddings_indexing ?? "Indexing…"}
            style={{
              height: 4,
              borderRadius: 999,
              background: "var(--border, #e5e7eb)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: "var(--accent, #2563eb)",
                transition: "width 150ms linear",
              }}
            />
          </div>
          <div
            className="muted"
            style={{
              fontSize: 11,
              marginTop: 4,
              // A long vault path must not stretch the card or wrap to a
              // second line that shifts everything below it.
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {page}
          </div>
        </div>
      ) : null}

      {stage === "loading-model" ? (
        <div
          className="muted"
          style={{ fontSize: 12, marginTop: 8 }}
          data-testid="reindex-loading"
        >
          {t.s_embeddings_loading_model_hint ??
            "First run loads the bundled model — this takes a few seconds."}
        </div>
      ) : null}

      {stage === "done" ? (
        <div
          style={{ color: "#16a34a", fontSize: 12, marginTop: 8 }}
          data-testid="reindex-done"
        >
          {(t.s_embeddings_done ?? "Indexed {n} pages").replace(
            "{n}",
            String(indexed),
          )}
        </div>
      ) : null}

      {stage === "error" ? (
        <div
          style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}
          data-testid="reindex-error"
        >
          {error}
        </div>
      ) : null}

      <AutoReindexToggle t={t} />
      <ArchivedSessionsToggle t={t} />
    </SettingsCard>
  );
}

// Lives inside the Semantic search card rather than beside the other auto-*
// switches: what it keeps up to date is the index built right above it, and the
// hint below only makes sense next to that button.
// Lives inside the Semantic search card rather than beside the other auto-*
// switches: what it keeps up to date is the index built right above it, and the
// hint below only makes sense next to that button.
function AutoReindexToggle({ t }: { t: Strings }): JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  if (!settings) return null;
  const enabled = settings.auto_reindex_enabled;
  return (
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
          {t.s_autoreindex_title ?? "Keep the index up to date"}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
          {t.s_autoreindex_desc ??
            "While myco is open, re-embed pages you edit once you stop typing. Only pages that changed are re-embedded."}
        </div>
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        aria-label={t.s_autoreindex_title ?? "Keep the index up to date"}
        data-testid="auto-reindex-toggle"
        onClick={() => void update({ auto_reindex_enabled: !enabled })}
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
  );
}

// Ask's session scope over `sessions/archive/` — the cold tier `is_cold()`
// keeps out of the index, so turning this on rebuilds it (the run shows in
// the card above, like any reindex). Off by default: reviving every archived
// log on a session-heavy vault tilts the index further toward sessions, so
// the archive opens only on request and only in the session scope.
// Ask's session scope over `sessions/archive/` — the cold tier `is_cold()`
// keeps out of the index, so turning this on rebuilds it (the run shows in
// the card above, like any reindex). Off by default: reviving every archived
// log on a session-heavy vault tilts the index further toward sessions, so
// the archive opens only on request and only in the session scope.
function ArchivedSessionsToggle({ t }: { t: Strings }): JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const reindex = useReindexStore((s) => s.reindex);
  if (!settings) return null;
  const enabled = settings.search_archived_sessions;
  return (
    <div
      className="row"
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: "1px solid var(--line)",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 12,
      }}
    >
      <div style={{ paddingRight: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {t.s_archived_sessions_title}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
          {t.s_archived_sessions_desc}
        </div>
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        aria-label={t.s_archived_sessions_title}
        data-testid="archived-sessions-toggle"
        onClick={() => {
          void update({ search_archived_sessions: !enabled }).then(() => {
            // The flag is on disk before the rebuild reads it.
            if (!enabled) void reindex();
          });
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
  );
}

// Resident mode: closing the window hides it and myco stays in the menu bar
// tray. Lives in the Appearance tab — the app has no dedicated "general" tab,
// and this governs window behavior. Default OFF (close quits, as always).
// Monthly spend guard (OPS-03): a configurable USD threshold plus a read-only
// view of the current month's estimated cost and per-model breakdown. Budget
// state is localStorage-backed and synchronous (see lib/budget.ts).
function BudgetSetting({ t }: { t: Strings }): JSX.Element {
  const [threshold, setThreshold] = useState<number>(getBudgetThreshold());
  // getUsage() reads localStorage synchronously; snapshot it once per render.
  const usage = useMemo(() => getUsage(), []);
  const fmt = (n: number): string => `$${n.toFixed(2)}`;

  return (
    <SettingsCard id="model_budget" className="card">
      <div style={{ fontWeight: 600 }}>
        {t.s_budget_title ?? "Monthly spend guard"}
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        {t.s_budget_desc ??
          "Estimated spend across paid API providers this month. A rough tripwire, not billing — set a threshold to get warned before you cross it."}
      </div>
      <div
        className="row"
        style={{ marginTop: 12, gap: 8, alignItems: "center" }}
      >
        <label style={{ fontSize: 13 }}>
          {t.s_budget_threshold ?? "Monthly limit (USD)"}
        </label>
        <input
          className="input"
          type="number"
          min={0}
          step={1}
          value={threshold}
          onChange={(e) => {
            const next = Math.max(
              0,
              Number(e.target.value) || DEFAULT_MONTHLY_THRESHOLD_USD,
            );
            setThreshold(next);
            setBudgetThreshold(next);
          }}
          style={{ width: 110 }}
        />
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {t.s_budget_usage ?? "This month"}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {t.s_budget_total ?? "Total"} {fmt(usage.totalUsd)} /{" "}
            {fmt(threshold)}
          </span>
        </div>
        {usage.entries.length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            {t.s_budget_empty ?? "No paid-API usage tracked yet this month."}
          </div>
        ) : (
          <div className="col" style={{ gap: 4, marginTop: 8 }}>
            {usage.entries.map((e) => (
              <div
                key={e.model}
                className="row"
                style={{
                  justifyContent: "space-between",
                  fontSize: 12.5,
                  color: "var(--ink-2)",
                }}
              >
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {e.model}
                </span>
                <span>{fmt(e.costUsd)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

// Auto-reflect (FEAT-06): mirrors the auto-ingest toggle exactly — a switch on
// settings.auto_reflect_enabled plus an interval input, persisted via `update`.
// Auto-reflect (FEAT-06): mirrors the auto-ingest toggle exactly — a switch on
// settings.auto_reflect_enabled plus an interval input, persisted via `update`.
function AutoReflectSetting({
  t,
  settings,
  update,
}: {
  t: Strings;
  settings: MycoSettings;
  update: (patch: Partial<MycoSettings>) => Promise<void> | void;
}): JSX.Element {
  const enabled = settings.auto_reflect_enabled;
  const interval = settings.auto_reflect_interval_min;
  return (
    <SettingsCard id="model_autoreflect" className="card">
      <div
        className="row"
        style={{ justifyContent: "space-between", alignItems: "flex-start" }}
      >
        <div style={{ paddingRight: 16 }}>
          <div style={{ fontWeight: 600 }}>
            {t.s_autoreflect_title ?? "Auto-reflect"}
          </div>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            {t.s_autoreflect_desc ??
              "While myco is open, periodically run a read-only reflect pass to surface orphans, stale pages, and missing links."}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={t.s_autoreflect_title ?? "Auto-reflect"}
          onClick={() => void update({ auto_reflect_enabled: !enabled })}
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
              background: enabled ? "var(--bg)" : "var(--ink-3)",
              transition: "left 150ms",
            }}
          />
        </button>
      </div>
      {enabled ? (
        <div
          className="row"
          style={{ marginTop: 12, gap: 8, alignItems: "center" }}
        >
          <label style={{ fontSize: 13 }}>
            {t.s_autoreflect_interval ?? "Every"}
          </label>
          <input
            className="input"
            type="number"
            min={1}
            value={interval}
            onChange={(e) =>
              void update({
                auto_reflect_interval_min: Math.max(
                  1,
                  Number(e.target.value) || 60,
                ),
              })
            }
            style={{ width: 90 }}
          />
          <span className="muted" style={{ fontSize: 13 }}>
            min
          </span>
        </div>
      ) : null}
      {settings.query_provider === "builtin-local" ? (
        // builtin-local can't generate prose, so reflect runs the extractive
        // variant (reflectStore.extractiveReflect): link-graph facts only.
        // Tell the user up front what flipping the toggle will produce.
        <div
          className="row muted"
          style={{ marginTop: 8, gap: 6, fontSize: 12, alignItems: "center" }}
        >
          <Icon name="info" size={12} /> {t.rf_extractive}
        </div>
      ) : null}
    </SettingsCard>
  );
}

// While the app is open, periodically ingest pending _inbox/ sources via the
// selected provider. Complements the headless cron daemon.
// Toggle + interval for the background session sweep (autoImport.ts): while
// the app is open, Claude Code / Codex session logs flow into _inbox/ on
// their own. Pair with auto-ingest below for a fully hands-off pipeline.
// While the app is open, periodically ingest pending _inbox/ sources via the
// selected provider. Complements the headless cron daemon.
// Toggle + interval for the background session sweep (autoImport.ts): while
// the app is open, Claude Code / Codex session logs flow into _inbox/ on
// their own. Pair with auto-ingest below for a fully hands-off pipeline.
function AutoImportSetting({
  t,
  settings,
  update,
}: {
  t: Strings;
  settings: MycoSettings;
  update: (patch: Partial<MycoSettings>) => Promise<void> | void;
}): JSX.Element {
  const enabled = settings.auto_import_enabled;
  const interval = settings.auto_import_interval_min;
  return (
    <SettingsCard id="model_autoimport" className="card">
      <div
        className="row"
        style={{ justifyContent: "space-between", alignItems: "flex-start" }}
      >
        <div style={{ paddingRight: 16 }}>
          <div style={{ fontWeight: 600 }}>
            {t.s_autoimport_title ?? "Auto-collect CLI sessions"}
          </div>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            {t.s_autoimport_desc ??
              "While myco is open, periodically sweep Claude Code / Codex conversations into _inbox/. Already-imported sessions are skipped; enable auto-ingest below to turn them into wiki pages."}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={t.s_autoimport_title ?? "Auto-collect CLI sessions"}
          onClick={() => void update({ auto_import_enabled: !enabled })}
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
              background: enabled ? "var(--bg)" : "var(--ink-3)",
              transition: "left 150ms",
            }}
          />
        </button>
      </div>
      {enabled ? (
        <div
          className="row"
          style={{ marginTop: 12, gap: 8, alignItems: "center" }}
        >
          <label style={{ fontSize: 13 }}>
            {t.s_autoimport_interval ?? "Every"}
          </label>
          <input
            className="input"
            type="number"
            min={1}
            value={interval}
            onChange={(e) =>
              void update({
                auto_import_interval_min: Math.max(
                  1,
                  Number(e.target.value) || 30,
                ),
              })
            }
            style={{ width: 90 }}
          />
          <span className="muted" style={{ fontSize: 13 }}>
            min
          </span>
        </div>
      ) : null}
    </SettingsCard>
  );
}

function AutoIngestSetting({
  t,
  settings,
  update,
}: {
  t: Strings;
  settings: MycoSettings;
  update: (patch: Partial<MycoSettings>) => Promise<void> | void;
}): JSX.Element {
  const enabled = settings.auto_ingest_enabled;
  const interval = settings.auto_ingest_interval_min;
  return (
    <SettingsCard id="model_autoingest" className="card">
      <div
        className="row"
        style={{ justifyContent: "space-between", alignItems: "flex-start" }}
      >
        <div style={{ paddingRight: 16 }}>
          <div style={{ fontWeight: 600 }}>{t.s_autoingest_title}</div>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            {t.s_autoingest_desc}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={t.s_autoingest_title}
          onClick={() => void update({ auto_ingest_enabled: !enabled })}
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
              background: enabled ? "var(--bg)" : "var(--ink-3)",
              transition: "left 150ms",
            }}
          />
        </button>
      </div>
      {enabled ? (
        <div
          className="row"
          style={{ marginTop: 12, gap: 8, alignItems: "center" }}
        >
          <label style={{ fontSize: 13 }}>{t.s_autoingest_interval}</label>
          <input
            className="input"
            type="number"
            min={1}
            value={interval}
            onChange={(e) =>
              void update({
                auto_ingest_interval_min: Math.max(
                  1,
                  Number(e.target.value) || 60,
                ),
              })
            }
            style={{ width: 90 }}
          />
          <span className="muted" style={{ fontSize: 13 }}>
            min
          </span>
        </div>
      ) : null}
    </SettingsCard>
  );
}
