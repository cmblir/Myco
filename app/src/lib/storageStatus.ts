// Where a vault's folder lives, read from its path alone. myco has no sync of
// its own (ON B5), so this only names the provider the folder sits in.

export type StorageProvider = "icloud" | "dropbox";

/** iCloud Drive / Dropbox from the path, or null when the path cannot tell —
 *  ~/Documents may be iCloud-backed with no trace in it, so no guess. */
export function storageProvider(path: string): StorageProvider | null {
  if (path.includes("/Library/Mobile Documents/")) return "icloud";
  if (/\/Dropbox(\/|$)/.test(path)) return "dropbox";
  return null;
}
