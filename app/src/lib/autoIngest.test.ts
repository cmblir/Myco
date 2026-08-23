// pendingInboxRows feeds the "waiting in _inbox" list on PageIngest — the
// place the inflow "보기 →" lands. Ordering and the today flag are what make
// "+N arrived" findable, so they get pinned here. runInboxPass is the
// unattended consumer of the same listing: redaction guard, format routing
// (Q4 item 20a), and the pass accounting live in the second half.

import { beforeEach, describe, expect, it, vi } from "vitest";

const listInboxEntries = vi.fn();
const readFile = vi.fn();
const scanTextSecrets = vi.fn();
const getSettings = vi.fn();
const archiveInboxSource = vi.fn();
const whisperCheck = vi.fn();
const describeImage = vi.fn();
const transcribeMedia = vi.fn();
const readExternalText = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    listInboxEntries: (...a: unknown[]) => listInboxEntries(...a),
    readFile: (...a: unknown[]) => readFile(...a),
    scanTextSecrets: (...a: unknown[]) => scanTextSecrets(...a),
    getSettings: (...a: unknown[]) => getSettings(...a),
    archiveInboxSource: (...a: unknown[]) => archiveInboxSource(...a),
    whisperCheck: (...a: unknown[]) => whisperCheck(...a),
    describeImage: (...a: unknown[]) => describeImage(...a),
    transcribeMedia: (...a: unknown[]) => transcribeMedia(...a),
    readExternalText: (...a: unknown[]) => readExternalText(...a),
  },
}));

const startIngest = vi.fn();
const bumpInboxRev = vi.fn();
const ingestState = { stage: "idle", startIngest, bumpInboxRev };
vi.mock("../stores/ingestStore", () => ({
  useIngestStore: { getState: () => ingestState },
}));

import type { InboxEntry } from "./ipc";
import { IMAGE_INGEST_PROMPT } from "./mediaIngest";
import { pendingInboxRows, runInboxPass } from "./autoIngest";

const NOW = new Date(2026, 7, 19, 14, 0); // local 2026-08-19 14:00
const secs = (d: Date): number => Math.floor(d.getTime() / 1000);

function entry(name: string, mtime: number): InboxEntry {
  const dot = name.lastIndexOf(".");
  return {
    name,
    rel: `_inbox/${name}`,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    bytes: 1,
    mtime,
  };
}

describe("pendingInboxRows", () => {
  it("sorts newest first, flags today, and derives path/kind per entry", () => {
    const today = secs(new Date(2026, 7, 19, 9, 30));
    const yesterday = secs(new Date(2026, 7, 18, 23, 50));
    const rows = pendingInboxRows(
      [entry("old.md", yesterday), entry("paper.pdf", today)],
      "/v",
      NOW,
    );
    expect(rows.map((r) => r.name)).toEqual(["paper.pdf", "old.md"]);
    expect(rows.map((r) => r.today)).toEqual([true, false]);
    expect(rows[0]).toMatchObject({
      path: "/v/_inbox/paper.pdf",
      ext: "pdf",
      kind: "extract",
    });
    expect(rows[1].kind).toBe("md");
  });

  it("puts files with no known mtime last, with mtime null and today false", () => {
    const rows = pendingInboxRows(
      [entry("unknown.epub", 0), entry("known.md", secs(NOW))],
      "/v",
      NOW,
    );
    expect(rows[0].name).toBe("known.md");
    expect(rows[1]).toMatchObject({
      name: "unknown.epub",
      mtime: null,
      today: false,
      kind: "unsupported",
    });
  });

  it("returns [] for an empty inbox", () => {
    expect(pendingInboxRows([], "/v", NOW)).toEqual([]);
  });
});

// Q4 item 13 — the promotion guard: scan BEFORE startIngest writes
// raw/<slug>.md. A flagged source stays in _inbox/ and the pass moves on to
// the next candidate so one flagged file cannot jam the queue.
describe("runInboxPass redaction guard", () => {
  beforeEach(() => {
    listInboxEntries.mockReset();
    readFile.mockReset();
    scanTextSecrets.mockReset();
    getSettings.mockReset();
    archiveInboxSource.mockReset();
    whisperCheck.mockReset();
    describeImage.mockReset();
    transcribeMedia.mockReset();
    readExternalText.mockReset();
    startIngest.mockReset();
    bumpInboxRev.mockReset();
    ingestState.stage = "idle";

    getSettings.mockResolvedValue({ pii_quarantine_enabled: false });
    listInboxEntries.mockResolvedValue([
      entry("leak.md", 100),
      entry("clean.md", 90),
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
    expect(result).toEqual({ ingested: true, held: 1, unsupported: 0 });
  });

  it("holds PII sources when quarantine is on and never calls startIngest", async () => {
    getSettings.mockResolvedValue({ pii_quarantine_enabled: true });
    scanTextSecrets.mockResolvedValue({ secrets: [], pii: ["email"] });

    const result = await runInboxPass("/v");

    expect(startIngest).not.toHaveBeenCalled();
    expect(archiveInboxSource).not.toHaveBeenCalled();
    expect(result).toEqual({ ingested: false, held: 2, unsupported: 0 });
  });

  it("promotes a PII source in warn-only mode (the default)", async () => {
    scanTextSecrets.mockResolvedValue({ secrets: [], pii: ["email"] });

    const result = await runInboxPass("/v");

    expect(startIngest).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ingested: true, held: 0, unsupported: 0 });
  });
});

// Q4 item 20a — the pass sees every file: supported non-md routed through
// sourceTextFor, media gated on one whisperCheck per pass, unsupported
// formats counted and left in place instead of silently invisible.
describe("runInboxPass format routing", () => {
  beforeEach(() => {
    listInboxEntries.mockReset();
    readFile.mockReset();
    scanTextSecrets.mockReset();
    getSettings.mockReset();
    archiveInboxSource.mockReset();
    whisperCheck.mockReset();
    describeImage.mockReset();
    transcribeMedia.mockReset();
    readExternalText.mockReset();
    startIngest.mockReset();
    bumpInboxRev.mockReset();
    ingestState.stage = "idle";

    getSettings.mockResolvedValue({
      pii_quarantine_enabled: false,
      query_provider: "prov-x",
      query_model: "model-y",
    });
    scanTextSecrets.mockResolvedValue({ secrets: [], pii: [] });
    startIngest.mockImplementation(async () => {
      ingestState.stage = "done";
    });
    archiveInboxSource.mockResolvedValue("");
  });

  it("counts unsupported formats, leaves them in place, and still ingests the next supported file", async () => {
    listInboxEntries.mockResolvedValue([
      entry("book.epub", 100),
      entry("clean.md", 90),
    ]);
    readFile.mockResolvedValue({ raw: "clean body" });

    const result = await runInboxPass("/v");

    expect(result).toEqual({ ingested: true, held: 0, unsupported: 1 });
    expect(startIngest).toHaveBeenCalledWith("clean", "clean body", { headless: true });
    expect(archiveInboxSource).toHaveBeenCalledTimes(1);
    expect(archiveInboxSource).toHaveBeenCalledWith("/v/_inbox/clean.md");
  });

  it("routes a non-md source through sourceTextFor with the settings provider/model", async () => {
    listInboxEntries.mockResolvedValue([entry("shot.png", 100)]);
    describeImage.mockResolvedValue("a described chart");

    const result = await runInboxPass("/v");

    expect(describeImage).toHaveBeenCalledWith(
      "prov-x",
      "model-y",
      "/v/_inbox/shot.png",
      IMAGE_INGEST_PROMPT,
    );
    expect(startIngest).toHaveBeenCalledWith("shot", "a described chart", {
      headless: true,
    });
    expect(archiveInboxSource).toHaveBeenCalledWith("/v/_inbox/shot.png");
    expect(result).toEqual({ ingested: true, held: 0, unsupported: 0 });
  });

  it("holds media when whisper is missing — one whisperCheck per pass", async () => {
    listInboxEntries.mockResolvedValue([
      entry("talk.mp3", 100),
      entry("lecture.mp4", 95),
      entry("clean.md", 90),
    ]);
    whisperCheck.mockResolvedValue({ installed: false, version: null, path: null });
    readFile.mockResolvedValue({ raw: "clean body" });

    const result = await runInboxPass("/v");

    expect(whisperCheck).toHaveBeenCalledTimes(1);
    expect(transcribeMedia).not.toHaveBeenCalled();
    expect(result).toEqual({ ingested: true, held: 2, unsupported: 0 });
  });
});
