// Ask the wiki — shells the prompt to `claude --print` with the vault as
// cwd. The CLI uses the user's existing Pro/Max subscription so we never
// touch an API key. Answers render as real markdown (clickable [[wikilinks]])
// and every cited page appears in an interactive mini galaxy under the
// answer — drag, hover, click for an in-place preview.

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";
import { complete } from "../lib/chat";
import { flattenMarkdown, stem } from "../lib/graphData";
import Viewer from "../components/Viewer";
import AgentPanel from "../components/AgentPanel";
import AudioOverviewPanel from "../components/AudioOverviewPanel";
import { useAudioStore } from "../stores/audioStore";
import ThinkingGalaxy from "../components/ThinkingGalaxy";
import MiniGalaxy from "../components/MiniGalaxy";
import type { GalaxyLink, GalaxyNode } from "../components/MiniGalaxy";
import NodePreview from "../components/NodePreview";

interface ChatTurn {
  q: string;
  a: string;
  error?: string;
}

const SYSTEM_PREAMBLE = `You are Memex, the wiki maintainer for the user's local markdown vault.
The current working directory is the vault root. Use Read/Grep/Glob tools to
look up answers from the wiki (\`wiki/\` if it exists) before reaching for
\`raw/\` sources. Answer in the user's language. When you state a fact that
comes from a vault file, cite it inline as [[page-stem]].`;

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
  const setRoute = useUIStore((s) => s.setRoute);
  const settings = useSettingsStore((s) => s.settings);
  const [mode, setMode] = useState<"ask" | "agent">("ask");
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  // stem (lowercased filename minus extension) → absolute path; mirrors the
  // Rust link resolver, so answer citations resolve like real wikilinks.
  const stemMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of flattenMarkdown(fileTree)) map.set(stem(p).toLowerCase(), p);
    return map;
  }, [fileTree]);

  // Random sample of real page names for the thinking animation — the pulses
  // light up actual vault pages, so the wait reads as "searching your wiki".
  const thinkingPages = useMemo(() => {
    const all = [...stemMap.keys()];
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, 18);
  }, [stemMap]);

  const openByStem = (target: string): void => {
    const abs = stemMap.get(target.toLowerCase());
    if (abs) setRoute(`page:${abs}`);
  };

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length]);

  async function ask(): Promise<void> {
    const question = q.trim();
    if (!question || !currentVault || busy) return;
    setQ("");
    setBusy(true);
    const pending: ChatTurn = { q: question, a: "" };
    setTurns((prev) => [...prev, pending]);
    try {
      const content = await complete({
        task: "query",
        cwd: currentVault.path,
        messages: [
          { role: "system", content: SYSTEM_PREAMBLE },
          // Skip turns that errored or have no answer — replaying an empty
          // assistant message makes providers (e.g. Anthropic) reject the
          // request with a 400 on the next question.
          ...turns
            .filter((p) => p.a && !p.error)
            .flatMap((p) => [
              { role: "user" as const, content: p.q },
              { role: "assistant" as const, content: p.a },
            ]),
          { role: "user", content: question },
        ],
      });
      setTurns((prev) =>
        prev.map((turn, i) =>
          i === prev.length - 1
            ? { ...turn, a: content || "(empty response)" }
            : turn,
        ),
      );
    } catch (err) {
      setTurns((prev) =>
        prev.map((turn, i) =>
          i === prev.length - 1 ? { ...turn, a: "", error: String(err) } : turn,
        ),
      );
    } finally {
      setBusy(false);
    }
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
          {(t.q_via ?? "via {provider} · {model}")
            .replace("{provider}", settings.query_provider)
            .replace("{model}", settings.query_model)}
        </div>
      ) : null}

      <div
        className="col"
        style={{ marginTop: 24, gap: 16, display: mode === "agent" ? "none" : "flex" }}
      >
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
            </div>
            <div className="prose" style={{ marginTop: 8 }}>
              {turn.error ? (
                <p style={{ color: "#dc2626" }}>{turn.error}</p>
              ) : turn.a ? (
                <Viewer content={turn.a} onLinkClick={openByStem} />
              ) : (
                <ThinkingGalaxy
                  pages={thinkingPages}
                  label={t.q_thinking ?? "searching the wiki…"}
                />
              )}
            </div>
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
