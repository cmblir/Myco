import { beforeEach, describe, expect, it, vi } from "vitest";

const { scan } = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: { scanProvenance: scan } }));
import { useProvenanceStore } from "./provenanceStore";
import { useVaultStore } from "./vaultStore";

function openVault(path: string | null): void {
  useVaultStore.setState({
    currentVault: path ? { path, name: "Synthetic vault" } : null,
    vaultToken: path ? `synthetic-opening-${path}` : "synthetic-closed",
    isOpeningVault: false,
  });
}

describe("provenance scan ownership", () => {
  beforeEach(() => {
    scan.mockReset();
    openVault("/a");
    useProvenanceStore.setState({
      rows: null,
      error: null,
      loading: false,
      scannedPath: null,
      scannedToken: null,
    });
  });

  it("replaces a running scan on vault switch and ignores its late rows", async () => {
    let finish!: (rows: unknown[]) => void;
    scan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    scan.mockResolvedValueOnce([{ source: "synthetic-b" }]);
    const old = useProvenanceStore.getState().scan("/a");
    openVault("/b");
    await useProvenanceStore.getState().scan("/b");
    finish([{ source: "synthetic-a" }]);
    await old;
    expect(useProvenanceStore.getState()).toMatchObject({
      scannedPath: "/b",
      rows: [{ source: "synthetic-b" }],
      loading: false,
    });
  });

  it("hides old vault rows immediately and offers an uncached retry after error", async () => {
    useProvenanceStore.setState({ rows: [], scannedPath: "/a" });
    openVault("/b");
    scan.mockRejectedValueOnce(new Error("scan unavailable"));
    const attempt = useProvenanceStore.getState().scan("/b");
    expect(useProvenanceStore.getState().rows).toBeNull();
    await attempt;
    expect(useProvenanceStore.getState()).toMatchObject({
      error: "Error: scan unavailable",
      loading: false,
    });
    scan.mockResolvedValueOnce([]);
    await useProvenanceStore.getState().scan("/b");
    expect(useProvenanceStore.getState()).toMatchObject({
      rows: [],
      scannedPath: "/b",
      error: null,
    });
  });

  it("ignores a late error from a previous vault", async () => {
    let fail!: (error: Error) => void;
    scan.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    scan.mockResolvedValueOnce([]);
    const old = useProvenanceStore.getState().scan("/a");
    openVault("/b");
    await useProvenanceStore.getState().scan("/b");
    fail(new Error("old scan failed"));
    await old;
    expect(useProvenanceStore.getState()).toMatchObject({
      scannedPath: "/b",
      error: null,
      rows: [],
    });
  });

  it("clears cached rows and errors synchronously when the vault closes", () => {
    useProvenanceStore.setState({
      rows: [],
      scannedPath: "/a",
      error: "Synthetic old error",
    });
    openVault(null);
    expect(useProvenanceStore.getState()).toMatchObject({
      rows: null,
      scannedPath: null,
      error: null,
      loading: false,
    });
  });

  it("clears old rows on a vault path change before another page requests a scan", () => {
    useProvenanceStore.setState({ rows: [], scannedPath: "/a" });
    openVault("/b");
    expect(useProvenanceStore.getState()).toMatchObject({
      rows: null,
      scannedPath: null,
      error: null,
      loading: false,
    });
  });

  it("does not cache a late successful response after the vault closes", async () => {
    let finish!: (rows: unknown[]) => void;
    scan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = useProvenanceStore.getState().scan("/a");
    openVault(null);
    const closed = useProvenanceStore.getState();
    finish([{ source: "synthetic-a" }]);
    await pending;
    const empty = {
      rows: null,
      scannedPath: null,
      error: null,
      loading: false,
    };
    expect(closed).toMatchObject(empty);
    expect(useProvenanceStore.getState()).toMatchObject(empty);
  });

  it("does not expose a late scan error after the vault closes", async () => {
    let fail!: (error: Error) => void;
    scan.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const pending = useProvenanceStore.getState().scan("/a");
    openVault(null);
    fail(new Error("Synthetic closed-vault scan failure"));
    await pending;
    expect(useProvenanceStore.getState()).toMatchObject({
      rows: null,
      scannedPath: null,
      error: null,
      loading: false,
    });
  });

  it("invalidates a pending request even if its vault is closed and reopened at the same path", async () => {
    let finish!: (rows: unknown[]) => void;
    scan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = useProvenanceStore.getState().scan("/a");
    openVault(null);
    openVault("/a");
    finish([{ source: "synthetic-old-a" }]);
    await pending;
    expect(useProvenanceStore.getState()).toMatchObject({
      rows: null,
      scannedPath: null,
      error: null,
      loading: false,
    });
  });

  it("preserves a same-vault cache across revisits and metadata-only changes", async () => {
    scan.mockResolvedValueOnce([{ source: "synthetic-a" }]);
    await useProvenanceStore.getState().scan("/a");
    useVaultStore.setState({
      currentVault: { path: "/a", name: "Synthetic renamed vault" },
    });
    await useProvenanceStore.getState().scan("/a");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(useProvenanceStore.getState()).toMatchObject({
      scannedPath: "/a",
      rows: [{ source: "synthetic-a" }],
    });
  });

  it.each(["rows", "error"])(
    "rejects old %s when the same path is reopened without closing",
    async (outcome) => {
      let finish!: (rows: unknown[]) => void;
      let fail!: (error: Error) => void;
      scan.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      );
      scan.mockResolvedValueOnce([{ source: "synthetic-new-a" }]);
      const previous = useProvenanceStore.getState().scan("/a");
      useVaultStore.setState({ vaultToken: "synthetic-reopened-a" });
      expect(useProvenanceStore.getState()).toMatchObject({
        rows: null,
        error: null,
        loading: false,
      });
      await useProvenanceStore.getState().scan("/a");
      if (outcome === "rows") finish([{ source: "synthetic-old-a" }]);
      else fail(new Error("Synthetic stale scan error"));
      await previous;
      expect(useProvenanceStore.getState()).toMatchObject({
        rows: [{ source: "synthetic-new-a" }],
        scannedToken: "synthetic-reopened-a",
        error: null,
        loading: false,
      });
      expect(scan).toHaveBeenCalledTimes(2);
    },
  );

  it("invalidates cached same-path rows when a new opening starts", async () => {
    scan.mockResolvedValueOnce([{ source: "synthetic-original" }]);
    await useProvenanceStore.getState().scan("/a");
    useVaultStore.setState({ isOpeningVault: true });
    expect(useProvenanceStore.getState()).toMatchObject({
      rows: null,
      scannedToken: null,
    });
    await useProvenanceStore.getState().scan("/a");
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("does not start a request for a closed or replaced vault", async () => {
    openVault(null);
    await useProvenanceStore.getState().scan("/a");
    openVault("/b");
    await useProvenanceStore.getState().scan("/a", true);
    expect(scan).not.toHaveBeenCalled();
  });
});
