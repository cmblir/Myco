// Ask the wiki — answers render as real markdown (clickable [[wikilinks]])
// and every cited page appears in an interactive mini galaxy under the
// answer — drag, hover, click for an in-place preview. The chat itself lives
// in queryStore so an in-flight answer survives navigating away; the Topbar
// shows a chip while it runs.

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";
import { askCopy, useQueryStore } from "../stores/queryStore";
import { ipc } from "../lib/ipc";
import { takeQueryPrefill } from "../lib/queryPrefill";
import MascotClip from "../components/MascotClip";
import { flattenMarkdown, stem } from "../lib/graphData";
import { RELEVANCE_FLOOR } from "../lib/chat";
import {
  confidenceBand,
  sourceTier,
  type Citation,
  type ConfidenceBand,
  type SourceTier,
} from "../lib/extractive";
import type { DeepStorageHit } from "../lib/deepStorage";
import Viewer from "../components/Viewer";
import AgentPanel from "../components/AgentPanel";
import AudioOverviewPanel from "../components/AudioOverviewPanel";
import { useAudioStore } from "../stores/audioStore";
import ThinkingGalaxy from "../components/ThinkingGalaxy";
import MiniGalaxy from "../components/MiniGalaxy";
import type { GalaxyLink, GalaxyNode } from "../components/MiniGalaxy";
import NodePreview from "../components/NodePreview";
import { isComposingKey } from "../lib/ime";
import { loadProfile } from "../lib/profile";

/** Dismissible flag for the "set up your profile" hint below — same
 *  try/catch-guarded localStorage pattern as `App.tsx`'s onboarding flag
 *  (localStorage can be unavailable or full). */
const PROFILE_HINT_DISMISSED_KEY = "myco.profileHint.dismissed";

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
  const route = useUIStore((s) => s.route);
  const splitRoute = useUIStore((s) => s.splitRoute);
  const lang = useUIStore((s) => s.lang);
  const settings = useSettingsStore((s) => s.settings);
  const [mode, setMode] = useState<"ask" | "agent">("ask");
  const [q, setQ] = useState("");
  const turns = useQueryStore((s) => s.turns);
  const busy = useQueryStore((s) => s.busy);
  const stage = useQueryStore((s) => s.stage);
  const askStore = useQueryStore((s) => s.ask);
  const markSeen = useQueryStore((s) => s.markSeen);
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

  // Visiting this page acknowledges a finished answer (clears the Topbar
  // chip) — same pattern as lint on the Provenance page.
  useEffect(() => {
    markSeen();
  }, [busy, markSeen]);

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
    const abs = stemMap.get(target.toLowerCase());
    if (abs) {
      setRoute(`page:${abs}`);
      return;
    }
    // Unresolved link: create the note and open it, instead of a silent no-op.
    void openWikilink(target).then((p) => {
      if (p) setRoute(`page:${p}`);
    });
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
            onClick={() => setRoute("settings")}
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
        }}
      >
        <Icon name="msg" size={16} />
        <input
          className="input"
          style={{ border: "none", padding: "4px 0", boxShadow: "none" }}
          placeholder={t.q_ph}
          value={q}
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
          <div key={i} className="card">
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="typebadge">
                <span
                  className="tb-dot"
                  style={{ background: "var(--ink)" }}
                ></span>
                {t.q_you ?? "you"}
              </span>
              <span style={{ fontWeight: 500 }}>{turn.q}</span>
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
            {turn.extractive && turn.a && !turn.error && !turn.extractiveEmpty ? (
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                <Icon name="info" size={12} /> {t.q_extractive_label ?? "From your notes (top matches, verbatim)"}
              </div>
            ) : null}
            <div className="prose" style={{ marginTop: 8 }}>
              {turn.error ? (
                <p style={{ color: "#dc2626" }}>{turn.error}</p>
              ) : turn.a ? (
                <Viewer content={turn.a} onLinkClick={openByStem} />
              ) : (
                <ThinkingGalaxy pages={thinkingPages} label={thinkingLabel} />
              )}
            </div>
            {turn.citations?.length ? (
              <CitationChips t={t} citations={turn.citations} />
            ) : null}
            {turn.deepStorage && currentVault ? (
              <DeepStorageRow
                t={t}
                hit={turn.deepStorage}
                onOpen={(page) => setRoute(`page:${currentVault.path}/${page}`)}
              />
            ) : null}
            {turn.a && !turn.error ? (
              // Ghost action: log this question to the recall-miss eval set
              // (Q4 item 5) when the answer missed what the user expected.
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

function bandLabel(t: Strings, band: ConfidenceBand): string {
  switch (band) {
    case "high":
      return t.q_cite_conf_high ?? "strong match";
    case "medium":
      return t.q_cite_conf_medium ?? "moderate match";
    case "low":
      return t.q_cite_conf_low ?? "weak match";
    case "lexical":
      return t.q_cite_conf_lexical ?? "keyword match";
  }
}

function tierLabel(t: Strings, tier: SourceTier): string {
  switch (tier) {
    case "map":
      return t.q_cite_tier_map ?? "drafted map";
    case "digest":
      return t.q_cite_tier_digest ?? "daily digest";
    case "rollup":
      return t.q_cite_tier_rollup ?? "weekly rollup";
    case "monthly":
      return t.q_cite_tier_monthly ?? "monthly rollup";
    case "session":
      return t.q_cite_tier_session ?? "session log";
    case "source":
      return t.q_cite_tier_source ?? "imported source";
    case "note":
      return t.q_cite_tier_note ?? "your note";
  }
}

// Per-citation confidence + source tier, under an extractive answer. Both are
// words, never colour alone: the band is a label, and the exact cosine (and
// the floor it cleared) lives in the chip's tooltip so the number is
// available without shouting it at everyone.
function CitationChips({
  t,
  citations,
}: {
  t: Strings;
  citations: Citation[];
}): JSX.Element {
  return (
    <ul
      aria-label={t.q_cite_list_label ?? "Citation confidence and source"}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        listStyle: "none",
        margin: "8px 0 0",
        padding: 0,
      }}
    >
      {citations.map((c) => {
        const tip =
          c.similarity == null
            ? (
                t.q_cite_conf_lexical_tip ??
                "{page} — keyword match only, so there is no similarity score for it"
              ).replace("{page}", c.page)
            : (
                t.q_cite_conf_tip ??
                "{page} — similarity {sim} (dense cosine; passages below {floor} are not shown)"
              )
                .replace("{page}", c.page)
                .replace("{sim}", c.similarity.toFixed(3))
                .replace("{floor}", RELEVANCE_FLOOR.toFixed(2));
        return (
          <li key={c.page} className="chip" title={tip}>
            <span style={{ fontWeight: 500 }}>{c.stem}</span>
            <span>· {bandLabel(t, confidenceBand(c.similarity))}</span>
            <span>· {tierLabel(t, sourceTier(c.page))}</span>
          </li>
        );
      })}
    </ul>
  );
}

// One cold-tier hit under the citation chips (Q4 item 12) — sessions, raw
// sources, or rollups echoing the question when the wiki-first citations
// don't already show it. The dot is --c-concept so the row reads as a
// deep-storage echo, not another citation; clicking opens the page.
function DeepStorageRow({
  t,
  hit,
  onOpen,
}: {
  t: Strings;
  hit: DeepStorageHit;
  onOpen: (page: string) => void;
}): JSX.Element {
  // Rendered as a percentage like the answer body's relevance figures. A hit
  // without a cosine never becomes a deep-storage row (pickDeepStorage skips
  // them), so the null arm is only type honesty.
  const sim =
    hit.similarity === null ? "–" : `${Math.round(hit.similarity * 100)}%`;
  return (
    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
      <button
        className="btn btn-ghost"
        style={{ fontSize: 12, padding: "2px 8px" }}
        title={hit.page}
        onClick={() => onOpen(hit.page)}
      >
        <span
          className="chip-dot"
          style={{ background: "var(--c-concept)" }}
        ></span>{" "}
        {(t.q_deep_row ?? "From deep storage: {stem} — similarity {sim}")
          .replace("{stem}", hit.stem)
          .replace("{sim}", sim)}
      </button>
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
