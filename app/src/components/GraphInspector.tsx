// Graph node inspector — a side panel for the 3D graph. Clicking a star opens
// this instead of navigating away, so the graph becomes an exploration surface:
// it shows the page's frontmatter (type / confidence / status), its degree, and
// its outgoing links, backlinks and tags. Link rows are clickable — they select
// (and fly the camera to) the target node, so you can walk the graph by links.
// All data comes from the already-loaded adjacency + the graphology graph; the
// frontmatter is fetched lazily per node via readFile (no backend change).

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import { ipc } from "../lib/ipc";
import type { Adjacency } from "../lib/ipc";
import type { Strings } from "../lib/i18n";
import { stem, type VaultGraph } from "../lib/graphData";

const GHOST = "ghost:";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export default function GraphInspector({
  t,
  nodeId,
  adjacency,
  graph,
  onSelect,
  onOpen,
  onClose,
}: {
  t: Strings;
  nodeId: string;
  adjacency: Adjacency;
  graph: VaultGraph | null;
  /** Select another node (re-inspect + fly camera to it). */
  onSelect: (id: string) => void;
  /** Open the node in the full reader. */
  onOpen: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const isGhost = nodeId.startsWith(GHOST);
  const [fm, setFm] = useState<Record<string, unknown> | null>(null);

  // Lazily fetch the page's frontmatter (real files only; ghosts have none).
  useEffect(() => {
    if (isGhost) {
      setFm(null);
      return;
    }
    let cancelled = false;
    setFm(null);
    ipc
      .readFile(nodeId)
      .then((f) => {
        if (cancelled) return;
        const raw = f.frontmatter;
        setFm(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
      })
      .catch(() => {
        if (!cancelled) setFm({});
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, isGhost]);

  const label = isGhost ? nodeId.slice(GHOST.length) : stem(nodeId);
  const title = str(fm?.title) ?? label;
  const outlinks = adjacency.forward[nodeId] ?? [];
  const backlinks = adjacency.backward[nodeId] ?? [];
  const tags = adjacency.tags[nodeId] ?? [];
  const deg =
    graph && graph.hasNode(nodeId)
      ? graph.degree(nodeId)
      : outlinks.length + backlinks.length;

  const meta: { label: string; value: string }[] = [];
  const type = str(fm?.type);
  const conf = str(fm?.confidence);
  const status = str(fm?.status);
  if (type) meta.push({ label: t.gr_insp_type ?? "Type", value: type });
  if (conf) meta.push({ label: t.gr_insp_confidence ?? "Confidence", value: conf });
  if (status) meta.push({ label: t.gr_insp_status ?? "Status", value: status });
  meta.push({ label: t.gr_insp_connections ?? "Connections", value: String(deg) });

  const linkList = (ids: string[]): JSX.Element =>
    ids.length === 0 ? (
      <div className="graph-insp__empty">{t.gr_insp_none ?? "—"}</div>
    ) : (
      <ul className="graph-insp__links">
        {ids.map((id) => (
          <li key={id}>
            <button
              type="button"
              className="graph-insp__link"
              title={id}
              onClick={() => onSelect(id)}
            >
              {stem(id)}
            </button>
          </li>
        ))}
      </ul>
    );

  return (
    <aside className="graph-inspector" role="region" aria-label={title}>
      <div className="graph-insp__head">
        <span className="graph-insp__title" title={nodeId}>
          {title}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      {isGhost ? (
        <p className="graph-insp__ghost">{t.gr_insp_unresolved ?? "Unresolved note"}</p>
      ) : null}

      <dl className="graph-insp__meta">
        {meta.map((m) => (
          <div className="graph-insp__row" key={m.label}>
            <dt>{m.label}</dt>
            <dd className={`graph-insp__badge graph-insp__badge--${m.value.toLowerCase()}`}>
              {m.value}
            </dd>
          </div>
        ))}
      </dl>

      {tags.length > 0 ? (
        <div className="graph-insp__section">
          <h4>{t.gr_insp_tags ?? "Tags"}</h4>
          <div className="graph-insp__tags">
            {tags.map((tag) => (
              <span className="graph-insp__tag" key={tag}>
                #{tag}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="graph-insp__section">
        <h4>
          {t.gr_insp_links_out ?? "Links"} <span className="muted">({outlinks.length})</span>
        </h4>
        {linkList(outlinks)}
      </div>

      <div className="graph-insp__section">
        <h4>
          {t.gr_insp_backlinks ?? "Backlinks"}{" "}
          <span className="muted">({backlinks.length})</span>
        </h4>
        {linkList(backlinks)}
      </div>

      {!isGhost ? (
        <button type="button" className="btn graph-insp__open" onClick={() => onOpen(nodeId)}>
          {t.gr_insp_open ?? "Open in reader"}
        </button>
      ) : null}
    </aside>
  );
}
