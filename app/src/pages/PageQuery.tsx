// Ask the wiki — the question bar carries a search-scope segment (wiki /
// sessions / all). An extractive answer quotes its passages in serif with
// numbered citation pills beside a source ladder that explains every
// retrieved page's rank (tier chip, cosine, RRF × prior = final, ▲▼), under a
// one-line retrieval stepper; the 고급 sliders re-rank the ladders live and
// ride along with the next question. Provider answers render as real markdown
// (clickable [[wikilinks]]) and every cited page appears in an interactive
// mini galaxy under the answer — drag, hover, click for an in-place preview.
// The chat itself lives in queryStore so an in-flight answer survives
// navigating away; the Topbar shows a chip while it runs.

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";
import { askCopy, useQueryStore, type ChatTurn } from "../stores/queryStore";
import { ipc, type AskScope, type TierWeights } from "../lib/ipc";
import { takeQueryPrefill } from "../lib/queryPrefill";
import MascotClip from "../components/MascotClip";
import { flattenMarkdown, stem } from "../lib/graphData";
import { RELEVANCE_FLOOR } from "../lib/chat";
import { confidenceBand, sourceTier, type Citation } from "../lib/extractive";
import { ladderOf } from "../lib/ladder";
import Viewer from "../components/Viewer";
import AgentPanel from "../components/AgentPanel";
import AudioOverviewPanel from "../components/AudioOverviewPanel";
import { useAudioStore } from "../stores/audioStore";
import ThinkingGalaxy from "../components/ThinkingGalaxy";
import MiniGalaxy from "../components/MiniGalaxy";
import type { GalaxyLink, GalaxyNode } from "../components/MiniGalaxy";
import NodePreview from "../components/NodePreview";
import RetrievalStepper from "../components/RetrievalStepper";
import AbstainCard from "../components/AbstainCard";
import SourceLadder, {
  TierPriorPanel,
  bandLabel,
  scopeLabel,
  tierLabel,
} from "../components/SourceLadder";
import { isComposingKey } from "../lib/ime";
import { loadProfile } from "../lib/profile";
import { wikilinkBase } from "../lib/wikilinks";

/** Dismissible flag for the "set up your profile" hint below — same
 *  try/catch-guarded localStorage pattern as `App.tsx`'s onboarding flag
 *  (localStorage can be unavailable or full). */
const PROFILE_HINT_DISMISSED_KEY = "myco.profileHint.dismissed";

/** Pages an extractive answer quotes — formatExtractiveAnswer's `maxPages`,
 *  so the pills and the markdown answer (provider history) agree. */
const QUOTED_PAGES = 5;
const SCOPES: readonly AskScope[] = ["wiki", "sessions", "all"];

// All [[wikilink]] targets in an answer, alias stripped, order kept, deduped.
function extractWikilinks(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const target = (m[1].split("|")[0] ?? "").trim();
    const key = target.toLowerCase();
    if (target && !seen.has(key)) {
      seen.add(key);
      out.push(target);
    }
  }
  return out;
}

export default function PageQuery({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const fileTree = useVaultStore((s) => s.fileTree);
  const adjacency = useVaultStore((s) => s.adjacency);
  const openWikilink = useVaultStore((s) => s.openWikilink);
  const setRoute = useUIStore((s) => s.setRoute);
  const setSettingsTab = useUIStore((s) => s.setSettingsTab);
  const route = useUIStore((s) => s.route);
  const splitRoute = useUIStore((s) => s.splitRoute);
  const lang = useUIStore((s) => s.lang);
  const askScope = useUIStore((s) => s.askScope);
  const setAskScope = useUIStore((s) => s.setAskScope);
  const weights = useUIStore((s) => s.askTierWeights);
  const setAskTierWeights = useUIStore((s) => s.setAskTierWeights);
  const settings = useSettingsStore((s) => s.settings);
  const [mode, setMode] = useState<"ask" | "agent">("ask");
  const [q, setQ] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const turns = useQueryStore((s) => s.turns);
  const busy = useQueryStore((s) => s.busy);
  const stage = useQueryStore((s) => s.stage);
  const askStore = useQueryStore((s) => s.ask);
  const harvest = useQueryStore((s) => s.harvest);
  const endRef = useRef<HTMLDivElement | null>(null);

  // "Set up your profile" hint (Phase B, Task 5): checked per vault, plus
  // whenever either pane's route changes (final-review item 10). Normal
  // navigation already re-checks for free — the primary pane is keyed by
  // route, so coming back from Settings remounts this page — but in SPLIT
  // view this page stays mounted while the profile editor saves in the other
  // pane; re-running on route/splitRoute catches leaving Settings there. A
  // profile saved externally (MCP) while sitting on Ask is still unseen
  // until any navigation — accepted, nothing short of polling covers it.
  const [needsProfile, setNeedsProfile] = useState(false);
  const [hintDismissed, setHintDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PROFILE_HINT_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const vaultPath = currentVault?.path;
    if (!vaultPath) return;
    let cancelled = false;
    void loadProfile(vaultPath).then((p) => {
      if (!cancelled) setNeedsProfile(p === null);
    });
    return () => {
      cancelled = true;
    };
  }, [currentVault?.path, route, splitRoute]);
  function dismissProfileHint(): void {
    try {
      localStorage.setItem(PROFILE_HINT_DISMISSED_KEY, "1");
    } catch {
      /* localStorage unavailable */
    }
    setHintDismissed(true);
  }

  // A surface elsewhere (e.g. the graph's gap panel) may have drafted a
  // question for us — consume it once on mount.
  useEffect(() => {
    const draft = takeQueryPrefill();
    if (draft) setQ(draft);
  }, []);

  // stem (lowercased filename minus extension) → absolute path; mirrors the
  // Rust link resolver, so answer citations resolve like real wikilinks.
  const stemMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of flattenMarkdown(fileTree)) map.set(stem(p).toLowerCase(), p);
    return map;
  }, [fileTree]);

  // The pages retrieval chose, carried on the `thinking` stage — the model call
  // is the long wait, and "these are the notes it is answering from" is exactly
  // what a user wants to see during it.
  const retrieved = stage?.kind === "thinking" ? stage.stems : [];
  // Before retrieval has chosen anything there is nothing true to show, so the
  // animation runs on the vault's hubs — a backdrop, not a claim.
  const backdropPages = useMemo(() => [...stemMap.keys()].slice(0, 18), [stemMap]);
  const thinkingPages = retrieved.length ? retrieved : backdropPages;
  const thinkingLabel = ((): string => {
    if (stage?.kind === "thinking") {
      // Name the pages it is answering FROM when it has them — that is the
      // question this wait actually raises, and the model call is the long
      // part, so this is the label a user reads.
      return retrieved.length
        ? (t.q_answering_from ?? "answering from {n} pages…").replace(
            "{n}",
            String(retrieved.length),
          )
        : (t.q_answering ?? "answering…");
    }
    // "searching the wiki…" is a claim, so it is only made while retrieval is
    // ACTUALLY running. With no index there is nothing to search and no
    // retrieving stage is ever reported — saying it anyway (the old default)
    // described work that was not happening.
    if (stage?.kind === "retrieving") return t.q_thinking ?? "searching the wiki…";
    return t.q_answering ?? "answering…";
  })();

  const openByStem = (target: string): void => {
    const base = wikilinkBase(target);
    if (!base) return;
    const abs = stemMap.get(base.toLowerCase());
    if (abs) {
      setRoute(`page:${abs}`);
      return;
    }
    // Unresolved link: create the note and open it, instead of a silent no-op.
    void openWikilink(base).then((p) => {
      if (p) setRoute(`page:${p}`);
    });
  };
  // Vault-relative page (as retrieval hits carry it) → open in the reader.
  const openPage = (page: string): void => {
    if (currentVault) setRoute(`page:${currentVault.path}/${page}`);
  };

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length]);

  // The chat logic (activity routing, extractive path, provider call) lives in
  // queryStore.ask so it keeps running when this page unmounts. The page only
  // hands over the localized copy the store bakes into turns.
  async function ask(): Promise<void> {
    const question = q.trim();
    if (!question || !currentVault || busy) return;
    setQ("");
    await askStore(question, lang, askCopy(t));
  }

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="page-eyebrow">{t.nav_query}</div>
            <h1 className="page-title">{t.q_title}</h1>
          </div>
          <div className="segmented" role="tablist" aria-label={t.q_mode ?? "Mode"}>
            <button
              className={mode === "ask" ? "active" : ""}
              onClick={() => setMode("ask")}
            >
              <Icon name="msg" size={12} /> {t.q_mode_ask ?? "Ask"}
            </button>
            <button
              className={mode === "agent" ? "active" : ""}
              onClick={() => setMode("agent")}
            >
              <Icon name="terminal" size={12} /> {t.q_mode_agent ?? "Agent"}
            </button>
          </div>
        </div>
        <p className="page-lede">{mode === "agent" ? (t.ag_lede ?? t.q_lede) : t.q_lede}</p>
      </header>

      {mode === "agent" ? <AgentPanel t={t} /> : null}

      {mode === "ask" && needsProfile && !hintDismissed ? (
        <div
          className="card"
          style={{
            padding: 10,
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: 8,
          }}
        >
          <Icon name="info" size={14} />
          <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>
            {t.ask_profile_hint ??
              "Set up your profile so Ask can tailor answers to your role and interests."}
          </span>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: "2px 8px" }}
            // The profile form lives on the Distill tab; settings opens on
            // the model tab, where this CTA named nothing.
            onClick={() => {
              setSettingsTab("distill");
              setRoute("settings");
            }}
          >
            {t.ask_profile_hint_cta ?? "Set up profile"} →
          </button>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: "2px 6px" }}
            aria-label={t.ask_profile_hint_dismiss ?? "Dismiss"}
            onClick={dismissProfileHint}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ) : null}

      <div
        className="card"
        style={{
          padding: 14,
          display: mode === "agent" ? "none" : "flex",
          gap: 8,
          alignItems: "center",
          marginTop: 8,
          flexWrap: "wrap",
        }}
      >
        <Icon name="msg" size={16} />
        {/* Scope segment: which corpus the question runs against. Persisted
            like the other Ask prefs; the store reads it at ask time. */}
        <div className="segmented" role="group" aria-label={t.q_scope_label}>
          {SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              className={askScope === s ? "active" : ""}
              aria-pressed={askScope === s}
              disabled={busy}
              onClick={() => setAskScope(s)}
            >
              {scopeLabel(t, s)}
            </button>
          ))}
        </div>
        <input
          className="input"
          style={{ border: "none", padding: "4px 0", boxShadow: "none", flex: 1, minWidth: 160 }}
          placeholder={t.q_ph}
          value={q}
          aria-describedby="ask-scope-help"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (isComposingKey(e)) return;
            if (e.key === "Enter") void ask();
          }}
          disabled={busy || !currentVault}
        />
        <button
          className="btn btn-primary"
          onClick={() => void ask()}
          disabled={busy || !currentVault || !q.trim()}
        >
          {busy ? "…" : t.q_send}
        </button>
      </div>
      <p id="ask-scope-help" className="ask-sr">
        {t.q_scope_help}
      </p>
      {settings && mode === "ask" ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {settings.query_provider === "builtin-local"
            ? (t.q_via_retrieval ??
                "via local semantic search — answers quote your notes verbatim (no model)")
            : (t.q_via ?? "via {provider} · {model}")
                .replace("{provider}", settings.query_provider)
                .replace("{model}", settings.query_model)}
        </div>
      ) : null}
      {settings?.query_provider === "builtin-local" && mode === "ask" ? (
        <div className="q-builtin-note muted" style={{ fontSize: 12, marginTop: 4 }}>
          <Icon name="info" size={12} />{" "}
          {t.q_builtin_extractive_note ??
            "Answers show the top matching passages from your notes. For a synthesized answer, pick an AI provider under Model settings."}{" "}
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: "2px 8px" }}
            onClick={() => setRoute("settings")}
          >
            {t.q_open_model_settings ?? "Model settings"} →
          </button>
        </div>
      ) : null}
      {mode === "ask" ? (
        // 고급: the tier-prior sliders. One panel for the page — it re-ranks
        // every ladder below live and is sent with the next question.
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: "2px 8px" }}
            aria-expanded={advancedOpen}
            aria-controls="ask-advanced"
            onClick={() => setAdvancedOpen((o) => !o)}
          >
            <Icon name={advancedOpen ? "chevD" : "chevR"} size={12} /> {t.q_prior_advanced}
          </button>
          {advancedOpen ? (
            <div id="ask-advanced" style={{ marginTop: 8, maxWidth: 440 }}>
              <TierPriorPanel
                t={t}
                id="ask-prior"
                weights={weights}
                onChange={setAskTierWeights}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        className="col"
        style={{ marginTop: 24, gap: 16, display: mode === "agent" ? "none" : "flex" }}
      >
        {turns.length === 0 && !busy ? (
          // Empty chat — MYCO keeps the blank space company (idle surface, so
          // the mascot is welcome here; it never interrupts a running chat).
          <div className="query-empty">
            <MascotClip clip="idle" size={120} />
            <p className="muted">{t.q_empty ?? "Ask the wiki anything — answers cite your own pages."}</p>
          </div>
        ) : null}
        {turns.map((turn, i) => (
          <div key={i} className="card ask-turn">
            <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
              <span className="typebadge">
                <span
                  className="tb-dot"
                  style={{ background: "var(--ink)" }}
                ></span>
                {t.q_you ?? "you"}
              </span>
              <span style={{ fontWeight: 500 }}>{turn.q}</span>
              {turn.scope ? (
                <span className="chip">
                  {t.q_scope_chip.replace("{scope}", scopeLabel(t, turn.scope))}
                </span>
              ) : null}
              {turn.range ? (
                // Time-aware Ask (mockup M5-c): the parsed window, promoted to
                // a chip so the applied filter is visible, not implicit.
                <span className="chip">
                  <Icon name="history" size={11} />{" "}
                  {(t.q_range_chip ?? "Period: {s} – {e}")
                    .replace("{s}", turn.range.start)
                    .replace("{e}", turn.range.end)}
                </span>
              ) : null}
            </div>
            {turn.trace ? (
              <RetrievalStepper
                t={t}
                trace={turn.trace}
                archivedOn={settings?.search_archived_sessions ?? false}
                lang={lang}
                id={`ask-trace-${i}`}
              />
            ) : null}
            {turn.abstained ? (
              // Abstention is the answer: the card, never a quoted passage.
              // "Widen" re-asks the same question over every scope.
              <AbstainCard
                t={t}
                id={`ask-turn-${i}`}
                question={turn.q}
                indexedPages={turn.trace?.indexedPages ?? null}
                floor={turn.floor ?? RELEVANCE_FLOOR}
                misses={turn.nearMisses ?? []}
                harvested={turn.harvested ?? false}
                onHarvest={() => void harvest(i)}
                onWiden={
                  turn.scope === "all" || busy
                    ? undefined
                    : () => {
                        setAskScope("all");
                        void askStore(turn.q, lang, askCopy(t));
                      }
                }
              />
            ) : turn.hits?.length && currentVault ? (
              <ExtractiveAnswer
                t={t}
                id={`ask-turn-${i}`}
                turn={turn}
                weights={weights}
                onOpenByStem={openByStem}
                onOpenPage={openPage}
              />
            ) : (
              <div className="prose" style={{ marginTop: 8 }}>
                {turn.error ? (
                  <p style={{ color: "#dc2626" }}>{turn.error}</p>
                ) : turn.a ? (
                  <Viewer content={turn.a} onLinkClick={openByStem} />
                ) : (
                  <ThinkingGalaxy pages={thinkingPages} label={thinkingLabel} />
                )}
              </div>
            )}
            {turn.a && !turn.error && !turn.abstained ? (
              // Ghost action: log this question to the recall-miss eval set
              // (Q4 item 5) when the answer missed what the user expected. An
              // abstained turn offers the same log as its harvest button.
              <button
                className="btn btn-ghost"
                style={{ padding: "3px 8px", fontSize: 11.5, marginTop: 6 }}
                onClick={() => {
                  if (currentVault)
                    void ipc
                      .recordRecallMiss(currentVault.path, turn.q)
                      .catch(() => undefined);
                }}
              >
                {t.q_miss_btn ?? "Not what you expected? Log it"}
              </button>
            ) : null}
            {turn.stale && !turn.extractive ? (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                <Icon name="info" size={12} />{" "}
                {t.q_stale_index ??
                  "This answer used the whole vault instead of the search index, which is out of date after a model update."}{" "}
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: "2px 8px" }}
                  onClick={() => setRoute("settings")}
                >
                  {t.q_open_model_settings ?? "Model settings"} →
                </button>
              </div>
            ) : null}
            {turn.retrievalFailed && !turn.extractive ? (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                <Icon name="info" size={12} />{" "}
                {/* Deliberately vague about HOW the vault was read: the non-CLI
                    path inlines a whole-vault concat, while the CLI path injects
                    nothing and lets the CLI's own Read/Grep find the pages. */}
                {t.q_retrieval_failed ??
                  "The search index could not be reached, so this answer skipped semantic search and read the vault directly instead. If it keeps happening, run “Reindex now” under Model settings."}{" "}
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: "2px 8px" }}
                  onClick={() => setRoute("settings")}
                >
                  {t.q_open_model_settings ?? "Model settings"} →
                </button>
              </div>
            ) : null}
            {turn.a ? (
              <AnswerGalaxy
                t={t}
                question={turn.q}
                answer={turn.a}
                stemMap={stemMap}
                adjacency={adjacency}
                onOpen={(abs) => setRoute(`page:${abs}`)}
              />
            ) : null}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <AudioOverviewPanel t={t} />
    </div>
  );
}

// Extractive answer + its source ladder, side by side. Both derive from the
// same `ladderOf(turn.hits, weights)` rows, so the pills' numbers ARE the
// ladder's ranks and moving a prior slider re-orders both at once. `hot` is
// the page lit from either side — a pill or a ladder row, hover or focus.
function ExtractiveAnswer({
  t,
  id,
  turn,
  weights,
  onOpenByStem,
  onOpenPage,
}: {
  t: Strings;
  id: string;
  turn: ChatTurn;
  weights: TierWeights;
  onOpenByStem: (target: string) => void;
  onOpenPage: (page: string) => void;
}): JSX.Element {
  const [hot, setHot] = useState<string | null>(null);
  const rows = useMemo(() => ladderOf(turn.hits ?? [], weights), [turn.hits, weights]);
  const quoted = rows.slice(0, QUOTED_PAGES);
  // Coverage complement: retrieved, ranked, but past the quote cap.
  const uncited: Citation[] = rows
    .slice(QUOTED_PAGES)
    .map((r) => ({ page: r.page, stem: r.stem, similarity: r.similarity }));
  const pct = (v: number | null): string =>
    v === null ? t.q_cite_sim_none : `${Math.round(v * 100)}%`;
  const hotHandlers = (page: string) => ({
    onMouseEnter: () => setHot(page),
    onMouseLeave: () => setHot(null),
    onFocus: () => setHot(page),
    onBlur: () => setHot(null),
  });
  return (
    <div className="ask-split">
      <div className="ask-answer">
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          <Icon name="info" size={12} />{" "}
          {t.q_extractive_label ?? "From your notes (top matches, verbatim)"}
        </div>
        <div className="ask-body">
          {quoted.map((r, n) => (
            <div key={r.page} className={`ask-sent${hot === r.page ? " hot" : ""}`}>
              <Viewer content={r.quote} onLinkClick={onOpenByStem} />
              <button
                type="button"
                className={`ask-cite${hot === r.page ? " hot" : ""}`}
                aria-label={t.q_cite_aria
                  .replace("{n}", String(n + 1))
                  .replace("{stem}", r.stem)
                  .replace("{sim}", pct(r.similarity))
                  .replace("{tier}", tierLabel(t, r.tier))}
                {...hotHandlers(r.page)}
                onClick={() => onOpenPage(r.page)}
              >
                {n + 1}
              </button>
            </div>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
          {t.q_ladder_hint}
        </p>
        {uncited.length ? <UncitedRow t={t} uncited={uncited} onOpen={onOpenPage} /> : null}
      </div>
      <aside className="ask-rail">
        <SourceLadder
          t={t}
          id={`${id}-ladder`}
          rows={rows}
          quoted={QUOTED_PAGES}
          floor={turn.floor ?? RELEVANCE_FLOOR}
          hot={hot}
          onHot={setHot}
          onOpen={onOpenPage}
        />
      </aside>
    </div>
  );
}

// Coverage row: pages retrieval surfaced that the answer does NOT quote.
// Grounded answers' most common failure is omission — the citations can only
// show what backs the said, never what was considered and left out.
// Collapsed to one line by default (it is an audit surface, not a second
// answer); expanding shows dashed chips so the eye never reads them as
// citations. Clicking a chip opens the page.
function UncitedRow({
  t,
  uncited,
  onOpen,
}: {
  t: Strings;
  uncited: Citation[];
  onOpen: (page: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
      <button
        className="btn btn-ghost"
        style={{ fontSize: 12, padding: "2px 8px" }}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾" : "▸"}{" "}
        {(t.q_uncited_row ?? "Reviewed but not quoted · {n}").replace(
          "{n}",
          String(uncited.length),
        )}
      </button>
      {open ? (
        <ul
          aria-label={t.q_uncited_row ?? "Reviewed but not quoted"}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            listStyle: "none",
            margin: "6px 0 0",
            padding: 0,
          }}
        >
          {uncited.map((c) => (
            <li key={c.page}>
              <button
                className="chip"
                title={c.page}
                style={{ borderStyle: "dashed", cursor: "pointer", opacity: 0.75 }}
                onClick={() => onOpen(c.page)}
              >
                <span style={{ fontWeight: 500 }}>{c.stem}</span>
                <span>· {bandLabel(t, confidenceBand(c.similarity))}</span>
                <span>· {tierLabel(t, sourceTier(c.page))}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Interactive mini galaxy of the pages an answer cites. Nodes are the
// resolved [[wikilinks]]; solid edges are the real links between those pages
// from the vault's adjacency. Click a star for an in-place preview.
function AnswerGalaxy({
  t,
  question,
  answer,
  stemMap,
  adjacency,
  onOpen,
}: {
  t: Strings;
  question: string;
  answer: string;
  stemMap: Map<string, string>;
  adjacency: ReturnType<typeof useVaultStore.getState>["adjacency"];
  onOpen: (absPath: string) => void;
}): JSX.Element | null {
  const [selected, setSelected] = useState<string | null>(null);
  const genAudio = useAudioStore((s) => s.generate);
  const audioBusy = useAudioStore((s) => s.generating);

  const nodes = useMemo<GalaxyNode[]>(() => {
    const out: GalaxyNode[] = [];
    for (const target of extractWikilinks(answer).slice(0, 32)) {
      const abs = stemMap.get(target.toLowerCase());
      if (!abs) continue; // unresolved citation — nothing to open
      out.push({
        id: abs,
        label: stem(abs),
        bright: true,
      });
    }
    return out;
  }, [answer, stemMap]);

  const links = useMemo<GalaxyLink[]>(() => {
    if (!adjacency) return [];
    const ids = new Set(nodes.map((n) => n.id));
    const out: GalaxyLink[] = [];
    for (const [src, targets] of Object.entries(adjacency.forward)) {
      if (!ids.has(src)) continue;
      for (const tgt of targets) {
        if (ids.has(tgt)) out.push({ a: src, b: tgt });
      }
    }
    return out;
  }, [adjacency, nodes]);

  if (nodes.length === 0) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 4 }}
      >
        <div className="section-title" style={{ fontSize: 13 }}>
          {t.q_sources_used} · {nodes.length}
        </div>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 12.5 }}
          disabled={audioBusy}
          onClick={() =>
            void genAudio(question, nodes.map((n) => n.id))
          }
        >
          <Icon name="spark" size={12} />{" "}
          {audioBusy ? (t.au_generating ?? "…") : (t.au_title ?? "Audio overview")}
        </button>
      </div>
      <MiniGalaxy
        nodes={nodes}
        links={links}
        selected={selected}
        onSelect={setSelected}
        ariaLabel={t.q_sources_used}
        hubLabel={question}
      />
      {selected ? (
        <NodePreview
          t={t}
          absPath={selected}
          label={stem(selected)}
          onOpen={() => onOpen(selected)}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
