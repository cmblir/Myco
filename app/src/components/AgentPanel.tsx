// Agent mode panel (Feature 4). Rendered on the Ask page when the Agent toggle
// is on. Runs the in-app tool-loop agent, streams a collapsible step trace, and
// renders the cited final answer. A task-agent preset picker loads/saves
// portable agents/<slug>.md presets; a write toggle offers (still per-call
// confirmed) vault mutations.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  useAgentStore,
  agentSupported,
  DEFAULT_AGENT_PROMPT,
} from "../stores/agentStore";
import {
  loadAgents,
  saveAgent,
  type TaskAgent,
} from "../lib/taskAgents";
import { promptText } from "../stores/dialogStore";
import type { AgentStep } from "../lib/agentLoop";
import Viewer from "./Viewer";
import { isComposingKey } from "../lib/ime";

export default function AgentPanel({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const fileTree = useVaultStore((s) => s.fileTree);
  const refreshTree = useVaultStore((s) => s.refreshTree);
  const resolveWikilink = useVaultStore((s) => s.resolveWikilink);
  const setRoute = useUIStore((s) => s.setRoute);
  const settings = useSettingsStore((s) => s.settings);

  const running = useAgentStore((s) => s.running);
  const steps = useAgentStore((s) => s.steps);
  const answer = useAgentStore((s) => s.answer);
  const error = useAgentStore((s) => s.error);
  const stoppedAtLimit = useAgentStore((s) => s.stoppedAtLimit);
  const question = useAgentStore((s) => s.question);
  const start = useAgentStore((s) => s.start);
  const cancel = useAgentStore((s) => s.cancel);

  const [q, setQ] = useState("");
  const [allowWrite, setAllowWrite] = useState(false);
  const [presets, setPresets] = useState<TaskAgent[]>([]);
  const [presetSlug, setPresetSlug] = useState<string>("");

  const provider = settings?.query_provider ?? "";
  const model = settings?.query_model ?? "";
  const supported = agentSupported(provider);

  // Load task-agent presets from the vault whenever its files change.
  useEffect(() => {
    void loadAgents(fileTree).then(setPresets);
  }, [fileTree]);

  const activePreset = useMemo(
    () => presets.find((p) => p.slug === presetSlug) ?? null,
    [presets, presetSlug],
  );

  async function run(): Promise<void> {
    const question = q.trim();
    if (!question || !currentVault || running) return;
    await start({
      provider,
      model,
      vaultPath: currentVault.path,
      question,
      systemPrompt: activePreset?.systemPrompt || DEFAULT_AGENT_PROMPT,
      allowWrite: activePreset ? activePreset.allowWrite : allowWrite,
    });
  }

  async function newPreset(): Promise<void> {
    if (!currentVault) return;
    const name = await promptText({
      title: t.ag_new_preset ?? "New task agent",
      message: t.ag_preset_name ?? "Name",
      placeholder: "contradiction finder",
    });
    if (!name) return;
    const prompt = await promptText({
      title: t.ag_preset_prompt ?? "System prompt",
      message: t.ag_preset_prompt_hint ?? "What should this agent do?",
      defaultValue: DEFAULT_AGENT_PROMPT,
    });
    if (!prompt) return;
    await saveAgent(currentVault.path, {
      name,
      model,
      tools: [],
      allowWrite,
      systemPrompt: prompt,
    });
    await refreshTree();
    setPresets(await loadAgents(useVaultStore.getState().fileTree));
  }

  const openByStem = (target: string): void => {
    const abs = resolveWikilink(target);
    if (abs) setRoute(`page:${abs}`);
  };

  return (
    <div className="agent-panel">
      <div className="card" style={{ padding: 14, marginTop: 8 }}>
        {!supported ? (
          <div className="agent-unsupported muted" style={{ fontSize: 13 }}>
            <Icon name="info" size={14} />{" "}
            {(t.ag_unsupported ??
              "Agent mode needs the Anthropic API or an OpenAI-compatible provider. Current: {provider}.").replace(
              "{provider}",
              provider || "—",
            )}
          </div>
        ) : null}

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label className="muted" style={{ fontSize: 12.5 }}>
            {t.ag_preset ?? "Task agent"}
          </label>
          <select
            className="input agent-preset-select"
            value={presetSlug}
            onChange={(e) => setPresetSlug(e.target.value)}
            style={{ maxWidth: 220 }}
          >
            <option value="">{t.ag_preset_none ?? "Default"}</option>
            {presets.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn btn-ghost" onClick={() => void newPreset()}>
            <Icon name="plus" size={12} /> {t.ag_new_preset ?? "New agent"}
          </button>
          <label
            className="agent-write-toggle"
            title={t.ag_write_hint ?? "Let the agent create/update pages (confirmed per write)"}
            style={{ marginLeft: "auto", fontSize: 12.5 }}
          >
            <input
              type="checkbox"
              checked={activePreset ? activePreset.allowWrite : allowWrite}
              disabled={!!activePreset || running}
              onChange={(e) => setAllowWrite(e.target.checked)}
            />{" "}
            {t.ag_allow_write ?? "Allow writes"}
          </label>
        </div>

        <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center" }}>
          <Icon name="terminal" size={16} />
          <input
            className="input agent-input"
            style={{ border: "none", padding: "4px 0", boxShadow: "none", flex: 1 }}
            placeholder={t.ag_ph ?? "Give the agent a multi-step task…"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (isComposingKey(e)) return;
              if (e.key === "Enter") void run();
            }}
            disabled={running || !currentVault || !supported}
          />
          {running ? (
            <button className="btn" onClick={cancel}>
              {t.ag_stop ?? "Stop"}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => void run()}
              disabled={!currentVault || !q.trim() || !supported}
            >
              {t.ag_run ?? "Run"}
            </button>
          )}
        </div>
        {supported && settings ? (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {(t.q_via ?? "via {provider} · {model}")
              .replace("{provider}", provider)
              .replace("{model}", model)}
          </div>
        ) : null}
      </div>

      {question ? (
        <div className="card agent-run" style={{ marginTop: 16 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="typebadge">
              <span className="tb-dot" style={{ background: "var(--ink)" }}></span>
              {t.ag_task ?? "task"}
            </span>
            <span style={{ fontWeight: 500 }}>{question}</span>
          </div>

          <AgentTrace t={t} steps={steps} running={running} />

          {error ? (
            <p style={{ color: "#dc2626", marginTop: 10 }}>{error}</p>
          ) : answer ? (
            <div className="prose agent-answer" style={{ marginTop: 12 }}>
              {stoppedAtLimit ? (
                <div className="agent-limit muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
                  <Icon name="info" size={12} /> {t.ag_stopped_limit ?? "Stopped at the step limit — partial answer."}
                </div>
              ) : null}
              <Viewer content={answer} onLinkClick={openByStem} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AgentTrace({
  t,
  steps,
  running,
}: {
  t: Strings;
  steps: AgentStep[];
  running: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(true);
  if (steps.length === 0 && !running) return null;
  return (
    <div className="agent-trace">
      <button
        className="agent-trace-head"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? "chevD" : "chevR"} size={12} />
        <span>
          {(t.ag_steps ?? "{n} steps").replace("{n}", String(steps.length))}
        </span>
        {running ? (
          <span className="agent-spinner" aria-label={t.ag_working ?? "working"}>
            ●
          </span>
        ) : null}
      </button>
      {open ? (
        <ol className="agent-steps">
          {steps.map((s, i) => (
            <li key={i} className={"agent-step" + (s.error ? " has-error" : "")}>
              <code className="agent-step-tool">{s.tool}</code>
              <span className="agent-step-args muted">
                {argSummary(s.args)}
              </span>
              {s.confirmed === false ? (
                <span className="agent-step-declined">
                  {t.ag_declined ?? "declined"}
                </span>
              ) : s.error ? (
                <span className="agent-step-err">{s.error}</span>
              ) : s.result ? (
                <span className="agent-step-result muted">{s.result}</span>
              ) : null}
            </li>
          ))}
          {running ? (
            <li className="agent-step agent-step-pending muted">…</li>
          ) : null}
        </ol>
      ) : null}
    </div>
  );
}

function argSummary(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}: ${s.length > 40 ? s.slice(0, 40) + "…" : s}`;
  });
  return parts.length ? `(${parts.join(", ")})` : "";
}
