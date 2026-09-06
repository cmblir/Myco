// Node inspector — what the selected note is, and the three ways out of this
// screen. It used to offer exactly one exit ("open in reader") next to a
// shortest-path toy; it now carries citations, trust and the same three
// actions the gap rows do, so a survey finding turns into work.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { ipc } from "../lib/ipc";
import type { Adjacency } from "../lib/ipc";
import type { Strings } from "../lib/i18n";
import { stem } from "../lib/graphData";
import type { GapAction } from "./GraphGaps";

const GHOST = "ghost:";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export default function GraphInspector({
  t,
  nodeId,
  adjacency,
  isSample,
  onSelect,
  onOpen,
  onAction,
  onNeighbors,
}: {
  t: Strings;
  nodeId: string | null;
  adjacency: Adjacency;
  /** Seeded first-run note (graphSample) rather than the owner's writing. */
  isSample: (id: string) => boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onAction: (action: GapAction, id: string) => void;
  /** Switch the question to "이 노트의 이웃" with this note as the subject. */
  onNeighbors: (id: string) => void;
}): JSX.Element {
  const [fm, setFm] = useState<Record<string, unknown> | null>(null);
  const isGhost = !!nodeId && nodeId.startsWith(GHOST);

  // Lazily fetch the page's frontmatter (real files only; ghosts have none).
  useEffect(() => {
    if (!nodeId || isGhost) {
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

  if (!nodeId) {
    return (
      <aside className="sv-panel sv-insp" aria-labelledby="sv-insp-h">
        <div className="sv-panel__h">
          <b id="sv-insp-h">{t.gr_insp_h}</b>
        </div>
        <div className="sv-insp__empty">
          <p>{t.gr_insp_empty}</p>
        </div>
      </aside>
    );
  }

  const label = isGhost ? nodeId.slice(GHOST.length) : stem(nodeId);
  const title = str(fm?.title) ?? label;
  const outlinks = adjacency.forward[nodeId] ?? [];
  const backlinks = adjacency.backward[nodeId] ?? [];
  const meta = adjacency.meta?.[nodeId];
  const cites = meta?.sourceCount ?? 0;
  const conf = meta?.confidence ?? str(fm?.confidence);
  const type = meta?.type ?? str(fm?.type);
  const status = meta?.status ?? str(fm?.status);

  const rows: [string, string][] = [
    [t.gr_insp_type, type ?? "—"],
    [t.gr_insp_confidence, conf ?? "—"],
    [t.gr_insp_cites, String(cites)],
    [t.gr_insp_links_out, String(outlinks.length)],
    [t.gr_insp_backlinks, String(backlinks.length)],
  ];
  if (status) rows.push([t.gr_insp_status, status]);

  const list = (ids: string[]): JSX.Element =>
    ids.length === 0 ? (
      <div className="sv-insp__none">{t.gr_insp_none}</div>
    ) : (
      <ul className="sv-links">
        {ids.map((id) => (
          <li key={id}>
            <button type="button" title={id} onClick={() => onSelect(id)}>
              {id.startsWith(GHOST) ? `◌ ${id.slice(GHOST.length)}` : stem(id)}
            </button>
          </li>
        ))}
      </ul>
    );

  return (
    <aside className="sv-panel sv-insp" aria-labelledby="sv-insp-h" aria-live="polite">
      <div className="sv-panel__h">
        <b id="sv-insp-h">{t.gr_insp_h}</b>
      </div>
      <div className="sv-insp__body">
        <h3 className="sv-insp__title">{title}</h3>
        <div className="sv-insp__path mono">{isGhost ? t.gr_insp_unresolved : nodeId}</div>
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

        {!isGhost ? (
          <dl className="sv-meta">
            {rows.map(([k, v]) => (
              <div className="sv-mrow" key={k}>
                <dt>{k}</dt>
                <dd className="mono">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <h4>
          {t.gr_insp_links_out} <span className="muted">{outlinks.length}</span>
        </h4>
        {list(outlinks)}
        <h4>
          {t.gr_insp_backlinks} <span className="muted">{backlinks.length}</span>
        </h4>
        {list(backlinks)}

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
              {t.gr_insp_open}
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
      </div>
    </aside>
  );
}
