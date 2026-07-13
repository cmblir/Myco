// Settings — six tabs. Model + Connections are wired to real backend
// (settingsStore + keychain IPC); Account/Language/Appearance act on the
// live UI store; About is static metadata.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon, ProviderGlyph } from "../lib/icons";
import type { IconName } from "../lib/icons";
import type { Lang, Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import type { Theme } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";
import { ipc } from "../lib/ipc";
import type { McpRegInfo, MemexSettings, OllamaStatus } from "../lib/ipc";
import { BUILTIN_MODEL, PROVIDERS, providerDesc, useEnabledProviders } from "../lib/providers";
import type { ProviderDef } from "../lib/providers";
import ModelSelect from "../components/ModelSelect";
import OllamaSetup from "../components/OllamaSetup";
import {
  getBudgetThreshold,
  getUsage,
  setBudgetThreshold,
  DEFAULT_MONTHLY_THRESHOLD_USD,
} from "../lib/budget";

export default function PageSettings({ t }: { t: Strings }): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const setLang = useUIStore((s) => s.setLang);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  const [tab, setTab] = useState<
    "account" | "model" | "providers" | "mcp" | "lang" | "appearance" | "about"
  >("model");

  const tabs: { id: typeof tab; label: string; icon: IconName }[] = [
    { id: "account", label: t.s_account, icon: "shield" },
    { id: "model", label: t.s_model, icon: "sparkles" },
    { id: "providers", label: t.s_providers, icon: "link" },
    { id: "mcp", label: t.s_mcp, icon: "terminal" },
    { id: "lang", label: t.s_lang, icon: "globe" },
    { id: "appearance", label: t.s_appearance, icon: "moon" },
    { id: "about", label: t.s_about, icon: "info" },
  ];

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_settings}</div>
        <h1 className="page-title">{t.s_title}</h1>
      </header>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "200px 1fr",
          gap: 32,
          marginTop: 16,
        }}
      >
        <nav className="col" style={{ gap: 1 }}>
          {tabs.map((x) => (
            <button
              key={x.id}
              className={"qbtn" + (tab === x.id ? " active" : "")}
              onClick={() => setTab(x.id)}
            >
              <span className="qicon">
                <Icon name={x.icon} size={14} />
              </span>
              <span>{x.label}</span>
            </button>
          ))}
        </nav>
        <div>
          {tab === "account" ? <SettingsAccount t={t} /> : null}
          {tab === "model" ? <SettingsModel t={t} /> : null}
          {tab === "providers" ? <SettingsProviders t={t} /> : null}
          {tab === "mcp" ? <SettingsMcp t={t} /> : null}
          {tab === "lang" ? (
            <SettingsLang t={t} lang={lang} setLang={setLang} />
          ) : null}
          {tab === "appearance" ? (
            <SettingsAppearance t={t} theme={theme} setTheme={setTheme} />
          ) : null}
          {tab === "about" ? <SettingsAbout t={t} /> : null}
        </div>
      </div>
    </div>
  );
}

function SettingsAccount({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const openVault = useVaultStore((s) => s.openVault);
  // Independent Obsidian vault (MP-10). The scaffold command is idempotent, so
  // after a successful run we treat the vault as registered regardless of
  // whether .obsidian already existed (we infer readiness from the result).
  const [vaultReady, setVaultReady] = useState(false);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);

  async function registerVault(): Promise<void> {
    if (!currentVault) return;
    setVaultBusy(true);
    setVaultError(null);
    try {
      await ipc.scaffoldObsidianVault(currentVault.path);
      setVaultReady(true);
    } catch (e) {
      setVaultError(String(e));
    } finally {
      setVaultBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
        {t.s_account}
      </h2>
      <div className="card row" style={{ gap: 14 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: "var(--ink)",
            color: "var(--bg)",
            display: "grid",
            placeItems: "center",
            fontSize: 22,
            fontWeight: 700,
          }}
        >
          M
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Local user</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {currentVault?.path ?? "no vault"} · Memex
          </div>
        </div>
      </div>
      <div className="field">
        <label>Vault path</label>
        <div className="row">
          <input
            className="input"
            style={{ fontFamily: "var(--font-mono)", fontSize: 13, flex: 1 }}
            value={currentVault?.path ?? ""}
            readOnly
          />
          <button
            className="btn"
            onClick={async () => {
              const p = await ipc.pickDirectory();
              if (p) await openVault(p);
            }}
          >
            Change…
          </button>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 10, alignItems: "center" }}>
          <button
            className="btn"
            onClick={() => void registerVault()}
            disabled={!currentVault || vaultBusy || vaultReady}
          >
            {vaultReady
              ? `✓ ${t.s_vault_registered ?? "Obsidian vault ready"}`
              : (t.s_vault_register ??
                "Make this an independent Obsidian vault")}
          </button>
          {vaultError ? (
            <span style={{ color: "#dc2626", fontSize: 12 }}>{vaultError}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SettingsModel({ t }: { t: Strings }): JSX.Element {
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
        label={t.s_model_query}
        providers={enabled}
        provider={settings.query_provider}
        model={settings.query_model}
        onPick={(provider, model) =>
          void update({ query_provider: provider, query_model: model })
        }
      />
      <ModelPicker
        label={t.s_model_ingest}
        providers={enabled}
        provider={settings.ingest_provider}
        model={settings.ingest_model}
        onPick={(provider, model) =>
          void update({ ingest_provider: provider, ingest_model: model })
        }
      />
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
function EmbeddingsSetting({ t }: { t: Strings }): JSX.Element {
  const [status, setStatus] = useState<{ indexed_pages: number; model: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = (): void => {
    ipc.embeddingsStatus().then(setStatus).catch(() => setStatus(null));
  };
  useEffect(refresh, []);

  const reindex = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await ipc.reindexEmbeddings("builtin-local", BUILTIN_MODEL);
      refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div style={{ fontWeight: 600 }}>{t.s_embeddings ?? "Semantic search"}</div>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
          {status ? `${status.indexed_pages} ${t.s_embeddings_indexed ?? "pages indexed"}` : "—"}
        </span>
      </div>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
        {t.s_embeddings_lede ??
          "Build an on-device embedding index for semantic search, related notes, and graph similarity. Runs offline."}
      </p>
      <button className="btn" onClick={() => void reindex()} disabled={busy}>
        {busy ? (t.s_embeddings_indexing ?? "Indexing…") : (t.s_embeddings_reindex ?? "Reindex now")}
      </button>
      {err ? (
        <div style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}>{err}</div>
      ) : null}
    </div>
  );
}

// Monthly spend guard (OPS-03): a configurable USD threshold plus a read-only
// view of the current month's estimated cost and per-model breakdown. Budget
// state is localStorage-backed and synchronous (see lib/budget.ts).
function BudgetSetting({ t }: { t: Strings }): JSX.Element {
  const [threshold, setThreshold] = useState<number>(getBudgetThreshold());
  // getUsage() reads localStorage synchronously; snapshot it once per render.
  const usage = useMemo(() => getUsage(), []);
  const fmt = (n: number): string => `$${n.toFixed(2)}`;

  return (
    <div className="card">
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
    </div>
  );
}

// Auto-reflect (FEAT-06): mirrors the auto-ingest toggle exactly — a switch on
// settings.auto_reflect_enabled plus an interval input, persisted via `update`.
function AutoReflectSetting({
  t,
  settings,
  update,
}: {
  t: Strings;
  settings: MemexSettings;
  update: (patch: Partial<MemexSettings>) => Promise<void> | void;
}): JSX.Element {
  const enabled = settings.auto_reflect_enabled;
  const interval = settings.auto_reflect_interval_min;
  return (
    <div className="card">
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
              "While Memex is open, periodically run a read-only reflect pass to surface orphans, stale pages, and missing links."}
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
    </div>
  );
}

// While the app is open, periodically ingest pending _inbox/ sources via the
// selected provider. Complements the headless cron daemon.
function AutoIngestSetting({
  t,
  settings,
  update,
}: {
  t: Strings;
  settings: MemexSettings;
  update: (patch: Partial<MemexSettings>) => Promise<void> | void;
}): JSX.Element {
  const enabled = settings.auto_ingest_enabled;
  const interval = settings.auto_ingest_interval_min;
  return (
    <div className="card">
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
    </div>
  );
}

function ModelPicker({
  label,
  providers,
  provider,
  model,
  onPick,
}: {
  label: string;
  providers: ProviderDef[];
  provider: string;
  model: string;
  onPick: (provider: string, model: string) => void;
}): JSX.Element {
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
          {provider} · {model}
        </span>
      </div>
      <ModelSelect
        providers={providers}
        provider={provider}
        model={model}
        onPick={onPick}
      />
    </div>
  );
}

// Memex Pro signs in with the account created on the website (email + password);
// the app fetches and stores the account's access key automatically — the user
// never copies a key by hand. Settings is the single source of truth for the
// logged-in email + connection flag (the Rust login command persists both).
function MemexProCard({
  t,
  def,
  settings,
}: {
  t: Strings;
  def: ProviderDef;
  settings: MemexSettings | null;
}): JSX.Element {
  const update = useSettingsStore((s) => s.update);
  const reload = useSettingsStore((s) => s.load);
  const loggedInEmail = (settings?.memex_pro_email ?? "").trim();
  const loggedIn = loggedInEmail.length > 0;
  const hasAccess = settings?.providers.memex_pro === true;
  const [url, setUrl] = useState(settings?.memex_pro_url ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logIn(): Promise<void> {
    if (!url.trim()) {
      setError(t.s_memexpro_url);
      return;
    }
    if (!email.trim() || !password) {
      setError(`${t.s_memexpro_email} · ${t.s_memexpro_password}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Persist the URL first — the Rust login command reads it from settings.
      await update({ memex_pro_url: url.trim() });
      const res = await ipc.memexProLogin(email.trim(), password);
      await reload(); // pull the email + connection flag the command persisted
      setPassword("");
      if (!res.connected) setError(t.s_memexpro_noaccess);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function logOut(): Promise<void> {
    setBusy(true);
    try {
      await ipc.memexProLogout();
      await reload();
      setEmail("");
      setPassword("");
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="card"
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: 14,
        alignItems: "flex-start",
        padding: 14,
      }}
    >
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: "var(--bg-soft)",
          border: "1px solid var(--line)",
          display: "grid",
          placeItems: "center",
          color: "var(--ink-2)",
        }}
      >
        <ProviderGlyph id={def.id} size={18} />
      </span>
      <div>
        <div className="row" style={{ gap: 8, marginBottom: 4 }}>
          <span style={{ fontWeight: 600 }}>{def.name}</span>
          <span className="chip" style={{ background: "var(--bg-soft)" }}>
            {def.kind}
          </span>
          {hasAccess ? (
            <span
              className="chip"
              style={{
                background: "rgba(22,163,74,0.1)",
                color: "var(--c-entity)",
              }}
            >
              ● {t.s_provider_connected}
            </span>
          ) : loggedIn ? (
            <span
              className="chip"
              style={{ background: "rgba(217,119,6,0.12)", color: "#d97706" }}
            >
              ○ {t.s_memexpro_noaccess}
            </span>
          ) : (
            <span className="chip">○ {t.s_provider_disconnected}</span>
          )}
        </div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          {providerDesc(t, def)}
        </div>
        {loggedIn ? (
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 13 }}>
              {t.s_memexpro_loggedin} <strong>{loggedInEmail}</strong>
            </span>
            <button
              className="btn"
              style={{ marginLeft: "auto" }}
              onClick={() => void logOut()}
              disabled={busy}
            >
              {t.s_memexpro_logout}
            </button>
          </div>
        ) : (
          <>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>{t.s_memexpro_url}</label>
              <input
                className="input"
                placeholder="https://memex-proxy.<you>.workers.dev"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
              />
            </div>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>{t.s_memexpro_email}</label>
              <input
                className="input"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field" style={{ marginBottom: 12 }}>
              <label>{t.s_memexpro_password}</label>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void logIn();
                }}
              />
            </div>
            <button
              className="btn btn-primary"
              onClick={() => void logIn()}
              disabled={busy || !url.trim() || !email.trim() || !password}
            >
              {t.s_memexpro_login}
            </button>
          </>
        )}
        {error ? (
          <div style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}>
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SettingsProviders({ t }: { t: Strings }): JSX.Element {
  const settings = useSettingsStore((s) => s.settings);
  const setProviderConnected = useSettingsStore((s) => s.setProviderConnected);
  const update = useSettingsStore((s) => s.update);
  const [keyInputOpen, setKeyInputOpen] = useState<string | null>(null);
  const [keyVal, setKeyVal] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [cliStatus, setCliStatus] = useState<{
    installed: boolean;
    version: string | null;
  } | null>(null);
  const [agentStatus, setAgentStatus] = useState<
    Record<string, { installed: boolean; version: string | null }>
  >({});
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);

  const syncOllama = useSettingsStore((s) => s.syncOllama);

  function refreshOllama(): void {
    ipc
      .ollamaStatus()
      .then((st) => {
        setOllamaStatus(st);
        // Keep the connection flag mirroring the live daemon, so the model
        // picker gains/loses ollama automatically.
        void syncOllama();
      })
      .catch(() => undefined);
  }

  async function connectCli(p: ProviderDef): Promise<void> {
    setBusy(p.id);
    try {
      // "Connect" actually runs the CLI (--version) to prove it works.
      const st =
        p.id === "anthropic-cli"
          ? await ipc.claudeCheck()
          : await ipc.agentCheck(p.id);
      if (!st.installed) {
        window.alert(`${p.name}: CLI not found. Install it first.`);
        return;
      }
      await setProviderConnected(p.flag, true);
    } catch (e) {
      window.alert(String(e));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    ipc
      .claudeCheck()
      .then(setCliStatus)
      .catch(() => undefined);
    for (const id of ["gemini-cli", "codex-cli"]) {
      ipc
        .agentCheck(id)
        .then((s) =>
          setAgentStatus((m) => ({
            ...m,
            [id]: { installed: s.installed, version: s.version },
          })),
        )
        .catch(() => undefined);
    }
    refreshOllama();
    // Mount-only probe of installed CLIs/daemons; refreshOllama is stable enough
    // that re-running on its identity would just re-probe on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveKey(providerId: string): Promise<void> {
    if (!keyVal.trim()) return;
    setBusy(providerId);
    try {
      await ipc.setProviderKey(providerId, keyVal.trim());
      const def = PROVIDERS.find((p) => p.id === providerId);
      if (def?.flag) await setProviderConnected(def.flag, true);
      setKeyInputOpen(null);
      setKeyVal("");
    } catch (e) {
      window.alert(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(providerId: string): Promise<void> {
    setBusy(providerId);
    try {
      await ipc.deleteProviderKey(providerId);
      const def = PROVIDERS.find((p) => p.id === providerId);
      if (def?.flag) await setProviderConnected(def.flag, false);
      // If Query/Ingest were pointed at this provider, reset them to the
      // always-available CLI so the picker and the actual dispatch target stay
      // in sync (otherwise a request would fail on the just-removed key).
      const patch: Partial<MemexSettings> = {};
      if (settings?.query_provider === providerId) {
        patch.query_provider = "anthropic-cli";
        patch.query_model = "sonnet";
      }
      if (settings?.ingest_provider === providerId) {
        patch.ingest_provider = "anthropic-cli";
        patch.ingest_model = "sonnet";
      }
      if (Object.keys(patch).length > 0) await update(patch);
    } catch (e) {
      window.alert(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
          {t.s_providers}
        </h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.s_providers_lede}
        </p>
      </div>
      <div className="col" style={{ gap: 10 }}>
        {PROVIDERS.map((p) => {
          // The connection flag persists the user's intent and gates the model
          // picker. But for a CLI provider the card must ALSO reflect whether the
          // CLI is actually installed: anthropic_cli defaults to ON, so on a
          // machine without the claude CLI the flag is true yet nothing works —
          // showing "Connected" there is a lie. The live check overrides it.
          const connected = settings?.providers[p.flag] === true;
          const isCli =
            p.id === "anthropic-cli" ||
            p.id === "gemini-cli" ||
            p.id === "codex-cli";
          // undefined = not a CLI, or the check hasn't returned yet.
          const cliInstalled = isCli
            ? p.id === "anthropic-cli"
              ? cliStatus?.installed
              : agentStatus[p.id]?.installed
            : undefined;
          if (p.id === "memex-pro") {
            return (
              <MemexProCard key={p.id} t={t} def={p} settings={settings ?? null} />
            );
          }
          if (p.id === "ollama") {
            return (
              <div
                key={p.id}
                className="card"
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: 14,
                  alignItems: "flex-start",
                  padding: 14,
                }}
              >
                <span
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    background: "var(--bg-soft)",
                    border: "1px solid var(--line)",
                    display: "grid",
                    placeItems: "center",
                    color: "var(--ink-2)",
                  }}
                >
                  <ProviderGlyph id={p.id} size={18} />
                </span>
                <div>
                  <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    <span
                      className="chip"
                      style={{ background: "var(--bg-soft)" }}
                    >
                      {p.kind}
                    </span>
                  </div>
                  <div
                    className="muted"
                    style={{ fontSize: 13, marginBottom: 12 }}
                  >
                    {providerDesc(t, p)}
                  </div>
                  {ollamaStatus ? (
                    <OllamaSetup
                      status={ollamaStatus}
                      refresh={refreshOllama}
                    />
                  ) : (
                    <div className="muted" style={{ fontSize: 13 }}>
                      checking ollama…
                    </div>
                  )}
                </div>
              </div>
            );
          }
          return (
            <div
              key={p.id}
              className="card"
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                gap: 14,
                alignItems: "center",
                padding: 14,
              }}
            >
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: "var(--bg-soft)",
                  border: "1px solid var(--line)",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--ink-2)",
                }}
              >
                <ProviderGlyph id={p.id} size={18} />
              </span>
              <div>
                <div className="row" style={{ gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  <span
                    className="chip"
                    style={{ background: "var(--bg-soft)" }}
                  >
                    {p.kind}
                  </span>
                  {connected && cliInstalled === false ? (
                    // Enabled but the CLI isn't actually installed → say so,
                    // overriding the stale/default "connected" flag (this is what
                    // "works in settings but not really" looked like on a fresh
                    // machine, where anthropic_cli defaults to ON).
                    <span
                      className="chip"
                      style={{
                        background: "rgba(220,38,38,0.1)",
                        color: "#dc2626",
                      }}
                    >
                      ⚠ {t.s_provider_cli_missing}
                    </span>
                  ) : connected ? (
                    <span
                      className="chip"
                      style={{
                        background: "rgba(22,163,74,0.1)",
                        color: "var(--c-entity)",
                      }}
                    >
                      ● {t.s_provider_connected}
                    </span>
                  ) : (
                    <span className="chip">○ {t.s_provider_disconnected}</span>
                  )}
                  {p.id === "anthropic-cli" && cliStatus?.version ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {cliStatus.version}
                    </span>
                  ) : null}
                  {agentStatus[p.id]?.version ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {agentStatus[p.id].version}
                    </span>
                  ) : null}
                </div>
                <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                  {providerDesc(t, p)}
                </div>
                {keyInputOpen === p.id ? (
                  <div className="row" style={{ marginTop: 10, gap: 8 }}>
                    <Icon name="key" size={14} />
                    <input
                      className="input"
                      placeholder={
                        p.id.startsWith("anthropic")
                          ? "sk-ant-…"
                          : p.id.startsWith("openai")
                            ? "sk-…"
                            : "Paste API key"
                      }
                      value={keyVal}
                      onChange={(e) => setKeyVal(e.target.value)}
                      style={{
                        flex: 1,
                        fontFamily: "var(--font-mono)",
                        fontSize: 13,
                      }}
                      type="password"
                    />
                    <button
                      className="btn btn-primary"
                      onClick={() => void saveKey(p.id)}
                      disabled={!keyVal.trim() || busy === p.id}
                    >
                      Save
                    </button>
                    <button
                      className="btn-ghost btn"
                      onClick={() => {
                        setKeyInputOpen(null);
                        setKeyVal("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : null}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {p.kind === "cli" ? (
                  connected ? (
                    <button
                      className="btn"
                      onClick={() =>
                        void setProviderConnected(p.flag, false)
                      }
                      disabled={busy === p.id}
                    >
                      {t.s_provider_disconnect}
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary"
                      onClick={() => void connectCli(p)}
                      disabled={busy === p.id}
                    >
                      {t.s_provider_connect}
                    </button>
                  )
                ) : p.needsKey ? (
                  connected ? (
                    <button
                      className="btn"
                      onClick={() => void disconnect(p.id)}
                      disabled={busy === p.id}
                    >
                      {t.s_provider_disconnect}
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary"
                      onClick={() => setKeyInputOpen(p.id)}
                      disabled={busy === p.id}
                    >
                      {t.s_provider_connect}
                    </button>
                  )
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div
        className="card-flat"
        style={{ display: "flex", gap: 12, alignItems: "flex-start" }}
      >
        <Icon name="shield" size={16} />
        <div style={{ fontSize: 13.5, color: "var(--ink-3)" }}>
          API keys are stored in your OS keychain (macOS Keychain / Windows
          Credential Manager / Secret Service), not in plaintext on disk.
        </div>
      </div>
    </div>
  );
}

function SettingsMcp({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const [info, setInfo] = useState<McpRegInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!currentVault) return;
    let alive = true;
    ipc
      .mcpRegistrationInfo(currentVault.path)
      .then((i) => {
        if (alive) setInfo(i);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [currentVault, tick]);

  function copy(text: string, which: string): void {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1500);
    });
  }

  async function install(): Promise<void> {
    if (!currentVault) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.mcpInstall(currentVault.path);
      setTick((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function register(): Promise<void> {
    if (!currentVault) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.mcpRegister(currentVault.path);
      setTick((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!currentVault) return <div className="muted">Loading…</div>;

  const codeBox = (text: string, which: string): JSX.Element => (
    <div
      className="card"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: 12,
        fontFamily: "monospace",
        fontSize: 12,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      <span style={{ flex: 1 }}>{text}</span>
      <button className="btn" onClick={() => copy(text, which)}>
        {copied === which ? t.mcp_copied : t.mcp_copy}
      </button>
    </div>
  );

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{t.s_mcp}</h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.mcp_lede}
        </p>
      </div>

      {info && !info.found ? (
        <div className="card" style={{ padding: 14, fontSize: 13 }} role="alert">
          {t.mcp_not_found}
        </div>
      ) : null}

      {info && info.found && !info.installed ? (
        <div className="col" style={{ gap: 10 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            {t.mcp_status_not_installed}
          </div>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void install()}
            style={{ alignSelf: "flex-start" }}
          >
            {busy ? t.mcp_installing : t.mcp_install_btn}
          </button>
        </div>
      ) : null}

      {info && info.installed && info.command && info.desktop_json ? (
        <div className="col" style={{ gap: 16 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            ✓ {t.mcp_status_installed}
          </div>

          <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: info.serving ? "#22c55e" : "#9aa0a8",
                display: "inline-block",
              }}
              aria-hidden="true"
            />
            {info.serving
              ? `${t.mcp_serving ?? "SSE server running"}${info.url ? ` — ${info.url}` : ""}`
              : (t.mcp_not_serving ?? "SSE server stopped")}
          </div>

          <div className="col" style={{ gap: 6 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              {t.mcp_command_label}
            </div>
            {codeBox(info.command, "cmd")}
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void register()}
              style={{ alignSelf: "flex-start" }}
            >
              {busy ? (t.mcp_registering ?? "Registering…") : t.mcp_register_btn}
            </button>
          </div>

          <div className="col" style={{ gap: 6 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              {t.mcp_desktop_label}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {t.mcp_desktop_path}
            </div>
            {codeBox(info.desktop_json, "desktop")}
          </div>

          <div className="muted" style={{ fontSize: 12 }}>
            {t.mcp_offline_note}
          </div>
        </div>
      ) : null}

      {error ? (
        <div style={{ color: "#dc2626", fontSize: 12, whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

function SettingsLang({
  t,
  lang,
  setLang,
}: {
  t: Strings;
  lang: Lang;
  setLang: (l: Lang) => void;
}): JSX.Element {
  const opts: { id: Lang; name: string; native: string }[] = [
    { id: "en", name: "English", native: "English" },
    { id: "ko", name: "Korean", native: "한국어" },
    { id: "ja", name: "Japanese", native: "日本語" },
  ];
  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{t.s_lang}</h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.s_lang_lede}
        </p>
      </div>
      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 10 }}>{t.s_lang_ui}</div>
        <div className="col" style={{ gap: 6 }}>
          {opts.map((o) => {
            const sel = lang === o.id;
            return (
              <button
                key={o.id}
                className="card-flat"
                style={{
                  padding: 12,
                  border: `1px solid ${sel ? "var(--ink)" : "transparent"}`,
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 12,
                  alignItems: "center",
                  textAlign: "left",
                  cursor: "pointer",
                  background: sel ? "var(--bg)" : "var(--bg-soft)",
                }}
                onClick={() => setLang(o.id)}
              >
                <span
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: "var(--ink)",
                    width: 28,
                    textAlign: "center",
                  }}
                >
                  {o.id === "en" ? "Aa" : o.id === "ko" ? "가" : "あ"}
                </span>
                <div>
                  <div style={{ fontWeight: 500 }}>{o.native}</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {o.name}
                  </div>
                </div>
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    border: `1.5px solid ${sel ? "var(--ink)" : "var(--line-strong)"}`,
                    background: sel ? "var(--ink)" : "transparent",
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SettingsAppearance({
  t,
  theme,
  setTheme,
}: {
  t: Strings;
  theme: Theme;
  setTheme: (th: Theme) => void;
}): JSX.Element {
  const opts: { id: Theme; label: string; icon: IconName }[] = [
    { id: "light", label: t.s_appearance_light, icon: "sun" },
    { id: "dark", label: t.s_appearance_dark, icon: "moon" },
    { id: "system", label: t.s_appearance_system, icon: "cloud" },
  ];
  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
          {t.s_appearance}
        </h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.s_appearance_lede}
        </p>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
        }}
      >
        {opts.map((o) => {
          const sel = theme === o.id;
          const isDark = o.id === "dark";
          return (
            <button
              key={o.id}
              className="card"
              style={{
                padding: 0,
                overflow: "hidden",
                textAlign: "left",
                cursor: "pointer",
                border: `1px solid ${sel ? "var(--ink)" : "var(--line)"}`,
              }}
              onClick={() => setTheme(o.id)}
            >
              <div
                style={{
                  height: 92,
                  background: isDark
                    ? "#191919"
                    : "linear-gradient(135deg, #fbfbfa, #efeeec)",
                  padding: 12,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    width: "70%",
                    height: 8,
                    background: isDark ? "#2c2c2c" : "#e9e8e4",
                    borderRadius: 4,
                  }}
                />
                <div
                  style={{
                    width: 40,
                    height: 8,
                    background: isDark ? "#ededec" : "#181715",
                    borderRadius: 4,
                    marginTop: 14,
                  }}
                />
                <div style={{ position: "absolute", top: 10, right: 10 }}>
                  <Icon name={o.icon} size={16} />
                </div>
              </div>
              <div
                style={{
                  padding: "10px 14px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontWeight: 500 }}>{o.label}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SettingsAbout({ t }: { t: Strings }): JSX.Element {
  return (
    <div className="col" style={{ gap: 20 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{t.s_about}</h2>
      <div
        className="card"
        style={{ padding: 24, display: "flex", gap: 18, alignItems: "center" }}
      >
        <span
          style={{
            width: 64,
            height: 64,
            color: "var(--ink)",
            display: "block",
          }}
        >
          <svg width="64" height="64" viewBox="0 0 240 240">
            <g fill="currentColor">
              <rect x="70" y="40" width="20" height="40" />
              <rect x="150" y="40" width="20" height="40" />
              <rect x="60" y="80" width="120" height="10" />
              <rect x="50" y="90" width="140" height="60" />
              <rect x="30" y="110" width="20" height="20" />
              <rect x="190" y="110" width="20" height="20" />
              <rect x="70" y="150" width="30" height="40" />
              <rect x="140" y="150" width="30" height="40" />
            </g>
            <rect x="80" y="110" width="20" height="20" fill="var(--bg)" />
            <rect x="140" y="110" width="20" height="20" fill="var(--bg)" />
          </svg>
        </span>
        <div>
          <div
            style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}
          >
            Memex
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            v0.2.0 · build 2026.05.13
          </div>
          <p
            style={{
              fontSize: 14,
              marginTop: 8,
              color: "var(--ink-2)",
              maxWidth: 520,
            }}
          >
            {t.s_about_built}
          </p>
        </div>
      </div>
    </div>
  );
}
