import { ipc } from "./ipc";
import { useVaultStore } from "../stores/vaultStore";

export type MapHistory = NonNullable<
  Awaited<ReturnType<typeof ipc.latestMapRefreshHistory>>
>;
export type MapHistoryRead =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; error: string }
  | { phase: "ready"; history: MapHistory | null };

/** Read one map only; expired responses (including errors) cannot reach the view. */
export function readMapHistory(
  vaultPath: string,
  vaultToken: string,
  key: string,
  onRead: (read: MapHistoryRead) => void,
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
          "Map history opening does not match the selected vault",
        );
      const history = await ipc.latestMapRefreshHistory(origin, key);
      if (!isCurrent()) return;
      if (
        history !== null &&
        (!history ||
          history.path !== `wiki/maps/${key}.md` ||
          typeof history.before !== "string" ||
          typeof history.after !== "string" ||
          typeof history.hasChangesSinceRefresh !== "boolean")
      )
        throw new Error("Map history response does not match the selected map");
      onRead({ phase: "ready", history });
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
