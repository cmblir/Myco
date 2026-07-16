// Overview — hero + real vault stats (file count, links, recent commits).

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useReflectStore } from "../stores/reflectStore";
import { ipc } from "../lib/ipc";
import type { FileNode, GitCommit } from "../lib/ipc";
import LinkSuggestions from "../components/LinkSuggestions";

export default function PageOverview({ t }: { t: Strings }): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  const currentVault = useVaultStore((s) => s.currentVault);
  const fileTree = useVaultStore((s) => s.fileTree);
  const adjacency = useVaultStore((s) => s.adjacency);
  const [recent, setRecent] = useState<GitCommit[]>([]);

  useEffect(() => {
    if (!currentVault) return;
    ipc
      .gitLog(currentVault.path, 8)
      .then(setRecent)
      .catch(() => setRecent([]));
  }, [currentVault]);

  const stats = useMemo(() => {
    const files = countFiles(fileTree);
    const sources = countIn(fileTree, "raw") + countIn(fileTree, "sources");
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
    return { files, sources, links, resolvedRatio };
  }, [fileTree, adjacency]);

  const recentLeaves = useMemo(
    () => collectFiles(fileTree).slice(0, 6),
    [fileTree],
  );

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.ov_eyebrow}</div>
        <h1 className="page-title">{t.ov_title}</h1>
        <p className="page-lede">{t.ov_lede}</p>
        <div className="row" style={{ marginTop: 24 }}>
          <button
            className="btn btn-primary"
            onClick={() => setRoute("ingest")}
          >
            <Icon name="upload" size={14} /> {t.ov_cta_ingest}
          </button>
          <button className="btn" onClick={() => setRoute("query")}>
            <Icon name="msg" size={14} /> {t.ov_cta_ask}
          </button>
        </div>
      </header>

      <div className="stat-strip">
        <Stat
          label={t.ov_stats_pages}
          value={String(stats.files)}
          sub={currentVault?.path ?? "—"}
        />
        <Stat
          label={t.ov_stats_sources}
          value={String(stats.sources)}
          sub="raw / sources folders"
        />
        <Stat
          label={t.ov_stats_links}
          value={String(stats.links)}
          sub="resolved wikilinks"
        />
        <Stat
          label={t.ov_stats_ratio}
          value={`${Math.round(stats.resolvedRatio * 100)}%`}
          sub="links resolved"
        />
      </div>

      {recentLeaves.length > 0 ? (
        <>
          <div className="section-head">
            <div className="section-title">{t.ov_quick}</div>
          </div>
          <div className="card-grid">
            {recentLeaves.slice(0, 3).map((node) => (
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
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: 600,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {node.name.replace(/\.md$/i, "")}
                </div>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                  {node.path}
                </div>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <LinkSuggestions t={t} />

      <div className="section-head">
        <div className="section-title">{t.ov_recent}</div>
        <button
          className="section-action"
          onClick={() => setRoute("history")}
          style={{ background: "transparent", border: 0 }}
        >
          {t.ov_recent_more} →
        </button>
      </div>
      <div className="list">
        {recent.length === 0 ? (
          <p className="muted" style={{ padding: "10px 6px" }}>
            {t.ov_no_git ?? "No git history yet."}
          </p>
        ) : (
          recent.map((c) => (
            <div key={c.hash} className="list-row">
              <span className="ic">
                <Icon name="save" size={14} />
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>{c.subject}</span>
              </span>
              <span className="meta">{c.date}</span>
              <span className="meta" style={{ fontFamily: "var(--font-mono)" }}>
                {c.hash}
              </span>
            </div>
          ))
        )}
      </div>

      <ReflectPanel t={t} />
    </div>
  );
}

// Read-only reflect pass (FEAT-06): a manual trigger plus a home for the
// suggestions the scheduler (or this button) produces. Shares reflectStore, so
// a run kicked here or by the scheduler shows up wherever the panel renders.
function ReflectPanel({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
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
          {stage === "done" || stage === "error" ? (
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

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div
        className="stat-sub"
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={sub}
      >
        {sub}
      </div>
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

function countIn(tree: FileNode[], folder: string): number {
  const root = tree.find(
    (n) => n.kind === "directory" && n.name.toLowerCase() === folder,
  );
  if (!root || root.kind !== "directory") return 0;
  return countFiles(root.children);
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
