import { beforeEach } from "vitest";

// Node's native localStorage depends on a backing file and varies by version.
// Give every isolated test file browser-like persistence without touching disk.
class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
  getItem(key: string): string | null {
    return this.entries.get(String(key)) ?? null;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.entries.delete(String(key));
  }
  setItem(key: string, value: string): void {
    this.entries.set(String(key), String(value));
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: storage,
});
beforeEach(() => storage.clear());
