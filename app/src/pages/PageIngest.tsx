// Ingest page — "Sieve": refusal is a first-class stage. Drop a file or paste
// raw text; the judgement stage (ingestStore.startIngest → judge_source) sorts
// it into drop / log / harvest BEFORE any file exists, harvests go through the
// plan gate and the writing agent, and the backfill queue for the sessions/
// archive sits on this page as the largest unopened input. The run itself
// lives in ingestStore (streamed events, cancel, stage), so it keeps going —
// and stays visible via the Topbar chip — while the user navigates elsewhere.
// This page is the rail, the judgement tile (with the form inside it), the
// verdict rows, the live progress panel and the backfill panel.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { InflowStats } from "../lib/ipc";
import { isMediaFile, sourceTextFor } from "../lib/mediaIngest";
import { formatElapsed } from "../lib/time";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUIStore } from "../stores/uiStore";
import { listInboxEntries, pendingInboxRows } from "../lib/autoIngest";
import type { PendingInboxRow } from "../lib/autoIngest";
import ZoteroImport from "../components/ZoteroImport";
import ConversationImport from "../components/ConversationImport";
import SessionBackfill from "../components/SessionBackfill";
import { useIngestStore } from "../stores/ingestStore";
import type { IngestStage, JudgedEntry } from "../stores/ingestStore";
import IngestProgress from "../components/IngestProgress";
import { ActivityIcon } from "../components/ActivityPanel";
import type { ActivityIconName } from "../components/ActivityPanel";
import { dropNoticeFor } from "../lib/ingestDrop";

/** Verdict rows shown under the tile; the store keeps more for the tally. */
const SHOW_ROWS = 6;

const fill = (s: string, vars: Record<string, string | number>): string =>
  Object.entries(vars).reduce(
    (acc, [k, v]) =>
      acc.replaceAll(`{${k}}`, typeof v === "number" ? v.toLocaleString() : v),
    s,
  );

export default function PageIngest({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const settings = useSettingsStore((s) => s.settings);
  const [over, setOver] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [ytBusy, setYtBusy] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  const [inflow, setInflow] = useState<InflowStats | null>(null);
  // The drop listener is registered once; keep the latest copy reachable so its
  // message follows a language change (same reason the handler reads settings
  // via getState() rather than closing over them).
  const tRef = useRef(t);
  tRef.current = t;
  const stage = useIngestStore((s) => s.stage);
  const inboxRev = useIngestStore((s) => s.inboxRev);
  // Only "are there any events?" is needed here; subscribing to the array
  // itself re-rendered this whole page on every stream event.
  const hasEvents = useIngestStore((s) => s.events.length > 0);
  const log = useIngestStore((s) => s.log);
  const startedAt = useIngestStore((s) => s.startedAt);
  const finishedAt = useIngestStore((s) => s.finishedAt);
  const reportPath = useIngestStore((s) => s.reportPath);
  const storedVaultPath = useIngestStore((s) => s.vaultPath);
  const judged = useIngestStore((s) => s.judged);
  const plan = useIngestStore((s) => s.plan);
  const startIngest = useIngestStore((s) => s.startIngest);
  const markSeen = useIngestStore((s) => s.markSeen);
  const resetIngest = useIngestStore((s) => s.reset);

  const setRoute = useUIStore((s) => s.setRoute);

  // Pending _inbox sources — the `_inbox` channel row. Refetched when a run
  // finishes because ingest archives the consumed source.
  const [inboxRows, setInboxRows] = useState<PendingInboxRow[] | null>(null);
  useEffect(() => {
    const root = currentVault?.path;
    if (!root) {
      setInboxRows(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const entries = await listInboxEntries(root);
      if (!cancelled) setInboxRows(pendingInboxRows(entries, root));
    })();
    return () => {
      cancelled = true;
    };
    // inboxRev bumps only after the archive move LANDS — the stage flips to
    // "done" earlier, and refetching on stage alone raced the move into
    // showing an already-consumed row with a soon-dead path.
  }, [currentVault, stage, inboxRev]);

  // Today's arrivals per channel. Best-effort, one read per vault/run — a
  // missing count is a dash, never an error state.
  useEffect(() => {
    const root = currentVault?.path;
    if (!root) return;
    let cancelled = false;
    ipc
      .inflowStats(root)
      .then((s) => {
        if (!cancelled) setInflow(s);
      })
      .catch(() => {
        if (!cancelled) setInflow(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentVault, stage]);

  // Unsupported formats stay listed (and counted) rather than vanishing — the
  // pass leaves them in place, and the count line says so.
  const unsupportedCount =
    inboxRows?.filter((r) => r.kind === "unsupported").length ?? 0;

  const running =
    stage === "writing-raw" ||
    stage === "plan-gate" ||
    stage === "claude" ||
    stage === "indexing";
  // After the run ends the panel stays up as the result view (mini galaxy,
  // feed, counters) until the user starts another ingest. Streamless runs
  // (HTTP providers) have no events and fall back to the plain form+banner.
  const showResults = running || hasEvents;

  // Visiting this page acknowledges a finished run (clears the Topbar chip).
  useEffect(() => {
    markSeen();
  }, [stage, markSeen]);

  // Tauri intercepts drag-drop at the OS level (so the browser drop event
  // never fires inside the WebView). Subscribe to its native event instead
  // and read the file via Rust IPC — we get a real path + UTF-8 contents.
  //
  // Subscription is set up exactly once per mount. `cancelled` handles the
  // race where the user navigates away before onDragDropEvent resolves;
  // the functional setState for title avoids re-subscribing on every
  // keystroke.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const webview = getCurrentWebview();
      const u = await webview.onDragDropEvent(async (event) => {
        if (event.payload.type === "over") {
          setOver(true);
          return;
        }
        if (event.payload.type === "leave") {
          setOver(false);
          return;
        }
        if (event.payload.type === "drop") {
          setOver(false);
          const paths = event.payload.paths ?? [];
          if (paths.length === 0) return;
          const first = paths[0];
          setDropError(null);
          // The form composes ONE source; extra dropped files used to vanish
          // with no signal. Load the first, but say so when there were more.
          setDropNotice(
            dropNoticeFor(paths.length, tRef.current.ing_drop_multi),
          );
          const base = first.split(/[\\/]/).pop() ?? "";
          // Whisper preflight: media without the CLI used to fail late inside
          // transcribe_media with a raw error — say so up front instead.
          if (isMediaFile(first) && !(await whisperInstalled())) {
            setDropError(tRef.current.voice_whisper_missing);
            return;
          }
          setTitle((prev) => prev || base.replace(/\.[^.]+$/, ""));
          try {
            const s = useSettingsStore.getState().settings;
            const text = await sourceTextFor(first, {
              provider: s?.query_provider ?? "",
              model: s?.query_model ?? "",
            });
            setBody(text);
          } catch (err) {
            setDropError(`Could not read ${first}: ${String(err)}`);
          }
        }
      });
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const canRun = !!currentVault && (title.trim() || body.trim());

  function resetForAnother(): void {
    resetIngest();
    setTitle("");
    setBody("");
    setDropError(null);
    setDropNotice(null);
  }

  // Pull a YouTube video's captions into the body so it ingests like any source.
  async function loadYoutube(): Promise<void> {
    setDropError(null);
    setYtBusy(true);
    try {
      const txt = await ipc.fetchYoutubeTranscript(body.trim());
      setBody(txt);
      setTitle((prev) => prev || "YouTube transcript");
    } catch (err) {
      setDropError(`Transcript failed: ${String(err)}`);
    } finally {
      setYtBusy(false);
    }
  }

  async function browseAndLoad(): Promise<void> {
    setDropError(null);
    let path: string | null = null;
    try {
      path = await ipc.pickTextFile();
    } catch (err) {
      setDropError(`File picker failed: ${String(err)}`);
      return;
    }
    if (!path) return;
    if (isMediaFile(path) && !(await whisperInstalled())) {
      setDropError(t.voice_whisper_missing);
      return;
    }
    const base = path.split(/[\\/]/).pop() ?? "";
    setTitle((prev) => prev || base.replace(/\.[^.]+$/, ""));
    try {
      const text = await sourceTextFor(path, {
        provider: settings?.query_provider ?? "",
        model: settings?.query_model ?? "",
      });
      setBody(text);
    } catch (err) {
      setDropError(`Could not read ${path}: ${String(err)}`);
    }
  }

  // Session tally: NOOP endings count as drops (zero files either way). A
  // drop saved the planner and the writer; a NOOP ending only the writer.
  const tally = useMemo(() => {
    let drop = 0;
    let logged = 0;
    let harvest = 0;
    let saved = 0;
    for (const j of judged) {
      if (j.verdict === "drop") {
        drop++;
        saved += 2;
      } else if (j.verdict === "noop") {
        drop++;
        saved += 1;
      } else if (j.verdict === "log") logged++;
      else harvest++;
    }
    return { drop, log: logged, harvest, saved };
  }, [judged]);

  // Refusals grouped by the rule that decided, newest reason kept.
  const refusedGroups = useMemo(() => {
    const groups = new Map<string, { count: number; last: string }>();
    for (const j of judged) {
      if (j.verdict === "harvest") continue;
      const g = groups.get(j.rule);
      if (g) g.count++;
      else groups.set(j.rule, { count: 1, last: j.reason });
    }
    return [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [judged]);
  const refusedTotal = tally.drop + tally.log;

  const todayIntake = (inflow?.inboxToday ?? 0) + (inflow?.sessionsToday ?? 0);
  const railGate =
    stage === "plan-gate"
      ? t.sv_reviewing
      : stage === "claude" || stage === "indexing" || stage === "done"
        ? plan.length > 0
          ? plan.length.toLocaleString()
          : t.sv_done
        : t.sv_waiting;
  const railRun =
    stage === "claude" || stage === "indexing"
      ? t.sv_running
      : stage === "done"
        ? t.sv_done
        : stage === "error"
          ? t.sv_failed
          : t.sv_idle;

  const channelIcon = (name: ActivityIconName): ReactNode => (
    <ActivityIcon name={name} size={28} />
  );

  return (
    <div className="workspace sv" data-testid="sieve">
      <ol className="sv-rail" aria-label={t.sv_rail_label}>
        <RailStep n={1} label={t.sv_step_intake} value={fill(t.sv_today_n, { n: todayIntake })} state={stage === "idle" ? "active" : undefined} />
        <RailStep
          n={2}
          label={t.sv_step_judge}
          value={fill(t.sv_tally, { d: tally.drop, l: tally.log, h: tally.harvest })}
          state={judgeState(stage)}
        />
        <RailStep n={3} label={t.sv_step_gate} value={railGate} state={gateState(stage)} />
        <RailStep n={4} label={t.sv_step_run} value={railRun} state={runState(stage)} />
        <RailStep
          n={5}
          label={t.sv_step_backfill}
          value={fill(t.sv_queue_n, { n: inboxRows?.length ?? 0 })}
        />
      </ol>

      {/* ── 2 · Judgement — the hero ─────────────────────────────────── */}
      <section className="sv-hero-wrap" aria-labelledby="sv-judge-title">
        <div className="sv-hero-glow" aria-hidden="true" />
        <div className="sv-hero">
          <div className="sv-hero-fig" style={{ "--i": 0 } as CSSProperties}>
            <ActivityIcon name="stop" size={112} />
          </div>
          <div style={{ "--i": 1, minWidth: 0 } as CSSProperties}>
            <div className="sv-eyebrow">{t.sv_judge_eyebrow}</div>
            <h1 className="sv-title" id="sv-judge-title">
              {t.sv_judge_title}
            </h1>
            <p className="sv-lede">{t.sv_judge_lede}</p>
            <div className="sv-meta">
              <span>{fill(t.sv_meta_session, { n: judged.length })}</span>
              <span>{fill(t.sv_meta_saved, { n: tally.saved })}</span>
            </div>
          </div>
          {/* role=status: the three counts move as verdicts land. */}
          <div className="sv-nums" role="status" style={{ "--i": 2 } as CSSProperties}>
            <Num kind="drop" value={tally.drop} label={t.sv_drop} sub={t.sv_drop_sub} />
            <Num kind="log" value={tally.log} label={t.sv_log} sub={t.sv_log_sub} />
            <Num kind="harvest" value={tally.harvest} label={t.sv_harvest} sub={t.sv_harvest_sub} />
          </div>

          {!showResults ? (
            <div className={"sv-dz" + (over ? " over" : "")} style={{ "--i": 3 } as CSSProperties}>
              <span className="sv-dz-arrow" aria-hidden="true">
                <Icon name="upload" size={20} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="sv-dz-t">{t.ing_drop}</div>
                <div className="sv-dz-s">{t.sv_dz_sub}</div>
              </div>
              <button type="button" className="btn hq-btn" onClick={() => void browseAndLoad()}>
                {t.ing_browse}
              </button>

              <div className="sv-dz-form">
                <div className="field">
                  <label>{t.ing_title_label}</label>
                  <input
                    className="input"
                    placeholder={t.ing_title_ph}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>{t.ing_or_paste}</label>
                  <textarea
                    className="textarea"
                    rows={6}
                    placeholder={t.ing_paste_ph}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                  {looksLikeYoutube(body) ? (
                    <button
                      type="button"
                      className="btn"
                      style={{ marginTop: 8 }}
                      disabled={ytBusy}
                      onClick={() => void loadYoutube()}
                    >
                      {ytBusy ? t.ing_yt_fetching : t.ing_yt_fetch}
                    </button>
                  ) : null}
                </div>
                <div className="row">
                  <span className="chip">
                    <Icon name="bolt" size={11} /> {settings?.ingest_model ?? "claude-cli"}
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    vault: {currentVault?.path ?? "(none)"}
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary hq-btn"
                    style={{ marginLeft: "auto" }}
                    onClick={() => void startIngest(title, body)}
                    disabled={!canRun}
                  >
                    <Icon name="sparkles" size={14} /> {t.ing_run}
                  </button>
                </div>
              </div>
              {dropError ? (
                <div className="sv-dz-note is-error" role="alert">
                  {dropError}
                </div>
              ) : null}
              {dropNotice ? (
                <div className="sv-dz-note muted" data-testid="ingest-drop-notice">
                  {dropNotice}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Intake channels: every entrance shares the judge. Counts are
              today's arrivals; a row that has controls expands. */}
          <div className="sv-chan" style={{ "--i": 4 } as CSSProperties}>
            <div className="sv-chan-l">{t.sv_channels}</div>
            <ul className="sv-chan-list" aria-label={t.sv_channels}>
              <Channel icon={channelIcon("mcp")} name={t.sv_ch_sessions} src="~/.claude · ~/.codex" count={inflow?.sessionsToday}>
                {currentVault ? <ConversationImport t={t} /> : null}
              </Channel>
              <Channel icon={channelIcon("link")} name={t.sv_ch_clipper} src="clip.rs" count={inflow?.inboxBySource.clipper ?? 0} />
              <Channel icon={channelIcon("ask")} name={t.sv_ch_mcp} src="mcp_native.rs" count={inflow?.mcpCallsToday} />
              <Channel icon={channelIcon("indexing")} name={t.sv_ch_zotero} src={t.sv_ch_manual}>
                {currentVault ? <ZoteroImport t={t} /> : null}
              </Channel>
              <Channel icon={channelIcon("distill")} name={t.sv_ch_inbox} src="_inbox/" count={inboxRows?.length}>
                {inboxRows !== null ? (
                  <div data-testid="inbox-pending">
                    {inboxRows.length === 0 ? (
                      <div className="muted" style={{ fontSize: 13 }}>
                        {t.ing_inbox_empty}
                      </div>
                    ) : (
                      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {inboxRows.map((r) => (
                          <li key={r.path}>
                            <button
                              type="button"
                              className="btn"
                              style={{
                                width: "100%",
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                justifyContent: "flex-start",
                                marginTop: 4,
                              }}
                              onClick={() => setRoute(`page:${r.path}`)}
                            >
                              <Icon name="inbox" size={13} />
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {r.name}
                              </span>
                              {r.kind !== "md" ? <span className="chip">{r.ext || "file"}</span> : null}
                              {r.kind === "unsupported" ? (
                                <span className="chip muted">{t.ing_inbox_unsupported_chip}</span>
                              ) : null}
                              {r.today ? <span className="chip">{t.ing_inbox_today}</span> : null}
                              <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                                {r.mtime != null
                                  ? new Date(r.mtime * 1000).toLocaleString([], {
                                      month: "short",
                                      day: "numeric",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })
                                  : ""}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {unsupportedCount > 0 ? (
                      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                        {t.ing_inbox_unsupported_line.replace("{n}", String(unsupportedCount))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Channel>
            </ul>
          </div>
        </div>
      </section>

      {/* Verdict rows + the exclusion disclosure. */}
      <div className="sv-rows" aria-live="polite" aria-label={t.sv_verdicts_title}>
        <div className="sv-rows-l">{t.sv_verdicts_title}</div>
        {judged.length === 0 ? (
          <div className="sv-empty">{t.sv_verdicts_empty}</div>
        ) : (
          judged.slice(0, SHOW_ROWS).map((j) => <VerdictRow key={j.at} j={j} t={t} />)
        )}
        {refusedTotal === 0 ? (
          <div className="sv-excl-none">{t.sv_excl_none}</div>
        ) : (
          <>
            <button
              type="button"
              className="sv-excl-btn"
              aria-expanded={showExcluded}
              aria-controls="sv-excl-body"
              onClick={() => setShowExcluded((v) => !v)}
            >
              <span className="sv-caret" aria-hidden="true">
                ▶
              </span>
              <span style={{ flex: 1 }}>
                {t.sv_excl_line.split("{n}")[0]}
                <b>{refusedTotal.toLocaleString()}</b>
                {t.sv_excl_line.split("{n}")[1] ?? ""}
              </span>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {t.sv_out_drop}
              </span>
            </button>
            {showExcluded ? (
              <div className="sv-excl-body" id="sv-excl-body">
                <table className="hq-table">
                  <thead>
                    <tr>
                      <th>{t.sv_excl_col_rule}</th>
                      <th className="hq-n">{t.sv_excl_col_count}</th>
                      <th>{t.sv_excl_col_last}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {refusedGroups.map(([rule, g]) => (
                      <tr key={rule}>
                        <td>
                          <code style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{rule}</code>
                        </td>
                        <td className="hq-n">{g.count.toLocaleString()}</td>
                        <td className="hq-why">{g.last}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </div>

      {settings ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          via {settings.ingest_provider} · {settings.ingest_model}
        </div>
      ) : null}

      {stage === "done" && startedAt && finishedAt ? (
        <div
          className="card"
          style={{
            marginTop: 16,
            padding: 18,
            border: "1px solid var(--ok)",
            background: "color-mix(in srgb, var(--ok) 8%, var(--bg))",
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
          role="status"
          aria-live="polite"
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "var(--ok)",
              color: "var(--bg)",
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            <Icon name="check" size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{t.ing_success_title}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              {t.ing_success_sub.replace("{time}", formatElapsed(finishedAt - startedAt))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn"
              onClick={() => {
                const root = storedVaultPath ?? currentVault?.path;
                if (root) void ipc.openExternal(`${root}/wiki/index.md`);
              }}
              disabled={!storedVaultPath && !currentVault}
            >
              {t.ing_open_index}
            </button>
            {reportPath ? (
              <button className="btn" onClick={() => void ipc.openExternal(reportPath)}>
                {t.ing_open_report}
              </button>
            ) : null}
            <button className="btn btn-primary" onClick={resetForAnother}>
              {t.ing_run_again}
            </button>
          </div>
        </div>
      ) : null}

      {stage === "cancelled" ? (
        <div
          className="card"
          style={{ marginTop: 16, padding: 18, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}
          role="status"
        >
          <Icon name="info" size={18} />
          <div style={{ flex: 1, minWidth: 200 }}>{t.ing_cancelled}</div>
          <button className="btn btn-primary" onClick={resetForAnother}>
            {t.ing_run_again}
          </button>
        </div>
      ) : null}

      {stage === "error" && showResults && log ? (
        <div className="card" style={{ marginTop: 16, padding: 14 }}>
          <div className="row" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
            <button className="btn btn-primary" onClick={resetForAnother}>
              {t.ing_run_again}
            </button>
          </div>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--danger)",
              margin: 0,
              maxHeight: 160,
              overflow: "auto",
            }}
          >
            {log}
          </pre>
        </div>
      ) : null}

      {showResults ? (
        <div className="sv-run">
          <IngestProgress t={t} />
        </div>
      ) : null}

      <SessionBackfill t={t} />
    </div>
  );
}

function judgeState(stage: IngestStage): "active" | "done" | undefined {
  if (stage === "writing-raw") return "active";
  if (stage === "idle" || stage === "cancelled" || stage === "error") return undefined;
  return "done";
}
function gateState(stage: IngestStage): "active" | "done" | undefined {
  if (stage === "plan-gate") return "active";
  if (stage === "claude" || stage === "indexing" || stage === "done") return "done";
  return undefined;
}
function runState(stage: IngestStage): "active" | "done" | undefined {
  if (stage === "claude" || stage === "indexing") return "active";
  if (stage === "done") return "done";
  return undefined;
}

function RailStep({
  n,
  label,
  value,
  state,
}: {
  n: number;
  label: string;
  value: string;
  state?: "active" | "done";
}): JSX.Element {
  return (
    <li className="sv-step" data-state={state} aria-current={state === "active" ? "step" : undefined}>
      <span className="sv-n" aria-hidden="true">
        {state === "done" ? "✓" : n}
      </span>
      <span className="sv-k">{label}</span>
      <span className="sv-v">{value}</span>
    </li>
  );
}

function Num({
  kind,
  value,
  label,
  sub,
}: {
  kind: "drop" | "log" | "harvest";
  value: number;
  label: string;
  sub: string;
}): JSX.Element {
  return (
    <div className={`sv-num is-${kind}`}>
      <span className="sv-big">{value.toLocaleString()}</span>
      <div className="sv-l">{label}</div>
      <div className="sv-s">{sub}</div>
    </div>
  );
}

/** One intake channel: a 28px object, the name, today's count. With children
 *  it is a native <details> — the existing import cards live inside. */
function Channel({
  icon,
  name,
  src,
  count,
  children,
}: {
  icon: ReactNode;
  name: string;
  src: string;
  count?: number;
  children?: ReactNode;
}): JSX.Element {
  const row = (
    <span className="sv-ch-row">
      {icon}
      <span className="sv-ch-nm">
        {name}
        <span className="sv-ch-src">{src}</span>
      </span>
      <span className="sv-ch-ct">{count == null ? "—" : count.toLocaleString()}</span>
    </span>
  );
  if (!children) return <li className="sv-ch">{row}</li>;
  return (
    <li className="sv-ch-li">
      <details className="sv-ch">
        <summary>{row}</summary>
        <div className="sv-ch-body">{children}</div>
      </details>
    </li>
  );
}

function VerdictRow({ j, t }: { j: JudgedEntry; t: Strings }): JSX.Element {
  const label =
    j.verdict === "harvest"
      ? t.sv_harvest
      : j.verdict === "log"
        ? t.sv_log
        : t.sv_drop;
  const out =
    j.verdict === "harvest"
      ? t.sv_out_harvest
      : j.verdict === "log"
        ? t.sv_out_log
        : j.verdict === "noop"
          ? t.sv_out_noop
          : t.sv_out_drop;
  return (
    <div className="sv-row">
      <span>
        <span className={`sv-chip is-${j.verdict}`}>{label}</span>
      </span>
      <span className="sv-fname" title={j.name}>
        {j.name}
      </span>
      <span className="sv-why">
        {j.reason} <code>{j.rule}</code>
      </span>
      <span className={"sv-out" + (j.verdict === "harvest" || j.verdict === "log" ? "" : " is-zero")}>{out}</span>
    </div>
  );
}

// Whether a whisper-family CLI is on PATH; an unreachable check reads as
// missing so the preflight fails toward the actionable message.
async function whisperInstalled(): Promise<boolean> {
  return ipc
    .whisperCheck()
    .then((s) => s.installed)
    .catch(() => false);
}

// A single pasted YouTube link (not a long body that merely mentions one).
function looksLikeYoutube(s: string): boolean {
  const t = s.trim();
  if (t.includes("\n") || t.length > 200) return false;
  return t.includes("youtube.com/watch") || t.includes("youtu.be/") || t.includes("youtube.com/shorts");
}
