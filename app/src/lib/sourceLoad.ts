import { ipc, type AgentVaultSession } from "./ipc";
import {
  checkedImageContext,
  isImageFile,
  sourceTextFor,
  type ImageIngestContext,
} from "./mediaIngest";
import { effectiveRole, type ModelRoleSelection } from "./modelRoles";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";
import { log } from "./log";
import type { Strings } from "./i18n";

export type SourceLoadFailure =
  | "authority_changed"
  | "capability_unavailable"
  | "credential_unavailable"
  | "whisper_missing"
  | "source_failed";

/** Static failures keep native details, source paths and provider responses out of UI. */
export class SourceLoadError extends Error {
  constructor(readonly code: SourceLoadFailure) {
    super(`Source load failed: ${code}`);
    this.name = "SourceLoadError";
  }
}

export function sourceLoadMessage(error: SourceLoadError, t: Strings): string {
  if (error.code === "whisper_missing") return t.voice_whisper_missing;
  if (error.code === "authority_changed") return t.ing_source_authority_changed;
  if (error.code === "capability_unavailable")
    return t.ing_image_capability_unavailable;
  if (error.code === "credential_unavailable")
    return t.ing_source_credential_unavailable;
  return t.workflow_failed;
}

interface View {
  path: string;
  token: string;
  authorizationRevision: string;
  selection: ModelRoleSelection;
}
interface Job {
  view: View;
  context?: ImageIngestContext;
  requestId: string;
  imageStarted: boolean;
  aborted: Promise<never>;
  rejectAbort: (error: SourceLoadError) => void;
  unsubscribe: (() => void)[];
}
export interface SourceLoader {
  load(path?: string): Promise<void>;
  invalidate(): void;
  dispose(): void;
}
interface SourceLoadOptions {
  onBusy: (busy: boolean) => void;
  onLoaded: (path: string, text: string) => void;
  onError: (error: SourceLoadError) => void;
  beforeRead?: (path: string) => Promise<void>;
}

function captureView(): View {
  const vault = useVaultStore.getState();
  const settings = useSettingsStore.getState().settings;
  if (
    !vault.currentVault ||
    !vault.vaultToken ||
    vault.isOpeningVault ||
    !settings?.role_authorization_revision
  ) {
    throw new SourceLoadError("authority_changed");
  }
  return {
    path: vault.currentVault.path,
    token: vault.vaultToken,
    authorizationRevision: settings.role_authorization_revision,
    selection: { ...effectiveRole(settings, "compilation") },
  };
}

function sameView(view: View): boolean {
  const vault = useVaultStore.getState();
  const settings = useSettingsStore.getState().settings;
  const selected = settings?.model_roles?.roles.compilation;
  return (
    !vault.isOpeningVault &&
    vault.currentVault?.path === view.path &&
    vault.vaultToken === view.token &&
    settings?.role_authorization_revision === view.authorizationRevision &&
    selected?.providerId === view.selection.providerId &&
    selected?.modelId === view.selection.modelId &&
    selected?.effort === view.selection.effort &&
    selected?.selection === view.selection.selection
  );
}

function failure(error: unknown): SourceLoadError {
  if (error instanceof SourceLoadError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "version" in error &&
    error.version === "ImageIngestFailureV1" &&
    "code" in error
  ) {
    if (error.code === "capability_unavailable")
      return new SourceLoadError("capability_unavailable");
    if (error.code === "credential_unavailable")
      return new SourceLoadError("credential_unavailable");
    if (
      error.code === "role_authorization_failed" ||
      error.code === "cancelled"
    ) {
      return new SourceLoadError("authority_changed");
    }
  }
  return new SourceLoadError("source_failed");
}

/** Own one file load from pre-picker capture through adoption. Every await keeps
 * the same opening/selection; invalidation settles promptly and never retargets. */
export function createSourceLoader(options: SourceLoadOptions): SourceLoader {
  let active: Job | null = null;
  let disposed = false;
  const current = (job: Job): boolean =>
    !disposed && active === job && sameView(job.view);
  const check = (job: Job): void => {
    if (!current(job)) throw new SourceLoadError("authority_changed");
  };
  const wait = async <T>(job: Job, pending: Promise<T>): Promise<T> => {
    const result = await Promise.race([pending, job.aborted]);
    check(job);
    return result;
  };
  const release = (job: Job): void =>
    job.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
  function invalidate(): void {
    const previous = active;
    if (!previous) return;
    active = null;
    release(previous);
    previous.rejectAbort(new SourceLoadError("authority_changed"));
    if (previous.imageStarted && previous.context) {
      void ipc
        .cancelImageIngest(previous.context.origin, previous.requestId)
        .catch(() => {
          log.warn("source_load.cancel_failed");
        });
    }
    if (!disposed) options.onBusy(false);
  }
  async function load(path?: string): Promise<void> {
    invalidate();
    if (disposed) return;
    let view: View;
    try {
      view = captureView();
    } catch {
      options.onError(new SourceLoadError("authority_changed"));
      return;
    }
    let rejectAbort!: Job["rejectAbort"];
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    // Invalidation may happen in an observer before the first awaited IPC.
    // The intentional cancellation is consumed again by each wait's race.
    void aborted.catch(() => undefined);
    const job: Job = {
      view,
      requestId: `image-ingest-${crypto.randomUUID()}`,
      imageStarted: false,
      aborted,
      rejectAbort,
      unsubscribe: [],
    };
    active = job;
    const guard = (): void => {
      if (active === job && !sameView(view)) invalidate();
    };
    job.unsubscribe.push(
      useVaultStore.subscribe(guard),
      useSettingsStore.subscribe(guard),
    );
    options.onBusy(true);
    try {
      check(job);
      const captured = await wait(job, ipc.agentVaultSession());
      if (captured.vaultPath !== view.path || !captured.openingToken)
        throw new SourceLoadError("authority_changed");
      const origin: AgentVaultSession = Object.freeze({ ...captured });
      const role = await wait(
        job,
        ipc
          .captureModelRole(origin, "compilation", "foreground")
          .catch((error) => {
            const safeError = failure(error);
            // Capture may reject with a legacy static string. Its failure is an
            // unavailable execution grant, never a failed file read or extraction.
            throw safeError.code === "source_failed"
              ? new SourceLoadError("authority_changed")
              : safeError;
          }),
      );
      const roleSnapshot = Object.freeze({
        ...role,
        origin: Object.freeze({ ...role.origin }),
        routeSignature: Object.freeze({ ...role.routeSignature }),
      });
      try {
        job.context = checkedImageContext({
          origin,
          roleSnapshot,
          requestId: job.requestId,
        });
      } catch {
        throw new SourceLoadError("authority_changed");
      }
      const route = roleSnapshot.routeSignature;
      if (
        roleSnapshot.authorizationRevision !== view.authorizationRevision ||
        route.providerId !== view.selection.providerId ||
        route.modelId !== view.selection.modelId ||
        route.effort !== view.selection.effort
      )
        throw new SourceLoadError("authority_changed");
      const picked = path ?? (await wait(job, ipc.pickTextFile()));
      check(job);
      if (!picked) return;
      if (options.beforeRead) await wait(job, options.beforeRead(picked));
      check(job);
      job.imageStarted = isImageFile(picked);
      const text = await wait(job, sourceTextFor(picked, job.context));
      options.onLoaded(picked, text);
    } catch (error) {
      if (current(job)) {
        const safeError = failure(error);
        log.warn("source_load.failed", { code: safeError.code });
        options.onError(safeError);
      }
    } finally {
      release(job);
      if (active === job) {
        active = null;
        if (!disposed) options.onBusy(false);
      }
    }
  }
  return {
    load,
    invalidate,
    dispose: () => {
      disposed = true;
      invalidate();
    },
  };
}
