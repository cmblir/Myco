import { ipc } from "./ipc";
import { useVaultStore } from "../stores/vaultStore";

export type RecoverySnapshots = Awaited<
  ReturnType<typeof ipc.retainedMapSnapshots>
>;
export type RecoveryRead =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; error: string }
  | { phase: "ready"; snapshots: RecoverySnapshots };

export type CatalogRead =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; error: string }
  | {
      phase: "ready";
      catalog: Awaited<ReturnType<typeof ipc.retainedMapKeys>>;
    };

/** Discover retained names only in the current opening, including absent files. */
export function readMapCatalog(
  vaultPath: string,
  vaultToken: string,
  onRead: (read: CatalogRead) => void,
): { cancel: () => void; finished: Promise<void> } {
  let cancelled = false;
  const isCurrent = () => {
    const active = useVaultStore.getState();
    return (
      !cancelled &&
      !!vaultToken &&
      !active.isOpeningVault &&
      active.currentVault?.path === vaultPath &&
      active.vaultToken === vaultToken
    );
  };
  const finished = (async () => {
    if (!isCurrent()) return;
    onRead({ phase: "loading" });
    try {
      const origin = await ipc.agentVaultSession();
      if (!isCurrent()) return;
      if (origin?.vaultPath !== vaultPath || !origin.openingToken)
        throw new Error(
          "Map catalog opening does not match the selected vault",
        );
      const catalog = await ipc.retainedMapKeys(origin);
      if (!isCurrent()) return;
      if (
        !catalog ||
        !Array.isArray(catalog.keys) ||
        catalog.keys.length > 256 ||
        typeof catalog.hasUnidentifiedRecords !== "boolean" ||
        catalog.keys.some(
          (key) => typeof key !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(key),
        ) ||
        new Set(catalog.keys).size !== catalog.keys.length
      )
        throw new Error("Map catalog response is invalid");
      onRead({ phase: "ready", catalog });
    } catch (error) {
      if (isCurrent()) onRead({ phase: "error", error: String(error) });
    }
  })();
  return {
    cancel: () => {
      cancelled = true;
    },
    finished,
  };
}

function validSnapshots(value: RecoverySnapshots, key: string): boolean {
  if (
    !value ||
    value.path !== `wiki/maps/${key}.md` ||
    !Array.isArray(value.records) ||
    value.records.length > 256
  )
    return false;
  const ids = new Set<string>();
  return value.records.every((record) => {
    if (
      !record ||
      typeof record.recordId !== "string" ||
      !/^[a-f0-9]{64}\.[a-f0-9]{32}\.json$/.test(record.recordId) ||
      ids.has(record.recordId)
    )
      return false;
    ids.add(record.recordId);
    if (record.evidence === "invalidRecord")
      return record.before === null && record.after === null;
    return (
      (record.evidence === "currentObject" ||
        record.evidence === "publicationUnknown") &&
      (record.before === null || typeof record.before === "string") &&
      typeof record.after === "string"
    );
  });
}

/** Read-only observations; cancellation and opening changes discard every late response. */
export function readMapRecovery(
  vaultPath: string,
  vaultToken: string,
  key: string,
  onRead: (read: RecoveryRead) => void,
): { cancel: () => void; finished: Promise<void> } {
  let cancelled = false;
  const isCurrent = () => {
    const active = useVaultStore.getState();
    return (
      !cancelled &&
      !!vaultToken &&
      !active.isOpeningVault &&
      active.currentVault?.path === vaultPath &&
      active.vaultToken === vaultToken
    );
  };
  const finished = (async () => {
    if (!isCurrent()) return;
    onRead({ phase: "loading" });
    try {
      const origin = await ipc.agentVaultSession();
      if (!isCurrent()) return;
      if (origin?.vaultPath !== vaultPath || !origin.openingToken)
        throw new Error(
          "Map recovery opening does not match the selected vault",
        );
      const snapshots = await ipc.retainedMapSnapshots(origin, key);
      if (!isCurrent()) return;
      if (!validSnapshots(snapshots, key))
        throw new Error(
          "Map recovery response does not match the selected map",
        );
      onRead({ phase: "ready", snapshots });
    } catch (error) {
      if (isCurrent()) onRead({ phase: "error", error: String(error) });
    }
  })();
  return {
    cancel: () => {
      cancelled = true;
    },
    finished,
  };
}
