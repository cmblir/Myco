import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVaultStore } from "./vaultStore";
import { ipc } from "../lib/ipc";

// The background poll asks for a link-graph refresh every few seconds to catch
// edits made outside the app. Answering that with a full rebuild means reading
// and parsing every note — measured at 305 ms on a 10k-note vault — almost
// always to conclude nothing happened. These tests pin the two halves of the
// bargain: the poll skips on an unmoved fingerprint, and a local write never
// skips (mtime+len cannot see an edit that keeps both, e.g. [[a]] -> [[b]]
// within one mtime tick).

const ADJ = { forward: {}, backward: {}, unresolved: {}, tags: {} };
const VAULT = { path: "/v", name: "v" };

function stubIpc(revision: number) {
  const buildLinkGraph = vi.fn().mockResolvedValue(ADJ);
  const vaultRevision = vi.fn().mockResolvedValue(revision);
  vi.spyOn(ipc, "buildLinkGraph").mockImplementation(buildLinkGraph);
  vi.spyOn(ipc, "vaultRevision").mockImplementation(vaultRevision);
  return { buildLinkGraph, vaultRevision };
}

describe("refreshLinkGraph", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: VAULT, adjacency: null, error: null });
  });

  it("polls with the fingerprint and skips the rebuild when it has not moved", async () => {
    const { buildLinkGraph, vaultRevision } = stubIpc(42);
    // First poll: no baseline yet, so it must build.
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(1);

    // Steady state: same fingerprint, so no rebuild — the whole point.
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(1);
    expect(vaultRevision).toHaveBeenCalledTimes(3);
  });

  it("rebuilds when the fingerprint moves", async () => {
    const { buildLinkGraph } = stubIpc(42);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(1);

    vi.spyOn(ipc, "vaultRevision").mockResolvedValue(43);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
  });

  it("always rebuilds for a caller that just wrote", async () => {
    const { buildLinkGraph, vaultRevision } = stubIpc(42);
    // Seed a baseline via the poll...
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    // ...then a local write. The fingerprint is unchanged in this stub, which
    // is the exact case the forced path exists for: a same-length edit inside
    // one mtime tick. It must still rebuild.
    await useVaultStore.getState().refreshLinkGraph();
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
    expect(vaultRevision).toHaveBeenCalledTimes(1); // never consulted when forced
  });

  it("does not let a forced rebuild leave the poll trusting a stale baseline", async () => {
    const { buildLinkGraph } = stubIpc(42);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true }); // build 1
    await useVaultStore.getState().refreshLinkGraph(); // build 2, forced
    // The next poll must re-establish the baseline rather than skip on the one
    // the forced rebuild invalidated.
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true }); // build 3
    expect(buildLinkGraph).toHaveBeenCalledTimes(3);
    // And then settle back into skipping.
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(3);
  });

  it("does not skip on a matching fingerprint from a different vault", async () => {
    const { buildLinkGraph } = stubIpc(42);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(1);

    // Two vaults can hash to the same value only by coincidence, but the
    // baseline is paired with its vault precisely so that coincidence — or an
    // empty vault — cannot serve one vault's graph for another.
    useVaultStore.setState({ currentVault: { path: "/other", name: "other" }, adjacency: null });
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
  });

  it("does not skip when the fingerprint matches but no graph is loaded", async () => {
    const { buildLinkGraph } = stubIpc(42);
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    // A vault switch clears the graph; the baseline must not paper over that.
    useVaultStore.setState({ adjacency: null });
    await useVaultStore.getState().refreshLinkGraph({ ifChanged: true });
    expect(buildLinkGraph).toHaveBeenCalledTimes(2);
  });
});
