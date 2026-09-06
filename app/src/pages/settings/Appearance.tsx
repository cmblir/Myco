// Settings > Appearance — theme, overview skin, mascot, and the three
// surfaces outside the main window (tray, notch, spotlight).

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../../lib/icons";
import type { IconName } from "../../lib/icons";
import type { Strings } from "../../lib/i18n";
import { useUIStore } from "../../stores/uiStore";
import type { Theme } from "../../stores/uiStore";
import {
  createOverviewEngine,
  OVERVIEW_THEMES,
  type OverviewThemeKey,
} from "../../lib/overviewThemes";
import { useSettingsStore } from "../../stores/settingsStore";
import { ipc } from "../../lib/ipc";
import type { SpotlightStatus } from "../../lib/ipc";
import MascotClip from "../../components/MascotClip";
import { SettingsCard } from "../../components/SettingsCard";
import { accelFromEvent, formatAccel } from "../../lib/shortcutAccel";

export function SettingsAppearance({
  t,
  theme,
  setTheme,
}: {
  t: Strings;
  theme: Theme;
  setTheme: (th: Theme) => void;
}): JSX.Element {
  const opts: { id: Theme; label: string; icon: IconName }[] = [
    { id: "light", label: t.s_appearance_light, icon: "sun" },
    { id: "dark", label: t.s_appearance_dark, icon: "moon" },
    { id: "system", label: t.s_appearance_system, icon: "cloud" },
  ];
  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
          {t.s_appearance}
        </h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.s_appearance_lede}
        </p>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
        }}
      >
        {opts.map((o) => {
          const sel = theme === o.id;
          const isDark = o.id === "dark";
          return (
            <button
              key={o.id}
              className="card"
              style={{
                padding: 0,
                overflow: "hidden",
                textAlign: "left",
                cursor: "pointer",
                border: `1px solid ${sel ? "var(--ink)" : "var(--line)"}`,
              }}
              onClick={() => setTheme(o.id)}
            >
              <div
                style={{
                  height: 92,
                  background: isDark
                    ? "#191919"
                    : "linear-gradient(135deg, #fbfbfa, #efeeec)",
                  padding: 12,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    width: "70%",
                    height: 8,
                    background: isDark ? "#2c2c2c" : "#e9e8e4",
                    borderRadius: 4,
                  }}
                />
                <div
                  style={{
                    width: 40,
                    height: 8,
                    background: isDark ? "#ededec" : "#181715",
                    borderRadius: 4,
                    marginTop: 14,
                  }}
                />
                <div style={{ position: "absolute", top: 10, right: 10 }}>
                  <Icon name={o.icon} size={16} />
                </div>
              </div>
              <div
                style={{
                  padding: "10px 14px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontWeight: 500 }}>{o.label}</span>
              </div>
            </button>
          );
        })}
      </div>
      <MascotToggle t={t} />
    </div>
  );
}

// MYCO master switch — the full opt-out research says any character presence
// needs. Off swaps every MascotClip for the static logo.
// A live preview, not a static thumbnail: the choice is about MOTION, so a
// frozen image cannot represent it. Each swatch runs its own engine and stops
// as soon as it scrolls out of view.
function ThemeSwatch({
  themeKey,
  label,
  selected,
  onPick,
}: {
  themeKey: OverviewThemeKey;
  label: string;
  selected: boolean;
  onPick: () => void;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const engine = createOverviewEngine(themeKey, { count: 14, speed: 0.6 });
    let raf = 0;
    let last = 0;
    let visible = true;
    let stopped = false;

    const fit = (): { w: number; h: number } => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = cv.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (cv.width !== w * dpr || cv.height !== h * dpr) {
        cv.width = w * dpr;
        cv.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    };
    const draw = (dt: number): void => {
      const { w, h } = fit();
      if (!engine.trails) ctx.clearRect(0, 0, w, h);
      engine.step(ctx, w, h, dt);
    };
    const frame = (ts: number): void => {
      if (stopped) return;
      const dt = last ? Math.min((ts - last) / 1000, 0.05) : 0.016;
      last = ts;
      draw(dt);
      raf = requestAnimationFrame(frame);
    };
    draw(0.016);
    // Ten swatches all animating off-screen is ten idle loops for nothing.
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible && !reduced && !raf && !stopped) {
        last = 0;
        raf = requestAnimationFrame(frame);
      } else if (!visible && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    });
    io.observe(cv);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [themeKey]);

  return (
    <button
      type="button"
      className={`ov-theme-sw${selected ? " is-on" : ""}`}
      aria-pressed={selected}
      onClick={onPick}
    >
      <canvas ref={ref} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

// MYCO master switch — the full opt-out research says any character presence
// needs. Off swaps every MascotClip for the static logo.
function MascotToggle({ t }: { t: Strings }): JSX.Element {
  const mascotEnabled = useUIStore((s) => s.mascotEnabled);
  const setMascotEnabled = useUIStore((s) => s.setMascotEnabled);
  return (
    <label
      className="card"
      style={{
        padding: "14px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        cursor: "pointer",
      }}
    >
      <MascotClip clip="idle" size={44} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 500, display: "block" }}>
          {t.s_mascot ?? "Show MYCO, the mascot"}
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          {t.s_mascot_hint ??
            "Loaders, empty states and the About page. Off = static logo."}
        </span>
      </span>
      <input
        type="checkbox"
        checked={mascotEnabled}
        onChange={(e) => setMascotEnabled(e.target.checked)}
      />
    </label>
  );
}

// The Overview page's living background. Options are named after the graph's
// layouts on purpose — one vocabulary, two expressions — but the setting is
// deliberately NOT linked to the graph's own layout.
export function SettingsOverviewTheme({ t }: { t: Strings }): JSX.Element {
  const overviewTheme = useUIStore((s) => s.overviewTheme);
  const setOverviewTheme = useUIStore((s) => s.setOverviewTheme);

  const label = (k: OverviewThemeKey): string => {
    const map: Record<OverviewThemeKey, string | undefined> = {
      galaxy: t.gr_layout_galaxy_s,
      mycelium: t.ov_theme_mycelium,
      spiral: t.gr_layout_spiral,
      synapse3d: t.gr_layout_synapse3d_s,
      celestial: t.gr_layout_celestial,
      radial: t.gr_layout_radial,
      walrus: t.gr_layout_walrus,
      strata: t.gr_layout_strata,
      semantic: t.gr_layout_semantic,
      atlas: t.gr_layout_atlas_s,
    };
    return map[k] ?? k;
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
          {t.s_ov_theme ?? "Overview background"}
        </h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.s_ov_theme_lede ??
            "The living background on the Overview page. Named after the graph's layouts; not linked to them."}
        </p>
      </div>
      <div className="ov-theme-grid">
        {OVERVIEW_THEMES.map((k) => (
          <ThemeSwatch
            key={k}
            themeKey={k}
            label={label(k)}
            selected={overviewTheme === k}
            onPick={() => setOverviewTheme(k)}
          />
        ))}
      </div>
    </div>
  );
}

// A live preview, not a static thumbnail: the choice is about MOTION, so a
// frozen image cannot represent it. Each swatch runs its own engine and stops
// as soon as it scrolls out of view.
// Resident mode: closing the window hides it and myco stays in the menu bar
// tray. Lives in the Appearance tab — the app has no dedicated "general" tab,
// and this governs window behavior. Default OFF (close quits, as always).
export function TrayResidentToggle({ t }: { t: Strings }): JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  if (!settings) return null;
  const enabled = settings.tray_resident;
  return (
    <SettingsCard id="appearance_tray" className="card">
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div style={{ paddingRight: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {t.s_tray_resident_title ?? "Keep running in the menu bar"}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
            {t.s_tray_resident_desc ??
              "Closing the window hides it instead of quitting — myco stays in the menu bar and background work keeps going. Quit from the tray menu."}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={t.s_tray_resident_title ?? "Keep running in the menu bar"}
          data-testid="tray-resident-toggle"
          onClick={() => void update({ tray_resident: !enabled })}
          style={{
            width: 44,
            height: 24,
            borderRadius: 12,
            border: "1px solid var(--line)",
            background: enabled ? "var(--ink)" : "var(--bg-soft)",
            position: "relative",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: enabled ? 22 : 2,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: enabled ? "var(--bg)" : "var(--ink)",
              transition: "left 150ms ease",
            }}
          />
        </button>
      </div>
    </SettingsCard>
  );
}

// Menu-bar notch drop surface (macOS only — it is an NSPanel over the notch).
// The flag persists through the settings store like every toggle; the extra
// update_notch_enabled call applies it live (shows/hides the window).
// Menu-bar notch drop surface (macOS only — it is an NSPanel over the notch).
// The flag persists through the settings store like every toggle; the extra
// update_notch_enabled call applies it live (shows/hides the window).
export function NotchToggle({ t }: { t: Strings }): JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings);
  const isMac =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || "");
  if (!settings || !isMac) return null;
  const enabled = settings.notch_enabled;
  const flip = (): void => {
    // ONE persister: update_notch_enabled writes the flag itself (and creates
    // or destroys the window). Routing the same flag through set_settings too
    // made two concurrent writers of the settings file — last-wins could undo
    // either side. The store only mirrors the result optimistically.
    const next = !enabled;
    useSettingsStore.setState((st) =>
      st.settings ? { settings: { ...st.settings, notch_enabled: next } } : st,
    );
    void ipc.updateNotchEnabled(next).catch(() => {
      /* plain-browser dev: no Tauri backend */
    });
  };
  return (
    <SettingsCard id="appearance_notch" className="card">
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div style={{ paddingRight: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {t.s_notch_title ?? "Notch drop surface"}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
            {t.s_notch_desc ??
              "Show a drop target under the menu-bar notch — files dropped there land in _inbox for ingest to read."}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={t.s_notch_title ?? "Notch drop surface"}
          data-testid="notch-toggle"
          onClick={flip}
          style={{
            width: 44,
            height: 24,
            borderRadius: 12,
            border: "1px solid var(--line)",
            background: enabled ? "var(--ink)" : "var(--bg-soft)",
            position: "relative",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: enabled ? 22 : 2,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: enabled ? "var(--bg)" : "var(--ink)",
              transition: "left 150ms ease",
            }}
          />
        </button>
      </div>
    </SettingsCard>
  );
}

// Global "ask from anywhere" shortcut. The row shows what the OS actually gave
// us, not what we asked for: a combination another app already owns fails to
// register, and hiding that would leave a key that silently does nothing.
// Global "ask from anywhere" shortcut. The row shows what the OS actually gave
// us, not what we asked for: a combination another app already owns fails to
// register, and hiding that would leave a key that silently does nothing.
export function SpotlightShortcutRow({ t }: { t: Strings }): JSX.Element {
  const [status, setStatus] = useState<SpotlightStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const isMac =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || "");

  useEffect(() => {
    void ipc
      .spotlightStatus()
      .then(setStatus)
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
  }, []);

  const send = (accel: string): void => {
    setRecording(false);
    void ipc
      .setSpotlightShortcut(accel)
      .then(setStatus)
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
  };

  // While recording, the next full combination wins. Capture phase so the
  // keystroke never also reaches the app underneath (e.g. the command bar).
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        setRecording(false);
        return;
      }
      const accel = accelFromEvent(e);
      if (!accel) return; // still holding modifiers, or no modifier at all
      e.preventDefault();
      send(accel);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const shortcut = status?.shortcut ?? "";
  const shown = formatAccel(shortcut, isMac);
  const state = ((): { text: string; bad: boolean } => {
    if (!shortcut) {
      return {
        text: t.s_spot_off ?? "Off — no global shortcut is registered.",
        bad: false,
      };
    }
    if (status?.registered) {
      return {
        text: (t.s_spot_ok ?? "Registered — press {k} anywhere.").replace(
          "{k}",
          shown,
        ),
        bad: false,
      };
    }
    const base = (
      t.s_spot_failed ??
      "{k} could NOT be registered — another app is most likely already using it. Pick a different combination."
    ).replace("{k}", shown);
    // The OS/parser message verbatim: it is the only detail we actually have.
    return {
      text: status?.error ? `${base} (${status.error})` : base,
      bad: true,
    };
  })();

  // The description is long enough that a title-left / control-right row always
  // wraps, so the controls sit under it deliberately instead of by accident.
  return (
    <SettingsCard id="appearance_spot" className="card">
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {t.s_spot_title ?? "Ask from anywhere"}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
        {t.s_spot_desc ??
          "A global shortcut opens a small ask window over whatever you are doing."}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button
          className="btn"
          data-testid="spotlight-record"
          onClick={() => setRecording((v) => !v)}
        >
          {recording
            ? (t.s_spot_recording ?? "Press the new combination…")
            : shown || (t.s_spot_record ?? "Change shortcut")}
        </button>
        {shortcut ? (
          <button className="btn" onClick={() => send("")}>
            {t.s_spot_disable ?? "Turn off"}
          </button>
        ) : null}
      </div>
      <div
        className="muted"
        style={{
          fontSize: 12,
          marginTop: 8,
          color: state.bad ? "var(--danger, #c0392b)" : undefined,
        }}
        role={state.bad ? "alert" : undefined}
      >
        {state.text}
      </div>
    </SettingsCard>
  );
}

// Monthly spend guard (OPS-03): a configurable USD threshold plus a read-only
// view of the current month's estimated cost and per-model breakdown. Budget
// state is localStorage-backed and synchronous (see lib/budget.ts).
