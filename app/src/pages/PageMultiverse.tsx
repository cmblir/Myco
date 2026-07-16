// Multiverse overview — the "home of every universe" surface. Lists every
// registered project (universe) as a card tinted with its identity hue, with
// its note count and active state. Entering a universe switches the active
// vault (backend registry + confinement) and opens its graph. The full 3D
// fly-into-universe scene is a later increment; this is the navigable,
// responsive overview it will grow out of.

import { useEffect } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useMultiverseStore } from "../stores/multiverseStore";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";

export default function PageMultiverse({ t }: { t: Strings }): JSX.Element {
  const order = useMultiverseStore((s) => s.order);
  const universes = useMultiverseStore((s) => s.universes);
  const isLoading = useMultiverseStore((s) => s.isLoading);
  const error = useMultiverseStore((s) => s.error);
  const available = useMultiverseStore((s) => s.available);
  const loadProjects = useMultiverseStore((s) => s.loadProjects);
  const setActiveUniverse = useMultiverseStore((s) => s.setActiveUniverse);
  const openVault = useVaultStore((s) => s.openVault);
  const setRoute = useUIStore((s) => s.setRoute);

  // The registry listing is cheap; fetch it whenever the overview mounts so a
  // project added/switched elsewhere shows up. Per-universe graphs stay lazy
  // (the scene tier warms them) — the cards only need the registry metadata.
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Enter a universe: flip the backend active project (registry pointer +
  // confinement root), then sync the frontend vault and jump to its graph.
  async function enter(slug: string, root: string): Promise<void> {
    await setActiveUniverse(slug);
    await openVault(root);
    setRoute("graph");
  }

  const cards = order.map((slug) => universes[slug]).filter(Boolean);

  let body: JSX.Element;
  if (isLoading && cards.length === 0) {
    body = (
      <div className="mv-state" role="status" aria-live="polite">
        <Icon name="globe" />
        <span>{t.mv_loading}</span>
      </div>
    );
  } else if (error) {
    body = (
      <div className="mv-state mv-state-error" role="alert">
        <Icon name="info" />
        <span>{error}</span>
      </div>
    );
  } else if (!available || cards.length === 0) {
    body = (
      <div className="mv-state">
        <Icon name="globe" />
        <div className="col" style={{ gap: 4, alignItems: "center" }}>
          <strong>{t.mv_empty}</strong>
          <span className="muted">{t.mv_empty_hint}</span>
        </div>
      </div>
    );
  } else {
    body = (
      <ul className="mv-grid" aria-label={t.mv_title}>
        {cards.map((u) => {
          const hue = `hsl(${u.hue} 70% 55%)`;
          return (
            <li
              key={u.info.slug}
              className={"mv-card" + (u.info.active ? " mv-card-active" : "")}
              style={{ ["--mv-hue" as string]: hue }}
            >
              <span className="mv-card-bar" aria-hidden="true" />
              <div className="mv-card-body">
                <div className="mv-card-head">
                  <span className="mv-dot" aria-hidden="true" />
                  <h2 className="mv-card-title" title={u.info.title}>
                    {u.info.title}
                  </h2>
                  {u.info.active && <span className="mv-badge">{t.mv_active}</span>}
                </div>
                {u.info.description && (
                  <p className="mv-card-desc">{u.info.description}</p>
                )}
                <div className="mv-card-meta">
                  <span>
                    {u.info.noteCount} {t.mv_notes}
                  </span>
                  {u.info.independentVault && (
                    <span className="mv-tag">{t.mv_independent}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn mv-enter"
                  disabled={u.info.active}
                  onClick={() => void enter(u.info.slug, u.info.root)}
                >
                  <Icon name="arrowR" />
                  {t.mv_enter}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_multiverse}</div>
        <h1 className="page-title">{t.mv_title}</h1>
        <p className="page-lede">{t.mv_lede}</p>
      </header>
      {body}
    </div>
  );
}
