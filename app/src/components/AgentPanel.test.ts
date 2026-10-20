// Node-only element and handler checks. Captured-role routing is covered by
// mocked IPC store tests; this panel must not use legacy Query fields to gate it.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STRINGS } from "../lib/i18n";
import type { MycoSettings } from "../lib/ipc";
import { selectedRolesFixture } from "../lib/modelRoles.testSupport";
import type { AgentState } from "../stores/agentStore";
import type * as AgentStoreModule from "../stores/agentStore";
import type * as VaultStoreModule from "../stores/vaultStore";

type PanelSettings = Pick<
  MycoSettings,
  "query_provider" | "query_model" | "model_roles"
>;
const current = vi.hoisted(() => ({
  settings: null as PanelSettings | null,
  question: "Synthetic agent task",
  hookIndex: 0,
  running: false,
  start: vi.fn(),
  setRoute: vi.fn(),
  setSettingsTab: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: vi.fn(),
    useMemo: <T>(calculate: () => T): T => calculate(),
    useState: <S>(initial: S | (() => S)) => {
      const value =
        current.hookIndex++ === 0
          ? (current.question as S)
          : typeof initial === "function"
            ? (initial as () => S)()
            : initial;
      return [value, vi.fn()] as const;
    },
  };
});
vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: <T>(
    pick: (s: { settings: PanelSettings | null }) => T,
  ): T => pick({ settings: current.settings }),
}));
vi.mock("../stores/vaultStore", async (importOriginal) => {
  const actual = await importOriginal<typeof VaultStoreModule>();
  return {
    ...actual,
    useVaultStore: Object.assign(
      <T>(
        pick: (s: ReturnType<typeof actual.useVaultStore.getState>) => T,
      ): T =>
        pick({
          ...actual.useVaultStore.getState(),
          currentVault: { path: "/synthetic-vault", name: "Synthetic" },
          fileTree: [],
        }),
      actual.useVaultStore,
    ),
  };
});
vi.mock("../stores/uiStore", () => ({
  useUIStore: <T>(pick: (s: object) => T): T =>
    pick({
      setRoute: current.setRoute,
      setSettingsTab: current.setSettingsTab,
    }),
}));
vi.mock("../stores/agentStore", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStoreModule>();
  return {
    ...actual,
    useAgentStore: <T>(pick: (s: AgentState) => T): T =>
      pick({
        ...actual.useAgentStore.getState(),
        running: current.running,
        question: "",
        steps: [],
        answer: "",
        error: null,
        start: current.start,
      }),
  };
});
import AgentPanel from "./AgentPanel";

const t = STRINGS.ko;
interface HostProps {
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  onKeyDown?: (event: { key: string; nativeEvent: object }) => void;
}
function hosts(node: ReactNode, tag: string): ReactElement<HostProps>[] {
  if (Array.isArray(node)) return node.flatMap((child) => hosts(child, tag));
  if (!isValidElement<HostProps>(node)) return [];
  return [
    ...(node.type === tag ? [node] : []),
    ...hosts(node.props.children, tag),
  ];
}
function tree(): ReactElement {
  current.hookIndex = 0;
  return AgentPanel({ t });
}
function select(query: string, agent: string, model = "synthetic-agent-model") {
  current.settings = {
    query_provider: query,
    query_model: "legacy-query-model",
    model_roles: selectedRolesFixture({
      ask: { providerId: query, modelId: "native-ask-model" },
      agent: { providerId: agent, modelId: model },
    }),
  };
}
function controls(node: ReactNode) {
  const input = hosts(node, "input").find(
    (element) => element.props.className === "input agent-input",
  );
  const run = hosts(node, "button").find(
    (element) => element.props.children === t.ag_run,
  );
  expect(input).toBeDefined();
  expect(run).toBeDefined();
  return { input: input!, run: run! };
}
async function attemptRun(node: ReactNode) {
  const { input, run } = controls(node);
  input.props.onKeyDown?.({ key: "Enter", nativeEvent: {} });
  run.props.onClick?.();
  await Promise.resolve();
}
beforeEach(() => {
  current.settings = null;
  current.question = "Synthetic agent task";
  current.hookIndex = 0;
  current.running = false;
  current.start.mockReset().mockResolvedValue(undefined);
  current.setRoute.mockReset();
  current.setSettingsTab.mockReset();
});
describe("AgentPanel native role selection", () => {
  it.each(["anthropic-api", "openai-api", "openrouter"])(
    "enables the selected %s Agent route despite an unsupported Query route",
    async (agent) => {
      select("builtin-local", agent);
      const node = tree();
      const html = renderToStaticMarkup(node);
      const { input, run } = controls(node);
      expect(input.props.disabled).toBe(false);
      expect(run.props.disabled).toBe(false);
      expect(html).toContain(agent);
      expect(html).toContain("synthetic-agent-model");
      expect(html).not.toContain("legacy-query-model");
      expect(html).not.toContain(t.ag_open_providers);
      await attemptRun(node);
      expect(current.start).toHaveBeenCalledTimes(2);
      for (const [options] of current.start.mock.calls) {
        expect(options).toMatchObject({
          provider: agent,
          model: "synthetic-agent-model",
          vaultPath: "/synthetic-vault",
          question: current.question,
        });
      }
    },
  );
  it.each(["builtin-local", "ollama", "anthropic-cli"])(
    "blocks unsupported %s Agent even when Query supports tools",
    async (agent) => {
      select("anthropic-api", agent);
      const node = tree();
      const { input, run } = controls(node);
      expect(input.props.disabled).toBe(true);
      expect(run.props.disabled).toBe(true);
      expect(renderToStaticMarkup(node)).toContain(
        t.ag_unsupported.replace("{provider}", agent),
      );
      await attemptRun(node);
      expect(current.start).not.toHaveBeenCalled();
    },
  );
  it.each(["loading", "legacy-only", "missing-agent", "missing-role-map"])(
    "never obtains Agent permission from %s settings",
    async (kind) => {
      if (kind === "legacy-only")
        current.settings = {
          query_provider: "openai-api",
          query_model: "legacy-query-model",
        };
      if (kind === "missing-agent") {
        select("openai-api", "anthropic-api");
        Reflect.deleteProperty(current.settings!.model_roles!.roles, "agent");
      }
      if (kind === "missing-role-map") {
        select("openai-api", "anthropic-api");
        Reflect.deleteProperty(current.settings!.model_roles!, "roles");
      }
      const node = tree();
      const { input, run } = controls(node);
      expect(input.props.disabled).toBe(true);
      expect(run.props.disabled).toBe(true);
      await attemptRun(node);
      expect(current.start).not.toHaveBeenCalled();
    },
  );
  it("opens Model settings for the unsupported selected local Agent", () => {
    select("anthropic-api", "builtin-local");
    const node = tree();
    const settings = hosts(node, "button").find((element) =>
      String(element.props.children).includes(t.ag_open_providers),
    );
    expect(settings).toBeDefined();
    settings!.props.onClick?.();
    expect(current.setSettingsTab).toHaveBeenCalledWith("model");
    expect(current.setRoute).toHaveBeenCalledWith("settings");
  });
  it.each([
    ["en", "verified tool runner", "Model settings"],
    ["ko", "도구 실행기", "모델 설정"],
    ["ja", "ツール実行", "モデル設定"],
  ] as const)(
    "discloses runner limits and model selection in %s",
    (lang, runner, model) => {
      expect(STRINGS[lang].ag_unsupported).toContain(runner);
      expect(STRINGS[lang].ag_unsupported).not.toContain("Anthropic API");
      expect(STRINGS[lang].ag_open_providers).toContain(model);
    },
  );
});
