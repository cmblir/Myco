// Synthetic UI ownership/transport checks; no native authority or image inference.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRoleSettings } from "./modelRoles";

const fixture = vi.hoisted(() => ({
  vault: {
    currentVault: { path: "/synthetic", name: "Synthetic" } as {
      path: string;
      name: string;
    } | null,
    vaultToken: "synthetic-ui-opening",
    isOpeningVault: false,
  },
  settings: {
    settings: undefined as
      | { role_authorization_revision: string; model_roles: ModelRoleSettings }
      | undefined,
  },
  vaultListeners: new Set<() => void>(),
  settingsListeners: new Set<() => void>(),
  session: vi.fn(),
  role: vi.fn(),
  picker: vi.fn(),
  image: vi.fn(),
  cancel: vi.fn(),
  document: vi.fn(),
  media: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("./ipc", () => ({
  ipc: {
    agentVaultSession: fixture.session,
    captureModelRole: fixture.role,
    pickTextFile: fixture.picker,
    describeImage: fixture.image,
    cancelImageIngest: fixture.cancel,
    readExternalText: fixture.document,
    transcribeMedia: fixture.media,
  },
}));
vi.mock("./log", () => ({ log: { warn: fixture.warn } }));
vi.mock("../stores/vaultStore", () => ({
  useVaultStore: {
    getState: () => fixture.vault,
    subscribe: (listener: () => void) => {
      fixture.vaultListeners.add(listener);
      return () => fixture.vaultListeners.delete(listener);
    },
  },
}));
vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => fixture.settings,
    subscribe: (listener: () => void) => {
      fixture.settingsListeners.add(listener);
      return () => fixture.settingsListeners.delete(listener);
    },
  },
}));

import {
  createSourceLoader,
  sourceLoadMessage,
  SourceLoadError,
  type SourceLoader,
} from "./sourceLoad";
import { roleFixture, selectedRolesFixture } from "./modelRoles.testSupport";
import { STRINGS } from "./i18n";
import type { AgentVaultSession, ImageIngestRequest } from "./ipc";

const origin = {
  vaultPath: "/synthetic",
  openingToken: "synthetic-native-opening",
};
const model = "synthetic-vision";
const provider = "openai-api";
const imagePath = "/synthetic/chart.png";
const loaders: SourceLoader[] = [];
const tick = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
function observers(beforeRead?: (path: string) => Promise<void>) {
  const onBusy = vi.fn(),
    onLoaded = vi.fn(),
    onError = vi.fn();
  const loader = createSourceLoader({ onBusy, onLoaded, onError, beforeRead });
  loaders.push(loader);
  return { loader, onBusy, onLoaded, onError };
}
function changedVault(): void {
  fixture.vaultListeners.forEach((listener) => listener());
}
function changedSettings(): void {
  fixture.settingsListeners.forEach((listener) => listener());
}

beforeEach(() => {
  for (const mock of [
    fixture.session,
    fixture.role,
    fixture.picker,
    fixture.image,
    fixture.cancel,
    fixture.document,
    fixture.media,
    fixture.warn,
  ])
    mock.mockReset();
  fixture.vault.currentVault = { path: origin.vaultPath, name: "Synthetic" };
  fixture.vault.vaultToken = "synthetic-ui-opening";
  fixture.vault.isOpeningVault = false;
  fixture.settings.settings = {
    role_authorization_revision: "b".repeat(64),
    model_roles: selectedRolesFixture({
      compilation: { providerId: provider, modelId: model },
    }),
  };
  fixture.session.mockResolvedValue(origin);
  fixture.role.mockImplementation((captured: AgentVaultSession) =>
    Promise.resolve(roleFixture("compilation", provider, model, captured)),
  );
  fixture.picker.mockResolvedValue(imagePath);
  fixture.image.mockResolvedValue("Synthetic accepted source.");
  fixture.cancel.mockResolvedValue(true);
  fixture.document.mockResolvedValue("Synthetic document.");
  fixture.media.mockResolvedValue("Synthetic transcript.");
});
afterEach(() => {
  loaders.splice(0).forEach((loader) => loader.dispose());
  expect(fixture.vaultListeners.size).toBe(0);
  expect(fixture.settingsListeners.size).toBe(0);
});

describe("initiating file authorization", () => {
  it("captures opening and Compilation foreground before opening the picker", async () => {
    const nativeOpening = deferred<AgentVaultSession>();
    const grant = deferred<ReturnType<typeof roleFixture>>();
    fixture.session.mockReturnValue(nativeOpening.promise);
    fixture.role.mockReturnValue(grant.promise);
    const observed = observers();
    const loading = observed.loader.load();
    expect(fixture.session).toHaveBeenCalledTimes(1);
    expect(fixture.picker).not.toHaveBeenCalled();
    nativeOpening.resolve(origin);
    await tick();
    expect(fixture.role).toHaveBeenCalledWith(
      origin,
      "compilation",
      "foreground",
    );
    expect(fixture.picker).not.toHaveBeenCalled();
    grant.resolve(roleFixture("compilation", provider, model, origin));
    await loading;
    expect(fixture.picker).toHaveBeenCalledTimes(1);
    const request = fixture.image.mock.calls[0][0] as ImageIngestRequest;
    expect(request).toMatchObject({
      path: imagePath,
      origin,
      roleSnapshot: { role: "compilation", usage: "foreground" },
    });
    expect(request.requestId).toMatch(/^image-ingest-/);
    expect(request).not.toHaveProperty("provider");
    expect(request).not.toHaveProperty("model");
    expect(Object.isFrozen(request.origin)).toBe(true);
    expect(Object.isFrozen(request.roleSnapshot)).toBe(true);
    expect(Object.isFrozen(request.roleSnapshot.routeSignature)).toBe(true);
    expect(observed.onLoaded).toHaveBeenCalledWith(
      imagePath,
      "Synthetic accepted source.",
    );
    expect(observed.onBusy.mock.calls).toEqual([[true], [false]]);
    expect(observed.onError).not.toHaveBeenCalled();
  });

  it.each(["session", "role"] as const)(
    "does not open a picker when %s capture fails",
    async (phase) => {
      fixture[phase].mockRejectedValue(
        new Error("Synthetic private source/path/response"),
      );
      const observed = observers();
      await observed.loader.load();
      expect(fixture.picker).not.toHaveBeenCalled();
      expect(fixture.image).not.toHaveBeenCalled();
      expect(observed.onError.mock.calls[0][0]).toBeInstanceOf(SourceLoadError);
      expect(JSON.stringify(observed.onError.mock.calls)).not.toContain(
        "private",
      );
      expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain("private");
    },
  );

  it.each([
    {
      name: "disconnected selected route",
      error: "connection_unavailable: synthetic-private-provider-model",
    },
    {
      name: "unsupported selected route",
      error: new Error("unsupported adapter: synthetic-private-provider-model"),
    },
  ])(
    "offers current-opening/model recovery for $name rejected by capture",
    async ({ error }) => {
      fixture.role.mockRejectedValue(error);
      const observed = observers();
      await observed.loader.load();
      expect(fixture.role).toHaveBeenCalledWith(
        origin,
        "compilation",
        "foreground",
      );
      expect(fixture.picker).not.toHaveBeenCalled();
      expect(fixture.image).not.toHaveBeenCalled();
      expect(fixture.document).not.toHaveBeenCalled();
      expect(fixture.media).not.toHaveBeenCalled();
      const reported = observed.onError.mock.calls[0][0] as SourceLoadError;
      expect(reported.code).toBe("authority_changed");
      for (const lang of ["ko", "en", "ja"] as const) {
        expect(sourceLoadMessage(reported, STRINGS[lang])).toBe(
          STRINGS[lang].ing_source_authority_changed,
        );
      }
      expect(fixture.warn).toHaveBeenCalledWith("source_load.failed", {
        code: "authority_changed",
      });
      expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain(
        "synthetic-private",
      );
      expect(JSON.stringify(observed.onError.mock.calls)).not.toContain(
        "synthetic-private",
      );
    },
  );

  it("preserves a typed capability refusal during capture for the specific recovery message", async () => {
    fixture.role.mockRejectedValue({
      version: "ImageIngestFailureV1",
      code: "capability_unavailable",
      detail: "Synthetic private unsupported model",
    });
    const observed = observers();
    await observed.loader.load();
    expect(fixture.picker).not.toHaveBeenCalled();
    expect(fixture.image).not.toHaveBeenCalled();
    const reported = observed.onError.mock.calls[0][0] as SourceLoadError;
    expect(reported.code).toBe("capability_unavailable");
    expect(sourceLoadMessage(reported, STRINGS.ko)).toBe(
      STRINGS.ko.ing_image_capability_unavailable,
    );
    expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain("private");
  });

  it.each([
    roleFixture("ask", provider, model, origin),
    roleFixture("compilation", provider, model, origin, "automatic"),
    roleFixture("compilation", provider, model, {
      ...origin,
      openingToken: "other-opening",
    }),
    roleFixture("compilation", provider, "other-model", origin),
    {
      ...roleFixture("compilation", provider, model, origin),
      authorizationRevision: "d".repeat(64),
    },
  ])(
    "rejects unrelated native grants without picker or image dispatch",
    async (grant) => {
      fixture.role.mockResolvedValue(grant);
      const observed = observers();
      await observed.loader.load();
      expect(fixture.picker).not.toHaveBeenCalled();
      expect(fixture.image).not.toHaveBeenCalled();
      expect(observed.onError.mock.calls[0][0].code).toBe("authority_changed");
    },
  );

  it.each(["missing-vault", "opening", "missing-settings", "missing-role"])(
    "refuses an unavailable initial view: %s",
    async (state) => {
      if (state === "missing-vault") fixture.vault.currentVault = null;
      if (state === "opening") fixture.vault.isOpeningVault = true;
      if (state === "missing-settings") fixture.settings.settings = undefined;
      if (state === "missing-role")
        fixture.settings.settings!.model_roles = {
          version: 2,
          roles: {},
        } as ModelRoleSettings;
      const observed = observers();
      await observed.loader.load();
      expect(fixture.session).not.toHaveBeenCalled();
      expect(fixture.picker).not.toHaveBeenCalled();
      expect(observed.onError.mock.calls[0][0].code).toBe("authority_changed");
    },
  );

  it("rejects a mismatched native origin without refreshing it", async () => {
    fixture.session.mockResolvedValue({
      ...origin,
      vaultPath: "/synthetic-other",
    });
    const observed = observers();
    await observed.loader.load();
    expect(fixture.session).toHaveBeenCalledTimes(1);
    expect(fixture.role).not.toHaveBeenCalled();
    expect(fixture.picker).not.toHaveBeenCalled();
  });

  it.each([
    ["/synthetic/document.pdf", "document", "Synthetic document."],
    ["/synthetic/recording.m4a", "media", "Synthetic transcript."],
  ] as const)(
    "preserves existing source dispatch for %s",
    async (path, route, text) => {
      const observed = observers();
      await observed.loader.load(path);
      expect(fixture[route]).toHaveBeenCalledWith(path);
      expect(fixture.image).not.toHaveBeenCalled();
      expect(fixture.picker).not.toHaveBeenCalled();
      expect(observed.onLoaded).toHaveBeenCalledWith(path, text);
    },
  );
});

describe("pending source ownership", () => {
  it("settles synchronous invalidation from the busy observer before any IPC", async () => {
    const onLoaded = vi.fn(),
      onError = vi.fn(),
      onBusy = vi.fn((busy: boolean) => {
        if (busy) loader.invalidate();
      });
    const loader = createSourceLoader({ onBusy, onLoaded, onError });
    loaders.push(loader);
    await loader.load();
    expect(fixture.session).not.toHaveBeenCalled();
    expect(fixture.picker).not.toHaveBeenCalled();
    expect(onBusy.mock.calls).toEqual([[true], [false]]);
    expect(onLoaded).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it.each(["session", "role", "picker"] as const)(
    "does not adopt or dispatch after invalidating delayed %s",
    async (phase) => {
      const delayed = deferred<unknown>();
      fixture[phase].mockReturnValue(delayed.promise);
      const observed = observers();
      const loading = observed.loader.load();
      await tick();
      observed.loader.invalidate();
      await loading;
      delayed.resolve(
        phase === "session"
          ? origin
          : phase === "role"
            ? roleFixture("compilation", provider, model, origin)
            : imagePath,
      );
      await tick();
      expect(fixture.image).not.toHaveBeenCalled();
      expect(observed.onLoaded).not.toHaveBeenCalled();
      expect(observed.onError).not.toHaveBeenCalled();
      expect(observed.onBusy.mock.calls).toEqual([[true], [false]]);
      expect(fixture.cancel).not.toHaveBeenCalled();
    },
  );

  it.each(["reopen", "switch", "opening", "authorization", "selection"])(
    "refuses a delayed picker after %s",
    async (change) => {
      const picker = deferred<string | null>();
      fixture.picker.mockReturnValue(picker.promise);
      const observed = observers();
      const loading = observed.loader.load();
      await tick();
      expect(fixture.picker).toHaveBeenCalledTimes(1);
      if (change === "reopen") fixture.vault.vaultToken = "reopened-ui-token";
      if (change === "switch")
        fixture.vault.currentVault = {
          path: "/synthetic-other",
          name: "Other",
        };
      if (change === "opening") fixture.vault.isOpeningVault = true;
      if (change === "authorization")
        fixture.settings.settings!.role_authorization_revision = "e".repeat(64);
      if (change === "selection")
        fixture.settings.settings!.model_roles.roles.compilation.modelId =
          "changed-model";
      changedVault();
      changedSettings();
      await loading;
      picker.resolve(imagePath);
      await tick();
      expect(fixture.image).not.toHaveBeenCalled();
      expect(fixture.session).toHaveBeenCalledTimes(1);
      expect(fixture.role).toHaveBeenCalledTimes(1);
      expect(observed.onLoaded).not.toHaveBeenCalled();
      expect(observed.onError).not.toHaveBeenCalled();
    },
  );

  it("checks the opening again after media preflight", async () => {
    const ready = deferred<void>();
    const observed = observers(() => ready.promise);
    const loading = observed.loader.load("/synthetic/recording.m4a");
    await tick();
    fixture.vault.vaultToken = "reopened-ui-token";
    changedVault();
    await loading;
    ready.resolve();
    await tick();
    expect(fixture.media).not.toHaveBeenCalled();
    expect(observed.onLoaded).not.toHaveBeenCalled();
  });

  it("cancels the exact image request on edit and rejects its late output", async () => {
    const image = deferred<string>();
    fixture.image.mockReturnValue(image.promise);
    const observed = observers();
    const loading = observed.loader.load(imagePath);
    await tick();
    const request = fixture.image.mock.calls[0][0] as ImageIngestRequest;
    observed.loader.invalidate();
    await loading;
    expect(fixture.cancel).toHaveBeenCalledWith(origin, request.requestId);
    image.resolve("Synthetic stale output.");
    await tick();
    expect(observed.onLoaded).not.toHaveBeenCalled();
    expect(observed.onError).not.toHaveBeenCalled();
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the newer request busy after the older request rejects", async () => {
    const old = deferred<string>(),
      next = deferred<string>();
    fixture.image
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    const observed = observers();
    const first = observed.loader.load(imagePath);
    await tick();
    const firstRequest = fixture.image.mock.calls[0][0] as ImageIngestRequest;
    const second = observed.loader.load("/synthetic/new.png");
    await tick();
    await first;
    const nextRequest = fixture.image.mock.calls[1][0] as ImageIngestRequest;
    old.reject(new Error("Synthetic stale private error"));
    await tick();
    expect(observed.onBusy.mock.calls).toEqual([[true], [false], [true]]);
    expect(observed.onError).not.toHaveBeenCalled();
    expect(fixture.cancel.mock.calls).toEqual([
      [origin, firstRequest.requestId],
    ]);
    expect(nextRequest.requestId).not.toBe(firstRequest.requestId);
    next.resolve("Synthetic newer output.");
    await second;
    expect(observed.onLoaded.mock.calls).toEqual([
      ["/synthetic/new.png", "Synthetic newer output."],
    ]);
    expect(observed.onBusy.mock.calls).toEqual([
      [true],
      [false],
      [true],
      [false],
    ]);
  });

  it("disposes without late callbacks and cannot be reused", async () => {
    const image = deferred<string>();
    fixture.image.mockReturnValue(image.promise);
    const observed = observers();
    const loading = observed.loader.load(imagePath);
    await tick();
    observed.loader.dispose();
    await loading;
    image.reject(new Error("Synthetic late source failure"));
    await tick();
    await observed.loader.load();
    expect(observed.onBusy.mock.calls).toEqual([[true]]);
    expect(observed.onError).not.toHaveBeenCalled();
    expect(observed.onLoaded).not.toHaveBeenCalled();
    expect(fixture.image).toHaveBeenCalledTimes(1);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
  });

  it("invalidates image output immediately on authorization revision change", async () => {
    const image = deferred<string>();
    fixture.image.mockReturnValue(image.promise);
    const observed = observers();
    const loading = observed.loader.load(imagePath);
    await tick();
    fixture.settings.settings!.role_authorization_revision = "e".repeat(64);
    changedSettings();
    await loading;
    image.resolve("Synthetic stale output.");
    await tick();
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(observed.onLoaded).not.toHaveBeenCalled();
    expect(observed.onError).not.toHaveBeenCalled();
  });
});

describe("static failure presentation", () => {
  it("explains capability and current-opening recovery in each supported language", () => {
    for (const lang of ["ko", "en", "ja"] as const) {
      expect(
        sourceLoadMessage(
          new SourceLoadError("capability_unavailable"),
          STRINGS[lang],
        ),
      ).toBe(STRINGS[lang].ing_image_capability_unavailable);
      expect(
        sourceLoadMessage(
          new SourceLoadError("authority_changed"),
          STRINGS[lang],
        ),
      ).toBe(STRINGS[lang].ing_source_authority_changed);
      expect(
        sourceLoadMessage(
          new SourceLoadError("credential_unavailable"),
          STRINGS[lang],
        ),
      ).toBe(STRINGS[lang].ing_source_credential_unavailable);
    }
  });
  it.each([
    "capability_unavailable",
    "credential_unavailable",
    "role_authorization_failed",
    "transport_failed",
  ])("maps typed native failure %s without private details", async (code) => {
    fixture.image.mockRejectedValue({
      version: "ImageIngestFailureV1",
      code,
      detail: "Synthetic private path/response",
    });
    const observed = observers();
    await observed.loader.load(imagePath);
    const error = observed.onError.mock.calls[0][0] as SourceLoadError;
    expect(error.code).toBe(
      code === "capability_unavailable" || code === "credential_unavailable"
        ? code
        : code === "role_authorization_failed"
          ? "authority_changed"
          : "source_failed",
    );
    expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain("private");
    for (const lang of ["ko", "en", "ja"] as const) {
      expect(sourceLoadMessage(error, STRINGS[lang])).not.toContain("private");
      expect(sourceLoadMessage(error, STRINGS[lang])).not.toContain(
        "Source load failed",
      );
    }
    expect(observed.onLoaded).not.toHaveBeenCalled();
  });

  it("reports failed cancellation statically while suppressing stale output", async () => {
    const image = deferred<string>();
    fixture.image.mockReturnValue(image.promise);
    fixture.cancel.mockRejectedValue(new Error("Synthetic private transport"));
    const observed = observers();
    const loading = observed.loader.load(imagePath);
    await tick();
    observed.loader.invalidate();
    await loading;
    await tick();
    expect(fixture.warn).toHaveBeenCalledWith("source_load.cancel_failed");
    expect(JSON.stringify(fixture.warn.mock.calls)).not.toContain("private");
    image.resolve("Synthetic late source.");
    await tick();
    expect(observed.onLoaded).not.toHaveBeenCalled();
  });
});
