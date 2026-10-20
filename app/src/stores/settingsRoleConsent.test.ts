import { beforeEach, expect, it, vi } from "vitest";
import { ipc, type MycoSettings } from "../lib/ipc";
import { roleSettingsFixture } from "../lib/modelRoles.testSupport";
import { useSettingsStore } from "./settingsStore";

const OBSERVED = "a".repeat(64);
const REPLACED = "b".repeat(64);
function config(model: string, revision: string): MycoSettings {
  const roles = roleSettingsFixture();
  roles.roles.reflect = { ...roles.roles.reflect, providerId: "ollama", modelId: model, selection: "explicit-external", automaticExternalAllowed: false };
  return { providers: { builtin_local: true, ollama: true }, model_roles: roles, role_authorization_revision: revision } as MycoSettings;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: config("synthetic-observed", OBSERVED), saving: false, saved: false, error: null });
});

it("an automatic-consent event stays bound to the observed route when a preceding selection is pending", async () => {
  const change = deferred<MycoSettings>();
  const selection = vi.spyOn(ipc, "selectModelRole").mockReturnValue(change.promise);
  const permit = vi.spyOn(ipc, "setRoleAutomaticUse").mockImplementation(async (_role, allowed, expected) => {
    if (expected !== REPLACED) throw new Error("role settings changed; review automatic permission again");
    const result = config("synthetic-replaced", REPLACED);
    result.model_roles!.roles.reflect.automaticExternalAllowed = allowed;
    return result;
  });
  const changing = useSettingsStore.getState().selectRole({ role: "reflect", providerId: "ollama", modelId: "synthetic-replaced", effort: "(default)" });
  expect(selection).toHaveBeenCalledTimes(1);
  expect(useSettingsStore.getState().settings?.model_roles?.roles.reflect.modelId).toBe("synthetic-observed");
  const automatic = useSettingsStore.getState().setRoleAutomaticUse("reflect", true);
  change.resolve(config("synthetic-replaced", REPLACED));
  await Promise.all([changing, automatic]);
  expect(permit).toHaveBeenCalledWith("reflect", true, OBSERVED);
  expect(useSettingsStore.getState().settings?.model_roles?.roles.reflect.automaticExternalAllowed).toBe(false);
  expect(useSettingsStore.getState().error).toContain("review automatic permission");
});

it("a subsequent native selection remains bound to its event revision instead of borrowing a queued change's authority", async () => {
  const change = deferred<MycoSettings>();
  const select = vi.spyOn(ipc, "selectModelRole").mockReturnValueOnce(change.promise).mockRejectedValueOnce(new Error("role settings changed; reload before selecting a model"));
  const first = useSettingsStore.getState().selectRole({ role: "reflect", providerId: "ollama", modelId: "synthetic-first", effort: "(default)" });
  const second = useSettingsStore.getState().selectRole({ role: "reflect", providerId: "ollama", modelId: "synthetic-second", effort: "(default)" });
  change.resolve(config("synthetic-first", REPLACED));
  await Promise.all([first, second]);
  expect(select.mock.calls[1][0].expectedAuthorizationRevision).toBe(OBSERVED);
  expect(useSettingsStore.getState().settings?.model_roles?.roles.reflect.modelId).toBe("synthetic-first");
});
