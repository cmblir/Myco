import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryRunner, runQuery } from "./queryLoad";
import { parseQuery } from "./blocks/query";
import { ipc } from "./ipc";
import { useVaultStore } from "../stores/vaultStore";

const A = "/v/wiki/a.md";
const B = "/v/wiki/b.md";

describe("runQuery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({
      currentVault: { path: "/v", name: "v" },
      fileTree: [
        {
          kind: "directory",
          name: "wiki",
          path: "/v/wiki",
          children: [
            { kind: "file", name: "a.md", path: A },
            { kind: "file", name: "b.md", path: B },
            { kind: "file", name: "shot.png", path: "/v/wiki/shot.png" },
          ],
        },
      ],
      adjacency: {
        forward: {},
        backward: {},
        unresolved: {},
        tags: { [A]: ["ml"], [B]: ["ml"] },
        meta: { [A]: { type: "concept" }, [B]: { type: "technique" } },
      },
    });
  });

  it("runs over the vault's notes, the current page left out, no IPC for a plain filter", async () => {
    const mtimes = vi.spyOn(ipc, "fileMtimes");
    const search = vi.spyOn(ipc, "searchVault");
    expect((await runQuery(parseQuery("tag:ml"))).map((r) => r.name)).toEqual([
      "a",
      "b",
    ]);
    expect(
      (await runQuery(parseQuery("tag:ml"), A)).map((r) => r.name),
    ).toEqual(["b"]);
    expect(mtimes).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("reads mtimes to sort or show dates; without them it still answers", async () => {
    vi.spyOn(ipc, "fileMtimes").mockResolvedValue([
      [A, 1],
      [B, 2],
    ]);
    expect(
      (await runQuery(parseQuery("tag:ml sort:modified"))).map((r) => r.name),
    ).toEqual(["b", "a"]);
    vi.spyOn(ipc, "fileMtimes").mockRejectedValue(new Error("gone"));
    const rows = await runQuery(parseQuery("tag:ml view:table"));
    expect(rows.map((r) => r.modified)).toEqual([0, 0]);
  });

  it("scans the text for each phrase; a failed scan fails the query", async () => {
    const search = vi
      .spyOn(ipc, "searchVault")
      .mockResolvedValue([{ path: B, name: "b.md", line: 3, snippet: "x" }]);
    expect(
      (await runQuery(parseQuery('"beam width" tag:ml'))).map((r) => r.name),
    ).toEqual(["b"]);
    expect(search).toHaveBeenCalledWith("beam width", 1000);
    search.mockRejectedValue(new Error("io"));
    await expect(runQuery(parseQuery('"beam"'))).rejects.toThrow("io");
  });

  it("fails without an open vault", async () => {
    useVaultStore.setState({ currentVault: null, adjacency: null });
    await expect(runQuery(parseQuery("tag:ml"))).rejects.toThrow();
  });

  // A Live widget scrolled out of view is dropped and drawn anew when it
  // comes back: each redraw ran the query again, a vault scan per phrase.
  describe("queryRunner", () => {
    const hit = [{ path: B, name: "b.md", line: 3, snippet: "x" }];

    it("answers a query it ran from that run while the index is the same", async () => {
      const search = vi.spyOn(ipc, "searchVault").mockResolvedValue(hit);
      const run = queryRunner(A);
      const first = await run(parseQuery('"beam width" tag:ml'));
      expect(first.map((r) => r.name)).toEqual(["b"]);
      expect(await run(parseQuery('"beam width" tag:ml'))).toBe(first);
      expect(search).toHaveBeenCalledTimes(1);
      // Another query is its own run.
      await run(parseQuery('"beam" tag:ml'));
      expect(search).toHaveBeenCalledTimes(2);
    });

    it("runs again once the vault's index or tree is a new one", async () => {
      const search = vi.spyOn(ipc, "searchVault").mockResolvedValue(hit);
      const run = queryRunner();
      const q = parseQuery('"beam"');
      await run(q);
      const { adjacency, fileTree } = useVaultStore.getState();
      useVaultStore.setState({ adjacency: { ...adjacency! } });
      await run(q);
      useVaultStore.setState({ fileTree: [...fileTree] });
      await run(q);
      expect(search).toHaveBeenCalledTimes(3);
    });

    it("tries a failed run again", async () => {
      const search = vi
        .spyOn(ipc, "searchVault")
        .mockRejectedValueOnce(new Error("io"))
        .mockResolvedValue(hit);
      const run = queryRunner();
      await expect(run(parseQuery('"beam"'))).rejects.toThrow("io");
      expect((await run(parseQuery('"beam"'))).map((r) => r.name)).toEqual([
        "b",
      ]);
      expect(search).toHaveBeenCalledTimes(2);
    });
  });
});
