// PageSchedules (Feature 7) — manage recurring digest schedules. Lists
// schedules with last-run + a link to the latest digest, an add/edit form
// (title, kind, prompt/topic, cadence, output dir, enable + notify toggles),
// "Run now", and delete. Generation runs in-app via the shared LLM stack; a
// background timer (scheduleTimer) fires due schedules while the app is open.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import { useScheduleStore } from "../stores/scheduleStore";
import { ipc } from "../lib/ipc";
import type { Schedule, ScheduleKind } from "../lib/ipc";

const KINDS: ScheduleKind[] = ["query", "changed", "stale", "topic"];
const CADENCES = ["daily", "weekly:1", "monthly:1", "every:6h"];

function newSchedule(): Schedule {
  return {
    id: `sch-${Date.now().toString(36)}`,
    title: "",
    kind: "query",
    prompt: "",
    cadence: "daily",
    output_dir: "digests",
    provider: "anthropic-cli",
    model: "sonnet",
    notify: false,
    last_run: null,
    enabled: true,
  };
}

export default function PageSchedules({ t }: { t: Strings }): JSX.Element {
  const vaultPath = useVaultStore((s) => s.currentVault?.path);
  const schedules = useScheduleStore((s) => s.schedules);
  const runningId = useScheduleStore((s) => s.runningId);
  const error = useScheduleStore((s) => s.error);
  const lastDigestPath = useScheduleStore((s) => s.lastDigestPath);
  const load = useScheduleStore((s) => s.load);
  const upsert = useScheduleStore((s) => s.upsert);
  const remove = useScheduleStore((s) => s.remove);
  const runNow = useScheduleStore((s) => s.runNow);
  const setRoute = useUIStore((s) => s.setRoute);

  const [draft, setDraft] = useState<Schedule | null>(null);
  const [bgOn, setBgOn] = useState<Record<string, boolean>>({});
  const [bgMsg, setBgMsg] = useState<string | null>(null);

  useEffect(() => {
    if (vaultPath) void load(vaultPath);
  }, [vaultPath, load]);

  async function toggleBackground(s: Schedule): Promise<void> {
    if (!vaultPath) return;
    const next = !bgOn[s.id];
    try {
      const msg = await ipc.installBackgroundSchedule(vaultPath, s.id, next);
      setBgOn((m) => ({ ...m, [s.id]: next }));
      setBgMsg(msg);
    } catch (err) {
      setBgMsg(String(err));
    }
  }

  async function save(): Promise<void> {
    if (!vaultPath || !draft || !draft.title.trim()) return;
    await upsert(vaultPath, draft);
    setDraft(null);
  }

  return (
    <div className="workspace">
      <header className="page-head">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="page-eyebrow">{t.nav_tools}</div>
            <h1 className="page-title">{t.sc_title ?? "Schedules"}</h1>
          </div>
          <button className="btn btn-primary" onClick={() => setDraft(newSchedule())}>
            <Icon name="plus" size={13} /> {t.sc_new ?? "New schedule"}
          </button>
        </div>
        <p className="page-lede">{t.sc_lede ?? "Recurring digests written into your vault while the app is open."}</p>
      </header>

      {error ? <p style={{ color: "#dc2626", fontSize: 13 }}>{error}</p> : null}
      {bgMsg ? (
        <p className="muted schedule-bgmsg" style={{ fontSize: 12.5 }}>{bgMsg}</p>
      ) : null}

      {draft ? (
        <ScheduleForm
          t={t}
          draft={draft}
          onChange={setDraft}
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
        />
      ) : null}

      <div className="col" style={{ gap: 10, marginTop: 16 }}>
        {schedules.length === 0 && !draft ? (
          <p className="muted" style={{ fontSize: 13 }}>{t.sc_empty ?? "No schedules yet."}</p>
        ) : null}
        {schedules.map((s) => (
          <div key={s.id} className="card schedule-row" style={{ padding: 16 }}>
            <div className="row" style={{ gap: 10 }}>
              <span className={"schedule-dot" + (s.enabled ? " on" : "")} />
              <b style={{ flex: 1 }}>{s.title}</b>
              <span className="schedule-tag">{s.kind}</span>
              <span className="muted" style={{ fontSize: 12 }}>{s.cadence}</span>
            </div>
            <div className="row" style={{ gap: 10, marginTop: 8, flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: 12 }}>
                {s.last_run
                  ? (t.sc_last_run ?? "last run {t}").replace(
                      "{t}",
                      new Date(s.last_run * 1000).toLocaleString(),
                    )
                  : (t.sc_never ?? "never run")}
              </span>
              <div className="row" style={{ gap: 6, marginLeft: "auto" }}>
                <button
                  className="btn btn-primary schedule-run"
                  disabled={!!runningId || !vaultPath}
                  onClick={() => vaultPath && void runNow(vaultPath, s)}
                >
                  {runningId === s.id ? (t.sc_running ?? "Running…") : (t.sc_run_now ?? "Run now")}
                </button>
                <button
                  className="btn btn-ghost schedule-bg"
                  onClick={() => void toggleBackground(s)}
                  title={t.sc_bg_hint ?? "Run this schedule even when the app is closed (macOS launchd)"}
                >
                  {bgOn[s.id]
                    ? (t.sc_bg_remove ?? "Remove background")
                    : (t.sc_bg_install ?? "Run in background")}
                </button>
                <button className="btn btn-ghost" onClick={() => setDraft(s)}>
                  {t.sc_edit ?? "Edit"}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => vaultPath && void remove(vaultPath, s.id)}
                >
                  {t.dlg_delete ?? "Delete"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {lastDigestPath ? (
        <div className="card" style={{ marginTop: 16, padding: 14 }}>
          <div className="row" style={{ gap: 8 }}>
            <Icon name="check" size={15} />
            <span style={{ fontSize: 13 }}>{t.sc_done ?? "Digest written."}</span>
            <button
              className="btn btn-ghost"
              style={{ marginLeft: "auto", fontSize: 12.5 }}
              onClick={() => setRoute(`page:${lastDigestPath}`)}
            >
              {t.sc_open ?? "Open digest"} →
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ScheduleForm({
  t,
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  t: Strings;
  draft: Schedule;
  onChange: (s: Schedule) => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  const set = (patch: Partial<Schedule>): void => onChange({ ...draft, ...patch });
  return (
    <div className="card schedule-form" style={{ padding: 16, marginTop: 8 }}>
      <div className="col" style={{ gap: 10 }}>
        <input
          className="input schedule-title"
          placeholder={t.sc_f_title ?? "Title (e.g. Weekly review)"}
          value={draft.title}
          onChange={(e) => set({ title: e.target.value })}
        />
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <label className="muted" style={{ fontSize: 12.5 }}>{t.sc_f_kind ?? "Kind"}</label>
          <select
            className="input schedule-kind"
            value={draft.kind}
            onChange={(e) => set({ kind: e.target.value as ScheduleKind })}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <label className="muted" style={{ fontSize: 12.5 }}>{t.sc_f_cadence ?? "Cadence"}</label>
          <select
            className="input schedule-cadence"
            value={draft.cadence}
            onChange={(e) => set({ cadence: e.target.value })}
          >
            {CADENCES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        {draft.kind === "query" || draft.kind === "topic" ? (
          <input
            className="input schedule-prompt"
            placeholder={
              draft.kind === "topic"
                ? (t.sc_f_topic ?? "Topic to track")
                : (t.sc_f_prompt ?? "Prompt to run over the wiki")
            }
            value={draft.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
          />
        ) : null}
        <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />{" "}
            {t.sc_f_enabled ?? "Enabled"}
          </label>
          <label style={{ fontSize: 12.5 }} title={t.sc_f_notify_hint ?? "Native notification when a run finishes (opt-in)"}>
            <input
              type="checkbox"
              checked={draft.notify}
              onChange={(e) => set({ notify: e.target.checked })}
            />{" "}
            {t.sc_f_notify ?? "Notify"}
          </label>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn btn-primary schedule-save"
            disabled={!draft.title.trim()}
            onClick={onSave}
          >
            {t.sc_f_save ?? "Save"}
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>
            {t.sc_f_cancel ?? "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
