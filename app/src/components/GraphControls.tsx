// Right-side controls drawer for the Graph view. The panel is organised so the
// common path is one tap: pick a LOOK (a vibe card that bundles skin + layout +
// its recommended settings), and go. Everything else is tucked into labelled,
// collapsible groups — Filters, Layout, Appearance, Motion & effects, Forces —
// so the ~30 fine controls never overwhelm the first glance. Each slider/toggle
// mutates the live settings object; the parent re-runs the layout and restyles.

import type { JSX } from "react";
import { useState } from "react";
import {
  LAYOUT_PRESETS,
  deleteLook,
  loadSavedLooks,
  matchPreset,
  saveLook,
  VIBE_PRESETS,
  type GraphSettings,
  type LayoutPresetKey,
  type SavedLook,
  type VibeKey,
} from "../lib/graphSettings";
import type { Strings } from "../lib/i18n";

interface Props {
  t: Strings;
  open: boolean;
  onToggle: () => void;
  settings: GraphSettings;
  onChange: (next: Partial<GraphSettings>) => void;
  onReset: () => void;
  tags: string[];
  folders: string[];
  tlPlaying: boolean;
  onTimelapse: () => void;
  traceMode: boolean;
  onTraceMode: (on: boolean) => void;
  flyMode: boolean;
  onFlyMode: (on: boolean) => void;
}

// The eight one-tap looks, each with a one-line "what you get" so a first-time
// user can choose by outcome, not by decoding skin+layout jargon.
function vibeMeta(t: Strings): { key: VibeKey; label: string; desc: string }[] {
  return [
    { key: "living", label: t.gr_vibe_living ?? "Living galaxy", desc: t.gr_vibe_living_desc ?? "The default — a glowing, breathing star map" },
    { key: "sigma", label: t.gr_vibe_sigma ?? "Sigma board", desc: t.gr_vibe_sigma_desc ?? "Vivid Gephi hairball on a clean charcoal board" },
    { key: "cosmicweb", label: t.gr_vibe_cosmicweb ?? "Cosmic web", desc: t.gr_vibe_cosmicweb_desc ?? "Dark-matter filaments; the links are the picture" },
    { key: "neural", label: t.gr_vibe_neural ?? "Neural", desc: t.gr_vibe_neural_desc ?? "A firing nervous system in the void" },
    { key: "planetarium", label: t.gr_vibe_planetarium ?? "Planetarium", desc: t.gr_vibe_planetarium_desc ?? "Constellations per topic under a deep-space sky" },
    { key: "paper", label: t.gr_vibe_paper ?? "Paper atlas", desc: t.gr_vibe_paper_desc ?? "A print-like territory map on white paper" },
    { key: "chronicle", label: t.gr_vibe_chronicle ?? "Chronicle", desc: t.gr_vibe_chronicle_desc ?? "Time strata — the vault read as history" },
    { key: "nebula", label: t.gr_vibe_nebula ?? "Meaning nebula", desc: t.gr_vibe_nebula_desc ?? "Notes clustered by meaning (embeddings)" },
  ];
}

export default function GraphControls({
  t,
  open,
  onToggle,
  settings,
  onChange,
  onReset,
  tags,
  folders,
  tlPlaying,
  onTimelapse,
  traceMode,
  onTraceMode,
  flyMode,
  onFlyMode,
}: Props): JSX.Element {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    // The look picker leads; Filters is common enough to sit open. The detail
    // groups start collapsed so the panel opens calm, not as a wall of controls.
    looks: true,
    filters: true,
    layout: false,
    appearance: false,
    motion: false,
    forces: false,
    // Raw force sliders are an expert affordance — collapsed inside Forces.
    advanced: false,
  });
  const [tagsOpen, setTagsOpen] = useState(false);
  // User-saved looks: the list + the "name this look" input. Loaded lazily so
  // the panel doesn't touch localStorage until it's opened.
  const [savedLooks, setSavedLooks] = useState<SavedLook[]>(() => loadSavedLooks());
  const [lookName, setLookName] = useState("");

  const toggle = (k: string): void =>
    setOpenSections((p) => ({ ...p, [k]: !p[k] }));

  const commitSaveLook = (): void => {
    const name = lookName.trim();
    if (!name) return;
    setSavedLooks(saveLook(name, settings));
    setLookName("");
  };

  if (!open) {
    return (
      <button
        type="button"
        className="graph-drawer-toggle graph-drawer-toggle--closed"
        onClick={onToggle}
        title={t.gr_settings ?? "Graph settings"}
        aria-label={t.gr_settings ?? "Graph settings"}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            d="M4 6h16M4 12h10M4 18h16"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    );
  }

  const activeVibe = (key: VibeKey): boolean =>
    settings.skin === VIBE_PRESETS[key].skin &&
    settings.layout === VIBE_PRESETS[key].layout;

  return (
    <aside className="graph-drawer" aria-label={t.gr_settings ?? "Graph settings"}>
      <header className="graph-drawer__head">
        <span className="graph-drawer__title">
          {t.gr_settings ?? "Graph settings"}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            className="graph-drawer__btn"
            onClick={onReset}
            title={t.gr_reset ?? "Reset to defaults"}
          >
            {t.gr_reset ?? "Reset"}
          </button>
          <button
            type="button"
            className="graph-drawer__btn graph-drawer__btn--icon"
            onClick={onToggle}
            aria-label={t.ui_close ?? "Close"}
          >
            ×
          </button>
        </div>
      </header>

      {/* ── Looks: the one-tap vibe picker (the primary control) ── */}
      <Section
        title={t.gr_looks ?? "Looks"}
        open={openSections.looks}
        onToggle={() => toggle("looks")}
      >
        <div className="graph-vibes" role="group" aria-label={t.gr_vibes ?? "One-tap looks"}>
          {vibeMeta(t).map(({ key, label, desc }) => {
            const active = activeVibe(key);
            return (
              <button
                key={key}
                type="button"
                className={`graph-vibe${active ? " graph-vibe--active" : ""}`}
                aria-pressed={active}
                onClick={() => onChange(VIBE_PRESETS[key])}
              >
                <span className="graph-vibe__name">{label}</span>
                <span className="graph-vibe__desc">{desc}</span>
              </button>
            );
          })}
        </div>

        {/* Saved looks: the user's own tuned configurations, one tap to recall. */}
        <div className="graph-field">
          <span className="graph-field__label">{t.gr_saved ?? "Saved looks"}</span>
          {savedLooks.length > 0 ? (
            <div className="graph-chips">
              {savedLooks.map((look) => (
                <span key={look.name} className="graph-saved">
                  <button
                    type="button"
                    className="graph-saved__apply"
                    onClick={() => onChange(look.settings)}
                    title={t.gr_saved_apply ?? "Apply this saved look"}
                  >
                    {look.name}
                  </button>
                  <button
                    type="button"
                    className="graph-saved__del"
                    onClick={() => setSavedLooks(deleteLook(look.name))}
                    aria-label={`${t.gr_saved_delete ?? "Delete"} ${look.name}`}
                    title={t.gr_saved_delete ?? "Delete"}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <span className="graph-saved__empty">
              {t.gr_saved_empty ?? "Save the current settings to recall them later."}
            </span>
          )}
          <div className="graph-saverow">
            <input
              type="text"
              className="graph-field__input"
              placeholder={t.gr_saved_name_ph ?? "Name this look…"}
              value={lookName}
              maxLength={40}
              onChange={(e) => setLookName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitSaveLook();
                }
              }}
            />
            <button
              type="button"
              className="graph-saverow__btn"
              onClick={commitSaveLook}
              disabled={!lookName.trim()}
            >
              {t.gr_saved_save ?? "Save"}
            </button>
          </div>
        </div>

        <Toggle
          label={t.gr_multiverse ?? "Multiverse"}
          hint={
            t.gr_multiverse_hint ??
            "Show every project as its own universe-bubble; fly into one to open it"
          }
          value={settings.multiverse}
          onChange={(v) => onChange({ multiverse: v })}
        />
      </Section>

      {/* ── Filters ── */}
      <Section
        title={t.gr_filters ?? "Filters"}
        open={openSections.filters}
        onToggle={() => toggle("filters")}
      >
        <label className="graph-field">
          <span className="graph-field__label">{t.gr_search ?? "Search"}</span>
          <input
            type="text"
            className="graph-field__input"
            placeholder={t.gr_search_ph ?? "path:wiki tag:#concept"}
            value={settings.search}
            onChange={(e) => onChange({ search: e.target.value })}
          />
        </label>

        {tags.length > 0 ? (
          <div className="graph-field">
            <button
              type="button"
              className="graph-subhead"
              onClick={() => setTagsOpen((v) => !v)}
              aria-expanded={tagsOpen}
            >
              <span className="graph-field__label">
                {t.gr_tags ?? "Tags"} ({tags.length})
                {settings.tagFilter ? ` · #${settings.tagFilter}` : ""}
              </span>
              <span className={`graph-subhead__caret${tagsOpen ? " is-open" : ""}`}>
                ▸
              </span>
            </button>
            {tagsOpen ? (
              <div className="graph-chips">
                <button
                  type="button"
                  className={`graph-chip${
                    settings.tagFilter === null ? " graph-chip--active" : ""
                  }`}
                  onClick={() => onChange({ tagFilter: null })}
                >
                  {t.gr_all ?? "all"}
                </button>
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`graph-chip${
                      settings.tagFilter === tag ? " graph-chip--active" : ""
                    }`}
                    onClick={() =>
                      onChange({
                        tagFilter: settings.tagFilter === tag ? null : tag,
                      })
                    }
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {folders.length > 0 ? (
          <label className="graph-field">
            <span className="graph-field__label">{t.gr_folder ?? "Folder"}</span>
            <select
              className="graph-field__input"
              value={settings.folderFilter ?? ""}
              onChange={(e) => onChange({ folderFilter: e.target.value || null })}
            >
              <option value="">{t.gr_all_folders ?? "all folders"}</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <Toggle
          label={t.gr_show_orphans ?? "Show orphans"}
          hint={t.gr_show_orphans_hint ?? "Nodes with no links"}
          value={settings.showOrphans}
          onChange={(v) => onChange({ showOrphans: v })}
        />
        <Toggle
          label={t.gr_existing_only ?? "Existing files only"}
          hint={
            t.gr_existing_only_hint ??
            "Hide unresolved [[wikilinks]] (ghost nodes)"
          }
          value={settings.existingOnly}
          onChange={(v) => onChange({ existingOnly: v })}
        />
      </Section>

      {/* ── Layout: the shape of the map, grouped by dimension ── */}
      <Section
        title={t.gr_layout ?? "Layout"}
        open={openSections.layout}
        onToggle={() => toggle("layout")}
      >
        {/* 3D layouts orbit in space; 2D layouts are flat, top-down maps. The
            split answers the recurring "which of these are 3D?" up front. */}
        <ChipRow
          label={t.gr_layout_3d ?? "3D — orbit in space"}
          value={settings.layout}
          onPick={(v) => onChange({ layout: v })}
          options={[
            ["galaxy", t.gr_layout_galaxy_s ?? "Galaxy"],
            ["synapse3d", t.gr_layout_synapse3d_s ?? "Synapse"],
            ["spiral", t.gr_layout_spiral ?? "Spiral galaxy"],
            ["semantic", t.gr_layout_semantic ?? "Semantic map"],
            ["celestial", t.gr_layout_celestial ?? "Celestial sphere"],
            ["radial", t.gr_layout_radial ?? "Radial orbit"],
          ]}
        />
        <ChipRow
          label={t.gr_layout_2d ?? "2D — flat map"}
          value={settings.layout}
          onPick={(v) => onChange({ layout: v })}
          options={[
            ["atlas", t.gr_layout_atlas_s ?? "Atlas"],
            ["synapse", t.gr_layout_synapse_s ?? "Synapse (flat)"],
            ["strata", t.gr_layout_strata ?? "Chronicle"],
          ]}
        />
        <Toggle
          label={t.gr_galaxies ?? "Folder galaxies"}
          hint={
            t.gr_galaxies_hint ??
            "Split the vault into one slowly rotating galaxy per folder"
          }
          value={settings.folderGalaxies}
          onChange={(v) => onChange({ folderGalaxies: v })}
        />
      </Section>

      {/* ── Appearance: colour, sky, sizes ── */}
      <Section
        title={t.gr_appearance ?? "Appearance"}
        open={openSections.appearance}
        onToggle={() => toggle("appearance")}
      >
        <ChipRow
          label={t.gr_skin ?? "Color mode"}
          value={settings.skin}
          onPick={(v) => onChange({ skin: v })}
          options={[
            ["auto", t.gr_skin_auto ?? "App theme"],
            ["black", t.gr_skin_black ?? "Black"],
            ["white", t.gr_skin_white ?? "White"],
            ["galaxy", t.gr_skin_galaxy ?? "Galaxy"],
            ["web", t.gr_skin_web ?? "Cosmic web"],
            ["sigma", t.gr_skin_sigma ?? "Sigma"],
          ]}
        />
        <ChipRow
          label={t.gr_sky ?? "Sky"}
          value={settings.skyStyle}
          onPick={(v) => onChange({ skyStyle: v })}
          options={[
            ["stars", t.gr_sky_stars ?? "Stars"],
            ["dense", t.gr_sky_dense ?? "Dense"],
            ["grid", t.gr_sky_grid ?? "Grid"],
            ["void", t.gr_sky_void ?? "Void"],
          ]}
        />
        <ChipRow
          label={t.gr_node_color ?? "Node colour"}
          value={settings.nodeColor}
          onPick={(v) => onChange({ nodeColor: v })}
          options={[
            ["community", t.gr_node_color_community ?? "By folder"],
            ["white", t.gr_node_color_white ?? "White"],
            ["black", t.gr_node_color_black ?? "Black"],
            ["auto", t.gr_node_color_auto ?? "Auto"],
          ]}
        />
        {settings.nodeColor === "auto" ? (
          <Slider
            label={t.gr_mono_below ?? "Colour above N nodes"}
            value={settings.monoBelow}
            min={0}
            max={2000}
            step={50}
            onChange={(v) => onChange({ monoBelow: v })}
          />
        ) : null}
        <ChipRow
          label={t.gr_edge_tint ?? "Link colour"}
          value={settings.edgeTint}
          onPick={(v) => onChange({ edgeTint: v })}
          options={[
            ["grey", t.gr_edge_tint_grey ?? "Grey"],
            ["community", t.gr_edge_tint_community ?? "Community webs"],
          ]}
        />
        <Slider
          label={t.gr_color_depth ?? "Colour depth"}
          value={settings.nodeColorDepth}
          min={0.4}
          max={2.4}
          step={0.1}
          onChange={(v) => onChange({ nodeColorDepth: v })}
        />
        <Slider
          label={t.gr_node_size ?? "Node size"}
          value={settings.nodeSize}
          min={0.5}
          max={3}
          step={0.05}
          onChange={(v) => onChange({ nodeSize: v })}
        />
        <Slider
          label={t.gr_link_thickness ?? "Link thickness"}
          value={settings.linkThickness}
          min={0.3}
          max={3}
          step={0.05}
          onChange={(v) => onChange({ linkThickness: v })}
        />
        <Slider
          label={t.gr_glow ?? "Glow"}
          value={settings.brightness}
          min={0.4}
          max={1.6}
          step={0.05}
          onChange={(v) => onChange({ brightness: v })}
        />
        <Slider
          label={t.gr_text_fade ?? "Text fade threshold"}
          value={settings.textFadeThreshold}
          min={0.1}
          max={3}
          step={0.05}
          onChange={(v) => onChange({ textFadeThreshold: v })}
        />
        <Toggle
          label={t.gr_arrows ?? "Arrows"}
          hint={t.gr_arrows_hint ?? "Show direction on each link"}
          value={settings.arrows}
          onChange={(v) => onChange({ arrows: v })}
        />
        {settings.arrows ? (
          <Slider
            label={t.gr_arrow_size ?? "Arrow size"}
            value={settings.arrowSize}
            min={0.1}
            max={3}
            step={0.05}
            onChange={(v) => onChange({ arrowSize: v })}
          />
        ) : null}
        <Toggle
          label={t.gr_semantic_edges ?? "Semantic links"}
          hint={t.gr_semantic_edges_hint ?? "Overlay dim edges between similar notes"}
          value={settings.semanticEdges}
          onChange={(v) => onChange({ semanticEdges: v })}
        />
        <Toggle
          label={t.gr_edge_bundles ?? "Bundled strands"}
          hint={
            t.gr_edge_bundles_hint ??
            "Merge links between two topics into one weighted arc"
          }
          value={settings.edgeBundles}
          onChange={(v) => onChange({ edgeBundles: v })}
        />
      </Section>

      {/* ── Motion & effects ── */}
      <Section
        title={t.gr_motion_fx ?? "Motion & effects"}
        open={openSections.motion}
        onToggle={() => toggle("motion")}
      >
        <Toggle
          label={t.gr_motion ?? "Ambient motion"}
          hint={t.gr_motion_hint ?? "Auto-rotate, pulses, breathing"}
          value={settings.ambientMotion}
          onChange={(v) => onChange({ ambientMotion: v })}
        />
        <Toggle
          label={t.gr_recency ?? "Recency glow"}
          hint={t.gr_recency_hint ?? "Recently edited notes burn hotter"}
          value={settings.recencyGlow}
          onChange={(v) => onChange({ recencyGlow: v })}
        />
        <Toggle
          label={t.gr_cinematic ?? "Cinematic finish"}
          hint={
            t.gr_cinematic_hint ?? "Film grain, vignette, lens streaks, anti-aliasing"
          }
          value={settings.cinematic}
          onChange={(v) => onChange({ cinematic: v })}
        />
        <Toggle
          label={t.gr_flow ?? "Edge flow"}
          hint={t.gr_flow_hint ?? "Light pulses ride links source → target"}
          value={settings.edgeFlow}
          onChange={(v) => onChange({ edgeFlow: v })}
        />
        <Toggle
          label={t.gr_minimap ?? "Minimap"}
          hint={t.gr_minimap_hint ?? "Corner chart of the whole galaxy; click to fly"}
          value={settings.minimap}
          onChange={(v) => onChange({ minimap: v })}
        />
        <Toggle
          label={t.gr_cosmic ?? "Cosmic events"}
          hint={t.gr_cosmic_hint ?? "Black holes & wormholes (dark theme)"}
          value={settings.cosmicEvents}
          onChange={(v) => onChange({ cosmicEvents: v })}
        />
        {settings.cosmicEvents ? (
          <Slider
            label={t.gr_cosmic_freq ?? "Event frequency"}
            value={settings.cosmicFrequency}
            min={0.25}
            max={4}
            step={0.25}
            onChange={(v) => onChange({ cosmicFrequency: v })}
          />
        ) : null}
        <Toggle
          label={t.gr_click_burst ?? "Click burst"}
          hint={t.gr_click_burst_hint ?? "Supernova + ripple when you select a node"}
          value={settings.clickBurst}
          onChange={(v) => onChange({ clickBurst: v })}
        />
        <Toggle
          label={t.gr_neural_firing ?? "Neural firing"}
          hint={t.gr_neural_firing_hint ?? "Signals that periodically ripple the mesh"}
          value={settings.neuralFiring}
          onChange={(v) => onChange({ neuralFiring: v })}
        />
        <Toggle
          label={t.gr_planets ?? "Near-field planets"}
          hint={t.gr_planets_hint ?? "Close-up nodes become procedural planets (dark 3D)"}
          value={settings.nearFieldPlanets}
          onChange={(v) => onChange({ nearFieldPlanets: v })}
        />
        <Toggle
          label={t.gr_mascot_cameo ?? "MYCO cameo"}
          hint={t.gr_mascot_cameo_hint ?? "MYCO drifts in now and then with a feature tip"}
          value={settings.mascotCameo}
          onChange={(v) => onChange({ mascotCameo: v })}
        />
        <Toggle
          label={t.gr_trace ?? "Trace path"}
          hint={t.gr_trace_hint ?? "Click a start node, then an end node"}
          value={traceMode}
          onChange={onTraceMode}
        />
        <Toggle
          label={t.gr_spaceship ?? "Spaceship"}
          hint={
            t.gr_spaceship_hint ??
            "WASD fly · drag to steer · click a node for info · Esc exit"
          }
          value={flyMode}
          onChange={onFlyMode}
        />
      </Section>

      {/* ── Forces (expert layout tuning) ── */}
      <Section
        title={t.gr_forces ?? "Forces"}
        open={openSections.forces}
        onToggle={() => toggle("forces")}
      >
        <ChipRow
          label={t.gr_preset ?? "Layout"}
          value={matchPreset(settings) ?? ""}
          onPick={(v) => onChange({ ...LAYOUT_PRESETS[v as LayoutPresetKey] })}
          options={[
            ["galaxy", t.gr_preset_galaxy ?? "Galaxy"],
            ["loose", t.gr_preset_loose ?? "Loose web"],
            ["dense", t.gr_preset_dense ?? "Dense"],
          ]}
        />
        <Section
          title={t.gr_advanced ?? "Advanced"}
          open={openSections.advanced}
          onToggle={() => toggle("advanced")}
        >
          {/* Slider ranges match Obsidian's panel one-for-one. */}
          <Slider
            label={t.gr_center_force ?? "Center force"}
            value={settings.centerForce}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => onChange({ centerForce: v })}
          />
          <Slider
            label={t.gr_repel_force ?? "Repel force"}
            value={settings.repelForce}
            min={0}
            max={50}
            step={0.5}
            onChange={(v) => onChange({ repelForce: v })}
          />
          <Slider
            label={t.gr_link_force ?? "Link force"}
            value={settings.linkForce}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => onChange({ linkForce: v })}
          />
          <Slider
            label={t.gr_link_distance ?? "Link distance"}
            value={settings.linkDistance}
            min={30}
            max={500}
            step={5}
            onChange={(v) => onChange({ linkDistance: v })}
          />
          <Slider
            label={t.gr_cluster_force ?? "Cluster force"}
            value={settings.clusterForce}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => onChange({ clusterForce: v })}
          />
        </Section>
      </Section>

      {/* ── Timelapse: an always-visible footer action ── */}
      <div className="graph-drawer__footer">
        <button
          type="button"
          className="graph-drawer__play"
          onClick={onTimelapse}
          aria-pressed={tlPlaying}
        >
          {tlPlaying
            ? (t.gr_timelapse_pause ?? "Pause timelapse")
            : (t.gr_timelapse_play ?? "Play timelapse")}
        </button>
        <Slider
          label={t.gr_tl_speed ?? "Timelapse speed"}
          value={settings.tlSpeed}
          min={0.25}
          max={4}
          step={0.25}
          onChange={(v) => onChange({ tlSpeed: v })}
        />
      </div>
    </aside>
  );
}

// A labelled row of single-select chips — the panel's most repeated shape, so it
// lives in one place (skin / sky / node colour / layout / edge tint / preset all
// share it). The generic keeps each caller's literal-union value type.
function ChipRow<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T | "";
  options: [T, string][];
  onPick: (v: T) => void;
}): JSX.Element {
  return (
    <div className="graph-field">
      <span className="graph-field__label">{label}</span>
      <div className="graph-chips">
        {options.map(([key, text]) => (
          <button
            key={key}
            type="button"
            className={`graph-chip${value === key ? " graph-chip--active" : ""}`}
            aria-pressed={value === key}
            onClick={() => onPick(key)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="graph-drawer__section">
      <button
        type="button"
        className="graph-drawer__section-head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span
          className="graph-drawer__caret"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
        {title}
      </button>
      {open ? (
        <div className="graph-drawer__section-body">{children}</div>
      ) : null}
    </section>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    // The whole row is the control: a real <button role="switch"> is focusable
    // and Space/Enter-operable for free (the old <span onClick> was neither),
    // its text content is the accessible name, and the wide row is an ample
    // touch target. The visual pill is decorative.
    <button
      type="button"
      className="graph-toggle"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
    >
      <span className="graph-toggle__text">
        <span>{label}</span>
        {hint ? <span className="graph-toggle__hint">{hint}</span> : null}
      </span>
      <span
        className={`graph-toggle__switch${value ? " graph-toggle__switch--on" : ""}`}
        aria-hidden="true"
      >
        <span className="graph-toggle__knob" />
      </span>
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label className="graph-slider">
      <span className="graph-slider__row">
        <span className="graph-slider__label">{label}</span>
        <span className="graph-slider__value">{format(value, step)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="graph-slider__input"
      />
    </label>
  );
}

function format(v: number, step: number): string {
  const decimals = step < 1 ? Math.min(2, Math.ceil(-Math.log10(step))) : 0;
  return v.toFixed(decimals);
}
