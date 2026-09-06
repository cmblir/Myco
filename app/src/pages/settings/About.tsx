// Settings > About — version, updates, the settings bundle and crash reports.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../../lib/i18n";
import { getVersion } from "@tauri-apps/api/app";
import { ipc } from "../../lib/ipc";
import type { PanicEntry } from "../../lib/ipc";
import { formatCrashReport } from "../../lib/crashReport";
import MascotClip from "../../components/MascotClip";
import { useUpdateStore } from "../../stores/updateStore";
import type { UpdateState } from "../../stores/updateStore";
import {
  applySettingsBundle,
  buildSettingsBundle,
  pendingImportUndo,
  sectionKeys,
  undoSettingsImport,
  validateSettingsBundle,
  type ValidatedSettingsBundle,
} from "../../lib/settingsBundle";

export function SettingsAbout({ t }: { t: Strings }): JSX.Element {
  // Read the version from the bundle rather than hardcoding it: the literal
  // that used to live here said 0.2.2 long after every manifest said 0.3.0,
  // because no release step ever touched this file. Falls back to the manifest
  // version in a plain browser (dev mock / screenshots), where there is no
  // Tauri host to ask.
  const [appVersion, setAppVersion] = useState(__PACKAGE_VERSION__);
  useEffect(() => {
    let alive = true;
    void getVersion()
      .then((v) => {
        if (alive) setAppVersion(v);
      })
      .catch(() => {
        // Not running inside Tauri; the fallback above stands.
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="col" style={{ gap: 20 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{t.s_about}</h2>
      <div
        className="card"
        style={{
          padding: 24,
          display: "flex",
          gap: 18,
          alignItems: "center",
          // Mobile: let the text column wrap under the mascot instead of
          // pushing the card past the viewport.
          flexWrap: "wrap",
        }}
      >
        {/* MYCO idle loop (transparent) — the living version of the logo. */}
        <MascotClip clip="idle" size={96} />
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div
            style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}
          >
            myco
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            v{appVersion} · build {__BUILD_DATE__}
          </div>
          <p
            style={{
              fontSize: 14,
              marginTop: 8,
              color: "var(--ink-2)",
              maxWidth: 520,
            }}
          >
            {t.s_about_built}
          </p>
        </div>
      </div>
      <UpdateCheck t={t} />
      <SettingsBackup t={t} appVersion={appVersion} />
      <CrashReport t={t} appVersion={appVersion} />
    </div>
  );
}

// Settings/looks export+import: one JSON file bundling the portable
// preferences (providers/models, automation toggles, appearance, graph
// looks, saved views, dismissed suggestions) so moving to a new machine does
// not mean re-clicking through every tab. API keys (keychain), the vault
// path, the MCP token and window geometry never leave this machine.
// Settings/looks export+import: one JSON file bundling the portable
// preferences (providers/models, automation toggles, appearance, graph
// looks, saved views, dismissed suggestions) so moving to a new machine does
// not mean re-clicking through every tab. API keys (keychain), the vault
// path, the MCP token and window geometry never leave this machine.
function SettingsBackup({
  t,
  appVersion,
}: {
  t: Strings;
  appVersion: string;
}): JSX.Element {
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // A validated import waiting for the user to confirm the overwrite, and
  // the sections it would replace (named in the confirm text).
  const [pending, setPending] = useState<{
    data: ValidatedSettingsBundle;
    sections: string[];
  } | null>(null);
  // Mirrors the module-level snapshot (settingsBundle.ts) into render state.
  const [undoable, setUndoable] = useState<string[] | null>(() =>
    pendingImportUndo(),
  );

  async function doExport(): Promise<void> {
    setBusy("export");
    setMessage(null);
    try {
      const path = await ipc.pickSettingsExportPath();
      if (!path) return;
      const current = await ipc.getSettings();
      const bundle = buildSettingsBundle(appVersion, current);
      await ipc.writeSettingsExport(path, JSON.stringify(bundle, null, 2));
      setMessage(t.s_backup_exported ?? "Settings exported.");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Step 1 of 2: read + validate, then hand the user a named confirmation.
  // Nothing is written here — an import replaces settings the user spent
  // time on, so it does not happen on the same click that picks the file.
  async function doImport(): Promise<void> {
    setBusy("import");
    setMessage(null);
    setPending(null);
    try {
      const path = await ipc.pickSettingsImportPath();
      if (!path) return;
      const raw = await ipc.readSettingsImport(path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        setMessage(t.s_backup_bad_json ?? "That file isn't valid JSON.");
        return;
      }
      const current = await ipc.getSettings();
      const result = validateSettingsBundle(parsed, current);
      if (!result.ok) {
        setMessage(
          (t.s_backup_import_failed ?? "Import failed: {error}").replace(
            "{error}",
            result.error,
          ),
        );
        return;
      }
      // Section names reach the user in the app's own language: the confirm
      // step is naming what is about to be overwritten.
      setPending({
        data: result.data,
        sections: sectionKeys(result.data.present).map(
          (k) =>
            (t as unknown as Record<string, string>)[`s_backup_section_${k}`] ??
            k,
        ),
      });
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Step 2 of 2: the confirmed overwrite. applySettingsBundle snapshots the
  // current state first, which is what makes the Undo button below real.
  async function confirmImport(): Promise<void> {
    if (!pending) return;
    setBusy("import");
    try {
      const current = await ipc.getSettings();
      const sections = await applySettingsBundle(
        pending.data,
        current,
        ipc.setSettings,
      );
      setPending(null);
      setUndoable(pendingImportUndo());
      setMessage(
        (t.s_backup_imported ?? "Restored: {sections}").replace(
          "{sections}",
          sections.join(", "),
        ),
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function undoImport(): Promise<void> {
    setBusy("import");
    try {
      const current = await ipc.getSettings();
      const restored = await undoSettingsImport(current, ipc.setSettings);
      setUndoable(pendingImportUndo());
      if (restored) {
        setMessage(
          (t.s_backup_undone ?? "Put back: {sections}").replace(
            "{sections}",
            restored.join(", "),
          ),
        );
      }
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card col" style={{ padding: 20, gap: 12 }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>
        {t.s_backup_title ?? "Settings & looks"}
      </div>
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        {t.s_backup_hint ??
          "Providers, automation, appearance and graph looks travel with this file. API keys, the vault path and this device's identity never do."}
      </p>
      <div className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void doExport()}
        >
          {busy === "export"
            ? (t.s_backup_busy ?? "Working…")
            : (t.s_backup_export ?? "Export…")}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void doImport()}
          data-testid="settings-import-btn"
        >
          {busy === "import"
            ? (t.s_backup_busy ?? "Working…")
            : (t.s_backup_import ?? "Import…")}
        </button>
        {undoable && !pending ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void undoImport()}
            data-testid="settings-import-undo-btn"
          >
            {t.s_backup_undo ?? "Undo import"}
          </button>
        ) : null}
      </div>
      {undoable && !pending ? (
        <span className="muted" style={{ fontSize: 12 }}>
          {t.s_backup_undo_hint ??
            "Your previous settings are held in memory until you quit myco."}
        </span>
      ) : null}
      {pending ? (
        <div
          className="col"
          role="group"
          aria-label={t.s_backup_confirm_title ?? "Replace these settings?"}
          data-testid="settings-import-confirm"
          style={{
            gap: 8,
            padding: 12,
            borderRadius: 8,
            border: "1px solid var(--line)",
            background: "var(--bg-2)",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {t.s_backup_confirm_title ?? "Replace these settings?"}
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
            {/* A file that parses but carries no section this version knows
                would replace nothing — say that, rather than printing an
                empty list into "This file replaces: ." */}
            {pending.sections.length === 0
              ? (t.s_backup_confirm_none ??
                "This file carries no settings this version can restore — importing it would change nothing.")
              : (
                  t.s_backup_confirm_body ??
                  "This file replaces: {sections}. Everything it replaces is kept in memory, so you can undo it until you quit myco."
                ).replace("{sections}", pending.sections.join(", "))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => void confirmImport()}
              data-testid="settings-import-confirm-btn"
            >
              {t.s_backup_confirm_apply ?? "Replace"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => setPending(null)}
            >
              {t.s_backup_confirm_cancel ?? "Cancel"}
            </button>
          </div>
        </div>
      ) : null}
      {message ? (
        <span className="muted" style={{ fontSize: 12 }} role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}

// Last panic (if any) plus a one-click GitHub-issue-shaped bug report on the
// clipboard. Hidden entirely when the log has never had an entry — this is
// not a feature most users will ever see. Never sends anything anywhere; the
// only actions are "copy to clipboard" and "delete the local log file".
// Last panic (if any) plus a one-click GitHub-issue-shaped bug report on the
// clipboard. Hidden entirely when the log has never had an entry — this is
// not a feature most users will ever see. Never sends anything anywhere; the
// only actions are "copy to clipboard" and "delete the local log file".
function CrashReport({
  t,
  appVersion,
}: {
  t: Strings;
  appVersion: string;
}): JSX.Element | null {
  const [entry, setEntry] = useState<PanicEntry | null | undefined>(undefined); // undefined = loading
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    ipc
      .recentPanics(1)
      .then((rows) => {
        if (alive) setEntry(rows[0] ?? null);
      })
      .catch(() => {
        if (alive) setEntry(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!entry) return null;

  async function copyReport(): Promise<void> {
    if (!entry) return;
    const osVersion = await ipc.osVersion().catch(() => "unknown");
    const report = formatCrashReport({
      appVersion,
      osVersion,
      panicLine: entry.raw,
      note,
    });
    await navigator.clipboard.writeText(report);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function clearLog(): Promise<void> {
    setBusy(true);
    try {
      await ipc.clearPanicLog();
      setEntry(null);
    } finally {
      setBusy(false);
    }
  }

  const when = new Date(entry.unix_secs * 1000).toLocaleString();
  const at = (t.cr_at ?? "{time} at {location}")
    .replace("{time}", when)
    .replace("{location}", entry.location);

  return (
    <div className="card col" style={{ padding: 20, gap: 12 }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>
        {t.cr_last_crash ?? "Last crash"}
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        {at}
      </div>
      <div
        style={{
          fontSize: 13,
          fontFamily: "var(--font-mono, monospace)",
          // A Rust panic message can span lines (assert_eq!'s output, for
          // one) — without this, the browser default collapses every
          // newline into a space and it renders as one unreadable run-on.
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {entry.message}
      </div>
      <label className="col" style={{ gap: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {t.cr_note_label ?? "What were you doing? (optional)"}
        </span>
        <input
          type="text"
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t.cr_note_ph ?? "e.g. editing a page and hit save"}
        />
      </label>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn" onClick={() => void copyReport()}>
          {copied
            ? (t.cr_copied ?? "Copied")
            : (t.cr_copy ?? "Copy a bug report")}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void clearLog()}
        >
          {t.cr_clear ?? "Clear crash log"}
        </button>
      </div>
    </div>
  );
}

/** The status line under "Check for updates" — every state says something. */
/** The status line under "Check for updates" — every state says something. */
function updateStatusText(t: Strings, s: UpdateState): string {
  switch (s.status) {
    case "idle":
      return "";
    case "checking":
      return t.up_checking ?? "Checking…";
    case "current":
      return t.up_current ?? "myco is up to date";
    case "unconfigured":
      return t.up_unconfigured ?? "No update channel configured";
    case "unavailable":
      return t.up_unavailable ?? "No update channel for this platform yet";
    case "downloading":
      return (t.up_downloading ?? "Downloading myco {v}…").replace(
        "{v}",
        s.version ?? "",
      );
    case "ready":
      return `${(t.up_ready ?? "myco {v} is ready").replace("{v}", s.version ?? "")} — ${t.up_restart ?? "Restart myco to apply"}`;
    case "error":
      return s.error
        ? `${t.up_error ?? "Update check failed"}: ${s.error}`
        : (t.up_error ?? "Update check failed");
  }
}

// Manual update check. The download runs in the background and lands on the next
// launch, so there is deliberately no "install now" here — nothing this button
// does can close the app under the user.
// Manual update check. The download runs in the background and lands on the next
// launch, so there is deliberately no "install now" here — nothing this button
// does can close the app under the user.
function UpdateCheck({ t }: { t: Strings }): JSX.Element {
  const state = useUpdateStore();
  const busy = state.status === "checking" || state.status === "downloading";
  const status = updateStatusText(t, state);

  return (
    <div className="col" style={{ gap: 8 }}>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => void state.checkForUpdates()}
        style={{ alignSelf: "flex-start" }}
      >
        {t.up_check ?? "Check for updates"}
      </button>
      {status ? (
        <span className="muted" style={{ fontSize: 12 }} role="status">
          {status}
        </span>
      ) : null}
    </div>
  );
}

// Vaults myco already knows about, so switching is a click instead of
// re-navigating a folder dialog. The "change folder" control itself already
// lives in the account block above — this only adds the shortcut list, rather
// than a second way to do the same thing on the same screen.
