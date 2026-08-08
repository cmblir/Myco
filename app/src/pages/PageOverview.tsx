// Overview — the vault's own state: counts, 7-day activity, what moved
// recently. The hero copy renders only for an empty vault, where it is the
// only true thing to show.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useReflectStore } from "../stores/reflectStore";
import { ipc } from "../lib/ipc";
import type { FileNode } from "../lib/ipc";
import LinkSuggestions from "../components/LinkSuggestions";
import VaultPulse from "../components/VaultPulse";
import RecentNotes from "../components/RecentNotes";
import { bucketByDay } from "../lib/vaultPulse";

export default function PageOverview({ t }: { t: Strings }): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);
  const currentVault = useVaultStore((s) => s.currentVault);
  const fileTree = useVaultStore((s) => s.fileTree);
  const adjacency = useVaultStore((s) => s.adjacency);
  const [mtimes, setMtimes] = useState<[string, number][]>([]);

  useEffect(() => {
    if (!currentVault) return;
    let cancelled = false;
    // One read per vault change — the dashboard does not poll. Failure is
    // quiet and degrades to "no activity yet" rather than an error state: a
    // missing sparkline must not take the page's numbers down with it.
    ipc
      .fileMtimes(currentVault.path)
      .then((rows) => {
        if (!cancelled) setMtimes(rows);
      })
      .catch(() => {
        if (!cancelled) setMtimes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentVault]);

  const buckets = useMemo(
    () => bucketByDay(mtimes, currentVault?.path ?? "", 7, new Date()),
    [mtimes, currentVault],
  );

  const stats = useMemo(() => {
    const files = countFiles(fileTree);
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
    return { files, links, resolvedRatio };
  }, [fileTree, adjacency]);

  const recentLeaves = useMemo(
    () => collectFiles(fileTree).slice(0, 6),
    [fileTree],
  );

  return (
    <div className="workspace">
      {stats.files === 0 ? (
        // For an empty vault this copy is the only true thing to show, and it
        // is the one moment it is genuinely useful. With pages present it is
        // product copy shown to someone who already uses the product.
        <header className="page-head">
          <div className="page-eyebrow">{t.ov_eyebrow}</div>
          <h1 className="page-title">{t.ov_title}</h1>
          <p className="page-lede">{t.ov_lede}</p>
        </header>
      ) : (
        <VaultPulse
          t={t}
          pages={stats.files}
          links={stats.links}
          buckets={buckets}
          resolvedRatio={stats.resolvedRatio}
        />
      )}

      <div className="row" style={{ marginTop: 20 }}>
        <button className="btn btn-primary" onClick={() => setRoute("ingest")}>
          <Icon name="upload" size={14} /> {t.ov_cta_ingest}
        </button>
        <button className="btn" onClick={() => setRoute("query")}>
          <Icon name="msg" size={14} /> {t.ov_cta_ask}
        </button>
      </div>

      <div className="ov-bands">
        {recentLeaves.length > 0 ? (
          <section>
            <div className="section-head">
              <div className="section-title">{t.ov_quick}</div>
            </div>
            <div className="card-grid">
              {recentLeaves.slice(0, 2).map((node) => (
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
                  <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>
                    {node.name.replace(/\.md$/i, "")}
                  </div>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <RecentNotes t={t} entries={mtimes} vaultRoot={currentVault?.path ?? ""} />
      </div>

      <LinkSuggestions t={t} />

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
