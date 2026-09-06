// Settings > Connections — the provider catalog; keys live in the OS keychain.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon, ProviderGlyph } from "../../lib/icons";
import type { Strings } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { ipc } from "../../lib/ipc";
import type { MycoSettings, OllamaStatus } from "../../lib/ipc";
import { PROVIDERS, providerDesc } from "../../lib/providers";
import type { ProviderDef } from "../../lib/providers";
import OllamaSetup from "../../components/OllamaSetup";
import { isComposingKey } from "../../lib/ime";
import { SettingsCard } from "../../components/SettingsCard";

export function SettingsProviders({ t }: { t: Strings }): JSX.Element {
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
      const patch: Partial<MycoSettings> = {};
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
          if (p.id === "myco-pro") {
            return (
              <MycoProCard
                key={p.id}
                t={t}
                def={p}
                settings={settings ?? null}
              />
            );
          }
          if (p.id === "ollama") {
            return (
              <SettingsCard
                id={`provider_${p.id}`}
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
              </SettingsCard>
            );
          }
          return (
            <SettingsCard
              id={`provider_${p.id}`}
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
              {/* min-width:0 lets this 1fr column shrink; the header row wraps so
                  the name + status chips never force the action button off-screen
                  at narrow widths (375px). */}
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
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
                      onClick={() => void setProviderConnected(p.flag, false)}
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
            </SettingsCard>
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

// myco Pro signs in with the account created on the website (email + password);
// the app fetches and stores the account's access key automatically — the user
// never copies a key by hand. Settings is the single source of truth for the
// logged-in email + connection flag (the Rust login command persists both).
function MycoProCard({
  t,
  def,
  settings,
}: {
  t: Strings;
  def: ProviderDef;
  settings: MycoSettings | null;
}): JSX.Element {
  const update = useSettingsStore((s) => s.update);
  const reload = useSettingsStore((s) => s.load);
  const loggedInEmail = (settings?.myco_pro_email ?? "").trim();
  const loggedIn = loggedInEmail.length > 0;
  const hasAccess = settings?.providers.myco_pro === true;
  const [url, setUrl] = useState(settings?.myco_pro_url ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logIn(): Promise<void> {
    if (!url.trim()) {
      setError(t.s_mycopro_url);
      return;
    }
    if (!email.trim() || !password) {
      setError(`${t.s_mycopro_email} · ${t.s_mycopro_password}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Persist the URL first — the Rust login command reads it from settings.
      await update({ myco_pro_url: url.trim() });
      const res = await ipc.mycoProLogin(email.trim(), password);
      await reload(); // pull the email + connection flag the command persisted
      setPassword("");
      if (!res.connected) setError(t.s_mycopro_noaccess);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function logOut(): Promise<void> {
    setBusy(true);
    try {
      await ipc.mycoProLogout();
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
    <SettingsCard
      id="provider_myco-pro"
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
              ○ {t.s_mycopro_noaccess}
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
              {t.s_mycopro_loggedin} <strong>{loggedInEmail}</strong>
            </span>
            <button
              className="btn"
              style={{ marginLeft: "auto" }}
              onClick={() => void logOut()}
              disabled={busy}
            >
              {t.s_mycopro_logout}
            </button>
          </div>
        ) : (
          <>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>{t.s_mycopro_url}</label>
              <input
                className="input"
                placeholder="https://myco-proxy.<you>.workers.dev"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
              />
            </div>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>{t.s_mycopro_email}</label>
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
              <label>{t.s_mycopro_password}</label>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (isComposingKey(e)) return;
                  if (e.key === "Enter") void logIn();
                }}
              />
            </div>
            <button
              className="btn btn-primary"
              onClick={() => void logIn()}
              disabled={busy || !url.trim() || !email.trim() || !password}
            >
              {t.s_mycopro_login}
            </button>
          </>
        )}
        {error ? (
          <div style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}>
            {error}
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}
