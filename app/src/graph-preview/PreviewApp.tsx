import { useEffect, useMemo, useState } from "react";
import { ipc } from "../lib/ipc";
import { flattenMarkdown } from "../lib/graphData";
import { copy } from "./copy";
import { GraphViewport } from "./GraphViewport";
import {
  neighborhood,
  type GraphResult,
  type Look,
  type PreviewGraph,
} from "./model";

export function PreviewApp() {
  const [graph, setGraph] = useState<PreviewGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [look, setLook] = useState<Look>("terrain");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [isFocused, setFocused] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [brightness, setBrightness] = useState(0.8);

  useEffect(() => {
    let cancelled = false;
    let worker: Worker | undefined;
    setError(null);
    const timeout = window.setTimeout(() => {
      cancelled = true;
      worker?.terminate();
      setError("Layout timed out after 30 seconds.");
    }, 30000);
    const fail = (message: string): void => {
      if (cancelled) return;
      console.error("[graph-preview]", message);
      setError(message);
      window.clearTimeout(timeout);
      worker?.terminate();
    };
    void (async () => {
      const root = await ipc.ensureDefaultVault();
      const [adjacency, tree] = await Promise.all([
        ipc.buildLinkGraph(root),
        ipc.listFiles(root),
      ]);
      if (cancelled) return;
      worker = new Worker(new URL("./layout.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<GraphResult>) => {
        if (cancelled) return;
        if ("error" in event.data) fail(event.data.error);
        else {
          setGraph(event.data.graph);
          window.clearTimeout(timeout);
          worker?.terminate();
        }
      };
      worker.onerror = (event) => fail(event.message);
      worker.postMessage({ adjacency, allowed: flattenMarkdown(tree) });
    })().catch((reason: unknown) =>
      fail(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      worker?.terminate();
    };
  }, [attempt]);

  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSelected(null);
        setFocused(false);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  const selectedNode = graph?.nodes.find((node) => node.id === selected);
  const neighbors = useMemo(
    () => (graph ? neighborhood(graph, selected) : new Set<string>()),
    [graph, selected],
  );
  const groups = useMemo(() => {
    const grouped = new Map<
      number,
      {
        label: string;
        color: string;
        count: number;
        id: string;
        degree: number;
      }
    >();
    for (const node of graph?.nodes ?? []) {
      const group = grouped.get(node.community);
      if (!group) grouped.set(node.community, { ...node, count: 1 });
      else {
        group.count++;
        if (node.degree > group.degree) {
          group.label = node.label;
          group.id = node.id;
          group.degree = node.degree;
        }
      }
    }
    return [...grouped.values()].sort((a, b) => b.count - a.count);
  }, [graph]);
  const results =
    graph?.nodes.filter((node) =>
      node.label.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const list = query
    ? results
    : selectedNode
      ? graph!.nodes.filter(
          (node) => node.id !== selected && neighbors.has(node.id),
        )
      : [];
  const format = new Intl.NumberFormat("ko");
  const choose = (id: string | null): void => {
    setSelected(id);
    if (!id) setFocused(false);
  };

  return (
    <main className="preview-shell">
      <header className="preview-header">
        <a className="wordmark" href="/graph-preview.html">
          {copy.brand}
          <span>{copy.lab}</span>
        </a>
        <span className="preview-badge">{copy.badge}</span>
      </header>
      <section className="intro">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        <div className="graph-stats" aria-live="polite">
          {graph && (
            <>
              <strong>
                {format.format(graph.nodes.length)}
                <small>{copy.note}</small>
              </strong>
              <strong>
                {format.format(graph.edges.length)}
                <small>{copy.edge}</small>
              </strong>
            </>
          )}
        </div>
      </section>
      <nav className="look-tabs" aria-label={copy.styles}>
        {(Object.keys(copy.modes) as Look[]).map((mode) => (
          <button
            key={mode}
            aria-pressed={look === mode}
            onClick={() => setLook(mode)}
          >
            <span className="mode-number">{copy.modes[mode].number}</span>
            <span>
              <b>{copy.modes[mode].title}</b>
              <small>{copy.modes[mode].caption}</small>
            </span>
            <span className="mode-dot" />
          </button>
        ))}
      </nav>
      <div className="workspace">
        <section className="graph-panel">
          <div className="graph-toolbar">
            <span className="live-dot" />
            <b>{copy.modes[look].title}</b>
            <span>{copy.modes[look].caption}</span>
            <button
              className="overview"
              onClick={() => {
                choose(null);
                setQuery("");
              }}
            >
              {copy.overview}
            </button>
          </div>
          {error ? (
            <div className="graph-message" role="alert">
              <p>{copy.error}</p>
              <code>{error}</code>
              <button onClick={() => setAttempt((value) => value + 1)}>
                {copy.retry}
              </button>
            </div>
          ) : !graph ? (
            <div className="graph-message" role="status">
              <div className="loading-dot" />
              {copy.loading}
            </div>
          ) : !graph.nodes.length ? (
            <div className="graph-message">{copy.empty}</div>
          ) : (
            <GraphViewport
              graph={graph}
              look={look}
              selected={selected}
              query={query}
              isFocused={isFocused}
              showLabels={showLabels}
              brightness={brightness}
              onSelect={choose}
            />
          )}
        </section>
        <aside className="inspector">
          <label className="search-label" htmlFor="note-search">
            {copy.search}
          </label>
          <input
            id="note-search"
            type="search"
            placeholder={copy.placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <section className="selected-card" aria-live="polite">
            <p className="eyebrow">{selectedNode ? copy.note : copy.start}</p>
            <h2>{selectedNode?.label ?? copy.inspect}</h2>
            <p>
              {selectedNode
                ? `${format.format(selectedNode.degree)} ${copy.edge}`
                : copy.inspectHint}
            </p>
            {selectedNode && (
              <div className="selection-actions">
                <button
                  aria-pressed={isFocused}
                  onClick={() => setFocused((value) => !value)}
                >
                  {copy.focus}
                </button>
                <button onClick={() => choose(null)}>{copy.clear}</button>
              </div>
            )}
          </section>
          {(query || selectedNode) && (
            <section className="note-results">
              <h3>
                {query ? copy.search : copy.neighbors}
                <span>{format.format(list.length)}</span>
              </h3>
              {!list.length && <p>{query ? copy.noResults : copy.isolated}</p>}
              <div className="note-list">
                {list.map((node) => (
                  <button
                    key={node.id}
                    aria-pressed={node.id === selected}
                    onClick={() => choose(node.id)}
                  >
                    <i style={{ background: node.color }} />
                    <span>{node.label}</span>
                    <span>↗</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {!query && !selectedNode && (
            <section>
              <h3>
                {copy.groups}
                <span>{format.format(groups.length)}</span>
              </h3>
              <div className="note-list">
                {groups.map((group) => (
                  <button key={group.id} onClick={() => choose(group.id)}>
                    <i style={{ background: group.color }} />
                    <span>{group.label}</span>
                    <small>{format.format(group.count)}</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          <section className="display-controls">
            <label htmlFor="edge-brightness">
              {copy.links}
              <input
                id="edge-brightness"
                type="range"
                min="0.1"
                max="1.5"
                step="0.1"
                value={brightness}
                onChange={(event) => setBrightness(Number(event.target.value))}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showLabels}
                onChange={(event) => setShowLabels(event.target.checked)}
              />
              {copy.labels}
            </label>
          </section>
        </aside>
      </div>
      <footer>
        <span>{copy.sample}</span>
        <span>{copy.keyboard}</span>
      </footer>
    </main>
  );
}
