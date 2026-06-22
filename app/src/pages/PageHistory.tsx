// History page — the vault's ingest history. Every ingest run files a WHY
// report under `ingest-reports/`; this page lists them newest-first with an
// expandable in-place preview (rendered markdown) and a jump to the reader.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { flattenMarkdown } from "../lib/graphData";
import Viewer from "../components/Viewer";

interface ReportRow {
  path: string; // absolute
  name: string; // filename without extension
  mtime: number; // unix seconds
}

export default function PageHistory({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const fileTree = useVaultStore((s) => s.fileTree);
  const refreshTree = useVaultStore((s) => s.refreshTree);
  const setRoute = useUIStore((s) => s.setRoute);
  const [mtimes, setMtimes] = useState<Map<string, number>>(new Map());
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);

  // Pick up reports a just-finished run may have written.
  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  useEffect(() => {
    if (!currentVault) return;
    let cancelled = false;
    ipc
      .fileMtimes(currentVault.path)
      .then((rows) => {
        if (!cancelled) setMtimes(new Map(rows));
      })
      .catch(() => {
        /* mtimes unavailable — list stays name-ordered */
      });
    return () => {
      cancelled = true;
    };
  }, [currentVault, fileTree]);

  const reports = useMemo<ReportRow[]>(() => {
    return flattenMarkdown(fileTree)
      .filter((p) => /[\\/]ingest-reports[\\/]/.test(p))
      .map((p) => ({
        path: p,
        name: (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, ""),
        mtime: mtimes.get(p) ?? 0,
      }))
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  }, [fileTree, mtimes]);

  // Load the expanded report's content; re-runs when a different row opens.
  useEffect(() => {
    if (!openPath) {
      setContent(null);
      return;
    }
    let cancelled = false;
    ipc
      .readFile(openPath)
      .then((f) => {
        if (!cancelled) setContent(f.content);
      })
      .catch((e: unknown) => {
        if (!cancelled) setContent(`ERROR: ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [openPath]);

  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [],
  );

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_history}</div>
        <h1 className="page-title">{t.h_title}</h1>
        <p className="page-lede">{t.h_lede}</p>
      </header>

      {!currentVault ? (
        <p className="muted">Open a vault to see history.</p>
      ) : reports.length === 0 ? (
        <div
          className="card-flat"
          style={{ display: "flex", gap: 12, alignItems: "flex-start" }}
        >
          <Icon name="info" size={16} />
          <div style={{ fontSize: 13.5, color: "var(--ink-3)" }}>
            {t.h_empty}
          </div>
        </div>
      ) : (
        <div className="col" style={{ marginTop: 16, gap: 0 }}>
          {reports.map((r, i) => {
            const open = openPath === r.path;
            return (
              <div
                key={r.path}
                className="card"
                style={{ padding: 0, borderRadius: 10, marginBottom: 8 }}
              >
                <button
                  type="button"
                  onClick={() => setOpenPath(open ? null : r.path)}
                  aria-expanded={open}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto auto",
                    gap: 16,
                    alignItems: "center",
                    padding: 16,
                    width: "100%",
                    background: "transparent",
                    border: 0,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: i === 0 ? "var(--ink)" : "var(--bg-soft)",
                      color: i === 0 ? "var(--bg)" : "var(--ink-3)",
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    <Icon name={i === 0 ? "spark" : "upload"} size={16} />
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>
                      {r.name}
                    </div>
                    {r.mtime > 0 ? (
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        {dateFmt.format(new Date(r.mtime * 1000))}
                      </div>
                    ) : null}
                  </div>
                  <span
                    className="btn"
                    role="link"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRoute(`page:${r.path}`);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        setRoute(`page:${r.path}`);
                      }
                    }}
                  >
                    {t.ing_open_report}
                  </span>
                  <Icon name={open ? "chevD" : "chevR"} size={13} />
                </button>
                {open ? (
                  <div
                    className="ingest-preview-body"
                    style={{ borderTop: "1px solid var(--line-soft)" }}
                  >
                    {content === null ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        …
                      </div>
                    ) : (
                      <Viewer content={content} />
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
