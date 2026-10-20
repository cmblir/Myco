// Add a source first; processing stages appear once a run starts. Optional
// intake channels and technical settings stay behind disclosures. The store
// still owns judgement, write consent, progress, cancellation and results.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { workflowLabel, type WorkflowStatus } from "../lib/workflowOutcome";
import { ipc } from "../lib/ipc";
import type { InflowStats } from "../lib/ipc";
import { isMediaFile } from "../lib/mediaIngest";
import {
  createSourceLoader,
  sourceLoadMessage,
  SourceLoadError,
  type SourceLoader,
} from "../lib/sourceLoad";
import { formatElapsed } from "../lib/time";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUIStore } from "../stores/uiStore";
import { listInboxEntries, pendingInboxRows } from "../lib/autoIngest";
import type { PendingInboxRow } from "../lib/autoIngest";
import AppPage from "../components/AppPage";
import { Hero } from "../components/ui";
import ZoteroImport from "../components/ZoteroImport";
import ConversationImport from "../components/ConversationImport";
import SessionBackfill from "../components/SessionBackfill";
import SessionCompileQueue from "../components/SessionCompileQueue";
import { isShortNote, refusalLine, useIngestStore } from "../stores/ingestStore";
import { selectedLocalTransformModel } from "../lib/localTransform";
import type {
  IngestRefusal,
  IngestStage,
  JudgedEntry,
} from "../stores/ingestStore";
import IngestProgress from "../components/IngestProgress";
import MycoMotion from "../components/MycoMotion";
import type { MycoMotionVariant } from "../components/MycoMotion";
import MascotClip from "../components/MascotClip";
import {
  INGEST_CLIPS,
  SURFACE_CLIPS,
  ingestClip,
  ingestHeld,
  nextAbsorbing,
  preloadStills,
} from "../lib/mascotClips";
import { ActivityIcon } from "../components/ActivityPanel";
import type { ActivityIconName } from "../components/ActivityPanel";
import { dropNoticeFor } from "../lib/ingestDrop";
import { INTAKE_COPY } from "../lib/intakeCopy";
import { captureToDaily } from "../lib/dailyNote";
import { saveAsNewNote, shortDailyLine, shortNoteName } from "../lib/newNote";
import { notice } from "../lib/notice";
import {
  importWebLink,
  looksLikeWebLink,
  msgAfterEdit,
  nextAutoTitle,
  webLinkError,
  type WebLinkMsg,
} from "../lib/webLink";
import "../styles/intake.css";

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
  const lang = useUIStore((s) => s.lang);
  const copy = INTAKE_COPY[lang];
  const settings = useSettingsStore((s) => s.settings);
  const hasLocalTransform = Boolean(settings && selectedLocalTransformModel(settings.ingest_provider, settings.ingest_model));
  const localHint = hasLocalTransform ? t.ing_local_transform_hint : t.ing_extractive_hint;
  const [over, setOver] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [ytBusy, setYtBusy] = useState(false);
  const [webBusy, setWebBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileNeedsSettings, setFileNeedsSettings] = useState(false);
  const fileLoad = useRef<SourceLoader | null>(null);
  // The title the last link import filled in; a later import may replace it,
  // a title the user typed stays.
  const lastAutoTitle = useRef("");
  // Bumped by each link import and by every edit of the box: a fetch that
  // lands after either is dropped, so it never overwrites typed text.
  const webReq = useRef(0);
  // A link import's refusal or PII notice. It sits under the box, next to the
  // button that caused it — the shared drop slot is below the submit row and
  // was off screen on short windows.
  const [webMsg, setWebMsg] = useState<WebLinkMsg | null>(null);
  const webMsgRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (webMsg) webMsgRef.current?.scrollIntoView({ block: "nearest" });
  }, [webMsg]);
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
  const workflowStatus = useIngestStore((s) => s.workflowStatus);
  const sourceChunksPending = useIngestStore((s) => s.sourceChunksPending);
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
  const refusal = useIngestStore((s) => s.refusal);
  const cancelledAt = useIngestStore((s) => s.cancelledAt);
  const gated = useIngestStore((s) => s.gated);
  const runId = useIngestStore((s) => s.runId);
  const written = useIngestStore((s) => s.changedPages);
  const startIngest = useIngestStore((s) => s.startIngest);
  const resetIngest = useIngestStore((s) => s.reset);

  const setRoute = useUIStore((s) => s.setRoute);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  // A short-note save in flight: both save buttons wait on it.
  const [savingShort, setSavingShort] = useState(false);

  useEffect(() => {
    const loader = createSourceLoader({
      onBusy: setFileBusy,
      onLoaded: (path, text) => {
        const name = (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");
        const lastAuto = lastAutoTitle.current;
        setTitle((previous) => nextAutoTitle(previous, lastAuto, name));
        lastAutoTitle.current = name;
        setBody(text);
      },
      onError: (error) => {
        setDropError(sourceLoadMessage(error, tRef.current));
        setFileNeedsSettings(
          error.code === "capability_unavailable" ||
            error.code === "authority_changed" ||
            error.code === "credential_unavailable",
        );
      },
      beforeRead: async (path) => {
        if (isMediaFile(path) && !(await whisperInstalled()))
          throw new SourceLoadError("whisper_missing");
      },
    });
    fileLoad.current = loader;
    return () => {
      loader.dispose();
      if (fileLoad.current === loader) fileLoad.current = null;
    };
  }, []);

  // Pending _inbox sources — the `_inbox` channel row. Refetched when a run
  // finishes because ingest archives the consumed source.
  const [inboxRows, setInboxRows] = useState<PendingInboxRow[] | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [inboxRetry, setInboxRetry] = useState(0);
  useEffect(() => {
    const root = currentVault?.path;
    setInboxError(null);
    setInboxRows(null);
    if (!root) {
      setInboxRows(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const entries = await listInboxEntries(root);
        if (!cancelled) setInboxRows(pendingInboxRows(entries, root));
      } catch (error) {
        if (!cancelled) setInboxError(String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
    // inboxRev bumps only after the archive move LANDS — the stage flips to
    // "done" earlier, and refetching on stage alone raced the move into
    // showing an already-consumed row with a soon-dead path.
  }, [currentVault, stage, inboxRev, inboxRetry]);

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

  // A keyboard Cancel at the gate unmounts the button that had focus (the
  // live panel goes with the run), and the cancelled card lands below the
  // form, often past the fold. Bring the card into view and focus its next
  // action instead of leaving focus on <body>.
  const cancelledRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (stage !== "cancelled" || showResults) return;
    const card = cancelledRef.current;
    card?.scrollIntoView({ block: "nearest" });
    card?.querySelector<HTMLButtonElement>(".btn-primary")?.focus();
  }, [stage, showResults]);

  // Tauri intercepts drag-drop at the OS level (so the browser drop event
  // never fires inside the WebView). Subscribe to its native event instead
  // and read the file via Rust IPC — we get a real path + UTF-8 contents.
  //
  // Registration and every pending source load belong to this mount.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const webview = getCurrentWebview();
      const u = await webview.onDragDropEvent(async (event) => {
        if (cancelled) return;
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
          setFileNeedsSettings(false);
          webReq.current++;
          setWebBusy(false);
          // The form composes ONE source; extra dropped files used to vanish
          // with no signal. Load the first, but say so when there were more.
          setDropNotice(
            dropNoticeFor(paths.length, tRef.current.ing_drop_multi),
          );
          await fileLoad.current?.load(first);
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

  // A pending source must not land after the form starts judging another draft.
  const canRun =
    !!currentVault &&
    !webBusy &&
    !ytBusy &&
    !fileBusy &&
    (title.trim() || body.trim());

  function resetForAnother(): void {
    fileLoad.current?.invalidate();
    resetIngest();
    setTitle("");
    lastAutoTitle.current = "";
    setBody("");
    setDropError(null);
    setDropNotice(null);
    setFileNeedsSettings(false);
    setWebMsg(null);
  }

  function resetForRetry(): void {
    fileLoad.current?.invalidate();
    // Keep this form's draft; a reopened result can recover its stored input.
    const source = useIngestStore.getState().sourceText;
    if (!body.trim()) setBody(source);
    resetIngest();
  }

  // UX S35: keep a short note the judge turned away, then clear the form —
  // the text now lives in the vault. Each path says itself when it fails.
  async function saveShort(where: "daily" | "new"): Promise<void> {
    setSavingShort(true);
    try {
      if (where === "daily") {
        if (await captureToDaily(shortDailyLine(title, body), t)) resetForAnother();
        return;
      }
      const path = await saveAsNewNote(shortNoteName(title, body) ?? "", body);
      if (!path) throw new Error("no note name");
      resetForAnother();
    } catch (err) {
      notice.warn(t.ing_short_new_failed, { sub: String(err) });
    } finally {
      setSavingShort(false);
    }
  }

  // Pull a YouTube video's captions into the body so it ingests like any source.
  async function loadYoutube(): Promise<void> {
    fileLoad.current?.invalidate();
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

  // S38: the Rust guard fetches, importWebLink runs the raw/ secret/PII rule;
  // the text then waits in the box for the normal judge → plan → receipt run.
  async function loadWebLink(): Promise<void> {
    fileLoad.current?.invalidate();
    setDropError(null);
    setDropNotice(null);
    setWebMsg(null);
    setWebBusy(true);
    const id = ++webReq.current;
    const url = body.trim();
    try {
      const r = await importWebLink(url, {
        fetchPage: ipc.fetchWebPage,
        scan: ipc.scanTextSecrets,
        piiQuarantine: settings?.pii_quarantine_enabled ?? false,
      });
      if (id !== webReq.current || (bodyRef.current?.value.trim() ?? "") !== url) {
        return;
      }
      if (!r.ok) {
        setWebMsg({ text: webLinkError(r.code, t), isError: true });
        return;
      }
      setBody(r.body);
      // Read the ref now: the updater runs at the next render, after the
      // assignment below.
      const lastAuto = lastAutoTitle.current;
      setTitle((prev) => nextAutoTitle(prev, lastAuto, r.title));
      lastAutoTitle.current = r.title;
      if (r.piiWarn) setWebMsg({ text: t.ing_web_pii_warn, isError: false });
      bodyRef.current?.focus();
    } finally {
      if (id === webReq.current) setWebBusy(false);
    }
  }

  async function browseAndLoad(): Promise<void> {
    setDropError(null);
    setDropNotice(null);
    setFileNeedsSettings(false);
    webReq.current++;
    setWebBusy(false);
    await fileLoad.current?.load();
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

  const runRoot = runLinkRoot(storedVaultPath, currentVault?.path);

  const todayIntake = (inflow?.inboxToday ?? 0) + (inflow?.sessionsToday ?? 0);
  const rail = railSteps(stage, plan.length, cancelledAt, t, workflowStatus);
  const steps = userSteps(stage, gated, cancelledAt, workflowStatus);
  const hero = heroMotion(stage, workflowStatus);
  const completed = !workflowStatus || workflowStatus === "success";
  // A received source is absorbed once, then read while the run works.
  // Derived during render (not in an effect) so the frame a run starts on
  // already shows the absorb, not a flash of read-loop.
  const [absorb, setAbsorb] = useState({ stage, on: stage === "writing-raw" });
  let absorbing = absorb.on;
  if (absorb.stage !== stage) {
    absorbing = nextAbsorbing(absorb.stage, stage, absorb.on);
    setAbsorb({ stage, on: absorbing });
  }
  const heroClip = stage === "done" && !completed ? null : ingestClip(stage, absorbing);
  // Held for the page's life, so each still the hero shows or swaps to is
  // already loaded when it does.
  useState(() => preloadStills(INGEST_CLIPS));
  // What this visit found, read before RunPill's effect marks the run seen:
  // coming back to a finished run holds celebrate instead of replaying it.
  const [atMount] = useState(() => {
    const s = useIngestStore.getState();
    return { stage: s.stage, seen: s.seen, runId: s.runId };
  });

  const channelIcon = (name: ActivityIconName): ReactNode => (
    <ActivityIcon name={name} size={28} />
  );

  return (
    <AppPage
      eyebrow={t.nav_workspace}
      title={t.nav_ingest}
      // Reveal the processing stages once there is a source to follow: the
      // three a user follows, the pipeline's counters under 세부 정보.
      bar={
        stage !== "idle" ? (
          <>
            <ol className="sv-rail" aria-label={t.sv_rail_label}>
              <RailStep n={1} label={t.sv_state_reading} state={steps.read} />
              <RailStep n={2} label={t.sv_state_choosing} state={steps.choose} />
              <RailStep
                n={3}
                label={t.sv_state_done}
                value={endNote(stage, t, workflowStatus)}
                state={steps.end}
              />
            </ol>
            <details className="sv-rail-details">
              <summary>{t.sv_details}</summary>
              <ol className="sv-rail">
                <RailStep
                  n={1}
                  label={t.sv_step_intake}
                  value={fill(t.sv_today_n, { n: todayIntake })}
                  state="done"
                />
                <RailStep
                  n={2}
                  label={t.sv_step_judge}
                  value={fill(t.sv_tally, {
                    d: tally.drop,
                    l: tally.log,
                    h: tally.harvest,
                  })}
                  state={rail.judge}
                />
                <RailStep
                  n={3}
                  label={t.sv_step_gate}
                  value={rail.gate.value}
                  state={rail.gate.state}
                />
                <RailStep
                  n={4}
                  label={t.sv_step_run}
                  value={rail.run.value}
                  state={rail.run.state}
                />
                <RailStep
                  n={5}
                  label={t.sv_step_backfill}
                  value={
                    rail.unreached
                      ? "—"
                      : fill(t.sv_queue_n, { n: inboxRows?.length ?? 0 })
                  }
                />
              </ol>
            </details>
          </>
        ) : undefined
      }
    >
      {/* `.sv` stays a real element rather than moving onto the page shell:
          `.sv.is-running` is what sweeps the violet arc around the judgement
          ring, and AppPage owns its own shell classes. */}
      <div
        className={"sv intake-page" + (hero.spinning ? " is-running" : "")}
        data-testid="sieve"
      >
        {/* ── 2 · Judgement — the hero ─────────────────────────────────── */}
        <Hero
          titleId="sv-judge-title"
          asset={
            heroClip ? (
              // The three ingest clips share this one slot, so one box size.
              <MascotClip
                clip={heroClip}
                size={SURFACE_CLIPS.ingestRunning.size}
                held={ingestHeld(heroClip, { absorbing, atMount, runId })}
                onEnded={
                  heroClip === "absorb" ? () => setAbsorb((a) => ({ ...a, on: false })) : undefined
                }
              />
            ) : (
              <MycoMotion variant={hero.variant} size={80} />
            )
          }
          title={copy.addTitle}
          lede={copy.addDescription}
        >
          {!showResults ? (
            <div
              className={"sv-dz" + (over ? " over" : "")}
              style={{ "--i": 3 } as CSSProperties}
            >
              <span className="sv-dz-arrow" aria-hidden="true">
                <Icon name="upload" size={20} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="sv-dz-t">
                  <span className="sv-dz-t__mouse">{t.ing_drop}</span>
                  <span className="sv-dz-t__touch">{t.ing_pick_file}</span>
                </div>
                <div className="sv-dz-s">{copy.addHint}</div>
              </div>
              <button
                type="button"
                className="btn hq-btn"
                onClick={() => void browseAndLoad()}
                aria-busy={fileBusy}
              >
                {t.ing_browse}
              </button>

              <div className="sv-dz-form">
                <div className="field">
                  <label htmlFor="ingest-title">{copy.titleOptional}</label>
                  <input
                    id="ingest-title"
                    className="input"
                    placeholder={t.ing_title_ph}
                    value={title}
                    onChange={(e) => {
                      fileLoad.current?.invalidate();
                      setTitle(e.target.value);
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ingest-body">{t.ing_or_paste}</label>
                  <textarea
                    id="ingest-body"
                    ref={bodyRef}
                    className="textarea"
                    rows={6}
                    placeholder={t.ing_paste_ph}
                    value={body}
                    onChange={(e) => {
                      fileLoad.current?.invalidate();
                      setBody(e.target.value);
                      // An edit cancels a link import in flight.
                      webReq.current++;
                      setWebBusy(false);
                      setWebMsg(msgAfterEdit);
                    }}
                  />
                  {refusal &&
                  refusalNoteShown({ stage, refusal, runId }, submitted, body) &&
                  isShortNote(refusal, body) ? (
                    <div
                      className="sv-dz-note"
                      data-testid="ingest-short-note"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 8,
                        marginTop: 8,
                      }}
                    >
                      <span style={{ flex: "1 1 200px" }}>{t.ing_short_title}</span>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={savingShort}
                        onClick={() => void saveShort("daily")}
                      >
                        {t.ing_short_daily}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={savingShort}
                        onClick={() => void saveShort("new")}
                      >
                        {t.ing_short_new}
                      </button>
                    </div>
                  ) : refusal &&
                    refusalNoteShown({ stage, refusal, runId }, submitted, body) ? (
                    <div
                      className="sv-dz-note"
                      data-testid="ingest-refusal"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 8,
                        marginTop: 8,
                      }}
                    >
                      <span style={{ flex: "1 1 200px" }}>
                        {refusalLine(refusal, t)}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          // The note unmounts with the reset; the textarea
                          // stays, so the caret lands in the emptied field.
                          resetForAnother();
                          bodyRef.current?.focus();
                        }}
                      >
                        {t.ing_clear}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          const el = bodyRef.current;
                          if (!el) return;
                          el.focus();
                          el.setSelectionRange(el.value.length, el.value.length);
                        }}
                      >
                        {t.ing_refused_more}
                      </button>
                    </div>
                  ) : null}
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
                  ) : looksLikeWebLink(body) ? (
                    <div data-testid="ingest-weblink" style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        className="btn"
                        // aria-disabled, not disabled: a disabled button drops
                        // keyboard focus, and the error line follows the press.
                        aria-disabled={webBusy}
                        aria-busy={webBusy}
                        onClick={() => {
                          if (!webBusy) void loadWebLink();
                        }}
                      >
                        {webBusy ? t.ing_web_fetching : t.ing_web_fetch}
                      </button>
                      <ul
                        className="sv-dz-note muted"
                        style={{ margin: "8px 0 0", paddingInlineStart: "1.2em" }}
                      >
                        <li>{t.ing_web_rule_visible}</li>
                        <li>{t.ing_web_rule_private}</li>
                        <li>{t.ing_web_rule_keep}</li>
                      </ul>
                    </div>
                  ) : null}
                  {webMsg ? (
                    <div
                      ref={webMsgRef}
                      className={`sv-dz-note${webMsg.isError ? " is-error" : " muted"}`}
                      role={webMsg.isError ? "alert" : "status"}
                      data-testid="ingest-weblink-msg"
                      // Room below so the scroll-into-view doesn't pin it
                      // to the window's bottom edge.
                      style={{ marginTop: 8, scrollMarginBottom: 16 }}
                    >
                      {webMsg.text}
                    </div>
                  ) : null}
                </div>
                <div className="intake-submit">
                  <div className="intake-storage">
                    <span>
                      {copy.savedIn}: {currentVault?.name ?? "—"}
                    </span>
                    {settings?.ingest_provider === "builtin-local" ? (
                      <span className="muted">{localHint}</span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary hq-btn"
                    onClick={() => {
                      void startIngest(title, body);
                      // startIngest claims its run synchronously, before its
                      // first await, so this is the new run's id.
                      setSubmitted({
                        runId: useIngestStore.getState().runId,
                        text: body,
                      });
                    }}
                    disabled={!canRun}
                  >
                    {settings?.ingest_provider === "builtin-local"
                      ? hasLocalTransform ? t.ing_run_local_transform : t.ing_run_extractive
                      : t.ing_run}
                  </button>
                </div>
              </div>
              {dropError ? (
                <div className="sv-dz-note is-error" role="alert">
                  {dropError}
                  {fileNeedsSettings ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        useUIStore.getState().setSettingsTab("model");
                        setRoute("settings");
                      }}
                    >
                      {t.q_open_model_settings}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {fileBusy ? (
                <p className="sv-dz-note muted" role="status">
                  {t.st_loading}
                </p>
              ) : null}
              {dropNotice ? (
                <div
                  className="sv-dz-note muted"
                  data-testid="ingest-drop-notice"
                >
                  {dropNotice}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Intake channels: every entrance shares the judge. Counts are
              today's arrivals; a row that has controls expands. */}
          <details
            className="sv-chan intake-disclosure"
            data-testid="intake-more-sources"
            style={{ "--i": 4 } as CSSProperties}
          >
            <summary>{copy.moreSources}</summary>
            <p className="muted intake-disclosure__hint">
              {copy.moreSourcesHint}
            </p>
            <ul className="sv-chan-list" aria-label={t.sv_channels}>
              <Channel
                icon={channelIcon("link")}
                name={t.sv_ch_clipper}
                src={copy.clipperHint}
                count={inflow?.inboxBySource.clipper ?? 0}
              />
              <Channel
                icon={channelIcon("indexing")}
                name={t.sv_ch_zotero}
                src={t.sv_ch_manual}
              >
                {currentVault ? <ZoteroImport t={t} /> : null}
              </Channel>
              <Channel
                icon={channelIcon("distill")}
                name={t.sv_ch_inbox}
                src={copy.inboxHint}
                count={inboxRows?.length}
              >
                {inboxError ? <div role="alert">
                  <p>{t.ing_auto_failed}</p>
                  <p className="muted">{inboxError}</p>
                  <button className="btn" type="button" onClick={() => setInboxRetry((value) => value + 1)}>{t.q_retry}</button>
                </div> : null}
                {!inboxError && inboxRows === null && currentVault ? <p role="status" className="muted">{t.st_loading}</p> : null}
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
                              <span
                                style={{
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {r.name}
                              </span>
                              {r.kind !== "md" ? (
                                <span className="chip">{r.ext || "file"}</span>
                              ) : null}
                              {r.kind === "unsupported" ? (
                                <span className="chip muted">
                                  {t.ing_inbox_unsupported_chip}
                                </span>
                              ) : null}
                              {r.today ? (
                                <span className="chip">
                                  {t.ing_inbox_today}
                                </span>
                              ) : null}
                              <span
                                className="muted"
                                style={{ marginLeft: "auto", fontSize: 12 }}
                              >
                                {r.mtime != null
                                  ? new Date(r.mtime * 1000).toLocaleString(
                                      [],
                                      {
                                        month: "short",
                                        day: "numeric",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      },
                                    )
                                  : ""}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {unsupportedCount > 0 ? (
                      <div
                        className="muted"
                        style={{ fontSize: 12, marginTop: 8 }}
                      >
                        {t.ing_inbox_unsupported_line.replace(
                          "{n}",
                          String(unsupportedCount),
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Channel>
            </ul>
            {/* UX S35: session sweep, MCP and the backfill are developer
                channels; they stay one more click away. */}
            <details className="intake-disclosure" data-testid="intake-advanced">
              <summary>{t.ing_more_advanced}</summary>
              <ul className="sv-chan-list" aria-label={t.ing_more_advanced}>
                <Channel
                  icon={channelIcon("mcp")}
                  name={t.sv_ch_sessions}
                  src={copy.sessionsHint}
                  count={inflow?.sessionsToday}
                >
                  {currentVault ? <ConversationImport t={t} /> : null}
                  <SessionCompileQueue t={t} />
                </Channel>
                <Channel
                  icon={channelIcon("ask")}
                  name={t.sv_ch_mcp}
                  src={copy.connectionHint}
                  count={inflow?.mcpCallsToday}
                />
              </ul>
              <SessionBackfill t={t} />
            </details>
          </details>
        </Hero>

        {/* Refusals remain visible immediately; detailed tallies are optional. */}
        {judged.length > 0 ? (
          <section className="intake-results">
            <h2>{copy.processingDetails}</h2>
            <details className="intake-disclosure intake-tallies">
              <summary>
                {t.sv_meta_session.replace("{n}", String(judged.length))}
              </summary>
              <div className="sv-nums">
                <Num
                  kind="drop"
                  value={tally.drop}
                  label={t.sv_drop}
                  sub={t.sv_drop_sub}
                />
                <Num
                  kind="log"
                  value={tally.log}
                  label={t.sv_log}
                  sub={t.sv_log_sub}
                />
                <Num
                  kind="harvest"
                  value={tally.harvest}
                  label={t.sv_harvest}
                  sub={t.sv_harvest_sub}
                />
              </div>
              <p className="muted">
                {fill(t.sv_meta_saved, { n: tally.saved })}
              </p>
            </details>
            <div
              className="sv-rows"
              aria-live="polite"
              aria-label={t.sv_verdicts_title}
            >
              <div className="sv-rows-l">{t.sv_verdicts_title}</div>
              {judged.length === 0 ? (
                <div className="sv-empty">{t.sv_verdicts_empty}</div>
              ) : (
                judged
                  .slice(0, SHOW_ROWS)
                  .map((j) => <VerdictRow key={j.at} j={j} t={t} />)
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
                                <code
                                  style={{
                                    fontFamily: "var(--font-mono)",
                                    fontSize: 11.5,
                                  }}
                                >
                                  {rule}
                                </code>
                              </td>
                              <td className="hq-n">
                                {g.count.toLocaleString()}
                              </td>
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
          </section>
        ) : null}

        {settings ? (
          <details className="intake-disclosure intake-processing">
            <summary>{copy.processingSettings}</summary>
            <p className="muted">
              {settings.ingest_provider} · {settings.ingest_model}
              {settings.ingest_provider === "builtin-local"
                ? ` · ${localHint}`
                : ""}
            </p>
            <p className="muted intake-path">
              {copy.savedIn}: {currentVault?.path ?? "—"}
            </p>
          </details>
        ) : null}

        {stage === "done" && startedAt && finishedAt ? (
          <div
            className="card"
            style={{
              marginTop: 16,
              padding: 18,
              border: `1px solid ${completed ? "var(--ok)" : "var(--warn)"}`,
              background: completed ? "color-mix(in srgb, var(--ok) 8%, var(--bg))" : "var(--bg-soft)",
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
                background: completed ? "var(--ok)" : "var(--warn)",
                color: "var(--bg)",
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              <Icon name={completed ? "check" : "info"} size={18} />
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>
                {completed ? t.ing_success_title : workflowLabel(workflowStatus!, t)}
              </div>
              <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                {completed ? t.ing_success_sub.replace(
                  "{time}",
                  formatElapsed(finishedAt - startedAt),
                ) : sourceChunksPending > 0 ? t.ing_extractive_pending.replace("{n}", String(sourceChunksPending)) : t.workflow_retry_hint}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn"
                onClick={() => {
                  if (runRoot) setRoute(`page:${runRoot}/wiki/index.md`);
                }}
                disabled={!runRoot}
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
              <button className="btn btn-primary" onClick={completed ? resetForAnother : resetForRetry}>
                {completed ? t.ing_run_again : t.workflow_review_retry}
              </button>
            </div>
            {runRoot && written.length > 0 ? (
              <div style={{ flexBasis: "100%" }} data-testid="ingest-touched">
                <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                  {t.ing_touched_n.replace("{n}", String(written.length))}
                </div>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {written.map((path) => (
                    <button
                      key={path}
                      type="button"
                      className="btn btn-ghost"
                      style={{ fontSize: 12.5 }}
                      onClick={() => setRoute(`page:${runRoot}/${path}`)}
                    >
                      <Icon name="page" size={12} /> {path}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {stage === "cancelled" ? (
          <div
            ref={cancelledRef}
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
            {/* Only while the form is on screen (a gate cancel): after a
                mid-run cancel it is hidden and clearing it would show nothing. */}
            {!showResults ? (
              <button
                className="btn"
                onClick={() => {
                  setTitle("");
                  setBody("");
                }}
              >
                {t.ing_clear}
              </button>
            ) : null}
            <button className="btn btn-primary" onClick={resetForRetry}>
              {t.workflow_review_retry}
            </button>
          </div>
        ) : null}

        {errorCardShown(stage, log) ? (
          <div className="card" style={{ marginTop: 16, padding: 14 }} role={workflowStatus === "pending" ? "status" : "alert"}>
            <div style={{ fontWeight: 600 }}>{workflowLabel(workflowStatus ?? "failed", t)}</div>
            <p className="muted">{t.workflow_retry_hint}</p>
            <div
              className="row"
              style={{ justifyContent: "flex-end", marginBottom: 8 }}
            >
              <button className="btn btn-primary" onClick={resetForRetry}>
                {t.workflow_review_retry}
              </button>
            </div>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: workflowStatus === "pending" ? "var(--ink-2)" : "var(--danger)",
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
      </div>
    </AppPage>
  );
}

/** Root for the success card's in-app links: the run's vault, and only while
 *  it is still the open one — the reader's read_file refuses paths outside
 *  the open vault, so after a switch the links go away instead of failing. */
export function runLinkRoot(
  runVault: string | null,
  openVault: string | undefined,
): string | null {
  return runVault && runVault === openVault ? runVault : null;
}

/** What the form last sent: the run it claimed and the text it judged. */
export interface Submitted {
  runId: string | null;
  text: string;
}

/** The refusal note (and its "Clear text") belongs under the text the store
 *  judged: a run this form started, on the text still in it. The store is
 *  shared — a headless inbox pass refuses into the same stage, and a
 *  remounted or edited form holds text no run ever judged. */
export function refusalNoteShown(
  run: { stage: IngestStage; refusal: IngestRefusal | null; runId: string | null },
  submitted: Submitted | null,
  body: string,
): boolean {
  return (
    run.stage === "refused" &&
    run.refusal !== null &&
    submitted !== null &&
    submitted.runId === run.runId &&
    submitted.text === body
  );
}

/** The hero works while the run works. At the plan gate the run waits on
 *  the user, so it rests: "idle" breathes slowly, where "welcome" would
 *  replay its greet with sparks as if something had just happened. */
export function heroMotion(stage: IngestStage, status?: WorkflowStatus | null): {
  spinning: boolean;
  variant: MycoMotionVariant;
} {
  const working =
    stage === "writing-raw" || stage === "claude" || stage === "indexing";
  return {
    spinning: working,
    variant: working
      ? "thinking"
      : status && status !== "success"
        ? "idle"
      : stage === "plan-gate"
        ? "idle"
        : stage === "done"
          ? "success"
          : "welcome",
  };
}

type StepState = "active" | "done" | undefined;
interface RailSteps {
  judge: StepState;
  gate: { value: string; state: StepState };
  run: { value: string; state: StepState };
  /** Steps 3–5 were never reached: they read "—", not "waiting"/"idle". */
  unreached: boolean;
}

/** Rail steps 2–5 for the store's stage. A refusal and a cancel at the plan
 *  gate never reached steps 3–5; a cancel mid-run passed the gate. Every
 *  cancel passed the judge: cancelIngest acts only at the gate or mid-run. */
export function railSteps(
  stage: IngestStage,
  planCount: number,
  cancelledAt: "gate" | "run" | null,
  t: Strings,
  status?: WorkflowStatus | null,
): RailSteps {
  const unreached =
    stage === "refused" || (stage === "cancelled" && cancelledAt === "gate");
  const pastGate =
    stage === "claude" ||
    stage === "indexing" ||
    stage === "done" ||
    (stage === "cancelled" && cancelledAt === "run");
  return {
    judge:
      stage === "writing-raw"
        ? "active"
        : stage === "idle" || stage === "error"
          ? undefined
          : "done",
    gate: unreached
      ? { value: "—", state: undefined }
      : stage === "plan-gate"
        ? { value: t.sv_reviewing, state: "active" }
        : pastGate
          ? {
              value: planCount > 0 ? planCount.toLocaleString() : t.sv_done,
              state: "done",
            }
          : { value: t.sv_waiting, state: undefined },
    run: unreached
      ? { value: "—", state: undefined }
      : status && status !== "success"
        ? { value: workflowLabel(status, t), state: undefined }
      : stage === "claude" || stage === "indexing"
        ? { value: t.sv_running, state: "active" }
        : stage === "done"
          ? { value: t.sv_done, state: "done" }
          : stage === "error"
            ? { value: t.sv_failed, state: undefined }
            : stage === "cancelled"
              ? { value: t.sv_cancelled, state: undefined }
              : { value: t.sv_idle, state: undefined },
    unreached,
  };
}

/** The three states a user follows (UX S14): myco reading, the user's turn
 *  to choose at the plan gate, the end. Reading is the judge; once past it
 *  the highlight only moves forward — the write after the gate is the run
 *  heading for its end, so it lights 끝, never 읽는 중 again. 끝 is ticked
 *  only when notes were added: a cancel or a refusal wrote nothing. The
 *  choice is ticked only when the gate was shown (`gated`) and the user did
 *  not cancel there — applying nothing is still a choice. A headless run
 *  has a plan and no gate, so the plan cannot stand in for `gated`. */
export function userSteps(
  stage: IngestStage,
  gated: boolean,
  cancelledAt: "gate" | "run" | null,
  status?: WorkflowStatus | null,
): { read: StepState; choose: StepState; end: StepState } {
  if (stage === "error") return { read: undefined, choose: undefined, end: undefined };
  return {
    read: stage === "writing-raw" ? "active" : stage === "idle" ? undefined : "done",
    choose:
      stage === "plan-gate"
        ? "active"
        : gated && cancelledAt !== "gate"
          ? "done"
          : undefined,
    end:
      stage === "done" && (!status || status === "success")
        ? "done"
        : stage === "claude" || stage === "indexing"
          ? "active"
          : undefined,
  };
}

/** What 끝 says when a run ended without adding notes. The bar is the one
 *  state always on screen; the cards that explain the end sit under the
 *  form, often past the fold. */
export function endNote(stage: IngestStage, t: Strings, status?: WorkflowStatus | null): string | undefined {
  if (status && status !== "success" && stage !== "refused") return workflowLabel(status, t);
  return stage === "error"
    ? t.sv_failed
    : stage === "cancelled"
      ? t.sv_cancelled
      : stage === "refused"
        ? t.sv_nothing_added
        : undefined;
}

/** The error card (log + next action). Not gated on stream events: an HTTP
 *  provider streams none, and its failure must show under the form too. */
export function errorCardShown(stage: IngestStage, log: string): boolean {
  return stage === "error" && log !== "";
}

function RailStep({
  n,
  label,
  value,
  state,
}: {
  n: number;
  label: string;
  value?: string;
  state?: "active" | "done";
}): JSX.Element {
  return (
    <li className="sv-step" data-state={state} aria-current={state === "active" ? "step" : undefined}>
      <span className="sv-n" aria-hidden="true">
        {state === "done" ? "✓" : n}
      </span>
      <span className="sv-k">{label}</span>
      {value === undefined ? null : <span className="sv-v">{value}</span>}
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
      {/* Keyed by the value so a landing verdict replays the bump. */}
      <span className="sv-big" key={value}>
        {value.toLocaleString()}
      </span>
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
