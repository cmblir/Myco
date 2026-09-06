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
import type { GapAction } from "./GraphGaps";

const GHOST = "ghost:";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export default function GraphInspector({
  t,
  nodeId,
  adjacency,
  graph,
  pathAnchor,
  path,
  onSetAnchor,
  onClearAnchor,
  onSelect,
  onOpen,
  onClose,
  isSample,
  onAction,
  onNeighbors,
}: {
  t: Strings;
  nodeId: string;
  adjacency: Adjacency;
  graph: VaultGraph | null;
  /** Node pinned as the shortest-path start, if any. */
  pathAnchor: string | null;
  /** Computed shortest path from the anchor to this node (null = none). */
  path: string[] | null;
  onSetAnchor: (id: string) => void;
  onClearAnchor: () => void;
  /** Select another node (re-inspect + fly camera to it). */
  onSelect: (id: string) => void;
  /** Open the node in the full reader. */
  onOpen: (id: string) => void;
  onClose: () => void;
  /** Seeded first-run note (graphSample) rather than the owner's own writing. */
  isSample: (id: string) => boolean;
  /** The three exits a gap row offers, on the inspected note. */
  onAction: (action: GapAction, id: string) => void;
  /** Switch the question to "이 노트의 이웃" with this note as the subject. */
  onNeighbors: (id: string) => void;
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

  // Trust: frontmatter is the fallback, adjacency.meta the cheap already-loaded
  // source (it is what the gap report and the size-by-citations channel read,
  // so the inspector must not disagree with the picture).
  const nodeMeta = adjacency.meta?.[nodeId];
  const cites = nodeMeta?.sourceCount ?? 0;
  const meta: { label: string; value: string }[] = [];
  const type = nodeMeta?.type ?? str(fm?.type);
  const conf = nodeMeta?.confidence ?? str(fm?.confidence);
  const status = nodeMeta?.status ?? str(fm?.status);
  if (type) meta.push({ label: t.gr_insp_type ?? "Type", value: type });
  if (conf) meta.push({ label: t.gr_insp_confidence ?? "Confidence", value: conf });
  if (status) meta.push({ label: t.gr_insp_status ?? "Status", value: status });
  if (!isGhost) meta.push({ label: t.gr_insp_cites, value: String(cites) });
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
          aria-label={t.ui_close ?? "Close"}
          title={t.ui_close ?? "Close"}
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      {isGhost ? (
        <p className="graph-insp__ghost">{t.gr_insp_unresolved ?? "Unresolved note"}</p>
      ) : null}

      {/* Trust badges: is this the owner's writing or a seeded sample note,
          and does it stand on any source at all? */}
      <div className="sv-badges">
        {isGhost ? (
          <span className="sv-badge sv-badge--warn">{t.gr_insp_unresolved}</span>
        ) : (
          <span className={`sv-badge${isSample(nodeId) ? " sv-badge--warn" : " sv-badge--ok"}`}>
            {isSample(nodeId) ? t.gr_insp_sample : t.gr_insp_own}
          </span>
        )}
        {!isGhost && cites === 0 ? (
          <span className="sv-badge sv-badge--warn">{t.gr_insp_nocite}</span>
        ) : null}
      </div>

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

      <div className="graph-insp__section">
        {pathAnchor === nodeId ? (
          <button
            type="button"
            className="graph-insp__pathbtn is-anchor"
            onClick={onClearAnchor}
          >
            {t.gr_insp_path_anchor ?? "Path start"} ✓ · {t.gr_insp_path_clear ?? "clear"}
          </button>
        ) : (
          <button
            type="button"
            className="graph-insp__pathbtn"
            onClick={() => onSetAnchor(nodeId)}
          >
            {t.gr_insp_path_start ?? "Set as path start"}
          </button>
        )}
        {pathAnchor && pathAnchor !== nodeId ? (
          <div className="graph-insp__pathresult">
            <h4>
              {t.gr_insp_path ?? "Path"}{" "}
              {path ? (
                <span className="muted">
                  ({path.length - 1} {t.gr_insp_hops ?? "hops"})
                </span>
              ) : null}
            </h4>
            {path ? (
              <ul className="graph-insp__links">
                {path.map((id) => (
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
            ) : (
              <div className="graph-insp__empty">
                {t.gr_insp_path_none ?? "No path to this node"}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Three exits, the same ones every gap row offers — a finding on this
          screen has to be able to turn into work without leaving by the
          browser's back button. */}
      <div className="sv-actions">
        {isGhost ? (
          <button
            type="button"
            className="sv-btn sv-btn--primary"
            onClick={() => onAction("want", nodeId)}
          >
            {t.gr_act_harvest}
          </button>
        ) : (
          <button
            type="button"
            className="sv-btn sv-btn--primary"
            onClick={() => onOpen(nodeId)}
          >
            {t.gr_insp_open ?? "Open in reader"}
          </button>
        )}
        <button type="button" className="sv-btn" onClick={() => onAction("link", nodeId)}>
          {t.gr_act_link}
        </button>
        {!isGhost ? (
          <button type="button" className="sv-btn" onClick={() => onAction("want", nodeId)}>
            {t.gr_act_harvest}
          </button>
        ) : null}
        <button type="button" className="sv-btn" onClick={() => onNeighbors(nodeId)}>
          {t.gr_act_neighbors}
        </button>
      </div>
    </aside>
  );
}
