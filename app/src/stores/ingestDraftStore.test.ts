import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIngestDraftStore } from "./ingestDraftStore";

const ROOT_A = "/synthetic/vault-a";
const ROOT_B = "/synthetic/vault-b";

describe("durable Ingest drafts", () => {
  beforeEach(() => localStorage.clear());

  it("restores both fields after navigation and a fresh store instance", () => {
    const first = createIngestDraftStore();
    first.getState().edit(ROOT_A, { title: "Source A", body: "Synthetic draft body" });
    first.getState().load(ROOT_A);
    expect(first.getState().drafts[ROOT_A]).toMatchObject({ title: "Source A", body: "Synthetic draft body" });
    const reopened = createIngestDraftStore();
    reopened.getState().load(ROOT_A);
    expect(reopened.getState().drafts[ROOT_A]).toMatchObject({ title: "Source A", body: "Synthetic draft body" });
  });

  it("isolates vault drafts and does not migrate A's text into B", () => {
    const store = createIngestDraftStore();
    store.getState().edit(ROOT_A, { title: "A", body: "First source" });
    store.getState().load(ROOT_B);
    expect(store.getState().drafts[ROOT_B]).toMatchObject({ title: "", body: "" });
    store.getState().edit(ROOT_B, { body: "Second source" });
    store.getState().discard(ROOT_B);
    const reopened = createIngestDraftStore();
    reopened.getState().load(ROOT_A);
    reopened.getState().load(ROOT_B);
    expect(reopened.getState().drafts[ROOT_A]?.body).toBe("First source");
    expect(reopened.getState().drafts[ROOT_B]?.body).toBe("");
  });

  it.each(["failed", "stopped", "partial", "pending", "skipped", null] as const)(
    "retains the submitted draft for a %s outcome", (workflowStatus) => {
      const store = createIngestDraftStore();
      store.getState().edit(ROOT_A, { body: "Keep this source" });
      const submitted = store.getState().drafts[ROOT_A]!;
      store.getState().complete(ROOT_A, submitted.revision, workflowStatus);
      expect(store.getState().drafts[ROOT_A]?.body).toBe("Keep this source");
    },
  );

  it("clears only the exact successful submission and persists that clear", () => {
    const store = createIngestDraftStore();
    store.getState().edit(ROOT_A, { title: "Done", body: "Saved source" });
    const submitted = store.getState().drafts[ROOT_A]!;
    store.getState().complete(ROOT_A, submitted.revision, "success");
    const reopened = createIngestDraftStore();
    reopened.getState().load(ROOT_A);
    expect(reopened.getState().drafts[ROOT_A]).toMatchObject({ title: "", body: "" });
  });

  it("does not clear newer typing, even when the body was changed back", () => {
    const store = createIngestDraftStore();
    store.getState().edit(ROOT_A, { title: "Draft", body: "Same source" });
    const submitted = store.getState().drafts[ROOT_A]!;
    store.getState().edit(ROOT_A, { body: "Changed source" });
    store.getState().edit(ROOT_A, { body: "Same source" });
    store.getState().complete(ROOT_A, submitted.revision, "success");
    expect(store.getState().drafts[ROOT_A]?.body).toBe("Same source");
  });

  it("does not clear a new draft after successful completion in another vault", () => {
    const store = createIngestDraftStore();
    store.getState().edit(ROOT_A, { body: "Submitted A" });
    const submitted = store.getState().drafts[ROOT_A]!;
    store.getState().edit(ROOT_B, { body: "Unsubmitted B" });
    store.getState().complete(ROOT_A, submitted.revision, "success");
    expect(store.getState().drafts[ROOT_B]?.body).toBe("Unsubmitted B");
  });

  it("retains memory input on quota failure and makes retry durable", () => {
    let canWrite = false;
    const backing = localStorage;
    const storage = {
      getItem: (key: string) => backing.getItem(key),
      setItem: (key: string, value: string) => {
        if (!canWrite) throw new DOMException("Storage quota exhausted", "QuotaExceededError");
        backing.setItem(key, value);
      },
      removeItem: (key: string) => backing.removeItem(key),
    };
    const store = createIngestDraftStore(() => storage);
    store.getState().edit(ROOT_A, { title: "Retain", body: "Unsaved source" });
    expect(store.getState().drafts[ROOT_A]).toMatchObject({ body: "Unsaved source", storageError: "save" });
    canWrite = true;
    store.getState().retry(ROOT_A);
    expect(store.getState().drafts[ROOT_A]?.storageError).toBeNull();
    const reopened = createIngestDraftStore();
    reopened.getState().load(ROOT_A);
    expect(reopened.getState().drafts[ROOT_A]?.body).toBe("Unsaved source");
  });

  it("recovers only the originating vault's latest input after repeated write failures", () => {
    const failedKeys = new Set<string>();
    const storage = {
      getItem: (key: string) => localStorage.getItem(key),
      setItem: (key: string, value: string) => {
        if (failedKeys.has(key)) throw new DOMException("Storage quota exhausted", "QuotaExceededError");
        localStorage.setItem(key, value);
      },
      removeItem: (key: string) => localStorage.removeItem(key),
    };
    const store = createIngestDraftStore(() => storage);
    store.getState().edit(ROOT_A, { title: "Saved A", body: "Original A" });
    store.getState().edit(ROOT_B, { title: "Saved B", body: "Original B" });
    for (let index = 0; index < localStorage.length; index++) {
      failedKeys.add(localStorage.key(index)!);
    }

    store.getState().edit(ROOT_A, { body: "First unsaved A" });
    store.getState().edit(ROOT_B, { body: "Unsaved B" });
    store.getState().edit(ROOT_A, { title: "Latest A", body: "Latest unsaved A" });
    store.getState().retry(ROOT_A);
    expect(store.getState().drafts[ROOT_A]).toMatchObject({
      title: "Latest A", body: "Latest unsaved A", storageError: "save",
    });
    expect(store.getState().drafts[ROOT_B]).toMatchObject({ body: "Unsaved B", storageError: "save" });

    failedKeys.clear();
    store.getState().retry(ROOT_A);
    expect(store.getState().drafts[ROOT_A]?.storageError).toBeNull();
    expect(store.getState().drafts[ROOT_B]?.storageError).toBe("save");
    const reopened = createIngestDraftStore();
    reopened.getState().load(ROOT_A);
    reopened.getState().load(ROOT_B);
    expect(reopened.getState().drafts[ROOT_A]).toMatchObject({ title: "Latest A", body: "Latest unsaved A" });
    expect(reopened.getState().drafts[ROOT_B]).toMatchObject({ title: "Saved B", body: "Original B" });

    store.getState().retry(ROOT_B);
    const afterBothRetries = createIngestDraftStore();
    afterBothRetries.getState().load(ROOT_A);
    afterBothRetries.getState().load(ROOT_B);
    expect(afterBothRetries.getState().drafts[ROOT_A]?.body).toBe("Latest unsaved A");
    expect(afterBothRetries.getState().drafts[ROOT_B]?.body).toBe("Unsaved B");
  });

  it("retries a failed read without overwriting the previously saved draft", () => {
    const first = createIngestDraftStore();
    first.getState().edit(ROOT_A, { body: "Saved before restart" });
    let canRead = false;
    const storage = {
      getItem: (key: string) => {
        if (!canRead) throw new Error("Storage is unavailable");
        return localStorage.getItem(key);
      },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const reopened = createIngestDraftStore(() => storage);
    reopened.getState().load(ROOT_A);
    expect(reopened.getState().drafts[ROOT_A]?.storageError).toBe("load");
    expect(storage.setItem).not.toHaveBeenCalled();
    canRead = true;
    reopened.getState().retry(ROOT_A);
    expect(reopened.getState().drafts[ROOT_A]).toMatchObject({ body: "Saved before restart", storageError: null });
  });

  it("retains current input when clearing the saved revision fails", () => {
    const storage = {
      getItem: (key: string) => localStorage.getItem(key),
      setItem: (key: string, value: string) => localStorage.setItem(key, value),
      removeItem: () => { throw new Error("Storage is unavailable"); },
    };
    const store = createIngestDraftStore(() => storage);
    store.getState().edit(ROOT_A, { body: "Keep until clear is durable" });
    store.getState().discard(ROOT_A);
    expect(store.getState().drafts[ROOT_A]).toMatchObject({ body: "Keep until clear is durable", storageError: "clear" });
  });

  it.each(["{broken", JSON.stringify({ version: 1, root: ROOT_B, title: "Wrong vault", body: "Other source", revision: "r1" }),
    JSON.stringify({ version: 1, root: ROOT_A, title: 7, body: "Invalid title", revision: "r1" })])(
    "exposes malformed or wrong-vault storage instead of treating it as a loaded draft", (raw) => {
      const storage = { getItem: () => raw, setItem: vi.fn(), removeItem: vi.fn() };
      const store = createIngestDraftStore(() => storage);
      store.getState().load(ROOT_A);
      expect(store.getState().drafts[ROOT_A]).toMatchObject({ title: "", body: "", storageError: "load" });
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    },
  );

  it("a retry after failed clearing cannot discard subsequently typed text", () => {
    let canClear = false;
    const storage = {
      getItem: (key: string) => localStorage.getItem(key),
      setItem: (key: string, value: string) => localStorage.setItem(key, value),
      removeItem: (key: string) => {
        if (!canClear) throw new Error("Storage unavailable");
        localStorage.removeItem(key);
      },
    };
    const store = createIngestDraftStore(() => storage);
    store.getState().edit(ROOT_A, { body: "Submitted source" });
    store.getState().complete(ROOT_A, store.getState().drafts[ROOT_A]!.revision, "success");
    store.getState().edit(ROOT_A, { body: "Newer source" });
    canClear = true;
    store.getState().retry(ROOT_A);
    expect(store.getState().drafts[ROOT_A]).toMatchObject({ body: "Newer source", storageError: null });
  });
});
