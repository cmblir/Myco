// Settings > 내 공간 > 정리 — run Tidy, and undo its last run (정리 기록).
// The run itself is the Tidy sheet (components/TidySheet.tsx); this card only
// opens it and reads `.myco/tidy/last.json` back.

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../../lib/i18n";
import { SettingsCard } from "../../components/SettingsCard";
import { Button } from "../../components/ui";
import { afterTidyWrite, tidyFs } from "../../stores/tidyActions";
import { useTidyStore } from "../../stores/tidyStore";
import { useUIStore } from "../../stores/uiStore";
import { flushPendingDrafts, useVaultStore } from "../../stores/vaultStore";
import { ipcTidyFs, lastTidy, undoTidy } from "../../lib/tidyRun";
import type { TidySnapshot, TidyUndo } from "../../lib/tidyRun";

type Last =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "run"; path: string; snapshot: TidySnapshot }
  | { kind: "error"; detail: string };

export function SettingsTidy({ t }: { t: Strings }): JSX.Element {
  const vault = useVaultStore((s) => s.currentVault?.path ?? null);
  const sheetOpen = useTidyStore((s) => s.open);
  const setOpen = useTidyStore((s) => s.setOpen);
  const lang = useUIStore((s) => s.lang);
  const [last, setLast] = useState<Last>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState<TidyUndo | null>(null);
  const [reload, setReload] = useState(0);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // Undo removes the 되돌리기 button that had focus; land a keyboard or screen
  // reader user on the result instead of <body>.
  useEffect(() => {
    if (undone) resultRef.current?.focus();
  }, [undone]);

  // Re-read whenever the sheet closes: it may just have written a run.
  useEffect(() => {
    if (!vault || sheetOpen) return;
    let cancelled = false;
    lastTidy(ipcTidyFs(vault)).then(
      (found) => {
        if (!cancelled) setLast(found ? { kind: "run", ...found } : { kind: "none" });
      },
      (e: unknown) => {
        if (!cancelled) setLast({ kind: "error", detail: String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [vault, sheetOpen, reload]);

  async function undo(path: string, snapshot: TidySnapshot): Promise<void> {
    if (!vault) return;
    setBusy(true);
    try {
      // Same steps as the sheet's own undo: an open page's pending draft is
      // written first (then undo sees it changed and leaves it), and the open
      // page is re-read after, so its editor adopts the restored text.
      await flushPendingDrafts();
      setUndone(await undoTidy(tidyFs(vault), path));
      await afterTidyWrite(vault, snapshot.files.map((f) => ({ from: f.to, to: f.path })));
    } catch (e) {
      setLast({ kind: "error", detail: String(e) });
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  }

  const num = new Intl.NumberFormat(lang);
  const when = (iso: string): string =>
    new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );

  return (
    <SettingsCard id="account_tidy" className="card col" style={{ gap: 10 }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{t.tidy_btn}</div>
      <div className="muted" style={{ fontSize: 13 }}>
        {t.tidy_s_desc}
      </div>
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Button onClick={() => setOpen(true)} disabled={!vault}>
          {t.tidy_s_run}
        </Button>
      </div>
      <div className="col" style={{ gap: 6 }} aria-live="polite">
        <span className="muted" style={{ fontSize: 12 }}>
          {t.tidy_s_history}
        </span>
        {last.kind === "loading" ? null : last.kind === "none" ? (
          <span style={{ fontSize: 13 }}>{t.tidy_s_none}</span>
        ) : last.kind === "error" ? (
          <span role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
            {t.tidy_error} — {last.detail}
          </span>
        ) : (
          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13 }}>
              {t.tidy_s_last
                .replace("{when}", when(last.snapshot.at))
                .replace("{n}", num.format(last.snapshot.files.length))}
              {last.snapshot.undone ? ` · ${t.tidy_s_last_undone}` : ""}
            </span>
            {last.snapshot.undone ? null : (
              <Button variant="quiet" disabled={busy} onClick={() => void undo(last.path, last.snapshot)}>
                {busy ? t.tidy_undoing : t.tidy_undo}
              </Button>
            )}
          </div>
        )}
        {undone ? (
          <div ref={resultRef} tabIndex={-1} role="status" style={{ fontSize: 13 }}>
            {t.tidy_undone.replace("{n}", num.format(undone.restored))}
            {undone.skipped.length ? (
              <>
                <div className="muted">{t.tidy_undo_skipped}</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {undone.skipped.map((p) => (
                    <li key={p} style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {p}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {undone.failed.length ? (
              <div role="alert" style={{ color: "var(--danger)" }}>
                {t.tidy_failed.replace("{n}", num.format(undone.failed.length))}{" "}
                {undone.failed.map((f) => f.path).join(", ")}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}
