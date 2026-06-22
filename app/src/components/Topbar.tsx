// Topbar — breadcrumb + meta + language switch.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { IconName } from "../lib/icons";
import type { Lang, Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useIngestStore } from "../stores/ingestStore";
import { useLintStore } from "../stores/lintStore";
import { ipc } from "../lib/ipc";
import type { ClaudeStatus } from "../lib/ipc";
import { formatTicker } from "../lib/time";

export default function Topbar({ t }: { t: Strings }): JSX.Element {
  const route = useUIStore((s) => s.route);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleCmd = useUIStore((s) => s.toggleCmd);
  const lang = useUIStore((s) => s.lang);
  const setLang = useUIStore((s) => s.setLang);
  const currentVault = useVaultStore((s) => s.currentVault);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);

  useEffect(() => {
    ipc
      .claudeCheck()
      .then(setClaude)
      .catch(() => undefined);
  }, []);

  const projectName = currentVault?.name ?? t.app_name;
  const { crumb, icon } = breadcrumbFor(route, projectName, t);

  return (
    <div className="topbar">
      <button
        className="icon-btn"
        onClick={toggleSidebar}
        title="Toggle sidebar (⌘B)"
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
      <IngestChip t={t} />
      <LintChip t={t} />
      <button className="pill" onClick={toggleCmd}>
        <Icon name="search" size={14} />
        <span>{t.ph_search}</span>
        <span className="kbd" style={{ marginLeft: 4 }}>
          ⌘K
        </span>
      </button>
      <span
        className="pill"
        title={
          claude?.installed
            ? `claude CLI ${claude.version ?? ""} (${claude.path})`
            : "claude CLI not detected on PATH"
        }
      >
        <span
          className="dot"
          style={{
            background: claude?.installed ? "#16a34a" : "var(--ink-4)",
          }}
        ></span>
        <span>claude {claude?.installed ? "ready" : "offline"}</span>
      </span>
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
        <span>Lint</span>
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
