// Provenance page — scans every markdown file in the vault, counts claim
// lines, and flags those with citation coverage below the slider threshold.

import { Fragment, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { ProvenanceRow, SourceRef } from "../lib/ipc";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useLintStore } from "../stores/lintStore";

export default function PageProvenance({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const setRoute = useUIStore((s) => s.setRoute);
  const lang = useUIStore((s) => s.lang);
  const [rows, setRows] = useState<ProvenanceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [threshold, setThreshold] = useState(0.7);
  // Lint runs live in lintStore so navigating away doesn't lose them.
  const lintStage = useLintStore((s) => s.stage);
  const lintReport = useLintStore((s) => s.report);
  const lintProgress = useLintStore((s) => s.progress);
  const runLint = useLintStore((s) => s.runLint);
  const dismissLint = useLintStore((s) => s.dismiss);
  const markLintSeen = useLintStore((s) => s.markSeen);
  const lintBusy = lintStage === "running";

  // Visiting this page acknowledges a finished lint (clears the Topbar chip).
  useEffect(() => {
    markLintSeen();
  }, [lintStage, markLintSeen]);

  useEffect(() => {
    if (!currentVault) return;
    setLoading(true);
    setError(null);
    ipc
      .scanProvenance(currentVault.path)
      .then(setRows)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [currentVault]);

  const totals = useMemo(() => {
    if (!rows) return { cited: 0, total: 0 };
    return {
      cited: rows.reduce((s, r) => s + r.cited, 0),
      total: rows.reduce((s, r) => s + r.total, 0),
    };
  }, [rows]);

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_provenance}</div>
        <h1 className="page-title">{t.p_title}</h1>
        <p className="page-lede">{t.p_lede}</p>
        <div className="row" style={{ marginTop: 16 }}>
          <button
            className="btn btn-primary"
            onClick={() => void runLint()}
            disabled={!currentVault || lintBusy}
          >
            <Icon name="check" size={14} />{" "}
            {lintBusy ? (t.p_linting ?? "Linting…") : (t.p_lint_run ?? "Run lint")}
          </button>
        </div>
      </header>

      {lintBusy || lintReport ? (
        <section
          className="card"
          style={{
            marginTop: 16,
            padding: 16,
            background: "var(--bg-soft)",
          }}
        >
          <div
            className="row"
            style={{ justifyContent: "space-between", marginBottom: 8 }}
          >
            <div className="section-title" style={{ fontSize: 14 }}>
              {t.p_lint_report ?? "Lint report"}
            </div>
            {!lintBusy ? (
              <button
                type="button"
                className="btn-ghost btn"
                onClick={dismissLint}
              >
                <Icon name="x" size={12} /> {t.p_dismiss ?? "dismiss"}
              </button>
            ) : null}
          </div>
          {lintBusy ? (
            <div
              className="row muted"
              style={{ gap: 8, fontSize: 12.5, alignItems: "center" }}
            >
              <span className="ingest-chip-spinner" /> {t.p_lint_running}
            </div>
          ) : null}
          {/* Stage 7: stream the report as it arrives (Claude CLI runs only;
              other providers show the spinner until the batch result lands). */}
          {lintBusy && lintProgress ? (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-mono)",
                fontSize: 12.5,
                margin: "8px 0 0",
                maxHeight: 400,
                overflow: "auto",
                opacity: 0.85,
              }}
            >
              {lintProgress}
            </pre>
          ) : null}
          {lintReport ? (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-mono)",
                fontSize: 12.5,
                margin: 0,
                maxHeight: 400,
                overflow: "auto",
              }}
            >
              {lintReport}
            </pre>
          ) : null}
        </section>
      ) : null}

      {!currentVault ? (
        <p className="muted">{t.p_open_vault ?? "Open a vault to scan provenance."}</p>
      ) : loading ? (
        <p className="muted">{t.p_scanning ?? "Scanning vault…"}</p>
      ) : error ? (
        <div className="card-flat" style={{ color: "#dc2626" }}>
          {error}
        </div>
      ) : !rows || rows.length === 0 ? (
        <p className="muted">
          {t.p_empty ?? "No claim-bearing notes yet — add some prose."}
        </p>
      ) : (
        <>
          <div
            className="row"
            style={{ marginTop: 16, flexWrap: "wrap", gap: 12 }}
          >
            <div className="card-flat" style={{ flex: "1 1 240px", padding: 14 }}>
              <div className="row">
                <div style={{ flex: 1 }}>
                  <div
                    className="muted"
                    style={{
                      fontSize: 12,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {t.p_threshold}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2 }}>
                    {Math.round(threshold * 100)}%
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={threshold}
                  onChange={(e) => setThreshold(parseFloat(e.target.value))}
                  style={{ width: 200, accentColor: "var(--ink)" }}
                />
              </div>
            </div>
            <div className="card-flat" style={{ flex: "1 1 240px", padding: 14 }}>
              <div
                className="muted"
                style={{
                  fontSize: 12,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                {t.p_overall ?? "Overall"}
              </div>
              <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2 }}>
                {totals.total > 0
                  ? Math.round((totals.cited / totals.total) * 100)
                  : 0}
                %
                <span
                  className="muted"
                  style={{ fontSize: 13, fontWeight: 400, marginLeft: 8 }}
                >
                  {totals.cited} / {totals.total} {t.p_claims_cited ?? "claims cited"}
                </span>
              </div>
            </div>
          </div>

          <div className="section-head">
            <div className="section-title" style={{ fontSize: 14 }}>
              {t.p_pages_by_coverage ?? "Pages, by claim coverage"}
            </div>
          </div>
          <div className="list">
            {rows.map((r) => {
              const pct = r.total > 0 ? r.cited / r.total : 1;
              const low = pct < threshold;
              return (
                <Fragment key={r.path}>
                <button
                  className="list-row"
                  style={{
                    gridTemplateColumns: "20px 1.4fr 2fr auto auto",
                    background: "transparent",
                    border: 0,
                    textAlign: "left",
                  }}
                  onClick={() => setRoute(`page:${r.path}`)}
                >
                  <span className="ic">
                    <Icon name="page" size={13} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.name.replace(/\.md$/i, "")}
                    </div>
                    <div
                      className="muted"
                      style={{
                        fontSize: 12,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.path}
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <div
                      className="cov-bar"
                      style={{ flex: 1 }}
                      role="meter"
                      aria-valuenow={Math.round(pct * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${Math.round(pct * 100)}% claims cited${
                        low ? ", low coverage" : ""
                      }`}
                    >
                      <div
                        className="cov-bar-fill"
                        style={{
                          width: `${pct * 100}%`,
                          background: low ? "var(--c-technique)" : "var(--ink)",
                        }}
                      ></div>
                    </div>
                    <span
                      className="muted"
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        minWidth: 88,
                        textAlign: "right",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {/* Non-color marker for low coverage (WCAG 1.4.1) */}
                      {low ? (
                        <span aria-hidden="true" style={{ marginRight: 4 }}>
                          !
                        </span>
                      ) : null}
                      {Math.round(pct * 100)}%
                      <span style={{ opacity: 0.6 }}>
                        {" "}
                        ({r.cited}/{r.total})
                      </span>
                    </span>
                  </div>
                  <span
                    className="chip"
                    style={{
                      background: low
                        ? "rgba(220,38,38,0.08)"
                        : "rgba(22,163,74,0.08)",
                      color: low ? "var(--c-technique)" : "var(--c-entity)",
                    }}
                  >
                    {low ? t.p_low : t.p_ok}
                  </span>
                  <span className="ic">
                    <Icon name="chevR" size={12} />
                  </span>
                </button>
                {r.sources.length > 0 ? (
                  <SourceList sources={r.sources} t={t} lang={lang} />
                ) : null}
                </Fragment>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Vendor display names are proper nouns — shown as-is, not translated.
const VENDOR_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude.ai",
  "claude-code": "Claude Code",
  codex: "Codex",
};

// `created` is an epoch (seconds, from the importer) or a date string (a
// hand-authored source). Format both; fall back to the raw value if neither.
function formatSourceDate(created: string | null, lang: string): string | null {
  if (!created) return null;
  const d = /^\d+$/.test(created)
    ? new Date(Number(created) * 1000)
    : new Date(created);
  if (Number.isNaN(d.getTime())) return created;
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// The sources a page cites, resolved to their provenance — collapsed by default
// so the coverage table stays scannable, expandable to trace each claim back to
// the conversation (or hand-authored source) it came from.
function SourceList({
  sources,
  t,
  lang,
}: {
  sources: SourceRef[];
  t: Strings;
  lang: string;
}): JSX.Element {
  return (
    <details
      className="prov-sources"
      data-testid="prov-sources"
      style={{
        margin: "-2px 0 6px 40px",
        fontSize: 12.5,
      }}
    >
      <summary style={{ cursor: "pointer", color: "var(--ink-3)" }}>
        {(t.p_sources ?? "Sources ({n})").replace("{n}", String(sources.length))}
      </summary>
      <ul
        style={{
          listStyle: "none",
          margin: "6px 0 0",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {sources.map((s) => {
          const vendor = VENDOR_LABEL[s.kind];
          const date = formatSourceDate(s.created, lang);
          return (
            <li
              key={s.slug}
              className="row"
              style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}
            >
              <span
                className="chip"
                style={{
                  background: vendor
                    ? "rgba(37,99,235,0.1)"
                    : "var(--bg-soft)",
                  color: vendor ? "var(--accent, #2563eb)" : "var(--ink-3)",
                  flexShrink: 0,
                }}
              >
                {vendor ?? (t.p_src_manual ?? "Written source")}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: s.resolved ? "var(--ink)" : "var(--ink-3)",
                }}
                title={s.title ?? s.slug}
              >
                {s.title ?? s.slug}
                {!s.resolved ? (
                  <span className="muted" style={{ marginLeft: 6 }}>
                    ({t.p_src_missing ?? "raw source missing"})
                  </span>
                ) : null}
              </span>
              {date ? (
                <span className="muted" style={{ flexShrink: 0, fontSize: 11.5 }}>
                  {date}
                </span>
              ) : null}
              {s.conversation_id ? (
                <span
                  className="muted"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    flexShrink: 0,
                  }}
                  title={s.conversation_id}
                >
                  {s.conversation_id.slice(0, 8)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
