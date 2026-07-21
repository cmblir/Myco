// Topbar — breadcrumb + meta + language switch.

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { IconName } from "../lib/icons";
import type { Lang, Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useIngestStore } from "../stores/ingestStore";
import { useLintStore } from "../stores/lintStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useEnabledProviders } from "../lib/providers";
import ModelSelect from "./ModelSelect";
import { ipc } from "../lib/ipc";
import { formatTicker } from "../lib/time";

export default function Topbar({ t }: { t: Strings }): JSX.Element {
  const route = useUIStore((s) => s.route);
  const splitRoute = useUIStore((s) => s.splitRoute);
  const setSplitRoute = useUIStore((s) => s.setSplitRoute);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleCmd = useUIStore((s) => s.toggleCmd);
  const lang = useUIStore((s) => s.lang);
  const setLang = useUIStore((s) => s.setLang);
  const currentVault = useVaultStore((s) => s.currentVault);

  const projectName = currentVault?.name ?? t.app_name;
  const { crumb, icon } = breadcrumbFor(route, projectName, t);

  return (
    <div className="topbar">
      <button
        className="icon-btn"
        onClick={toggleSidebar}
        title={t.tb_toggle_sidebar ?? "Toggle sidebar (⌘B)"}
      >
        <Icon name="sidebar" />
      </button>
      <div className="breadcrumb">
        <Icon name={icon} size={14} />
        {crumb.map((c, i) => (
          <span key={i} style={{ display: "inline-flex", gap: 6 }}>
            {i > 0 ? <span className="crumb-sep">/</span> : null}
            {i === crumb.length - 1 ? <b>{c}</b> : <span>{c}</span>}
          </span>
        ))}
      </div>
      <div className="topbar-spacer" />
      {/* Split view: open a second pane beside the current one (Overview + Graph
          etc.). Defaults the pane to Graph, or Overview when Graph is primary. */}
      <button
        className={`pill pill-icon${splitRoute ? " is-active" : ""}`}
        onClick={() =>
          setSplitRoute(splitRoute ? null : route === "graph" ? "overview" : "graph")
        }
        title={splitRoute ? (t.split_close ?? "Close split view") : (t.split_open ?? "Split view")}
        aria-label={splitRoute ? (t.split_close ?? "Close split view") : (t.split_open ?? "Split view")}
        aria-pressed={!!splitRoute}
      >
        <Icon name="columns" size={14} />
      </button>
      <IngestChip t={t} />
      <LintChip t={t} />
      <button className="pill pill-search" onClick={toggleCmd}>
        <Icon name="search" size={14} />
        <span className="pill-label">{t.ph_search}</span>
        <span className="kbd" style={{ marginLeft: 4 }}>
          ⌘K
        </span>
      </button>
      <ModelChip t={t} />
      <select
        className="pill"
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        style={{ paddingRight: 18, cursor: "pointer", appearance: "none" }}
      >
        <option value="en">EN</option>
        <option value="ko">한국어</option>
        <option value="ja">日本語</option>
      </select>
    </div>
  );
}

// Interactive picker for the ACTIVE query model (not just the Claude CLI): a
// pill showing the provider + a green/grey ready dot that opens a popover to
// switch provider/model. Reads/writes settingsStore.query_provider|query_model,
// so the choice persists to disk and stays in sync with Settings → Model.
// Readiness: builtin-local ships in the app (always ready); CLI/daemon providers
// get a live probe; API providers count as ready when enabled (their key lives
// in the keychain — no cheap liveness check).
function ModelChip({ t }: { t: Strings }): JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const providers = useEnabledProviders();
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const provider = settings?.query_provider ?? "";
  const model = settings?.query_model ?? "";

  const label =
    provider === "builtin-local"
      ? "local"
      : provider === "anthropic-cli"
        ? "claude"
        : provider === "ollama"
          ? "ollama"
          : provider.replace(/-(api|cli)$/, "");

  // Re-probe readiness whenever the query provider changes.
  useEffect(() => {
    if (!settings || !provider) return;
    let alive = true;
    (async () => {
      try {
        let ok: boolean;
        if (provider === "builtin-local") {
          ok = true; // bundled in the app binary
        } else if (provider === "anthropic-cli") {
          ok = (await ipc.claudeCheck()).installed;
        } else if (provider === "ollama") {
          ok = (await ipc.ollamaStatus()).daemon_running;
        } else {
          ok =
            (settings.providers as Record<string, boolean>)[
              provider.replace(/-/g, "_")
            ] === true;
        }
        if (alive) setReady(ok);
      } catch {
        if (alive) setReady(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [provider, settings]);

  // Close the popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!settings) return null;

  return (
    <div className="model-chip-wrap" ref={wrapRef}>
      <button
        className="pill"
        onClick={() => setOpen((v) => !v)}
        title={`${provider} · ${model || "(default)"}`}
        aria-label={t.tb_model_picker ?? "Switch query model"}
        aria-expanded={open}
      >
        <span
          className="dot"
          style={{ background: ready ? "#16a34a" : "var(--ink-4)" }}
        ></span>
        <span className="pill-label">
          {label} {ready ? "ready" : "offline"}
        </span>
        <Icon name="chevD" size={12} />
      </button>
      {open ? (
        <div className="model-chip-pop">
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {t.s_model_query}
          </div>
          <ModelSelect
            t={t}
            providers={providers}
            provider={provider}
            model={model}
            onPick={(p, m) =>
              void update({ query_provider: p, query_model: m })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

// Global ingest status: spinner + elapsed while a run is live (any page),
// then a green/red chip after it finishes until the user visits Ingest.
// Clicking always jumps to the Ingest page.
function IngestChip({ t }: { t: Strings }): JSX.Element | null {
  const stage = useIngestStore((s) => s.stage);
  const startedAt = useIngestStore((s) => s.startedAt);
  const seen = useIngestStore((s) => s.seen);
  const setRoute = useUIStore((s) => s.setRoute);
  const running =
    stage === "writing-raw" || stage === "claude" || stage === "indexing";

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (running) {
    return (
      <button
        className="pill"
        onClick={() => setRoute("ingest")}
        title={t.ing_live_title}
      >
        <span className="ingest-chip-spinner" />
        <span>
          {t.nav_ingest} {startedAt ? formatTicker(now - startedAt) : ""}
        </span>
      </button>
    );
  }
  if (!seen && (stage === "done" || stage === "error")) {
    const ok = stage === "done";
    return (
      <button
        className="pill"
        onClick={() => setRoute("ingest")}
        title={ok ? t.ing_chip_done : t.ing_chip_error}
      >
        <span
          className="dot"
          style={{ background: ok ? "#16a34a" : "#dc2626" }}
        ></span>
        <span>{ok ? t.ing_chip_done : t.ing_chip_error}</span>
      </button>
    );
  }
  return null;
}

// Same pattern as IngestChip, for lint runs: spinner while running, then a
// done/failed chip until the user revisits the Provenance page.
function LintChip({ t }: { t: Strings }): JSX.Element | null {
  const stage = useLintStore((s) => s.stage);
  const seen = useLintStore((s) => s.seen);
  const setRoute = useUIStore((s) => s.setRoute);

  if (stage === "running") {
    return (
      <button
        className="pill"
        onClick={() => setRoute("provenance")}
        title={t.p_lint_running}
      >
        <span className="ingest-chip-spinner" />
        <span>{t.tb_lint ?? "Lint"}</span>
      </button>
    );
  }
  if (!seen && (stage === "done" || stage === "error")) {
    const ok = stage === "done";
    return (
      <button
        className="pill"
        onClick={() => setRoute("provenance")}
        title={ok ? t.p_lint_done : t.p_lint_failed}
      >
        <span
          className="dot"
          style={{ background: ok ? "#16a34a" : "#dc2626" }}
        ></span>
        <span>{ok ? t.p_lint_done : t.p_lint_failed}</span>
      </button>
    );
  }
  return null;
}

function breadcrumbFor(
  route: string,
  project: string,
  t: Strings,
): { crumb: string[]; icon: IconName } {
  if (route === "overview")
    return { crumb: [project, t.nav_overview], icon: "home" };
  if (route === "ingest")
    return { crumb: [project, t.nav_ingest], icon: "upload" };
  if (route === "query") return { crumb: [project, t.nav_query], icon: "msg" };
  if (route === "graph")
    return { crumb: [project, t.nav_graph], icon: "graph" };
  if (route === "history")
    return { crumb: [project, t.nav_history], icon: "history" };
  if (route === "provenance")
    return { crumb: [project, t.nav_provenance], icon: "quote" };
  if (route === "settings")
    return { crumb: [t.nav_settings], icon: "settings" };
  if (route.startsWith("page:")) {
    const path = route.slice(5);
    const name = path.split(/[\\/]/).pop() ?? path;
    return { crumb: [project, name], icon: "page" };
  }
  return { crumb: [project], icon: "home" };
}
