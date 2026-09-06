// Settings > MCP — the in-process server's status and how to register it.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../../lib/i18n";
import { ipc } from "../../lib/ipc";
import type { McpNativeInfo } from "../../lib/ipc";

export function SettingsMcp({ t }: { t: Strings }): JSX.Element {
  const [info, setInfo] = useState<McpNativeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // The native server is global (not per-vault) and auto-starts at launch —
  // there is nothing to install, so this just reads its status + connect info.
  useEffect(() => {
    let alive = true;
    ipc
      .mcpInfo()
      .then((i) => {
        if (alive) setInfo(i);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  function copy(text: string, which: string): void {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1500);
    });
  }

  // One-click Connect: register memex with Claude Code over HTTP, token header
  // included. Re-runnable — it removes any stale entry first.
  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const msg = await ipc.mcpConnect();
      setStatus(msg);
      setTick((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

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

      {/* The server runs in-process and starts with the app — no install. */}
      <div
        style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: info?.running ? "#22c55e" : "#9aa0a8",
            display: "inline-block",
          }}
          aria-hidden="true"
        />
        {info?.running
          ? `${t.mcp_serving ?? "MCP server running"} — ${info.url}`
          : (t.mcp_starting ?? "MCP server starting…")}
      </div>

      <div className="col" style={{ gap: 8 }}>
        <button
          className="btn btn-primary"
          disabled={busy || !info}
          onClick={() => void connect()}
          style={{ alignSelf: "flex-start" }}
        >
          {busy
            ? (t.mcp_connecting ?? "Connecting…")
            : (t.mcp_connect_btn ?? "Connect to Claude Code")}
        </button>
        {status ? (
          <div style={{ fontSize: 12, color: "#16a34a" }}>{status}</div>
        ) : null}
      </div>

      {info ? (
        <div className="col" style={{ gap: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {t.mcp_command_label}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {t.mcp_connect_hint ?? "Or run this once in a terminal:"}
          </div>
          {codeBox(info.command, "cmd")}
        </div>
      ) : null}

      {info ? (
        <div className="col" style={{ gap: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {t.mcp_desktop_label}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {t.mcp_desktop_path}
          </div>
          {codeBox(info.desktop_json, "desktop")}
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

// Ontology distillation (Task 8, Phase A). Edits DistillConfig — every field
// writes straight through setDistillConfig (no separate save button, matching
// AutoReflect/AutoIngest above). "Distill now" runs distill_run directly and
// shows the RunReport inline (no toast component exists in this app yet).
