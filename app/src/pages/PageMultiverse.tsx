// Multiverse overview — the "home of every universe" surface. Lists every
// registered project (universe) as a card tinted with its identity hue, with
// its note count and active state. Entering a universe switches the active
// vault (backend registry + confinement) and opens its graph. The full 3D
// fly-into-universe scene is a later increment; this is the navigable,
// responsive overview it will grow out of.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useMultiverseStore } from "../stores/multiverseStore";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import MultiverseScene from "../components/MultiverseScene";
import type { SceneUniverse } from "../lib/multiverseScene";

type ViewMode = "cosmos" | "cards";

export default function PageMultiverse({ t }: { t: Strings }): JSX.Element {
  const order = useMultiverseStore((s) => s.order);
  const universes = useMultiverseStore((s) => s.universes);
  const isLoading = useMultiverseStore((s) => s.isLoading);
  const error = useMultiverseStore((s) => s.error);
  const available = useMultiverseStore((s) => s.available);
  const loadProjects = useMultiverseStore((s) => s.loadProjects);
  const loadAll = useMultiverseStore((s) => s.loadAll);
  const setActiveUniverse = useMultiverseStore((s) => s.setActiveUniverse);
  const openVault = useVaultStore((s) => s.openVault);
  const setRoute = useUIStore((s) => s.setRoute);
  const [view, setView] = useState<ViewMode>("cosmos");

  // The registry listing is cheap; fetch it whenever the overview mounts so a
  // project added/switched elsewhere shows up. The cosmos view additionally
  // needs every universe's graph, so it warms them all (parallel, per-universe
  // error isolation) — the cards only need the registry metadata.
  useEffect(() => {
    if (view === "cosmos") void loadAll();
    else void loadProjects();
  }, [view, loadAll, loadProjects]);

  // Enter a universe: flip the backend active project (registry pointer +
  // confinement root), then sync the frontend vault and jump to its graph.
  async function enter(slug: string, root: string): Promise<void> {
    await setActiveUniverse(slug);
    await openVault(root);
    setRoute("graph");
  }

  // Enter by slug (from a 3D star click) — look up its root first.
  async function enterBySlug(slug: string): Promise<void> {
    const u = universes[slug];
    if (u) await enter(slug, u.info.root);
  }

  const cards = order.map((slug) => universes[slug]).filter(Boolean);

  // Universes whose graphs have finished loading, for the 3D scene.
  const sceneUniverses = useMemo<SceneUniverse[]>(
    () =>
      order
        .map((slug) => universes[slug])
        .filter((u) => u && u.adjacency)
        .map((u) => ({ slug: u.info.slug, root: u.info.root, adjacency: u.adjacency! })),
    [order, universes],
  );

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

  const toggle = (
    <div className="mv-viewtoggle" role="group" aria-label={t.mv_title}>
      <button
        type="button"
        className={"mv-viewbtn" + (view === "cosmos" ? " is-on" : "")}
        aria-pressed={view === "cosmos"}
        onClick={() => setView("cosmos")}
      >
        <Icon name="globe" />
        {t.mv_view_cosmos}
      </button>
      <button
        type="button"
        className={"mv-viewbtn" + (view === "cards" ? " is-on" : "")}
        aria-pressed={view === "cards"}
        onClick={() => setView("cards")}
      >
        <Icon name="book" />
        {t.mv_view_cards}
      </button>
    </div>
  );

  // Cosmos (3D) view: full-bleed scene once at least one universe graph is
  // loaded, with a floating header + view toggle. Falls back to the shared
  // state panel (loading / error / empty) until the field is ready.
  if (view === "cosmos" && available) {
    return (
      <div className="mv-cosmos">
        <div className="mv-cosmos-head">
          <div>
            <div className="page-eyebrow">{t.nav_multiverse}</div>
            <h1 className="mv-cosmos-title">{t.mv_title}</h1>
          </div>
          {toggle}
        </div>
        {sceneUniverses.length > 0 ? (
          <MultiverseScene
            universes={sceneUniverses}
            onEnterUniverse={(slug) => void enterBySlug(slug)}
          />
        ) : (
          <div className="mv-state" role="status" aria-live="polite">
            <Icon name="globe" />
            <span>{t.mv_loading}</span>
          </div>
        )}
        <p className="mv-cosmos-hint">{t.mv_cosmos_hint}</p>
      </div>
    );
  }

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_multiverse}</div>
        <h1 className="page-title">{t.mv_title}</h1>
        <p className="page-lede">{t.mv_lede}</p>
        {available && cards.length > 0 && <div style={{ marginTop: 16 }}>{toggle}</div>}
      </header>
      {body}
    </div>
  );
}
