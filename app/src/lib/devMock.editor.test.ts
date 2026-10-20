// Browser-only editor CAS exercises synthetic memory, never native authority.
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentVaultSession,
  EditorFileSnapshot,
  EditorWriteReceipt,
} from "./ipc";
import { installTauriMock } from "./devMock";

function invoke<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const surface = window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: (name: string, input: unknown) => Promise<T>;
    };
  };
  return surface.__TAURI_INTERNALS__.invoke(command, args);
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const original = "---\ntitle: Synthetic editor\n---\n\nOriginal A.\n";
const external = "---\ntitle: Synthetic editor\n---\n\nExternal B.\n";
const draft = "---\ntitle: Synthetic editor\n---\n\nDraft A.\n";
let serial = 0;
let path: string;
let origin: AgentVaultSession;

beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window ??= globalThis;
  installTauriMock();
});
beforeEach(async () => {
  await invoke("open_vault", { path: "/myco" });
  origin = await invoke<AgentVaultSession>("agent_vault_session");
  path = `/myco/wiki/synthetic-editor-${++serial}.md`;
  await invoke("write_file", { path, content: original });
});

describe("explicit browser demo editor receipts", () => {
  it("keeps synthetic A/D through a conflict and reopening without minting write authority", async () => {
    const read = await invoke<EditorFileSnapshot>("read_editor_file", { path, origin });
    await invoke("write_file", { path, content: external });
    const checkpoint = await invoke<Record<string, unknown>>("stage_editor_draft", {
      path, origin, expectedSha256: read.revision, draft, expectedJournalRevision: null,
    });
    expect(checkpoint).toMatchObject({ path, origin, baselineRaw: original,
      baselineRevision: sha(original), draftRaw: draft, mockOnly: true });
    await expect(invoke("write_editor_file", {
      path, origin, expectedSha256: read.revision, content: draft,
    })).rejects.toThrow("conflict");
    await invoke("open_vault", { path: "/myco" });
    const fresh = await invoke<AgentVaultSession>("agent_vault_session");
    expect(await invoke("read_editor_draft", { path, origin: fresh })).toEqual(checkpoint);
    await expect(invoke("write_editor_file", {
      path, origin, expectedSha256: sha(external), content: draft,
    })).rejects.toThrow("MOCK_EDITOR_STALE_OPENING");
    expect((await invoke<{ raw: string }>("read_file", { path })).raw).toBe(external);
  });

  it("uses checkpoint revisions instead of equal draft text for synthetic ABA", async () => {
    const read = await invoke<EditorFileSnapshot>("read_editor_file", { path, origin });
    const first = await invoke<{ revision: string }>("stage_editor_draft", {
      path, origin, expectedSha256: read.revision, draft, expectedJournalRevision: null,
    });
    const second = await invoke<{ revision: string }>("stage_editor_draft", {
      path, origin, expectedSha256: read.revision, draft, expectedJournalRevision: first.revision,
    });
    expect(second.revision).not.toBe(first.revision);
    await expect(invoke("retire_editor_draft", {
      path, origin, expectedJournalRevision: first.revision,
    })).rejects.toThrow("MOCK_EDITOR_JOURNAL_CONFLICT");
    expect(await invoke("read_editor_draft", { path, origin })).toEqual(second);
    await invoke("retire_editor_draft", { path, origin, expectedJournalRevision: second.revision });
    expect(await invoke("read_editor_draft", { path, origin })).toBeNull();
    expect((await invoke<{ raw: string }>("read_file", { path })).raw).toBe(original);
  });

  it("marks exact-byte reads and persisted writes as mock only", async () => {
    const snapshot = await invoke<EditorFileSnapshot>("read_editor_file", {
      path,
      origin,
    });
    expect(snapshot).toMatchObject({
      file: { path, raw: original },
      origin,
      revision: sha(original),
      mockOnly: true,
    });
    const receipt = await invoke<EditorWriteReceipt>("write_editor_file", {
      path,
      content: draft,
      expectedSha256: snapshot.revision,
      origin,
    });
    expect(receipt).toEqual({
      path,
      origin,
      revision: sha(draft),
      mockOnly: true,
    });
    expect((await invoke<{ raw: string }>("read_file", { path })).raw).toBe(
      draft,
    );
  });

  it("preserves B when an A-based draft conflicts with the synthetic disk", async () => {
    const snapshot = await invoke<EditorFileSnapshot>("read_editor_file", {
      path,
      origin,
    });
    await invoke("write_file", { path, content: external });
    await expect(
      invoke("write_editor_file", {
        path,
        content: draft,
        expectedSha256: snapshot.revision,
        origin,
      }),
    ).rejects.toThrow("conflict");
    expect((await invoke<{ raw: string }>("read_file", { path })).raw).toBe(
      external,
    );
  });

  it.each([undefined, null, "bad"])(
    "refuses a missing or malformed first-read SHA: %s",
    async (expectedSha256) => {
      await expect(
        invoke("write_editor_file", {
          path,
          content: draft,
          expectedSha256,
          origin,
        }),
      ).rejects.toThrow("MOCK_EDITOR_BASELINE_REQUIRED");
      expect((await invoke<{ raw: string }>("read_file", { path })).raw).toBe(
        original,
      );
    },
  );

  it("rejects old read and save origins after the same demo vault reopens", async () => {
    await invoke("open_vault", { path: "/myco" });
    const fresh = await invoke<AgentVaultSession>("agent_vault_session");
    expect(fresh.openingToken).not.toBe(origin.openingToken);
    await expect(invoke("read_editor_file", { path, origin })).rejects.toThrow(
      "MOCK_EDITOR_STALE_OPENING",
    );
    await expect(
      invoke("write_editor_file", {
        path,
        content: draft,
        expectedSha256: sha(original),
        origin,
      }),
    ).rejects.toThrow("MOCK_EDITOR_STALE_OPENING");
    expect((await invoke<{ raw: string }>("read_file", { path })).raw).toBe(
      original,
    );
  });

  it("allows original reads while refusing raw and outside editor writes", async () => {
    const raw = `/myco/raw/synthetic-editor-${serial}.md`;
    await invoke("write_file", { path: raw, content: original });
    const snapshot = await invoke<EditorFileSnapshot>("read_editor_file", {
      path: raw,
      origin,
    });
    expect(snapshot).toMatchObject({
      file: { path: raw, raw: original },
      revision: sha(original),
      mockOnly: true,
    });
    await expect(
      invoke("write_editor_file", {
        path: raw,
        content: draft,
        expectedSha256: snapshot.revision,
        origin,
      }),
    ).rejects.toThrow("immutable");
    for (const outside of [
      "/outside/synthetic.md",
      "/myco/wiki/../raw/synthetic.md",
    ]) {
      await expect(
        invoke("read_editor_file", { path: outside, origin }),
      ).rejects.toThrow("MOCK_EDITOR_PATH_REFUSED");
      await expect(
        invoke("write_editor_file", {
          path: outside,
          content: draft,
          expectedSha256: sha(original),
          origin,
        }),
      ).rejects.toThrow("MOCK_EDITOR_PATH_REFUSED");
    }
    expect(
      (await invoke<{ raw: string }>("read_file", { path: raw })).raw,
    ).toBe(original);
  });
});
