// Topbar — breadcrumb + meta + model status + background-job chips.
//
// Division of labour with ActivityChip: every LIVE run is reported there, in
// one collapsible chip (see buildRunning). The bar's own pills cover only the
// FINISHED half — the done/failed pop that survives until the user visits the
// page explaining the run. Ask has worked this way since the BusyJobsChip came
// out; ingest, lint and harvest each used to hand-roll their own live pill on
// top of it, so three spinners could sit in the bar at once.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JSX } from "react";
import { Icon, ProviderGlyph } from "../lib/icons";
import type { IconName, ProviderId } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useIngestStore } from "../stores/ingestStore";
import { useLintStore } from "../stores/lintStore";
import { useQueryStore } from "../stores/queryStore";
import { useDistillRunStore } from "../stores/distillRunStore";
import { useHarvestStore } from "../stores/harvestStore";
import type { RunOutcome } from "../stores/harvestStore";
import { useSettingsStore } from "../stores/settingsStore";
import ActivityChip from "./ActivityChip";
import { PROVIDERS } from "../lib/providers";
import { ipc } from "../lib/ipc";
import type { MycoSettings } from "../lib/ipc";

export default function Topbar({ t }: { t: Strings }): JSX.Element {
  const route = useUIStore((s) => s.route);
  const splitRoute = useUIStore((s) => s.splitRoute);
  const setSplitRoute = useUIStore((s) => s.setSplitRoute);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleCmd = useUIStore((s) => s.toggleCmd);
  const goBack = useUIStore((s) => s.goBack);
  const goForward = useUIStore((s) => s.goForward);
  const canBack = useUIStore((s) => s.navHistory.idx > 0);
  const canFwd = useUIStore(
    (s) => s.navHistory.idx < s.navHistory.entries.length - 1,
  );
  const currentVault = useVaultStore((s) => s.currentVault);

  const projectName = currentVault?.name ?? t.app_name;
  const { crumb, icon } = breadcrumbFor(route, projectName, t);

  return (
    <div className="topbar">
      <button
        className="icon-btn"
        onClick={toggleSidebar}
        title={t.tb_toggle_sidebar ?? "Toggle sidebar (⌘B)"}
      >
        <Icon name="sidebar" />
      </button>
      <button
        className="icon-btn"
        onClick={goBack}
        disabled={!canBack}
        title={t.tb_back ?? "Back (⌘[)"}
        aria-label={t.tb_back ?? "Back (⌘[)"}
      >
        <Icon name="arrowL" size={14} />
      </button>
      <button
        className="icon-btn"
        onClick={goForward}
        disabled={!canFwd}
        title={t.tb_forward ?? "Forward (⌘])"}
        aria-label={t.tb_forward ?? "Forward (⌘])"}
      >
        <Icon name="arrowR" size={14} />
      </button>
      <div className="breadcrumb">
        <Icon name={icon} size={14} />
        {crumb.map((c, i) => (
          <span key={i} style={{ display: "inline-flex", gap: 6 }}>
            {i > 0 ? <span className="crumb-sep">/</span> : null}
            {i === crumb.length - 1 ? <b>{c}</b> : <span>{c}</span>}
          </span>
        ))}
      </div>
      <div className="topbar-spacer" />
      {/* Split view: open a second pane beside the current one (Overview + Graph
          etc.). Defaults the pane to Graph, or Overview when Graph is primary. */}
      <button
        className={`pill pill-icon${splitRoute ? " is-active" : ""}`}
        onClick={() =>
          setSplitRoute(splitRoute ? null : route === "graph" ? "overview" : "graph")
        }
        title={splitRoute ? (t.split_close ?? "Close split view") : (t.split_open ?? "Split view")}
        aria-label={splitRoute ? (t.split_close ?? "Close split view") : (t.split_open ?? "Split view")}
        aria-pressed={!!splitRoute}
      >
        <Icon name="columns" size={14} />
      </button>
      <RunPills t={t} />
      <ActivityChip t={t} />
      <button className="pill pill-search" onClick={toggleCmd}>
        <Icon name="search" size={14} />
        <span className="pill-label">{t.ph_search}</span>
        <span className="kbd" style={{ marginLeft: 4 }}>
          ⌘K
        </span>
      </button>
      <ModelChip t={t} />
    </div>
  );
}

// Interactive picker for the ACTIVE query model (not just the Claude CLI): a
// pill showing the provider + a green/grey ready dot that opens a popover to
// switch provider/model. Reads/writes settingsStore.query_provider|query_model,
// so the choice persists to disk and stays in sync with Settings → Model. The
// popover is a status + shortcut (both tasks' provider/model/readiness, and a
// button into Settings) — full editing stays on the Model tab, not rebuilt
// here.
//
// Readiness: builtin-local ships in the app (always ready); CLI/daemon providers
// get a live probe; API providers count as ready when enabled (their key lives
// in the keychain — no cheap liveness check).
//
// The popover renders through a portal (not as a DOM child of .topbar): the
// topbar scrolls horizontally when many run-chips are live (see .topbar's
// overflow-x), and CSS forces overflow-y into the same clipping behavior the
// moment overflow-x isn't `visible` — so a popover anchored inside it was
// being silently clipped to the bar's height. That was the dead click: the
// popover DID open, it just rendered somewhere the user couldn't see.
function probeProviderReady(
  provider: string,
  settings: MycoSettings,
): Promise<boolean> {
  if (!provider) return Promise.resolve(false);
  if (provider === "builtin-local") return Promise.resolve(true); // bundled in the app binary
  if (provider === "anthropic-cli")
    return ipc.claudeCheck().then((r) => r.installed);
  if (provider === "ollama")
    return ipc.ollamaStatus().then((r) => r.daemon_running);
  return Promise.resolve(
    (settings.providers as Record<string, boolean>)[
      provider.replace(/-/g, "_")
    ] === true,
  );
}

/** Display name for a provider id, from the full catalog (not just the
 * enabled subset — the popover shows status even for a provider that got
 * disconnected out from under the current selection). */
function providerName(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.name ?? id;
}

/** Compact form of a model id for the pill: the glyph + nickname already say
 * WHO, so drop the leading provider-family word — "claude-sonnet-4-6" ->
 * "sonnet-4-6". Single-word ids (CLI aliases like "sonnet", "(default)")
 * pass through unchanged. */
function shortModel(model: string): string {
  const i = model.indexOf("-");
  return i > 0 ? model.slice(i + 1) : model;
}

/** Viewport-safe position for the model popover, given the pill's own rect
 * (only the two edges this needs, not a full DOMRect — keeps this testable
 * without a DOM). Anchors right-aligned to the pill (where it always lives,
 * at the bar's right end) then clamps both edges into the viewport — so it
 * holds at any window width, not just the ones the pill's usual position
 * happens to fit. `viewport` defaults to the real window and is only ever
 * overridden by tests. Pure otherwise, so it works identically whether
 * called on open or on a later resize. Exported for its unit test. */
export function computeModelPopPos(
  anchor: { right: number; bottom: number },
  viewport: { width: number; height: number } = {
    width: window.innerWidth,
    height: window.innerHeight,
  },
): {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
} {
  const margin = 8;
  const vw = viewport.width;
  const vh = viewport.height;
  // Never wider than the viewport minus both margins — the min(340px, ...)
  // the CSS used to do, but computed here so the left-clamp below can use it.
  const width = Math.min(340, vw - margin * 2);
  let left = anchor.right - width; // right-align to the pill's right edge...
  left = Math.min(left, vw - width - margin); // ...never past the right edge...
  left = Math.max(left, margin); // ...never past the left edge either.
  const top = anchor.bottom + 6;
  // A short window must not clip the bottom — the popover scrolls internally
  // past this instead (see .model-chip-pop's overflow-y).
  const maxHeight = Math.max(80, vh - anchor.bottom - 12);
  return { top, left, width, maxHeight };
}

function ModelChip({ t }: { t: Strings }): JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings);
  const setRoute = useUIStore((s) => s.setRoute);
  const [queryReady, setQueryReady] = useState(false);
  const [ingestReady, setIngestReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [popPos, setPopPos] = useState<ReturnType<typeof computeModelPopPos> | null>(
    null,
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const provider = settings?.query_provider ?? "";
  const model = settings?.query_model ?? "";
  const isLocal = provider === "builtin-local";

  const label = isLocal
    ? "local"
    : provider === "anthropic-cli"
      ? "claude"
      : provider === "ollama"
        ? "ollama"
        : provider.replace(/-(api|cli)$/, "");

  // Re-probe readiness (both tasks) whenever settings change.
  useEffect(() => {
    if (!settings) return;
    let alive = true;
    probeProviderReady(settings.query_provider, settings)
      .then((ok) => alive && setQueryReady(ok))
      .catch(() => alive && setQueryReady(false));
    probeProviderReady(settings.ingest_provider, settings)
      .then((ok) => alive && setIngestReady(ok))
      .catch(() => alive && setIngestReady(false));
    return () => {
      alive = false;
    };
  }, [settings]);

  // Close the popover on outside-click / Escape, reposition it on resize.
  // `onDown` must check BOTH the pill (wrapRef) and the portal-rendered
  // popover (popRef) — they are siblings in the DOM once the popover portals
  // to <body>, so checking wrapRef alone would treat every click inside the
  // popover as "outside".
  //
  // No scroll listener: the topbar is `position: sticky; top: 0`, so the
  // pill's viewport-relative rect (what the popover is anchored to) never
  // moves on a page/window scroll — recomputing would be a no-op, and the
  // fixed-position popover already stays correctly placed as content scrolls
  // underneath it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setPopPos(computeModelPopPos(r));
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  if (!settings) return null;

  const openPopover = (): void => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setPopPos(computeModelPopPos(r));
    setOpen(true);
  };

  const readyWord = (ok: boolean): string =>
    ok ? (t.tb_model_ready ?? "ready") : (t.tb_model_offline ?? "offline");

  return (
    <div className="model-chip-wrap" ref={wrapRef}>
      <button
        className="pill model-chip"
        onClick={() => (open ? setOpen(false) : openPopover())}
        title={`${providerName(provider)} · ${model || "(default)"} · ${readyWord(queryReady)}`}
        aria-label={t.tb_model_picker ?? "Model status"}
        aria-expanded={open}
      >
        <ProviderGlyph id={provider as ProviderId} size={14} />
        <span className="pill-label">{label}</span>
        {!isLocal && model ? (
          <span className="model-chip-id">{shortModel(model)}</span>
        ) : null}
        <span className={"dot" + (queryReady ? " is-ready" : "")}></span>
        <Icon name="chevD" size={12} />
      </button>
      {open && popPos
        ? createPortal(
            <div
              className="model-chip-pop"
              ref={popRef}
              style={{
                top: popPos.top,
                left: popPos.left,
                width: popPos.width,
                maxHeight: popPos.maxHeight,
              }}
            >
              <div className="muted" style={{ fontSize: 12 }}>
                {t.s_model}
              </div>
              <div className="model-chip-rows">
                <div className="status-row">
                  <span className={"dot" + (queryReady ? " is-ready" : "")}></span>
                  <b>{t.s_model_query}</b>
                  <span className="sr-action">
                    {providerName(provider)} · {model || "—"}
                  </span>
                </div>
                <div className="status-row">
                  <span className={"dot" + (ingestReady ? " is-ready" : "")}></span>
                  <b>{t.s_model_ingest}</b>
                  <span className="sr-action">
                    {providerName(settings.ingest_provider)} · {settings.ingest_model || "—"}
                  </span>
                </div>
              </div>
              <button
                className="btn"
                style={{ width: "100%", justifyContent: "center" }}
                onClick={() => {
                  setOpen(false);
                  setRoute("settings");
                }}
              >
                {t.tb_model_open_settings ?? "Open model settings"}
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** What a finished-run pill shows for one source: nothing while the run is
 * still live (the live half is ActivityChip's job, so the bar can never show
 * two spinners), nothing once the user has seen the page that explains it,
 * and the outcome otherwise. Pure; unit-tested. */
export function runPillOutcome(src: {
  running: boolean;
  outcome: RunOutcome;
  seen: boolean;
}): RunOutcome {
  return src.running || src.seen ? null : src.outcome;
}

interface RunPillProps {
  running: boolean;
  outcome: RunOutcome;
  seen: boolean;
  /** Page that explains the run: where the pill jumps, and visiting which
   * clears it. */
  route: RouteId;
  doneLabel: string;
  errorLabel: string;
  markSeen: () => void;
}

/** The done/failed pop a long run leaves in the bar. One component for every
 * source — ingest, ask, lint, distill, harvest — which is what four near-
 * identical copies of this used to be. */
function RunPill({
  running,
  outcome,
  seen,
  route,
  doneLabel,
  errorLabel,
  markSeen,
}: RunPillProps): JSX.Element | null {
  const current = useUIStore((s) => s.route);
  const split = useUIStore((s) => s.splitRoute);
  const setRoute = useUIStore((s) => s.setRoute);

  // Visiting the page acknowledges the run. Done here rather than in each
  // page, so a new source needs no page edit and cannot forget — and so a run
  // that lands while the user is ALREADY on its page never pops at all.
  // splitRoute counts: the page is on screen in the second pane.
  useEffect(() => {
    if (!seen && (current === route || split === route)) markSeen();
  }, [seen, current, split, route, markSeen]);

  const shown = runPillOutcome({ running, outcome, seen });
  if (!shown) return null;
  const ok = shown === "done";
  const label = ok ? doneLabel : errorLabel;
  return (
    <button
      className="pill chip-pop"
      onClick={() => setRoute(route)}
      title={label}
    >
      <span
        className="dot"
        style={{ background: ok ? "#16a34a" : "#dc2626" }}
      ></span>
      <span>{label}</span>
    </button>
  );
}

/** Every finished-run pill in the bar, in one place: the five long jobs that
 * outlive the page that started them. Nothing here is live — that is
 * ActivityChip's running list. */
function RunPills({ t }: { t: Strings }): JSX.Element {
  const ingestStage = useIngestStore((s) => s.stage);
  const ingestSeen = useIngestStore((s) => s.seen);
  const ingestMarkSeen = useIngestStore((s) => s.markSeen);
  const askBusy = useQueryStore((s) => s.busy);
  const askSeen = useQueryStore((s) => s.seen);
  const askMarkSeen = useQueryStore((s) => s.markSeen);
  const lastTurn = useQueryStore((s) => s.turns[s.turns.length - 1]);
  const lintStage = useLintStore((s) => s.stage);
  const lintSeen = useLintStore((s) => s.seen);
  const lintMarkSeen = useLintStore((s) => s.markSeen);
  const distillRunning = useDistillRunStore((s) => s.running);
  const distillOutcome = useDistillRunStore((s) => s.outcome);
  const distillSeen = useDistillRunStore((s) => s.seen);
  const distillMarkSeen = useDistillRunStore((s) => s.markSeen);
  const harvestPhase = useHarvestStore((s) => s.run.phase);
  const harvestOutcome = useHarvestStore((s) => s.outcome);
  const harvestSeen = useHarvestStore((s) => s.seen);
  const harvestMarkSeen = useHarvestStore((s) => s.markSeen);

  return (
    <>
      <RunPill
        running={
          ingestStage === "writing-raw" ||
          ingestStage === "claude" ||
          ingestStage === "indexing"
        }
        // "refused" is not an outcome the bar reports: the refusal itself is
        // the result, and it is only readable on the page.
        outcome={stageOutcome(ingestStage)}
        seen={ingestSeen}
        route="ingest"
        doneLabel={t.ing_chip_done}
        errorLabel={t.ing_chip_error}
        markSeen={ingestMarkSeen}
      />
      <RunPill
        running={askBusy}
        outcome={lastTurn ? (lastTurn.error ? "error" : "done") : null}
        seen={askSeen}
        route="query"
        doneLabel={t.q_chip_done}
        errorLabel={t.q_chip_error}
        markSeen={askMarkSeen}
      />
      <RunPill
        running={lintStage === "running"}
        outcome={stageOutcome(lintStage)}
        seen={lintSeen}
        route="provenance"
        doneLabel={t.p_lint_done}
        errorLabel={t.p_lint_failed}
        markSeen={lintMarkSeen}
      />
      {/* Feedback is where a distill chain's output lands (proposals,
          quarantine) — the page that explains what the run just did. */}
      <RunPill
        running={distillRunning}
        outcome={distillOutcome}
        seen={distillSeen}
        route="feedback"
        doneLabel={t.tb_distill_done}
        errorLabel={t.tb_distill_error}
        markSeen={distillMarkSeen}
      />
      {/* Overview hosts the harvest queue, which shows the run's result. */}
      <RunPill
        running={harvestPhase !== null}
        outcome={harvestOutcome}
        seen={harvestSeen}
        route="overview"
        doneLabel={t.tb_harvest_done}
        errorLabel={t.tb_harvest_error}
        markSeen={harvestMarkSeen}
      />
    </>
  );
}

/** The two stores whose terminal state IS their stage (ingest, lint) map onto
 * the shared outcome the same way. */
function stageOutcome(stage: string): RunOutcome {
  if (stage === "done") return "done";
  if (stage === "error") return "error";
  return null;
}

function breadcrumbFor(
  route: string,
  project: string,
  t: Strings,
): { crumb: string[]; icon: IconName } {
  if (route === "overview")
    return { crumb: [project, t.nav_overview], icon: "home" };
  if (route === "ingest")
    return { crumb: [project, t.nav_ingest], icon: "upload" };
  if (route === "query") return { crumb: [project, t.nav_query], icon: "msg" };
  if (route === "graph")
    return { crumb: [project, t.nav_graph], icon: "graph" };
  if (route === "history")
    return { crumb: [project, t.nav_history], icon: "history" };
  if (route === "provenance")
    return { crumb: [project, t.nav_provenance], icon: "quote" };
  if (route === "settings")
    return { crumb: [t.nav_settings], icon: "settings" };
  if (route.startsWith("page:")) {
    const path = route.slice(5);
    const name = path.split(/[\\/]/).pop() ?? path;
    return { crumb: [project, name], icon: "page" };
  }
  return { crumb: [project], icon: "home" };
}
