// History page — the vault's ingest history. Every ingest run files a WHY
// report under `ingest-reports/`; this page lists them newest-first with an
// expandable in-place preview (rendered markdown) and a jump to the reader.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc, type RunSummary } from "../lib/ipc";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { flattenMarkdown } from "../lib/graphData";
import { formatRunLine } from "../lib/runList";
import { buildRunRows, type RunRows } from "../lib/runDetailView";
import DiffView from "../components/DiffView";
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
  const lang = useUIStore((s) => s.lang);
  const [mtimes, setMtimes] = useState<Map<string, number>>(new Map());
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  // Run drill-in (W3–6 item 6).
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [runRows, setRunRows] = useState<RunRows | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [undoingRun, setUndoingRun] = useState<string | null>(null);

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

  // The distill run list; section hides when empty or unavailable.
  useEffect(() => {
    if (!currentVault) return;
    let cancelled = false;
    ipc
      .listDistillRuns(currentVault.path, 20)
      .then((rs) => {
        if (!cancelled) setRuns(rs);
      })
      .catch(() => {
        /* run list unavailable — the Runs section stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [currentVault]);

  // Expanding a run fetches its manifest detail + git diff. A run without a
  // commit rejects with "no-commit" — fall back to the manifest file list.
  useEffect(() => {
    setRunRows(null);
    setRunError(null);
    if (!openRun || !currentVault) return;
    let cancelled = false;
    const vault = currentVault.path;
    void (async () => {
      try {
        const detail = await ipc.distillRunDetail(vault, openRun);
        const diffs = await ipc.distillRunDiff(vault, openRun).catch((e: unknown) => {
          if (String(e).includes("no-commit")) return null;
          throw e;
        });
        if (!cancelled) setRunRows(buildRunRows(detail, diffs));
      } catch (e: unknown) {
        if (!cancelled) setRunError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openRun, currentVault]);

  const undoRun = async (id: string): Promise<void> => {
    if (!currentVault) return;
    setUndoingRun(id);
    setRunError(null);
    try {
      await ipc.undoDistillRun(currentVault.path, id);
      setOpenRun(null);
      setRuns(await ipc.listDistillRuns(currentVault.path, 20));
      void refreshTree();
    } catch (e: unknown) {
      setRunError(String(e));
    } finally {
      setUndoingRun(null);
    }
  };

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

      {/* Distill runs (W3–6 item 6): expand → file rows + word diff; WHY →
          the run's ingest report; undo → existing undo_distill_run. */}
      {currentVault && runs.length > 0 ? (
        <section style={{ marginTop: 16 }} data-testid="history-runs">
          <div className="page-eyebrow">{t.history_runs_title}</div>
          {runError ? (
            <div style={{ color: "#dc2626", fontSize: 12.5, margin: "4px 0 8px" }}>
              {runError}
            </div>
          ) : null}
          <div className="col" style={{ marginTop: 8, gap: 0 }}>
            {runs.map((r) => {
              const open = openRun === r.id;
              // Hide WHY only once the open run's detail proved the report absent.
              const whyShown = !open || runRows === null || runRows.whyRel !== null;
              return (
                <div
                  key={r.id}
                  className="card"
                  style={{ padding: 0, borderRadius: 10, marginBottom: 8 }}
                >
                  {/* Same three-sibling disclosure pattern as the report rows
                      below — separately named buttons, no nesting. */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto auto auto",
                      gap: 12,
                      alignItems: "center",
                      padding: "12px 16px",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setOpenRun(open ? null : r.id)}
                      aria-expanded={open}
                      aria-label={r.id}
                      style={{
                        background: "transparent",
                        border: 0,
                        textAlign: "left",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 13.5,
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {r.id}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {formatRunLine(r, lang)}
                      </div>
                    </button>
                    {whyShown ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          setRoute(
                            `page:${currentVault.path}/ingest-reports/distill-${r.id}.md`,
                          )
                        }
                      >
                        {t.history_run_open_why}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void undoRun(r.id)}
                      disabled={undoingRun !== null}
                      aria-busy={undoingRun === r.id}
                    >
                      {undoingRun === r.id
                        ? (t.set_distill_undoing ?? "Undoing…")
                        : (t.set_distill_undo ?? "Undo this run")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpenRun(open ? null : r.id)}
                      aria-expanded={open}
                      aria-label={
                        open
                          ? (t.hist_collapse ?? "Collapse")
                          : (t.hist_expand ?? "Expand")
                      }
                      style={{
                        background: "transparent",
                        border: 0,
                        cursor: "pointer",
                        display: "grid",
                        placeItems: "center",
                        padding: 0,
                      }}
                    >
                      <Icon name={open ? "chevD" : "chevR"} size={13} />
                    </button>
                  </div>
                  {open ? (
                    <div
                      className="ingest-preview-body"
                      style={{ borderTop: "1px solid var(--line-soft)" }}
                    >
                      {runRows === null ? (
                        runError === null ? (
                          <div className="muted" style={{ fontSize: 12 }}>
                            …
                          </div>
                        ) : null
                      ) : (
                        <>
                          {runRows.noCommit ? (
                            <div
                              className="muted"
                              style={{ fontSize: 12.5, marginBottom: 8 }}
                            >
                              {t.history_no_commit}
                            </div>
                          ) : null}
                          {runRows.files.map((f) => (
                            <div key={f.rel} style={{ marginBottom: 10 }}>
                              <div
                                className="row"
                                style={{ gap: 8, marginBottom: 4 }}
                              >
                                <span className="typebadge">{t[f.statusKey]}</span>
                                <span
                                  style={{
                                    fontSize: 12.5,
                                    fontFamily: "var(--font-mono)",
                                  }}
                                >
                                  {f.rel}
                                </span>
                              </div>
                              {f.tooLarge ? (
                                <div className="muted" style={{ fontSize: 12 }}>
                                  {t.history_diff_too_large}
                                </div>
                              ) : null}
                              {f.diff !== null && f.diff.length > 0 ? (
                                <DiffView lines={f.diff} />
                              ) : null}
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {!currentVault ? (
        <p className="muted">{t.h_open_vault ?? "Open a vault to see history."}</p>
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
                {/* A plain grid row holding THREE sibling controls. It used to
                    be one disclosure <button> with a role="link" span nested
                    inside it — invalid interactive nesting that a screen reader
                    read as one polluted name ("report, date, Open report,
                    collapsed, button"). Same 4-column layout, now three real,
                    separately-named buttons. */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto auto",
                    gap: 16,
                    alignItems: "center",
                    padding: 16,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setOpenPath(open ? null : r.path)}
                    aria-expanded={open}
                    aria-label={r.name}
                    style={{
                      gridColumn: "1 / 3",
                      display: "grid",
                      gridTemplateColumns: "auto 1fr",
                      gap: 16,
                      alignItems: "center",
                      background: "transparent",
                      border: 0,
                      textAlign: "left",
                      cursor: "pointer",
                      padding: 0,
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
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setRoute(`page:${r.path}`)}
                  >
                    {t.ing_open_report}
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpenPath(open ? null : r.path)}
                    aria-expanded={open}
                    aria-label={
                      open
                        ? (t.hist_collapse ?? "Collapse")
                        : (t.hist_expand ?? "Expand")
                    }
                    style={{
                      background: "transparent",
                      border: 0,
                      cursor: "pointer",
                      display: "grid",
                      placeItems: "center",
                      padding: 0,
                    }}
                  >
                    <Icon name={open ? "chevD" : "chevR"} size={13} />
                  </button>
                </div>
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
