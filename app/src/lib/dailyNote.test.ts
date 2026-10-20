import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureToDaily,
  clipReceipt,
  dailyDayOf,
  dailyPath,
  draftAfterCapture,
  oneLine,
  openDailyNote,
  questionLine,
  quoteBlocks,
  quoteLine,
  shiftDay,
} from "./dailyNote";
import { takeReaderIntent } from "./askLoop";
import { ipc } from "./ipc";
import { useNoticeStore } from "../stores/noticeStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

describe("shiftDay", () => {
  it("steps back across a month boundary", () => {
    expect(shiftDay("2026-10-01", -1)).toBe("2026-09-30");
  });

  it("steps forward across a year boundary", () => {
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("knows a leap day", () => {
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDay("2028-03-01", -1)).toBe("2028-02-29");
  });
});

describe("dailyDayOf", () => {
  it("reads the day off a daily note path", () => {
    expect(dailyDayOf("/v/daily/2026-09-28.md", "/v")).toBe("2026-09-28");
  });

  it("ignores everything that is not a daily note", () => {
    expect(dailyDayOf("/v/wiki/2026-09-28.md", "/v")).toBeNull();
    expect(dailyDayOf("/v/mydaily/2026-09-28.md", "/v")).toBeNull();
    expect(dailyDayOf("/v/daily/tasks.md", "/v")).toBeNull();
    expect(dailyDayOf("/v/daily/archive/tasks.md", "/v")).toBeNull();
  });

  it("knows a note the weekly rollup moved to daily/archive/", () => {
    expect(dailyDayOf("/v/daily/archive/2026-W39/2026-09-27.md", "/v")).toBe("2026-09-27");
    expect(dailyDayOf("/v/daily/archive/2026-09-28.md", "/v")).toBe("2026-09-28");
    expect(dailyDayOf("/v/wiki/daily/archive/2026-W39/2026-09-27.md", "/v")).toBeNull();
    expect(dailyDayOf("/v/daily/archive/2026-W09/2026-02-30.md", "/v")).toBeNull();
  });

  it("only knows the vault's own daily/, not a daily/ folder deeper in it", () => {
    // Their ‹ › would open or create notes in the vault's top-level daily/.
    expect(dailyDayOf("/v/wiki/journal/daily/2026-09-28.md", "/v")).toBeNull();
    expect(dailyDayOf("/v/journal/daily/2026-09-28.md", "/v")).toBeNull();
    expect(dailyDayOf("/v/raw/daily/2026-09-28.md", "/v")).toBeNull();
    expect(dailyDayOf("/v2/daily/2026-09-28.md", "/v")).toBeNull();
  });

  it("refuses a file name that is not a real date", () => {
    // shiftDay throws RangeError on these under JavaScriptCore (WKWebView),
    // and on 2026-13-01 under V8 too — during the Reader's render.
    for (const day of ["2026-13-01", "2026-02-30", "2026-02-29", "2026-09-31", "2026-00-10"])
      expect(dailyDayOf(`/v/daily/${day}.md`, "/v")).toBeNull();
    expect(dailyDayOf("/v/daily/2028-02-29.md", "/v")).toBe("2028-02-29");
  });
});

describe("openDailyNote", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUIStore.setState({ route: "overview" });
    // No open vault: refreshTree returns before touching IPC.
    useVaultStore.setState({ currentVault: null, fileTree: [] });
  });

  it("opens an existing note without writing to it", async () => {
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: "# x\n" } as never);
    const write = vi.spyOn(ipc, "writeFile");
    await openDailyNote("/v", "2026-09-27");
    expect(write).not.toHaveBeenCalled();
    expect(useUIStore.getState().route).toBe(`page:${dailyPath("/v", "2026-09-27")}`);
  });

  it("creates a missing note with its date heading, then opens it", async () => {
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("no such file"));
    vi.spyOn(ipc, "createFolder").mockResolvedValue("/v/daily" as never);
    const create = vi.spyOn(ipc, "createFile").mockResolvedValue("/v/daily/2026-09-27.md");
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null as never);
    await openDailyNote("/v", "2026-09-27");
    expect(create).toHaveBeenCalledWith("/v/daily", "2026-09-27.md");
    expect(write).toHaveBeenCalledWith("/v/daily/2026-09-27.md", "# 2026-09-27\n\n");
    expect(useUIStore.getState().route).toBe("page:/v/daily/2026-09-27.md");
  });

  it("opens the archived note for a day the weekly rollup moved", async () => {
    // distill.rs archive_rolled moves settled days to daily/archive/<week>/.
    const archived = "/v/daily/archive/2026-W38/2026-09-20.md";
    useVaultStore.setState({
      fileTree: [
        {
          kind: "directory",
          name: "daily",
          path: "/v/daily",
          children: [
            {
              kind: "directory",
              name: "archive",
              path: "/v/daily/archive",
              children: [
                {
                  kind: "directory",
                  name: "2026-W38",
                  path: "/v/daily/archive/2026-W38",
                  children: [{ kind: "file", name: "2026-09-20.md", path: archived }],
                },
              ],
            },
          ],
        },
      ],
    });
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("no such file"));
    const create = vi.spyOn(ipc, "createFile");
    const write = vi.spyOn(ipc, "writeFile");
    await openDailyNote("/v", shiftDay("2026-09-21", -1));
    expect(create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(useUIStore.getState().route).toBe(`page:${archived}`);
  });

  it("creates nothing for a day that is not a date", async () => {
    // 9999-12-31's Tomorrow is "+010000-01": no such daily note may appear.
    const read = vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("no such file"));
    const create = vi.spyOn(ipc, "createFile");
    await openDailyNote("/v", shiftDay("9999-12-31", 1));
    expect(read).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(useUIStore.getState().route).toBe("overview");
  });

  it("never overwrites a file it could not create", async () => {
    // create_file refuses an existing file — a read that failed for another
    // reason must not turn into a write over the user's note.
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("permission denied"));
    vi.spyOn(ipc, "createFolder").mockResolvedValue("/v/daily" as never);
    vi.spyOn(ipc, "createFile").mockRejectedValue(new Error("exists"));
    const write = vi.spyOn(ipc, "writeFile");
    await openDailyNote("/v", "2026-09-27");
    expect(write).not.toHaveBeenCalled();
  });
});

describe("draftAfterCapture", () => {
  it("lets a clean draft re-read the file capture_note wrote", () => {
    expect(draftAfterCapture("# d\n- 09:00 a\n", false, "- 09:05 b")).toBeNull();
  });

  it("appends the line to a dirty draft, so its autosave keeps it", () => {
    // The draft's next write replaces the file, capture and all.
    expect(draftAfterCapture("# d\n- 09:00 a\nmore", true, "- 09:05 b")).toBe(
      "# d\n- 09:00 a\nmore\n- 09:05 b\n",
    );
    expect(draftAfterCapture("# d\n\n", true, "- 09:05 b")).toBe("# d\n\n- 09:05 b\n");
    expect(draftAfterCapture("", true, "- 09:05 b")).toBe("- 09:05 b\n");
  });

  it("carries the quote's footnote definition into a dirty draft too", () => {
    expect(draftAfterCapture("# d\n", true, "- 09:05 Q [^src-a]", "[^src-a]: raw/a.md")).toBe(
      "# d\n- 09:05 Q [^src-a]\n\n[^src-a]: raw/a.md\n",
    );
    // Lines go above the note's closing definitions, as capture_note writes them.
    expect(draftAfterCapture("# d\n- 1 Q [^src-a]\n\n[^src-a]: raw/a.md\n", true, "- 2 b")).toBe(
      "# d\n- 1 Q [^src-a]\n- 2 b\n\n[^src-a]: raw/a.md\n",
    );
  });
});

describe("oneLine", () => {
  it("keeps the Home box to the one line capture_note saves", () => {
    // Shift+Enter and a pasted list used to show two lines and save one.
    expect(oneLine("milk\neggs")).toBe("milk eggs");
    expect(oneLine("a\r\n\r\nb\n")).toBe("a b ");
    expect(oneLine("plain")).toBe("plain");
  });
});

describe("captureToDaily", () => {
  const copy = { home_captured: "Added", home_capture_failed: "Failed", home_open_daily: "Open" };
  beforeEach(() => {
    vi.restoreAllMocks();
    useNoticeStore.setState({ notices: [] });
    useUIStore.setState({ route: "overview" });
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, fileTree: [] });
    vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
  });

  it("toasts a receipt whose Open goes to the note the line went into", async () => {
    // The receipt names the file capture_note wrote, so a press after
    // midnight still opens the note that holds the line.
    const capture = vi
      .spyOn(ipc, "captureNote")
      .mockResolvedValue({ rel: "daily/2026-10-02.md", line: "- 09:05 milk" });
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: "# x\n" } as never);
    expect(await captureToDaily("milk", copy)).toEqual({ rel: "daily/2026-10-02.md", line: "- 09:05 milk" });
    expect(capture).toHaveBeenCalledWith("milk", undefined);
    const [toast] = useNoticeStore.getState().notices;
    expect([toast.kind, toast.title, toast.action?.label]).toEqual(["ok", "Added", "Open"]);
    toast.action?.run();
    await vi.waitFor(() =>
      expect(useUIStore.getState().route).toBe("page:/v/daily/2026-10-02.md"),
    );
  });

  it("opens the note on the line it wrote, not at the top", async () => {
    // A busy day's 25th line is off the first screen: the reader that opens
    // the note scrolls to the written line and lights it (ReaderIntent show).
    vi.spyOn(ipc, "captureNote").mockResolvedValue({ rel: "daily/2026-10-02.md", line: "- 09:05 milk" });
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: "# x\n" } as never);
    await captureToDaily("milk", copy);
    useNoticeStore.getState().notices[0].action?.run();
    expect(takeReaderIntent("/v/daily/2026-10-02.md")).toEqual({
      kind: "show",
      section: null,
      quote: "- 09:05 milk",
    });
  });

  it("names the raw/ original a quote cites, so its footnote is defined", async () => {
    const capture = vi
      .spyOn(ipc, "captureNote")
      .mockResolvedValue({ rel: "daily/2026-10-02.md", line: "- 09:05 Q [^src-a]" });
    await captureToDaily("Q [^src-a]", copy, "raw/a.md");
    expect(capture).toHaveBeenCalledWith("Q [^src-a]", "raw/a.md");
  });

  it("warns with the reason, and offers nothing to open, when the write fails", async () => {
    vi.spyOn(ipc, "captureNote").mockRejectedValue(new Error("disk full"));
    expect(await captureToDaily("milk", copy)).toBeNull();
    const [toast] = useNoticeStore.getState().notices;
    expect([toast.kind, toast.title, toast.action]).toEqual(["warn", "Failed", undefined]);
    expect(toast.sub).toContain("disk full");
  });
});

// The abstain card's "write it down" (UX S30): the question and nothing
// else; capture_note adds the time. Never an answer: there is none.
describe("questionLine", () => {
  const t = { q_abstain_note_line: "질문: {q}" };

  it("puts the question after the label", () => {
    expect(questionLine("주말 등산 코스 추천", t)).toBe("질문: 주말 등산 코스 추천");
  });

  it("keeps the question to one line", () => {
    expect(questionLine("주말\n등산", t)).toBe("질문: 주말 등산");
  });

  it("writes a question with $ patterns verbatim", () => {
    // String.replace reads `$&` in a replacement string as the match.
    expect(questionLine("cost in $& and $1?", t)).toBe("질문: cost in $& and $1?");
  });
});

describe("clipReceipt", () => {
  const copy = { capture_inbox_receipt: "{rel} · next ingest", home_open_daily: "Open" };
  beforeEach(() => {
    useNoticeStore.setState({ notices: [] });
    useUIStore.setState({ route: "overview" });
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, fileTree: [] });
  });

  it("names where the clip went and opens it", () => {
    clipReceipt({ rel: "_inbox/clip-attention-1a2b3c4d.md", title: "Attention" }, copy);
    const [n] = useNoticeStore.getState().notices;
    expect(n).toMatchObject({
      kind: "ok",
      title: "_inbox/clip-attention-1a2b3c4d.md · next ingest",
      sub: "Attention",
    });
    n.action?.run();
    expect(useUIStore.getState().route).toBe("page:/v/_inbox/clip-attention-1a2b3c4d.md");
  });

  it("says nothing for a payload that is not a clip of this vault's inbox", () => {
    clipReceipt(null, copy);
    clipReceipt({ rel: "../x.md" }, copy);
    expect(useNoticeStore.getState().notices).toEqual([]);
  });
});

// S41: a sentence selected in a raw/ original goes into today's note as one
// line citing that original; capture_note adds the time.
describe("quoteLine", () => {
  it("cites the raw original by its stem", () => {
    expect(quoteLine("Attention is all you need.", "/v/raw/attention-paper.md")).toBe(
      "Attention is all you need. [^src-attention-paper]",
    );
  });

  it("keeps a multi-line selection to one line", () => {
    expect(quoteLine("  first line\n\nsecond\tline ", "/v/raw/a.md")).toBe(
      "first line second line [^src-a]",
    );
  });

  it("cites a nested original by its file name", () => {
    expect(quoteLine("x y", "/v/raw/archive/old-clip.md")).toBe("x y [^src-old-clip]");
  });

  it("cuts a long selection at a sentence and marks the cut", () => {
    const long = "A sentence that ends here. ".repeat(40);
    const line = quoteLine(long, "/v/raw/a.md") ?? "";
    expect(line.length).toBeLessThan(560);
    expect(line).toMatch(/here\. … \[\^src-a\]$/);
  });

  it("offers nothing for an empty selection", () => {
    expect(quoteLine(" \n ", "/v/raw/a.md")).toBeNull();
  });

  it("offers nothing when the file name cannot be a citation", () => {
    // A footnote label holds no space or bracket: `[^src-my clip]` would read
    // as plain text and cite nothing.
    expect(quoteLine("text", "/v/raw/my clip.md")).toBeNull();
    expect(quoteLine("text", "/v/raw/a]b.md")).toBeNull();
  });
});

// S41: a selection across blocks makes cards per block, never one run-on
// sentence the original does not have (spec 2026-09-29 Part 1).
describe("quoteBlocks", () => {
  it("quotes each block of the selection on its own line", () => {
    const prose = "**A** is first\n\n\n**B** is second.\n\n";
    expect(quoteBlocks(prose, "/v/raw/a.md")).toEqual([
      "**A** is first [^src-a]",
      "**B** is second. [^src-a]",
    ]);
  });

  it("keeps a paragraph wrapped over source lines whole", () => {
    expect(quoteBlocks("one sentence\nwrapped here.\n\n", "/v/raw/a.md")).toEqual([
      "one sentence wrapped here. [^src-a]",
    ]);
  });

  it("offers nothing for an empty selection", () => {
    expect(quoteBlocks(" \n\n ", "/v/raw/a.md")).toEqual([]);
  });

  it("accepts a Korean file name", () => {
    expect(quoteLine("문장", "/v/raw/트랜스포머-노트.md")).toBe("문장 [^src-트랜스포머-노트]");
  });
});
