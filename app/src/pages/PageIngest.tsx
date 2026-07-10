// Ingest page — drop a file or paste raw text, then call `claude` to write
// it into `raw/<slug>.md` and ingest into the wiki per CLAUDE.md instructions.
// The run itself lives in ingestStore (streamed events, cancel, stage), so it
// keeps going — and stays visible via the Topbar chip — while the user
// navigates elsewhere. This page is the form plus the live progress panel.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { sourceTextFor } from "../lib/mediaIngest";
import { formatElapsed } from "../lib/time";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useIngestStore } from "../stores/ingestStore";
import IngestProgress from "../components/IngestProgress";

export default function PageIngest({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const settings = useSettingsStore((s) => s.settings);
  const [over, setOver] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [ytBusy, setYtBusy] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const stage = useIngestStore((s) => s.stage);
  const events = useIngestStore((s) => s.events);
  const log = useIngestStore((s) => s.log);
  const startedAt = useIngestStore((s) => s.startedAt);
  const finishedAt = useIngestStore((s) => s.finishedAt);
  const reportPath = useIngestStore((s) => s.reportPath);
  const storedVaultPath = useIngestStore((s) => s.vaultPath);
  const startIngest = useIngestStore((s) => s.startIngest);
  const markSeen = useIngestStore((s) => s.markSeen);
  const resetIngest = useIngestStore((s) => s.reset);

  const running =
    stage === "writing-raw" || stage === "claude" || stage === "indexing";
  // After the run ends the panel stays up as the result view (mini galaxy,
  // feed, counters) until the user starts another ingest. Streamless runs
  // (HTTP providers) have no events and fall back to the plain form+banner.
  const showResults = running || events.length > 0;

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
          const base = first.split(/[\\/]/).pop() ?? "";
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

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_ingest}</div>
        <h1 className="page-title">{t.ing_title}</h1>
        <p className="page-lede">{t.ing_lede}</p>
      </header>

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
            border: "1px solid var(--accent, #16a34a)",
            background: "color-mix(in srgb, var(--accent, #16a34a) 8%, var(--bg))",
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
              background: "var(--accent, #16a34a)",
              color: "#fff",
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            <Icon name="check" size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>
              {t.ing_success_title}
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              {t.ing_success_sub.replace(
                "{time}",
                formatElapsed(finishedAt - startedAt),
              )}
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
              <button
                className="btn"
                onClick={() => void ipc.openExternal(reportPath)}
              >
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
          style={{
            marginTop: 16,
            padding: 18,
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
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
              color: "#dc2626",
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
        <IngestProgress t={t} />
      ) : (
        <div className="ingest-grid">
          <div className="col">
            <div className={"dropzone" + (over ? " over" : "")}>
              <Icon name="upload" size={26} />
              <div className="dropzone-title">{t.ing_drop}</div>
              <div className="dropzone-sub">
                Drop a text/markdown file anywhere on this window — or
              </div>
              <button
                className="btn"
                style={{ marginTop: 10 }}
                onClick={() => void browseAndLoad()}
              >
                {t.ing_browse}
              </button>
              {dropError ? (
                <div
                  style={{
                    marginTop: 10,
                    color: "#dc2626",
                    fontSize: 12,
                  }}
                >
                  {dropError}
                </div>
              ) : null}
            </div>

            <div className="field">
              <label>{t.ing_title_label ?? "Title"}</label>
              <input
                className="input"
                placeholder={t.ing_title_ph ?? "e.g. Byte Pair Encoding"}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="field">
              <label>{t.ing_or_paste}</label>
              <textarea
                className="textarea"
                rows={10}
                placeholder={t.ing_paste_ph}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              {looksLikeYoutube(body) ? (
                <button
                  className="btn"
                  style={{ marginTop: 8 }}
                  disabled={ytBusy}
                  onClick={() => void loadYoutube()}
                >
                  {ytBusy
                    ? (t.ing_yt_fetching ?? "Fetching transcript…")
                    : (t.ing_yt_fetch ?? "Fetch YouTube transcript")}
                </button>
              ) : null}
            </div>

            <div className="row">
              <span className="chip">
                <Icon name="bolt" size={11} />{" "}
                {settings?.ingest_model ?? "claude-cli"}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>
                vault: {currentVault?.path ?? "(none)"}
              </span>
              <button
                className="btn btn-primary"
                style={{ marginLeft: "auto" }}
                onClick={() => void startIngest(title, body)}
                disabled={!canRun}
              >
                <Icon name="sparkles" size={14} /> {t.ing_run}
              </button>
            </div>
          </div>

          <aside className="col">
            <div className="card">
              <div
                className="section-title"
                style={{ fontSize: 13.5, marginBottom: 12 }}
              >
                {t.ing_pipeline}
              </div>
              <div className="stepper">
                <StepRow
                  idx={1}
                  title={t.ing_step_read}
                  active={false}
                  done={stage === "done"}
                  t={t}
                />
                <StepRow
                  idx={2}
                  title={t.ing_step_claude}
                  active={false}
                  done={stage === "done"}
                  t={t}
                />
                <StepRow
                  idx={3}
                  title={t.ing_step_refresh}
                  active={false}
                  done={stage === "done"}
                  t={t}
                />
              </div>
            </div>
            {log ? (
              <div className="card" style={{ minHeight: 80 }}>
                <div
                  className="section-title"
                  style={{ fontSize: 13.5, marginBottom: 6 }}
                >
                  Log
                </div>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: stage === "error" ? "#dc2626" : "var(--ink-3)",
                    margin: 0,
                    maxHeight: 280,
                    overflow: "auto",
                  }}
                >
                  {log}
                </pre>
              </div>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}

function StepRow({
  idx,
  title,
  active,
  done,
  t,
}: {
  idx: number;
  title: string;
  active: boolean;
  done: boolean;
  t: Strings;
}): JSX.Element {
  return (
    <div className={"step " + (done ? "done" : active ? "active" : "")}>
      <div className="step-bullet">
        {done ? <Icon name="check" size={11} /> : idx}
      </div>
      <div className="step-body">
        <div className="step-title">{title}</div>
        {active ? (
          <div className="step-sub">{t.ing_working ?? "working…"}</div>
        ) : null}
      </div>
    </div>
  );
}

// A single pasted YouTube link (not a long body that merely mentions one).
function looksLikeYoutube(s: string): boolean {
  const t = s.trim();
  if (t.includes("\n") || t.length > 200) return false;
  return t.includes("youtube.com/watch") || t.includes("youtu.be/") || t.includes("youtube.com/shorts");
}
