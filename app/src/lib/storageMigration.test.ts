import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RENAMED_STORAGE_KEYS, migrateLegacyStorageKeys } from "./storageMigration";

/** Minimal in-memory Storage — the node test environment has no localStorage. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

describe("migrateLegacyStorageKeys", () => {
  it("moves a legacy value to the new key and drops the old one", () => {
    const s = fakeStorage({ "memex.onboarded": "1", "memex-ui": '{"state":{}}' });
    migrateLegacyStorageKeys(s);
    expect(s.getItem("myco.onboarded")).toBe("1");
    expect(s.getItem("myco-ui")).toBe('{"state":{}}');
    expect(s.getItem("memex.onboarded")).toBeNull();
    expect(s.getItem("memex-ui")).toBeNull();
  });

  it("keeps an existing new value when both are present, and clears the stale one", () => {
    const s = fakeStorage({ "memex.lastVaultPath": "/old", "myco.lastVaultPath": "/new" });
    migrateLegacyStorageKeys(s);
    expect(s.getItem("myco.lastVaultPath")).toBe("/new");
    expect(s.getItem("memex.lastVaultPath")).toBeNull();
  });

  it("is idempotent and leaves unrelated keys alone", () => {
    const s = fakeStorage({ "memex.errorlog": "[]", unrelated: "keep" });
    migrateLegacyStorageKeys(s);
    migrateLegacyStorageKeys(s);
    expect(s.getItem("myco.errorlog")).toBe("[]");
    expect(s.getItem("unrelated")).toBe("keep");
    expect(s.length).toBe(2);
  });

  it("survives a storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    expect(() => migrateLegacyStorageKeys(throwing)).not.toThrow();
  });

  it("maps every old key to the same name under the new prefix, with no duplicates", () => {
    for (const [oldKey, newKey] of RENAMED_STORAGE_KEYS) {
      expect(newKey).toBe(oldKey.replace(/^memex/, "myco"));
    }
    const news = RENAMED_STORAGE_KEYS.map(([, n]) => n);
    expect(new Set(news).size).toBe(news.length);
  });
});

// Regression guard for the rebrand: a newly added `memex.*` storage key would
// be invisible to the migration above, so fail the build instead.
describe("source tree", () => {
  const srcRoot = new URL("../", import.meta.url);

  function* walk(dir: URL): Generator<URL> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) yield* walk(child);
      else if (/\.tsx?$/.test(entry.name)) yield child;
    }
  }

  it("has no leftover legacy storage keys", () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      if (/storageMigration\.(ts|test\.ts)$/.test(file.pathname)) continue;
      const text = readFileSync(file, "utf8");
      // Storage-key shapes only: a dotted `memex.*` literal, or the zustand
      // persist name. Other `memex-*` literals (CSS classes, the `memex-pro`
      // provider id) are not storage and are renamed by their own stages.
      for (const m of text.matchAll(/["'`](memex\.[\w.]*|memex-ui)["'`]/g)) {
        offenders.push(`${file.pathname.split("/src/")[1]}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
