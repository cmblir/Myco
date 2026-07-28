// One-time rename of persisted browser-storage keys from the old product name
// (Memex) to the new one (myco).
//
// This module is imported for its side effect as the FIRST import of main.tsx.
// That placement is load-bearing: several consumers read their key while their
// module is being evaluated (zustand's `persist` rehydrates when the store is
// created), so the rename has to happen before any of them are imported. Miss
// it and onboarding re-appears, the last vault is forgotten, and saved graph
// looks are lost.

/** Old key → new key. Exported so tests can assert the list is complete. */
export const RENAMED_STORAGE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["memex.errorlog", "myco.errorlog"],
  ["memex.onboarded", "myco.onboarded"],
  ["memex.lastVaultPath", "myco.lastVaultPath"],
  ["memex.graph.settings.v26", "myco.graph.settings.v26"],
  ["memex.graph.savedLooks.v1", "myco.graph.savedLooks.v1"],
  ["memex.graph.clusterTopics.v1", "myco.graph.clusterTopics.v1"],
  ["memex.linkSuggestions.dismissed.v1", "myco.linkSuggestions.dismissed.v1"],
  ["memex.queryViews.v1", "myco.queryViews.v1"],
  ["memex.budget.usage.v1", "myco.budget.usage.v1"],
  ["memex.budget.threshold.v1", "myco.budget.threshold.v1"],
  // zustand persist store name — keep its `version` untouched so the store's
  // own migrations still see the version they wrote.
  ["memex-ui", "myco-ui"],
];

/**
 * Move any value still stored under an old key to its new key. Idempotent: a
 * value already present under the new key wins and the stale old key is
 * dropped. Never throws — localStorage can be unavailable or full, and losing
 * the rename is better than failing to boot.
 */
export function migrateLegacyStorageKeys(storage: Storage = localStorage): void {
  for (const [oldKey, newKey] of RENAMED_STORAGE_KEYS) {
    try {
      const legacy = storage.getItem(oldKey);
      if (legacy === null) continue;
      if (storage.getItem(newKey) === null) {
        storage.setItem(newKey, legacy);
      }
      storage.removeItem(oldKey);
    } catch {
      // Best-effort per key: one failure must not stop the rest.
    }
  }
}

try {
  migrateLegacyStorageKeys();
} catch {
  // `localStorage` itself can throw on access in a sandboxed context.
}
