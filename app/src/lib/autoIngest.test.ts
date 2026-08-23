// pendingInboxRows feeds the "waiting in _inbox" list on PageIngest — the
// place the inflow "보기 →" lands. Ordering and the today flag are what make
// "+N arrived" findable, so they get pinned here.

import { beforeEach, describe, expect, it, vi } from "vitest";

const listFiles = vi.fn();
const readFile = vi.fn();
const scanTextSecrets = vi.fn();
const getSettings = vi.fn();
const archiveInboxSource = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    listFiles: (...a: unknown[]) => listFiles(...a),
    readFile: (...a: unknown[]) => readFile(...a),
    scanTextSecrets: (...a: unknown[]) => scanTextSecrets(...a),
    getSettings: (...a: unknown[]) => getSettings(...a),
    archiveInboxSource: (...a: unknown[]) => archiveInboxSource(...a),
  },
}));

const startIngest = vi.fn();
const bumpInboxRev = vi.fn();
const ingestState = { stage: "idle", startIngest, bumpInboxRev };
vi.mock("../stores/ingestStore", () => ({
  useIngestStore: { getState: () => ingestState },
}));

import { pendingInboxRows, runInboxPass } from "./autoIngest";

const NOW = new Date(2026, 7, 19, 14, 0); // local 2026-08-19 14:00
const secs = (d: Date): number => Math.floor(d.getTime() / 1000);

describe("pendingInboxRows", () => {
  it("sorts newest first and flags today's arrivals", () => {
    const today = secs(new Date(2026, 7, 19, 9, 30));
    const yesterday = secs(new Date(2026, 7, 18, 23, 50));
    const rows = pendingInboxRows(
      [
        { name: "old.md", path: "/v/_inbox/old.md" },
        { name: "new.md", path: "/v/_inbox/new.md" },
      ],
      new Map([
        ["/v/_inbox/old.md", yesterday],
        ["/v/_inbox/new.md", today],
      ]),
      NOW,
    );
    expect(rows.map((r) => r.name)).toEqual(["new.md", "old.md"]);
    expect(rows.map((r) => r.today)).toEqual([true, false]);
  });

  it("puts files with no known mtime last, with mtime null and today false", () => {
    const rows = pendingInboxRows(
      [
        { name: "unknown.md", path: "/v/_inbox/unknown.md" },
        { name: "known.md", path: "/v/_inbox/known.md" },
      ],
      new Map([["/v/_inbox/known.md", secs(NOW)]]),
      NOW,
    );
    expect(rows[0].name).toBe("known.md");
    expect(rows[1]).toMatchObject({ name: "unknown.md", mtime: null, today: false });
  });

  it("returns [] for an empty inbox", () => {
    expect(pendingInboxRows([], new Map(), NOW)).toEqual([]);
  });
});

// Q4 item 13 — the promotion guard: scan BEFORE startIngest writes
// raw/<slug>.md. A flagged source stays in _inbox/ and the pass moves on to
// the next candidate so one flagged file cannot jam the queue.
describe("runInboxPass redaction guard", () => {
  beforeEach(() => {
    listFiles.mockReset();
    readFile.mockReset();
    scanTextSecrets.mockReset();
    getSettings.mockReset();
    archiveInboxSource.mockReset();
    startIngest.mockReset();
    bumpInboxRev.mockReset();
    ingestState.stage = "idle";

    getSettings.mockResolvedValue({ pii_quarantine_enabled: false });
    listFiles.mockResolvedValue([
      {
        kind: "directory",
        name: "_inbox",
        path: "/v/_inbox",
        children: [
          { kind: "file", name: "leak.md", path: "/v/_inbox/leak.md" },
          { kind: "file", name: "clean.md", path: "/v/_inbox/clean.md" },
        ],
      },
    ]);
    readFile.mockImplementation((p: string) => Promise.resolve({ raw: `body of ${p}` }));
    startIngest.mockImplementation(async () => {
      ingestState.stage = "done";
    });
    archiveInboxSource.mockResolvedValue("");
  });

  it("skips a flagged source, ingests the next clean one, and counts the held file", async () => {
    scanTextSecrets
      .mockResolvedValueOnce({ secrets: ["aws-access-key"], pii: [] })
      .mockResolvedValueOnce({ secrets: [], pii: [] });

    const result = await runInboxPass("/v");

    expect(startIngest).toHaveBeenCalledTimes(1);
    expect(startIngest).toHaveBeenCalledWith("clean", "body of /v/_inbox/clean.md", {
      headless: true,
    });
    expect(archiveInboxSource).toHaveBeenCalledWith("/v/_inbox/clean.md");
    expect(result).toEqual({ ingested: true, held: 1 });
  });

  it("holds PII sources when quarantine is on and never calls startIngest", async () => {
    getSettings.mockResolvedValue({ pii_quarantine_enabled: true });
    scanTextSecrets.mockResolvedValue({ secrets: [], pii: ["email"] });

    const result = await runInboxPass("/v");

    expect(startIngest).not.toHaveBeenCalled();
    expect(archiveInboxSource).not.toHaveBeenCalled();
    expect(result).toEqual({ ingested: false, held: 2 });
  });

  it("promotes a PII source in warn-only mode (the default)", async () => {
    scanTextSecrets.mockResolvedValue({ secrets: [], pii: ["email"] });

    const result = await runInboxPass("/v");

    expect(startIngest).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ingested: true, held: 0 });
  });
});
