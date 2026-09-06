// Sidebar status strip — the four things that break quietly.
//
// The footer this replaces said `Vault linked · 59f` and nothing else, so a
// stale index, a dead MCP server or an unloadable model showed up only as
// "the answers got worse". Four glass tiles, each reading a source that
// already exists; a tile that is unhappy takes an amber dot AND a border AND
// a reason line (never colour alone), and the strip offers exactly one action.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import indexingPng from "../assets/activity/indexing.png";
import mcpPng from "../assets/activity/mcp.png";
import askPng from "../assets/activity/ask.png";
import type { Strings } from "../lib/i18n";
import { flattenMarkdown } from "../lib/graphData";
import { ipc } from "../lib/ipc";
import { PROVIDERS } from "../lib/providers";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useReindexStore } from "../stores/reindexStore";
import { useSettingsStore } from "../stores/settingsStore";

/** Markdown counts behind the vault tile: the sessions/wiki ratio is the
 *  single most telling number about this vault (1,473 vs 269 on the owner's). */
export function vaultSplit(
  files: string[],
  root: string | undefined,
): { total: number; sessions: number; wiki: number } {
  const prefix = root ? (root.endsWith("/") ? root : `${root}/`) : "";
  let sessions = 0;
  let wiki = 0;
  for (const f of files) {
    if (!prefix) continue;
    if (f.startsWith(`${prefix}sessions/`)) sessions++;
    else if (f.startsWith(`${prefix}wiki/`)) wiki++;
  }
  return { total: files.length, sessions, wiki };
}

/** Which tile is unhappy, and why. At most one note is shown: a dead MCP
 *  server outranks a lagging index because nothing else works without it.
 *  `null` = every source is healthy. */
export function statusWarning(input: {
  mcpRunning: boolean | null;
  wikiPages: number;
  indexedPages: number | null;
}): "mcp" | "index" | null {
  if (input.mcpRunning === false) return "mcp";
  // An index that holds fewer pages than the wiki has cannot retrieve the
  // rest — the honest half of "is the index fresh?" that needs no timestamp.
  if (input.indexedPages !== null && input.wikiPages > input.indexedPages) return "index";
  return null;
}

function providerName(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.name ?? id;
}

export default function StatusStrip({ t }: { t: Strings }): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const setRoute = useUIStore((s) => s.setRoute);
  const setSettingsTab = useUIStore((s) => s.setSettingsTab);
  const fileTree = useVaultStore((s) => s.fileTree);
  const currentVault = useVaultStore((s) => s.currentVault);
  const settings = useSettingsStore((s) => s.settings);
  const indexedPages = useReindexStore((s) => s.indexedPages);
  const refreshStatus = useReindexStore((s) => s.refreshStatus);
  const reindex = useReindexStore((s) => s.reindex);
  const stage = useReindexStore((s) => s.stage);
  const [mcpRunning, setMcpRunning] = useState<boolean | null>(null);
  const [showSplit, setShowSplit] = useState(false);
  // Dev-only, ?mock=1 only: forces the unhappy branch so the amber path can be
  // seen without stopping the real server.
  const [broken, setBroken] = useState(false);
  const canSimulate =
    import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock");

  useEffect(() => {
    if (indexedPages === null) void refreshStatus();
  }, [indexedPages, refreshStatus, fileTree]);

  useEffect(() => {
    let alive = true;
    ipc.mcpInfo().then(
      (i) => alive && setMcpRunning(i.running),
      // Unreachable server = not running, which is exactly what the tile says.
      () => alive && setMcpRunning(false),
    );
    return () => {
      alive = false;
    };
  }, []);

  const nf = new Intl.NumberFormat(lang);
  const split = vaultSplit(flattenMarkdown(fileTree), currentVault?.path);
  const running = broken ? false : mcpRunning;
  const indexed = broken ? 0 : indexedPages;
  const warning = statusWarning({
    mcpRunning: running,
    wikiPages: split.wiki,
    indexedPages: indexed,
  });
  const busy = stage === "loading-model" || stage === "indexing";

  const openSettings = (tab: "account" | "model" | "mcp"): void => {
    setSettingsTab(tab);
    setRoute("settings");
  };

  const tile = (
    key: string,
    label: string,
    value: string,
    onClick: () => void,
    icon: JSX.Element,
    bad = false,
  ): JSX.Element => (
    <button
      key={key}
      className={"st-cell" + (bad ? " is-bad" : "")}
      onClick={onClick}
      aria-label={`${label}: ${value}`}
    >
      <span className="st-ico" aria-hidden="true">
        {icon}
      </span>
      <span className="st-tx">
        <span className="st-lab">{label}</span>
        <span className="st-val">{value}</span>
      </span>
      <span className="sdot st-dot" aria-hidden="true"></span>
    </button>
  );

  const png = (src: string): JSX.Element => <img src={src} alt="" />;

  return (
    <div className="side-status">
      <div className="st-head">
        <span>{t.sb_status ?? "Status"}</span>
        {canSimulate ? (
          <button
            className={"pill" + (broken ? " is-active" : "")}
            aria-pressed={broken}
            onClick={() => setBroken((v) => !v)}
          >
            {t.sb_st_simulate ?? "Simulate failure"}
          </button>
        ) : null}
      </div>
      <div className="st-grid">
        {tile(
          "vault",
          t.sb_st_vault ?? "Vault",
          currentVault ? nf.format(split.total) : "—",
          () => setShowSplit((v) => !v),
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <ellipse cx="12" cy="6" rx="8" ry="3" />
            <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
            <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
          </svg>,
        )}
        {tile(
          "index",
          t.sb_st_index ?? "Index",
          indexed === null
            ? "—"
            : indexed === 0
              ? (t.s_embeddings_empty ?? "Not indexed yet")
              : nf.format(indexed),
          () => openSettings("model"),
          png(indexingPng),
          warning === "index",
        )}
        {tile(
          "mcp",
          "MCP",
          running === null
            ? "—"
            : running
              ? (t.sb_st_on ?? "running")
              : (t.sb_st_off ?? "stopped"),
          () => openSettings("mcp"),
          png(mcpPng),
          warning === "mcp",
        )}
        {tile(
          "model",
          t.sb_st_model ?? "Model",
          settings
            ? `${providerName(settings.query_provider)} · ${settings.query_model || "—"}`
            : "—",
          () => openSettings("model"),
          png(askPng),
        )}
      </div>
      {showSplit ? (
        <div className="st-split">
          sessions <b>{nf.format(split.sessions)}</b> · wiki <b>{nf.format(split.wiki)}</b>
        </div>
      ) : null}
      {warning ? (
        <div className="st-note" role="status">
          <span aria-hidden="true">▲</span>
          <span>
            {warning === "mcp"
              ? (t.sb_st_mcp_down ?? "The MCP server is stopped — agents cannot reach this vault.")
              : (t.sb_st_lagging ?? "{n} wiki pages are outside the index — Ask cannot find them.").replace(
                  "{n}",
                  nf.format(Math.max(0, split.wiki - (indexed ?? 0))),
                )}
            <button
              className="st-fix"
              disabled={warning === "index" && busy}
              onClick={() => (warning === "mcp" ? openSettings("mcp") : void reindex())}
            >
              {warning === "mcp"
                ? (t.nav_settings ?? "Settings")
                : busy
                  ? (t.s_embeddings_indexing ?? "Indexing…")
                  : (t.s_embeddings_reindex ?? "Reindex now")}
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
