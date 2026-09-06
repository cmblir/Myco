// Heads-up overlay for spaceship mode: an exit button, a controls legend, and —
// when a node is selected (clicked while flying) — an info panel beside the ship
// showing that node's title, cluster colour, link count and neighbours.
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";

export interface ShipHudNode {
  id: string;
  title: string;
  color: string;
  degree: number;
  neighbors: string[];
}

export default function ShipHud({
  t,
  node,
  speed,
  onClose,
  onOpen,
  onExit,
}: {
  t: Strings;
  node: ShipHudNode | null;
  /** current flight speed in world units/s (rounded for display) */
  speed?: number;
  onClose: () => void;
  onOpen: (id: string) => void;
  onExit: () => void;
}): JSX.Element {
  return (
    <div className="ship-hud" aria-live="polite">
      <button
        type="button"
        className="ship-hud__exit"
        onClick={onExit}
        title={t.gr_spaceship_exit ?? "Exit spaceship (Esc)"}
      >
        {t.gr_spaceship_exit ?? "Exit"} ✕
      </button>

      <div className="ship-hud__legend">
        {speed !== undefined ? (
          <span className="ship-hud__speed">
            {t.gr_speed ?? "Speed"} {Math.round(speed)}
          </span>
        ) : null}
        {t.gr_spaceship_hint ??
          "WASD fly · drag to steer · click a node · Esc exit"}
      </div>

      {node ? (
        <aside className="ship-hud__panel" aria-label={node.title}>
          <div className="ship-hud__panel-head">
            <span
              className="ship-hud__dot"
              style={{ background: node.color }}
              aria-hidden="true"
            />
            <span className="ship-hud__title">{node.title}</span>
            <button
              type="button"
              className="ship-hud__close"
              onClick={onClose}
              title={t.gr_close ?? "Close"}
            >
              ✕
            </button>
          </div>
          <div className="ship-hud__meta">
            {node.degree} {t.gr_node_count ?? "links"}
          </div>
          {node.neighbors.length > 0 ? (
            <div className="ship-hud__neighbors">
              {node.neighbors.map((n) => (
                <span key={n} className="ship-hud__chip">
                  {n}
                </span>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="ship-hud__open"
            onClick={() => onOpen(node.id)}
          >
            {t.gr_open ?? "Open page"}
          </button>
        </aside>
      ) : null}
    </div>
  );
}
