// Synthetic UI-handler/store integration, not a DOM, native authority or
// installed-model test. Only hook rendering and the IPC wire are mocked.
import { isValidElement, type ComponentProps, type ReactElement } from "react";
import type * as ReactModule from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type MycoSettings } from "../../lib/ipc";
import { STRINGS } from "../../lib/i18n";
import { SEMANTIC_ROLES, type RoleId } from "../../lib/modelRoles";
import {
  roleSettingsFixture,
  selectedRolesFixture,
} from "../../lib/modelRoles.testSupport";
import { BUILTIN_CHAT_MODEL, CLI_DEFAULT } from "../../lib/providers";
import { useSettingsStore } from "../../stores/settingsStore";
import type * as SettingsModule from "../../stores/settingsStore";
import ModelSelect from "../../components/ModelSelect";
import { ModelPicker, SettingsModel } from "./Model";

vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof ReactModule>();
  return {
    ...original,
    useEffect: () => undefined,
    useId: () => "synthetic-model-select",
    useMemo: <T>(create: () => T): T => create(),
    useState: <T>(initial: T | (() => T)): [T, (next: T) => void] => [
      typeof initial === "function" ? (initial as () => T)() : initial,
      () => undefined,
    ],
  };
});

vi.mock("../../stores/settingsStore", async (importOriginal) => {
  const original = await importOriginal<typeof SettingsModule>();
  // Read the real store snapshot without a mounted hook dispatcher. The real
  // queue, selectRole and revision binding remain under test.
  const store = Object.assign(
    (
      select: (
        state: ReturnType<typeof original.useSettingsStore.getState>,
      ) => unknown,
    ) => select(original.useSettingsStore.getState()),
    original.useSettingsStore,
  );
  return { ...original, useSettingsStore: store };
});

vi.mock("../../stores/uiStore", () => ({
  useUIStore: (select: (state: { lang: "ko" }) => unknown) =>
    select({ lang: "ko" }),
}));

const OBSERVED = "a".repeat(64);
const SAVED = "b".repeat(64);
type Element = ReactElement<Record<string, unknown>>;

function findElement(
  node: unknown,
  predicate: (element: Element) => boolean,
): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
  } else if (isValidElement<Record<string, unknown>>(node)) {
    if (predicate(node)) return node;
    return findElement(node.props.children, predicate);
  }
  return undefined;
}

function requiredElement(
  node: unknown,
  predicate: (element: Element) => boolean,
): Element {
  const found = findElement(node, predicate);
  if (!found) throw new Error("Expected settings control was not rendered");
  return found;
}

function rolePicker(role: RoleId): ReturnType<typeof ModelPicker> {
  const row = requiredElement(
    SettingsModel({ t: STRINGS.ko }),
    (element) =>
      element.type === ModelPicker && element.props.rowId === `model_${role}`,
  );
  return ModelPicker(row.props as ComponentProps<typeof ModelPicker>);
}

function externalReflect(): MycoSettings {
  return {
    providers: { builtin_local: true, codex_cli: true, openai_api: false },
    model_roles: selectedRolesFixture({
      reflect: {
        providerId: "codex-cli",
        modelId: "synthetic-explicit-model",
        effort: "ultra",
      },
    }),
    role_authorization_revision: OBSERVED,
  } as MycoSettings;
}

function selectionWire(initial: MycoSettings) {
  let persisted = structuredClone(initial);
  return vi
    .spyOn(ipc, "selectModelRole")
    .mockImplementation(async (request) => {
      if (
        request.expectedAuthorizationRevision !==
        persisted.role_authorization_revision
      ) {
        throw new Error(
          "role settings changed; reload before selecting a model",
        );
      }
      const roleSettings = persisted.model_roles;
      if (!roleSettings)
        throw new Error("Synthetic native role settings missing");
      const choice = roleSettings.roles[request.role];
      roleSettings.roles[request.role] = {
        ...choice,
        providerId: request.providerId,
        modelId: request.modelId,
        effort: request.effort,
        selection:
          request.providerId === "builtin-local"
            ? "explicit-local"
            : "explicit-external",
        automaticExternalAllowed: false,
      };
      persisted = { ...persisted, role_authorization_revision: SAVED };
      return structuredClone(persisted);
    });
}

async function waitForStore(): Promise<void> {
  await vi.waitFor(() =>
    expect(useSettingsStore.getState().saving).toBe(false),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  useSettingsStore.setState({
    settings: externalReflect(),
    loading: false,
    saving: false,
    saved: false,
    error: null,
    notchPending: false,
    notchError: null,
  });
});

describe("Settings feature selection events", () => {
  it("the recommendation commits provider, model and default effort in one observed-revision request", async () => {
    const select = selectionWire(useSettingsStore.getState().settings!);
    const recommendation = requiredElement(
      rolePicker("reflect"),
      (element) => element.type === "input" && element.props.type === "radio",
    );
    (recommendation.props.onChange as () => void)();
    await waitForStore();

    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith({
      role: "reflect",
      providerId: "builtin-local",
      modelId: BUILTIN_CHAT_MODEL,
      effort: CLI_DEFAULT,
      expectedAuthorizationRevision: OBSERVED,
    });
    expect(
      useSettingsStore.getState().settings?.model_roles?.roles.reflect,
    ).toMatchObject({
      providerId: "builtin-local",
      modelId: BUILTIN_CHAT_MODEL,
      effort: CLI_DEFAULT,
      automaticExternalAllowed: false,
    });
    expect(useSettingsStore.getState().error).toBeNull();
  });

  it("a provider switch resets incompatible effort in the same selection instead of a second stale write", async () => {
    const select = selectionWire(useSettingsStore.getState().settings!);
    const modelSelect = requiredElement(
      rolePicker("reflect"),
      (element) => element.type === ModelSelect,
    );
    const provider = requiredElement(
      ModelSelect(modelSelect.props as ComponentProps<typeof ModelSelect>),
      (element) =>
        element.type === "select" && element.props.value === "codex-cli",
    );
    (provider.props.onChange as (event: { target: { value: string } }) => void)(
      {
        target: { value: "builtin-local" },
      },
    );
    await waitForStore();

    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "reflect",
        providerId: "builtin-local",
        effort: CLI_DEFAULT,
        expectedAuthorizationRevision: OBSERVED,
      }),
    );
    expect(
      useSettingsStore.getState().settings?.model_roles?.roles.reflect.effort,
    ).toBe(CLI_DEFAULT);
    expect(useSettingsStore.getState().error).toBeNull();
  });

  it("all semantic feature choices are present independently without external connections", () => {
    const settings = {
      providers: { builtin_local: true },
      model_roles: roleSettingsFixture(),
      role_authorization_revision: OBSERVED,
    } as MycoSettings;
    useSettingsStore.setState({ settings });
    const view = SettingsModel({ t: STRINGS.ko });
    for (const role of SEMANTIC_ROLES) {
      const row = requiredElement(
        view,
        (element) =>
          element.type === ModelPicker &&
          element.props.rowId === `model_${role}`,
      );
      expect(row.props.provider).toBe("builtin-local");
      expect(row.props.model).toBe(settings.model_roles!.roles[role].modelId);
    }
  });

  it("connecting an optional provider changes no feature selection or automatic permission", async () => {
    const settings = {
      providers: { builtin_local: true, openai_api: false },
      model_roles: roleSettingsFixture(),
      role_authorization_revision: OBSERVED,
    } as MycoSettings;
    useSettingsStore.setState({ settings });
    const roles = structuredClone(settings.model_roles);
    const select = vi.spyOn(ipc, "selectModelRole");
    const automatic = vi.spyOn(ipc, "setRoleAutomaticUse");
    vi.spyOn(ipc, "setSettings").mockImplementation(async (next) => next);

    await useSettingsStore.getState().setProviderConnected("openai_api", true);

    expect(useSettingsStore.getState().settings?.providers.openai_api).toBe(
      true,
    );
    expect(useSettingsStore.getState().settings?.model_roles).toEqual(roles);
    expect(select).not.toHaveBeenCalled();
    expect(automatic).not.toHaveBeenCalled();
  });
});
