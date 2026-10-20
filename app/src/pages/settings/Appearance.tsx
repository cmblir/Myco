// Settings > Appearance — theme, mascot, and the three
// surfaces outside the main window (tray, notch, spotlight).

import { lazy, Suspense, useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../../lib/icons";
import type { IconName } from "../../lib/icons";
import { STRINGS, type Strings } from "../../lib/i18n";
import type { Myco3DSkin } from "../../lib/myco3d";
import { useUIStore } from "../../stores/uiStore";
import type { Theme } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ipc } from "../../lib/ipc";
import type { SpotlightStatus } from "../../lib/ipc";
import MascotClip from "../../components/MascotClip";
import { SettingsCard } from "../../components/SettingsCard";
import { Segment } from "../../components/ui";
import type { TextSize } from "../../lib/textSize";
import { accelFromEvent, formatAccel } from "../../lib/shortcutAccel";
import "../../styles/notch-toggle.css";

// three.js and the model load only when the Appearance tab opens. A chunk that
// fails to load says so in the card instead of taking the page down.
const Myco3D = lazy(() =>
  import("../../components/Myco3D")
    .then((m) => ({ default: m.Myco3D }))
    .catch((e: unknown) => {
      console.error("[myco3d] chunk failed to load", e);
      return { default: Myco3DUnavailable };
    }),
);

// The card's default view: the turntable videos, a small chunk of its own.
const MycoSpin = lazy(() =>
  import("../../components/MycoSpin")
    .then((m) => ({ default: m.MycoSpin }))
    .catch((e: unknown) => {
      console.error("[myco-spin] chunk failed to load", e);
      return { default: Myco3DUnavailable };
    }),
);

function Myco3DUnavailable(): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  return (
    <p className="myco3d-note" role="status">
      {STRINGS[lang].myco3d_error}
    </p>
  );
}

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
      <RoamToggle t={t} />
      <Myco3DCard t={t} />
    </div>
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

// myco out of the notch while long work runs (lib/roamTrigger). It roams as
// the mascot, so with the mascot off there is nothing to switch.
function RoamToggle({ t }: { t: Strings }): JSX.Element {
  const mascotEnabled = useUIStore((s) => s.mascotEnabled);
  const mascotRoam = useUIStore((s) => s.mascotRoam);
  const setMascotRoam = useUIStore((s) => s.setMascotRoam);
  return (
    // The checkbox shows the value; the corner chip would sit on top of it.
    <SettingsCard
      id="appearance_roam"
      className="card"
      style={{ padding: "14px 16px" }}
      hideValue
    >
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          cursor: mascotEnabled ? "pointer" : "default",
          opacity: mascotEnabled ? 1 : 0.6,
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 500, display: "block" }}>{t.s_roam}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {t.s_roam_hint}
          </span>
        </span>
        <input
          type="checkbox"
          checked={mascotEnabled && mascotRoam}
          disabled={!mascotEnabled}
          onChange={(e) => setMascotRoam(e.target.checked)}
        />
      </label>
    </SettingsCard>
  );
}

// The myco to turn around, black or white: the turntable video by default,
// the procedural model as the other view (specs 2026-10-04-myco-spin.md and
// -myco-3d.md). A viewer, not a setting, so neither choice is stored.
function Myco3DCard({ t }: { t: Strings }): JSX.Element {
  const [skin, setSkin] = useState<Myco3DSkin>("black");
  const [view, setView] = useState<"video" | "model">("video");
  return (
    <SettingsCard
      id="appearance_myco3d"
      className="card"
      style={{ padding: "14px 16px" }}
      hideValue
    >
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ fontWeight: 500 }}>{t.s_myco3d}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
            {t.s_myco3d_hint}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Segment<"video" | "model">
            label={t.s_myco3d_view}
            value={view}
            options={[
              { value: "video", label: t.s_myco3d_video },
              { value: "model", label: t.s_myco3d_model },
            ]}
            onChange={setView}
          />
          <Segment<Myco3DSkin>
            label={t.s_myco3d_skin}
            value={skin}
            options={[
              { value: "black", label: t.s_myco3d_black },
              { value: "white", label: t.s_myco3d_white },
            ]}
            onChange={setSkin}
          />
        </div>
      </div>
      <div className="myco3d-stage">
        <Suspense
          fallback={
            <p className="myco3d-note" role="status">
              {t.myco3d_loading}
            </p>
          }
        >
          {view === "video" ? <MycoSpin key={skin} skin={skin} /> : <Myco3D skin={skin} solid />}
        </Suspense>
      </div>
    </SettingsCard>
  );
}

// Text size (UX S22): follow the system by default; a custom step only
// overrides it. The sample line is .prose, so it moves exactly as notes do.
export function TextSizeSetting({ t }: { t: Strings }): JSX.Element {
  const textSize = useUIStore((s) => s.textSize);
  const setTextSize = useUIStore((s) => s.setTextSize);
  const custom = textSize !== "system";
  return (
    <SettingsCard id="appearance_text_size" className="card" hideValue>
      <div className="col" style={{ gap: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t.s_text_size}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
            {t.s_text_size_desc}
          </div>
        </div>
        <Segment
          label={t.s_text_size}
          value={custom ? "custom" : "system"}
          options={[
            { value: "system", label: t.s_text_size_system },
            { value: "custom", label: t.s_text_size_custom },
          ]}
          onChange={(v) => setTextSize(v === "system" ? "system" : "medium")}
        />
        {custom ? (
          <Segment<TextSize>
            label={t.s_text_size_custom}
            value={textSize}
            options={[
              { value: "small", label: t.s_text_size_small },
              { value: "medium", label: t.s_text_size_medium },
              { value: "large", label: t.s_text_size_large },
            ]}
            onChange={setTextSize}
          />
        ) : null}
        <p className="prose" style={{ margin: 0 }}>
          {t.s_text_size_sample}
        </p>
      </div>
    </SettingsCard>
  );
}

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
          className="notch-settings-toggle"
          type="button"
          onClick={() => void update({ tray_resident: !enabled })}
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            border: 0,
            padding: 0,
            background: "transparent",
            position: "relative",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 10,
              left: 0,
              width: 44,
              height: 24,
              borderRadius: 12,
              border: "1px solid var(--line)",
              background: enabled ? "var(--ink)" : "var(--bg-soft)",
            }}
          />
          <span
            aria-hidden="true"
            className="notch-settings-toggle__thumb"
            style={{
              position: "absolute",
              top: 12,
              left: enabled ? 22 : 2,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: enabled ? "var(--bg)" : "var(--ink)",
            }}
          />
        </button>
      </div>
    </SettingsCard>
  );
}

// Menu-bar notch drop surface (macOS only — it is an NSPanel over the notch).
// The dedicated store action keeps native visibility and persistence together.
export function NotchToggle({ t }: { t: Strings }): JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings);
  const setNotchEnabled = useSettingsStore((s) => s.setNotchEnabled);
  const pending = useSettingsStore((s) => s.notchPending);
  const error = useSettingsStore((s) => s.notchError);
  const isMac =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || "");
  if (!settings || !isMac) return null;
  const enabled = settings.notch_enabled;
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
          className="notch-settings-toggle"
          type="button"
          disabled={pending}
          aria-busy={pending}
          onClick={() => void setNotchEnabled(!enabled)}
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            border: 0,
            padding: 0,
            background: "transparent",
            position: "relative",
            cursor: pending ? "wait" : "pointer",
            opacity: pending ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 10,
              left: 0,
              width: 44,
              height: 24,
              borderRadius: 12,
              border: "1px solid var(--line)",
              background: enabled ? "var(--ink)" : "var(--bg-soft)",
            }}
          />
          <span
            aria-hidden="true"
            className="notch-settings-toggle__thumb"
            style={{
              position: "absolute",
              top: 12,
              left: enabled ? 22 : 2,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: enabled ? "var(--bg)" : "var(--ink)",
            }}
          />
        </button>
      </div>
      {error && (
        <p role="alert" style={{ color: "var(--danger)", marginBottom: 0 }}>
          {error}
        </p>
      )}
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
