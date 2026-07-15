// Obsidian-style right-side controls drawer for the Graph view. Three
// sections: Filters, Display, Forces. Each slider mutates the live
// settings object; the parent re-runs the layout and restyles the
// canvas in response.

import type { JSX } from "react";
import { useState } from "react";
import {
  LAYOUT_PRESETS,
  matchPreset,
  type GraphSettings,
  type GraphSkinKey,
  type LayoutPresetKey,
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
    filters: true,
    display: true,
    forces: true,
    // Raw force sliders are an expert affordance — collapsed by default; the
    // preset chips cover the common cases (spec B4).
    advanced: false,
  });
  // The tag list can be long — collapsed by default so it never buries the
  // rest of the Filters section; the active tag (if any) still shows a hint.
  const [tagsOpen, setTagsOpen] = useState(false);

  const toggle = (k: string): void =>
    setOpenSections((p) => ({ ...p, [k]: !p[k] }));

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
            <span className="graph-field__label">
              {t.gr_folder ?? "Folder"}
            </span>
            <select
              className="graph-field__input"
              value={settings.folderFilter ?? ""}
              onChange={(e) =>
                onChange({ folderFilter: e.target.value || null })
              }
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

      <Section
        title={t.gr_display ?? "Display"}
        open={openSections.display}
        onToggle={() => toggle("display")}
      >
        <div className="graph-field">
          <span className="graph-field__label">
            {t.gr_layout ?? "Layout"}
          </span>
          <div className="graph-chips">
            {(
              [
                ["galaxy", t.gr_layout_galaxy ?? "Galaxy (3D)"],
                ["atlas", t.gr_layout_atlas ?? "Atlas (2D)"],
                ["synapse", t.gr_layout_synapse ?? "Synapse (2D)"],
              ] as [GraphSettings["layout"], string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`graph-chip${
                  settings.layout === key ? " graph-chip--active" : ""
                }`}
                aria-pressed={settings.layout === key}
                onClick={() => onChange({ layout: key })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="graph-field">
          <span className="graph-field__label">
            {t.gr_skin ?? "Color mode"}
          </span>
          <div className="graph-chips">
            {(
              [
                ["auto", t.gr_skin_auto ?? "App theme"],
                ["black", t.gr_skin_black ?? "Black"],
                ["white", t.gr_skin_white ?? "White"],
                ["galaxy", t.gr_skin_galaxy ?? "Galaxy"],
              ] as [GraphSkinKey, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`graph-chip${
                  settings.skin === key ? " graph-chip--active" : ""
                }`}
                aria-pressed={settings.skin === key}
                onClick={() => onChange({ skin: key })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Toggle
          label={t.gr_galaxies ?? "Folder galaxies"}
          hint={
            t.gr_galaxies_hint ??
            "Split the vault into one slowly rotating galaxy per folder"
          }
          value={settings.folderGalaxies}
          onChange={(v) => onChange({ folderGalaxies: v })}
        />
        <div className="graph-field">
          <span className="graph-field__label">
            {t.gr_node_color ?? "Node colour"}
          </span>
          <div className="graph-chips">
            {(
              [
                ["community", t.gr_node_color_community ?? "By folder"],
                ["white", t.gr_node_color_white ?? "White"],
                ["black", t.gr_node_color_black ?? "Black"],
                ["auto", t.gr_node_color_auto ?? "Auto"],
              ] as [GraphSettings["nodeColor"], string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`graph-chip${
                  settings.nodeColor === key ? " graph-chip--active" : ""
                }`}
                aria-pressed={settings.nodeColor === key}
                onClick={() => onChange({ nodeColor: key })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Slider
          label={t.gr_color_depth ?? "Colour depth"}
          value={settings.nodeColorDepth}
          min={0.4}
          max={2.4}
          step={0.1}
          onChange={(v) => onChange({ nodeColorDepth: v })}
        />
        <div className="graph-field">
          <span className="graph-field__label">
            {t.gr_edge_tint ?? "Link colour"}
          </span>
          <div className="graph-chips">
            {(
              [
                ["grey", t.gr_edge_tint_grey ?? "Grey"],
                ["community", t.gr_edge_tint_community ?? "Community webs"],
              ] as [GraphSettings["edgeTint"], string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`graph-chip${
                  settings.edgeTint === key ? " graph-chip--active" : ""
                }`}
                aria-pressed={settings.edgeTint === key}
                onClick={() => onChange({ edgeTint: key })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
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
        <Slider
          label={t.gr_text_fade ?? "Text fade threshold"}
          value={settings.textFadeThreshold}
          min={0.1}
          max={3}
          step={0.05}
          onChange={(v) => onChange({ textFadeThreshold: v })}
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
        <Toggle
          label={t.gr_motion ?? "Ambient motion"}
          hint={t.gr_motion_hint ?? "Auto-rotate, pulses, breathing"}
          value={settings.ambientMotion}
          onChange={(v) => onChange({ ambientMotion: v })}
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
      </Section>

      <Section
        title={t.gr_forces ?? "Forces"}
        open={openSections.forces}
        onToggle={() => toggle("forces")}
      >
        <div className="graph-field">
          <span className="graph-field__label">{t.gr_preset ?? "Layout"}</span>
          <div className="graph-chips">
            {(
              [
                ["galaxy", t.gr_preset_galaxy ?? "Galaxy"],
                ["loose", t.gr_preset_loose ?? "Loose web"],
                ["dense", t.gr_preset_dense ?? "Dense"],
              ] as [LayoutPresetKey, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`graph-chip${
                  matchPreset(settings) === key ? " graph-chip--active" : ""
                }`}
                onClick={() => onChange({ ...LAYOUT_PRESETS[key] })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
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
    </aside>
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
