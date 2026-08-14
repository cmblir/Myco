// Topbar — breadcrumb + meta + model status + background-job chips.

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
import { useSettingsStore } from "../stores/settingsStore";
import { useReindexStore } from "../stores/reindexStore";
import { useDistillRunStore } from "../stores/distillRunStore";
import { PROVIDERS } from "../lib/providers";
import { ipc } from "../lib/ipc";
import type { MycoSettings } from "../lib/ipc";
import { formatTicker } from "../lib/time";

export default function Topbar({ t }: { t: Strings }): JSX.Element {
  const route = useUIStore((s) => s.route);
  const splitRoute = useUIStore((s) => s.splitRoute);
  const setSplitRoute = useUIStore((s) => s.setSplitRoute);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleCmd = useUIStore((s) => s.toggleCmd);
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
      <IngestChip t={t} />
      <LintChip t={t} />
      <QueryChip t={t} />
      <BusyJobsChip t={t} />
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

// Global ingest status: spinner + elapsed while a run is live (any page),
// then a green/red chip after it finishes until the user visits Ingest.
// Clicking always jumps to the Ingest page.
function IngestChip({ t }: { t: Strings }): JSX.Element | null {
  const stage = useIngestStore((s) => s.stage);
  const startedAt = useIngestStore((s) => s.startedAt);
  const seen = useIngestStore((s) => s.seen);
  const setRoute = useUIStore((s) => s.setRoute);
  const running =
    stage === "writing-raw" || stage === "claude" || stage === "indexing";

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (running) {
    return (
      <button
        className="pill chip-live"
        onClick={() => setRoute("ingest")}
        title={t.ing_live_title}
      >
        <span className="ingest-chip-spinner" />
        <span>
          {t.nav_ingest} {startedAt ? formatTicker(now - startedAt) : ""}
        </span>
      </button>
    );
  }
  if (!seen && (stage === "done" || stage === "error")) {
    const ok = stage === "done";
    return (
      <button
        className="pill chip-pop"
        onClick={() => setRoute("ingest")}
        title={ok ? t.ing_chip_done : t.ing_chip_error}
      >
        <span
          className="dot"
          style={{ background: ok ? "#16a34a" : "#dc2626" }}
        ></span>
        <span>{ok ? t.ing_chip_done : t.ing_chip_error}</span>
      </button>
    );
  }
  return null;
}

// Same pattern as IngestChip, for a finished Ask run: the chat lives in
// queryStore, so an answer keeps computing when the user leaves the Query
// page. The BUSY half of this (spinner + elapsed while an answer is still
// coming) now lives in BusyJobsChip below, folded in with distill/reindex so
// the three don't each show their own live pill at once — this component
// only covers the done/error pop once an answer lands.
function QueryChip({ t }: { t: Strings }): JSX.Element | null {
  const busy = useQueryStore((s) => s.busy);
  const seen = useQueryStore((s) => s.seen);
  const turns = useQueryStore((s) => s.turns);
  const setRoute = useUIStore((s) => s.setRoute);

  if (busy) return null;
  const last = turns[turns.length - 1];
  if (!seen && last) {
    const ok = !last.error;
    return (
      <button
        className="pill chip-pop"
        onClick={() => setRoute("query")}
        title={ok ? (t.q_chip_done ?? "Answer ready") : (t.q_chip_error ?? "Answer failed")}
      >
        <span
          className="dot"
          style={{ background: ok ? "#16a34a" : "#dc2626" }}
        ></span>
        <span>{ok ? (t.q_chip_done ?? "Answer ready") : (t.q_chip_error ?? "Answer failed")}</span>
      </button>
    );
  }
  return null;
}

// Ask / distill / reindex, unified into ONE live pill: each already gets its
// own busy state from an existing store (queryStore / distillRunStore /
// reindexStore) — this just picks the highest-priority one that's currently
// running and shows it, with a "+N" badge for however many others are also
// in flight, so three concurrent background jobs don't crowd the bar with
// three separate pills. Priority (most to least urgent to surface): Ask,
// since the user is actively waiting on it; distill; reindex.
function BusyJobsChip({ t }: { t: Strings }): JSX.Element | null {
  const askBusy = useQueryStore((s) => s.busy);
  const askStartedAt = useQueryStore((s) => s.startedAt);
  const distillBusy = useDistillRunStore((s) => s.running);
  const reindexStage = useReindexStore((s) => s.stage);
  const reindexDone = useReindexStore((s) => s.done);
  const reindexTotal = useReindexStore((s) => s.total);
  const reindexPage = useReindexStore((s) => s.page);
  const setRoute = useUIStore((s) => s.setRoute);

  const reindexBusy = reindexStage === "loading-model" || reindexStage === "indexing";
  const anyBusy = askBusy || distillBusy || reindexBusy;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyBusy) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyBusy]);

  if (!anyBusy) return null;

  const jobs: { label: string; route: RouteId }[] = [];
  if (askBusy) {
    jobs.push({
      label: `${t.nav_query} ${askStartedAt ? formatTicker(now - askStartedAt) : ""}`.trim(),
      route: "query",
    });
  }
  if (distillBusy) {
    // Distill has no dedicated page of its own — its status card lives on
    // Overview.
    jobs.push({ label: t.set_distill_running ?? "Distilling…", route: "overview" });
  }
  if (reindexBusy) {
    const label =
      reindexStage === "loading-model"
        ? (t.s_embeddings_loading_model ?? "Loading model…")
        : `${t.s_embeddings_indexing ?? "Indexing…"} ${reindexDone}/${reindexTotal}${reindexPage ? " — " + reindexPage : ""}`;
    // Settings opens on its "model" tab by default, where the reindex card
    // lives — no tab deep-link needed.
    jobs.push({ label, route: "settings" });
  }

  const top = jobs[0];
  const extra = jobs.length - 1;

  return (
    <button
      className="pill chip-live"
      onClick={() => setRoute(top.route)}
      title={jobs.map((j) => j.label).join(" · ")}
    >
      <span className="ingest-chip-spinner" />
      <span className="job-chip-label">{top.label}</span>
      {extra > 0 ? <span className="pill-badge">+{extra}</span> : null}
    </button>
  );
}

// Same pattern as IngestChip, for lint runs: spinner while running, then a
// done/failed chip until the user revisits the Provenance page.
function LintChip({ t }: { t: Strings }): JSX.Element | null {
  const stage = useLintStore((s) => s.stage);
  const seen = useLintStore((s) => s.seen);
  const setRoute = useUIStore((s) => s.setRoute);

  if (stage === "running") {
    return (
      <button
        className="pill chip-live"
        onClick={() => setRoute("provenance")}
        title={t.p_lint_running}
      >
        <span className="ingest-chip-spinner" />
        <span>{t.tb_lint ?? "Lint"}</span>
      </button>
    );
  }
  if (!seen && (stage === "done" || stage === "error")) {
    const ok = stage === "done";
    return (
      <button
        className="pill chip-pop"
        onClick={() => setRoute("provenance")}
        title={ok ? t.p_lint_done : t.p_lint_failed}
      >
        <span
          className="dot"
          style={{ background: ok ? "#16a34a" : "#dc2626" }}
        ></span>
        <span>{ok ? t.p_lint_done : t.p_lint_failed}</span>
      </button>
    );
  }
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
