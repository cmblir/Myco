import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioScript, AudioGenerationLifecycle } from "../lib/audioOverview";
import type * as AudioOverviewModule from "../lib/audioOverview";
import type { AudioOverviewJobContext, MycoSettings, VaultMeta } from "../lib/ipc";
import { STRINGS, type Lang } from "../lib/i18n";
import { selectedRolesFixture } from "../lib/modelRoles.testSupport";
import { BUILTIN_CHAT_MODEL, BUILTIN_FAST_CHAT_MODEL } from "../lib/providers";

// Script, persistence and platform calls are mocked; roleFor and canGenerate
// remain real so unrelated provider fields cannot confer Audio capability.
const { getSettings, generateScript, saveTranscript, cancelAudioOverview, refreshTree, vaultState, logWarn, speechCancel, speechTurns, uiState } =
  vi.hoisted(() => ({
    getSettings: vi.fn(),
    generateScript: vi.fn(),
    saveTranscript: vi.fn(),
    cancelAudioOverview: vi.fn(),
    logWarn: vi.fn(),
    speechCancel: vi.fn(),
    speechTurns: vi.fn(),
    uiState: { lang: "en" as Lang },
    refreshTree: vi.fn(),
    vaultState: {
      vaultToken: "synthetic-opening-a",
      isOpeningVault: false,
      currentVault: {
        path: "/synthetic/audio",
        name: "Audio fixture",
      } as VaultMeta | null,
    },
  }));

vi.mock("../lib/ipc", () => ({ ipc: { getSettings } }));
vi.mock("../lib/audioOverview", async (importOriginal) => ({
  ...await importOriginal<typeof AudioOverviewModule>(),
  generateScript, saveTranscript, cancelAudioOverview,
}));
vi.mock("../lib/log", () => ({ log: { warn: logWarn } }));
vi.mock("../lib/tts", () => ({
  ttsAvailable: () => false,
  LOCAL_SPEECH_UNAVAILABLE: "local_speech_unavailable",
  speakTurns: speechTurns,
}));
vi.mock("./uiStore", () => ({
  useUIStore: { getState: () => uiState },
}));
vi.mock("./vaultStore", () => ({
  useVaultStore: { getState: () => ({ ...vaultState, refreshTree }) },
}));

import { useAudioStore } from "./audioStore";
import { AudioOverviewError } from "../lib/audioOverview";
import { LOCAL_SPEECH_UNAVAILABLE, type SpeakOpts } from "../lib/tts";

const pages = ["/synthetic/audio/wiki/sample.md"];
const script: AudioScript = {
  title: "Synthetic overview",
  turns: [
    { speaker: "A", text: "A synthetic source fact.", cites: ["[[sample]]"] },
  ],
  sourcePages: pages,
};

function settings(overrides: Partial<MycoSettings> = {}): MycoSettings {
  return {
    model_roles: selectedRolesFixture({}),
    providers: {
      anthropic_cli: false,
      gemini_cli: false,
      codex_cli: false,
      anthropic_api: false,
      openai_api: false,
      google_api: false,
      ollama: false,
      openrouter: false,
      myco_pro: false,
      builtin_local: true,
    },
    query_provider: "builtin-local",
    query_model: "e5-small-ko",
    ingest_provider: "builtin-local",
    ingest_model: "extractive-ingest",
    query_effort: "(default)",
    ingest_effort: "(default)",
    myco_pro_url: "",
    myco_pro_email: "",
    auto_import_enabled: false,
    auto_import_interval_min: 5,
    auto_ingest_enabled: false,
    auto_ingest_interval_min: 5,
    auto_reflect_enabled: false,
    auto_reflect_interval_min: 5,
    auto_reindex_enabled: false,
    tray_resident: false,
    spotlight_shortcut: "",
    vault_history_enabled: false,
    pii_quarantine_enabled: false,
    search_archived_sessions: false,
    notch_enabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue(settings());
  generateScript.mockReset().mockResolvedValue(script);
  saveTranscript
    .mockReset()
    .mockResolvedValue("/synthetic/audio/audio/overview.md");
  cancelAudioOverview.mockReset().mockResolvedValue(undefined);
  logWarn.mockReset();
  speechCancel.mockReset();
  speechTurns.mockReset().mockReturnValue({ cancel: speechCancel, pause: vi.fn(), resume: vi.fn() });
  uiState.lang = "en";
  refreshTree.mockReset().mockResolvedValue(undefined);
  vaultState.currentVault = { path: "/synthetic/audio", name: "Audio fixture" };
  vaultState.vaultToken = "synthetic-opening-a";
  vaultState.isOpeningVault = false;
  useAudioStore.getState().reset();
});

describe("Audio generation uses its selected role", () => {
  it.each([BUILTIN_CHAT_MODEL, BUILTIN_FAST_CHAT_MODEL])(
    "allows selected local %s while legacy Query and Ingest are extractive",
    async (model) => {
      getSettings.mockResolvedValue(
        settings({
          model_roles: selectedRolesFixture({
            audio: { providerId: "builtin-local", modelId: model },
          }),
        }),
      );

      await useAudioStore.getState().generate(script.title, pages);

      expect(generateScript).toHaveBeenCalledOnce();
      expect(generateScript).toHaveBeenCalledWith(
        "/synthetic/audio",
        pages,
        script.title,
        { isCurrent: expect.any(Function), onJob: expect.any(Function) },
      );
      expect(saveTranscript).toHaveBeenCalledOnce();
      expect(saveTranscript).toHaveBeenCalledWith(
        "/synthetic/audio",
        script,
        expect.any(String),
      );
      expect(refreshTree).toHaveBeenCalledOnce();
      expect(useAudioStore.getState()).toMatchObject({
        script,
        transcriptPath: "/synthetic/audio/audio/overview.md",
        error: null,
        generating: false,
      });
    },
  );

  it.each(["e5-small-ko", "extractive-ingest", "synthetic-unsupported-chat"])(
    "refuses non-generative local Audio model %s despite unrelated external roles",
    async (model) => {
      getSettings.mockResolvedValue(
        settings({
          model_roles: selectedRolesFixture({
            audio: { providerId: "builtin-local", modelId: model },
            ask: { providerId: "openai-api", modelId: "synthetic-query" },
            compilation: {
              providerId: "anthropic-api",
              modelId: "synthetic-ingest",
            },
          }),
          query_provider: "openai-api",
          query_model: "synthetic-query",
          ingest_provider: "anthropic-api",
          ingest_model: "synthetic-ingest",
          providers: {
            ...settings().providers,
            openai_api: true,
            anthropic_api: true,
          },
        }),
      );

      await useAudioStore.getState().generate(script.title, pages);

      expect(generateScript).not.toHaveBeenCalled();
      expect(saveTranscript).not.toHaveBeenCalled();
      expect(refreshTree).not.toHaveBeenCalled();
      expect(useAudioStore.getState()).toMatchObject({
        script: null,
        transcriptPath: null,
        error: STRINGS.en.au_needs_provider,
        generating: false,
      });
    },
  );

  it("refuses an empty Audio provider even when legacy Ingest uses an external provider", async () => {
    getSettings.mockResolvedValue(
      settings({
        model_roles: selectedRolesFixture({
          audio: { providerId: "", modelId: "" },
        }),
        ingest_provider: "anthropic-api",
        ingest_model: "synthetic-ingest",
      }),
    );

    await useAudioStore.getState().generate(script.title, pages);

    expect(generateScript).not.toHaveBeenCalled();
    expect(useAudioStore.getState()).toMatchObject({
      error: STRINGS.en.au_needs_provider,
      generating: false,
    });
  });

  it("allows an explicitly selected external Audio role without inheriting legacy roles", async () => {
    getSettings.mockResolvedValue(
      settings({
        model_roles: selectedRolesFixture({
          audio: { providerId: "openai-api", modelId: "synthetic-audio" },
        }),
        providers: { ...settings().providers, openai_api: true },
      }),
    );

    await useAudioStore.getState().generate(script.title, pages);

    expect(generateScript).toHaveBeenCalledOnce();
    expect(useAudioStore.getState()).toMatchObject({
      script,
      error: null,
      generating: false,
    });
  });

  it("does not infer Audio permission from legacy fields when native roles are missing", async () => {
    getSettings.mockResolvedValue(
      settings({
        model_roles: undefined,
        query_provider: "openai-api",
        query_model: "synthetic-query",
      }),
    );

    await useAudioStore.getState().generate(script.title, pages);

    expect(generateScript).not.toHaveBeenCalled();
    expect(useAudioStore.getState().error).toBe(STRINGS.en.au_needs_provider);
    expect(useAudioStore.getState().generating).toBe(false);
  });

  it("keeps a selected local generator's failure instead of switching providers", async () => {
    generateScript.mockRejectedValue(
      new Error("Synthetic selected model is unavailable"),
    );

    await useAudioStore.getState().generate(script.title, pages);

    expect(generateScript).toHaveBeenCalledOnce();
    expect(saveTranscript).not.toHaveBeenCalled();
    expect(useAudioStore.getState()).toMatchObject({
      error: STRINGS.en.au_generation_failed,
      script: null,
      generating: false,
    });
  });

  it("does not request settings or generate without a vault", async () => {
    vaultState.currentVault = null;

    await useAudioStore.getState().generate(script.title, pages);

    expect(getSettings).not.toHaveBeenCalled();
    expect(generateScript).not.toHaveBeenCalled();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function waitForScript(): Promise<void> {
  await vi.waitFor(() => expect(generateScript).toHaveBeenCalledOnce());
}

async function waitForSave(): Promise<void> {
  await vi.waitFor(() => expect(saveTranscript).toHaveBeenCalledOnce());
}

describe("Audio persistence outcomes and run ownership", () => {
  it("reports a failed save without adopting a successful script and allows retry", async () => {
    saveTranscript.mockRejectedValueOnce(
      new Error("Synthetic transcript save failed"),
    );

    await useAudioStore.getState().generate(script.title, pages);

    expect(useAudioStore.getState()).toMatchObject({
      generating: false,
      script: null,
      transcriptPath: null,
      error: STRINGS.en.au_publication_failed,
    });
    expect(refreshTree).not.toHaveBeenCalled();

    await useAudioStore.getState().generate(script.title, pages);

    expect(generateScript).toHaveBeenCalledTimes(2);
    expect(saveTranscript).toHaveBeenCalledTimes(2);
    expect(useAudioStore.getState()).toMatchObject({
      generating: false,
      script,
      transcriptPath: "/synthetic/audio/audio/overview.md",
      error: null,
    });
    expect(refreshTree).toHaveBeenCalledOnce();
  });

  it("does not start while the vault is opening", async () => {
    vaultState.isOpeningVault = true;

    await useAudioStore.getState().generate(script.title, pages);

    expect(getSettings).not.toHaveBeenCalled();
    expect(generateScript).not.toHaveBeenCalled();
    expect(saveTranscript).not.toHaveBeenCalled();
    expect(useAudioStore.getState().generating).toBe(false);
  });

  it("does not start a duplicate generation in the same opening", async () => {
    const pending = deferred<AudioScript>();
    generateScript.mockReturnValueOnce(pending.promise);
    const run = useAudioStore.getState().generate(script.title, pages);
    await waitForScript();

    await useAudioStore.getState().generate("Duplicate", pages);

    expect(getSettings).toHaveBeenCalledOnce();
    expect(generateScript).toHaveBeenCalledOnce();
    pending.resolve(script);
    await run;
  });

  it("reset invalidates a settings lookup before model execution", async () => {
    const pending = deferred<MycoSettings>();
    getSettings.mockReturnValueOnce(pending.promise);
    const run = useAudioStore.getState().generate(script.title, pages);

    useAudioStore.getState().reset();
    pending.resolve(settings());
    await run;

    expect(generateScript).not.toHaveBeenCalled();
    expect(saveTranscript).not.toHaveBeenCalled();
    expect(useAudioStore.getState()).toMatchObject({
      generating: false,
      script: null,
      transcriptPath: null,
      error: null,
    });
  });

  it.each(["vault-switch", "same-path-reopen", "opening-started"])(
    "%s during settings lookup prevents model execution",
    async (transition) => {
      const pending = deferred<MycoSettings>();
      getSettings.mockReturnValueOnce(pending.promise);
      const run = useAudioStore.getState().generate(script.title, pages);
      if (transition === "vault-switch") {
        vaultState.currentVault = {
          path: "/synthetic/next-audio",
          name: "Next fixture",
        };
      } else if (transition === "same-path-reopen") {
        vaultState.vaultToken = "synthetic-opening-b";
      } else {
        vaultState.isOpeningVault = true;
      }
      pending.resolve(settings());
      await run;

      expect(generateScript).not.toHaveBeenCalled();
      expect(saveTranscript).not.toHaveBeenCalled();
      expect(useAudioStore.getState()).toMatchObject({
        generating: false,
        script: null,
        transcriptPath: null,
        error: null,
      });
    },
  );

  it.each(["resolve", "reject"])(
    "reset ignores a late model %s without saving or adopting its outcome",
    async (outcome) => {
      const pending = deferred<AudioScript>();
      generateScript.mockReturnValueOnce(pending.promise);
      const run = useAudioStore.getState().generate(script.title, pages);
      await waitForScript();
      useAudioStore.getState().reset();
      if (outcome === "resolve") pending.resolve(script);
      else pending.reject(new Error("Synthetic stale model error"));
      await run;

      expect(saveTranscript).not.toHaveBeenCalled();
      expect(refreshTree).not.toHaveBeenCalled();
      expect(useAudioStore.getState()).toMatchObject({
        generating: false,
        script: null,
        transcriptPath: null,
        error: null,
      });
    },
  );

  it.each(["vault-switch", "same-path-reopen", "opening-started"])(
    "%s during model execution prevents starting a stale transcript write",
    async (transition) => {
      const pending = deferred<AudioScript>();
      generateScript.mockReturnValueOnce(pending.promise);
      const run = useAudioStore.getState().generate(script.title, pages);
      await waitForScript();
      if (transition === "vault-switch") {
        vaultState.currentVault = {
          path: "/synthetic/next-audio",
          name: "Next fixture",
        };
      } else if (transition === "same-path-reopen") {
        vaultState.vaultToken = "synthetic-opening-b";
      } else {
        vaultState.isOpeningVault = true;
      }
      pending.resolve(script);
      await run;

      expect(saveTranscript).not.toHaveBeenCalled();
      expect(refreshTree).not.toHaveBeenCalled();
      expect(useAudioStore.getState()).toMatchObject({
        generating: false,
        script: null,
        transcriptPath: null,
        error: null,
      });
    },
  );

  it.each(["resolve", "reject"])(
    "reset ignores a late save %s instead of adopting a transcript or error",
    async (outcome) => {
      const pending = deferred<string>();
      saveTranscript.mockReturnValueOnce(pending.promise);
      const run = useAudioStore.getState().generate(script.title, pages);
      await waitForSave();
      useAudioStore.getState().reset();
      if (outcome === "resolve")
        pending.resolve("/synthetic/audio/audio/stale.md");
      else pending.reject(new Error("Synthetic stale save error"));
      await run;

      expect(refreshTree).not.toHaveBeenCalled();
      expect(useAudioStore.getState()).toMatchObject({
        generating: false,
        script: null,
        transcriptPath: null,
        error: null,
      });
    },
  );

  it("a same-path reopen ignores an in-flight save's late success", async () => {
    const pending = deferred<string>();
    saveTranscript.mockReturnValueOnce(pending.promise);
    const run = useAudioStore.getState().generate(script.title, pages);
    await waitForSave();
    vaultState.vaultToken = "synthetic-opening-b";
    pending.resolve("/synthetic/audio/audio/stale.md");
    await run;

    expect(refreshTree).not.toHaveBeenCalled();
    expect(useAudioStore.getState()).toMatchObject({
      generating: false,
      script: null,
      transcriptPath: null,
      error: null,
    });
  });

  it("a replaced run cannot clear a newer run's busy state or save its late script", async () => {
    const oldScript = deferred<AudioScript>();
    const newScript = deferred<AudioScript>();
    generateScript
      .mockReturnValueOnce(oldScript.promise)
      .mockReturnValueOnce(newScript.promise);
    const oldRun = useAudioStore.getState().generate(script.title, pages);
    await waitForScript();
    useAudioStore.getState().reset();
    const newRun = useAudioStore.getState().generate("New overview", pages);
    await vi.waitFor(() => expect(generateScript).toHaveBeenCalledTimes(2));

    oldScript.resolve(script);
    await oldRun;

    expect(saveTranscript).not.toHaveBeenCalled();
    expect(useAudioStore.getState()).toMatchObject({
      generating: true,
      script: null,
      transcriptPath: null,
      error: null,
    });
    const newer = { ...script, title: "New overview" };
    newScript.resolve(newer);
    await newRun;
    expect(saveTranscript).toHaveBeenCalledOnce();
    expect(useAudioStore.getState().script).toEqual(newer);
  });

  it.each(["resolve", "reject"])(
    "a new opening can start its own run while an old save is pending (%s)",
    async (outcome) => {
      const oldSave = deferred<string>();
      saveTranscript.mockReturnValueOnce(oldSave.promise);
      const oldRun = useAudioStore.getState().generate(script.title, pages);
      await waitForSave();
      vaultState.vaultToken = "synthetic-opening-b";
      const newer = { ...script, title: "New opening overview" };
      generateScript.mockResolvedValueOnce(newer);

      await useAudioStore.getState().generate(newer.title, pages);

      expect(generateScript).toHaveBeenCalledTimes(2);
      expect(useAudioStore.getState()).toMatchObject({
        generating: false,
        script: newer,
        transcriptPath: "/synthetic/audio/audio/overview.md",
        error: null,
      });
      if (outcome === "resolve")
        oldSave.resolve("/synthetic/audio/audio/stale.md");
      else oldSave.reject(new Error("Synthetic stale save error"));
      await oldRun;
      expect(useAudioStore.getState()).toMatchObject({
        generating: false,
        script: newer,
        transcriptPath: "/synthetic/audio/audio/overview.md",
        error: null,
      });
      expect(refreshTree).toHaveBeenCalledOnce();
    },
  );
});

describe("Native Audio cancellation and partial ownership", () => {
  const job: AudioOverviewJobContext = {
    jobId: "synthetic-store-audio-job",
    origin: { vaultPath: "/synthetic/audio", openingToken: "synthetic-native-opening-a" },
  };

  function registerPending(pending: Promise<AudioScript>, context = job) {
    generateScript.mockImplementationOnce(async (
      _vault: string, _pages: string[], _title: string, lifecycle: AudioGenerationLifecycle,
    ) => {
      lifecycle.onJob(context);
      return pending;
    });
  }

  it("reset cancels only the registered old job and ignores its later script", async () => {
    const pending = deferred<AudioScript>();
    registerPending(pending.promise);
    const run = useAudioStore.getState().generate(script.title, pages);
    await waitForScript();
    useAudioStore.getState().reset();
    expect(cancelAudioOverview).toHaveBeenCalledWith(job);
    pending.resolve(script);
    await run;
    expect(saveTranscript).not.toHaveBeenCalled();
    expect(cancelAudioOverview.mock.calls.every(([context]) => context === job)).toBe(true);
    expect(useAudioStore.getState()).toMatchObject({ script: null, transcriptPath: null, error: null });
  });

  it("provides a stale lifecycle for a begin that returns after reset", async () => {
    const begin = deferred<AudioOverviewJobContext>();
    generateScript.mockImplementationOnce(async (
      _vault: string, _pages: string[], _title: string, lifecycle: AudioGenerationLifecycle,
    ) => {
      const context = await begin.promise;
      lifecycle.onJob(context);
      expect(lifecycle.isCurrent()).toBe(false);
      throw new AudioOverviewError("stale");
    });
    const run = useAudioStore.getState().generate(script.title, pages);
    await waitForScript();
    useAudioStore.getState().reset();
    expect(cancelAudioOverview).not.toHaveBeenCalled();
    begin.resolve(job);
    await run;
    expect(cancelAudioOverview).toHaveBeenCalledWith(job);
    expect(saveTranscript).not.toHaveBeenCalled();
    expect(useAudioStore.getState()).toMatchObject({ generating: false, error: null });
  });

  it("generation Stop invalidates immediately and awaits cancellation of its exact job", async () => {
    const pending = deferred<AudioScript>();
    const cancellation = deferred<void>();
    registerPending(pending.promise);
    cancelAudioOverview.mockReturnValue(cancellation.promise);
    const run = useAudioStore.getState().generate(script.title, pages);
    await waitForScript();
    let stopped = false;
    const stop = useAudioStore.getState().cancelGeneration().then(() => { stopped = true; });
    expect(useAudioStore.getState()).toMatchObject({ generating: false, error: STRINGS.en.au_stopped });
    expect(cancelAudioOverview).toHaveBeenCalledWith(job);
    await Promise.resolve();
    expect(stopped).toBe(false);
    cancellation.resolve(undefined);
    await stop;
    pending.resolve(script);
    await run;
    expect(saveTranscript).not.toHaveBeenCalled();
    expect(useAudioStore.getState().error).toBe(STRINGS.en.au_stopped);
  });

  it("playback Stop cancels TTS without cancelling a registered generation", async () => {
    const pending = deferred<AudioScript>();
    registerPending(pending.promise);
    const run = useAudioStore.getState().generate(script.title, pages);
    await waitForScript();
    useAudioStore.setState({ script });
    useAudioStore.getState().play();
    useAudioStore.getState().stop();
    expect(speechCancel).toHaveBeenCalledOnce();
    expect(cancelAudioOverview).not.toHaveBeenCalled();
    expect(useAudioStore.getState().generating).toBe(true);
    pending.resolve(script);
    await run;
    expect(saveTranscript).toHaveBeenCalledOnce();
  });

  it("retains a partial native publication without a success script or automatic cancellation", async () => {
    generateScript.mockImplementationOnce(async (
      _vault: string, _pages: string[], _title: string, lifecycle: AudioGenerationLifecycle,
    ) => {
      lifecycle.onJob(job);
      return script;
    });
    const retained = "/synthetic/audio/audio/partial.md";
    saveTranscript.mockRejectedValueOnce(new AudioOverviewError("partial", retained));
    await useAudioStore.getState().generate(script.title, pages);
    expect(useAudioStore.getState()).toMatchObject({
      generating: false, script: null, transcriptPath: null,
      error: STRINGS.en.au_publication_partial.replace("{path}", retained),
    });
    expect(cancelAudioOverview).not.toHaveBeenCalled();
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it("a stale cancellation failure cannot overwrite a newer job or clear its busy state", async () => {
    const oldScript = deferred<AudioScript>();
    const newScript = deferred<AudioScript>();
    const cancellation = deferred<void>();
    registerPending(oldScript.promise);
    cancelAudioOverview.mockReturnValue(cancellation.promise);
    const oldRun = useAudioStore.getState().generate(script.title, pages);
    await waitForScript();
    const stop = useAudioStore.getState().cancelGeneration();
    const newerJob = { ...job, jobId: "synthetic-new-audio-job" };
    registerPending(newScript.promise, newerJob);
    const newRun = useAudioStore.getState().generate("New overview", pages);
    await vi.waitFor(() => expect(generateScript).toHaveBeenCalledTimes(2));
    cancellation.reject(new Error("Synthetic private cancellation failure"));
    await stop;
    expect(useAudioStore.getState()).toMatchObject({ generating: true, error: null });
    oldScript.resolve(script);
    await oldRun;
    expect(cancelAudioOverview.mock.calls.every(([context]) => context === job)).toBe(true);
    expect(useAudioStore.getState()).toMatchObject({ generating: true, error: null });
    newScript.resolve({ ...script, title: "New overview" });
    await newRun;
    expect(useAudioStore.getState().script?.title).toBe("New overview");
  });

  it("reset cancellation failure emits only a static event and cannot resurrect the panel", async () => {
    const pending = deferred<AudioScript>();
    registerPending(pending.promise);
    cancelAudioOverview.mockRejectedValue(new Error("Synthetic private cancellation detail"));
    const run = useAudioStore.getState().generate(script.title, pages);
    await waitForScript();
    useAudioStore.getState().reset();
    await vi.waitFor(() => expect(logWarn).toHaveBeenCalledWith("audio.reset_cancel_unconfirmed"));
    pending.resolve(script);
    await run;
    expect(logWarn.mock.calls.flat()).not.toContain("Synthetic private cancellation detail");
    expect(useAudioStore.getState()).toMatchObject({ generating: false, script: null, error: null });
  });

  it.each(["stopped", "reset", "new-run"])(
    "late begin cancellation failure respects the %s screen owner",
    async (owner) => {
      const begin = deferred<AudioOverviewJobContext>();
      const cleanup = deferred<void>();
      generateScript.mockImplementationOnce(async (
        _vault: string, _pages: string[], _title: string, lifecycle: AudioGenerationLifecycle,
      ) => {
        const context = await begin.promise;
        lifecycle.onJob(context);
        expect(lifecycle.isCurrent()).toBe(false);
        try {
          await cancelAudioOverview(context);
        } catch {
          throw new AudioOverviewError("stale", undefined, true);
        }
        throw new AudioOverviewError("stale");
      });
      cancelAudioOverview.mockReturnValueOnce(cleanup.promise);
      const oldRun = useAudioStore.getState().generate(script.title, pages);
      await waitForScript();
      await useAudioStore.getState().cancelGeneration();
      expect(cancelAudioOverview).not.toHaveBeenCalled();
      expect(useAudioStore.getState().error).toBe(STRINGS.en.au_stopped);

      const newerScript = deferred<AudioScript>();
      let newRun: Promise<void> | undefined;
      if (owner === "reset") useAudioStore.getState().reset();
      if (owner === "new-run") {
        registerPending(newerScript.promise, { ...job, jobId: "synthetic-new-owner-job" });
        newRun = useAudioStore.getState().generate("New owner", pages);
        await vi.waitFor(() => expect(generateScript).toHaveBeenCalledTimes(2));
      }

      begin.resolve(job);
      await vi.waitFor(() => expect(cancelAudioOverview).toHaveBeenCalledWith(job));
      cleanup.reject(new Error("Synthetic private late-begin cleanup failure"));
      await oldRun;
      expect(saveTranscript).not.toHaveBeenCalled();
      expect(cancelAudioOverview.mock.calls.every(([context]) => context === job)).toBe(true);
      expect(useAudioStore.getState()).toMatchObject({
        generating: owner === "new-run",
        script: null,
        transcriptPath: null,
        error: owner === "stopped" ? STRINGS.en.au_cancel_failed : null,
      });
      if (newRun) {
        newerScript.resolve({ ...script, title: "New owner" });
        await newRun;
        expect(useAudioStore.getState().script?.title).toBe("New owner");
      }
    },
  );
});

describe("Local Audio playback language and unavailable state", () => {
  it("clears a prior unavailable-speech error when playback restarts while preserving the saved transcript", () => {
    const path = "/synthetic/audio/audio/saved.md";
    useAudioStore.setState({ script, transcriptPath: path, error: STRINGS.en.au_no_tts });
    useAudioStore.getState().play();
    expect(speechTurns).toHaveBeenCalledOnce();
    expect(useAudioStore.getState()).toMatchObject({
      playing: true,
      error: null,
      script,
      transcriptPath: path,
    });
    useAudioStore.getState().stop();
  });

  it.each(["en", "ko", "ja"] as const)("passes the current %s UI language to speech playback", (lang) => {
    uiState.lang = lang;
    useAudioStore.setState({ script });
    useAudioStore.getState().play();
    expect(speechTurns).toHaveBeenCalledWith(script.turns, 0, {
      lang,
      onTurn: expect.any(Function),
      onDone: expect.any(Function),
      onError: expect.any(Function),
    });
    useAudioStore.getState().stop();
  });

  it("reads the new UI language when playback restarts instead of retaining the previous one", () => {
    useAudioStore.setState({ script });
    uiState.lang = "ko";
    useAudioStore.getState().play();
    expect(speechTurns.mock.calls[0][2]).toMatchObject({ lang: "ko" });
    uiState.lang = "ja";
    useAudioStore.getState().play(0);
    expect(speechTurns.mock.calls[1][2]).toMatchObject({ lang: "ja" });
    useAudioStore.getState().stop();
  });

  it.each(["en", "ko", "ja"] as const)(
    "localizes unavailable local speech in %s without discarding the saved transcript or leaving playback active",
    (lang) => {
      uiState.lang = lang;
      const path = "/synthetic/audio/audio/saved.md";
      useAudioStore.setState({ script, transcriptPath: path, currentTurn: 0 });
      speechTurns.mockImplementationOnce((_turns: unknown, _start: number, opts: SpeakOpts) => {
        opts.onError?.(LOCAL_SPEECH_UNAVAILABLE);
        return { cancel: speechCancel, pause: vi.fn(), resume: vi.fn() };
      });
      useAudioStore.getState().play();
      expect(useAudioStore.getState()).toMatchObject({
        playing: false,
        currentTurn: -1,
        error: STRINGS[lang].au_no_tts,
        script,
        transcriptPath: path,
      });
      expect(getSettings).not.toHaveBeenCalled();
      expect(generateScript).not.toHaveBeenCalled();
      expect(saveTranscript).not.toHaveBeenCalled();
      expect(cancelAudioOverview).not.toHaveBeenCalled();
      useAudioStore.getState().stop();
    },
  );
});
