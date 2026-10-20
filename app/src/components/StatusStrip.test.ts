// The two pure decisions behind the sidebar status strip: what the vault tile
// counts, and which single warning the strip shows.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import StatusStrip, { noteShown, statusWarning, summaryAlert, vaultSplit } from "./StatusStrip";
import { STRINGS } from "../lib/i18n";
import type { FileNode } from "../lib/ipc";
import type * as VaultStoreModule from "../stores/vaultStore";

const inventory = vi.hoisted(() => ({
  currentVault: { path: "/v", name: "Synthetic" },
  fileTree: [] as FileNode[],
  isOpeningVault: false,
}));

vi.mock("../stores/vaultStore", async (importOriginal) => {
  const actual = await importOriginal<typeof VaultStoreModule>();
  return {
    ...actual,
    useVaultStore: Object.assign(
      (select: (state: ReturnType<typeof actual.useVaultStore.getState>) => unknown) =>
        select({ ...actual.useVaultStore.getState(), ...inventory }),
      actual.useVaultStore,
    ),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  inventory.fileTree = [];
  inventory.isOpeningVault = false;
});

const render = (): string => {
  vi.stubGlobal("window", { location: { search: "" } });
  return renderToStaticMarkup(createElement(StatusStrip, { t: STRINGS.ko }));
};

describe("status inventory readiness", () => {
  it("uses loading for the summary and vault tile while initial inventory is pending", () => {
    inventory.isOpeningVault = true;
    const html = render();
    expect(html).toContain(STRINGS.ko.st_loading);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain(STRINGS.ko.home_notes_count.replace("{n}", "0"));
    expect(html).toContain(`aria-label="${STRINGS.ko.sb_st_vault}: ${STRINGS.ko.st_loading}"`);
    expect(html).toContain(`aria-label="${STRINGS.ko.sb_st_index}: ${STRINGS.ko.st_loading}"`);
    expect(html).not.toContain(`aria-label="${STRINGS.ko.sb_st_vault}: 0"`);
  });

  it("reports the measured zero once an empty inventory is ready", () => {
    const html = render();
    expect(html).toContain(STRINGS.ko.home_notes_count.replace("{n}", "0"));
    expect(html).toContain(`aria-label="${STRINGS.ko.sb_st_vault}: 0"`);
    expect(html).not.toContain(STRINGS.ko.st_loading);
  });
});

const FILES = [
  "/v/sessions/2026-09/a.md",
  "/v/sessions/2026-09/b.md",
  "/v/wiki/attention.md",
  "/v/daily/2026-09-06.md",
];

describe("vaultSplit", () => {
  it("counts sessions and wiki separately, everything in the total", () => {
    expect(vaultSplit(FILES, "/v")).toEqual({ total: 4, sessions: 2, wiki: 1 });
  });

  it("accepts a root with a trailing slash and does not match a mere prefix", () => {
    expect(vaultSplit(["/v/wikipedia/x.md"], "/v/").wiki).toBe(0);
  });

  it("counts nothing per-folder without a vault root", () => {
    expect(vaultSplit(FILES, undefined)).toEqual({ total: 4, sessions: 0, wiki: 0 });
  });
});

describe("statusWarning", () => {
  it("is silent while every source is healthy", () => {
    expect(statusWarning({ mcpRunning: true, wikiPages: 269, indexedPages: 269 })).toBeNull();
  });

  it("flags an index that holds fewer pages than the wiki has", () => {
    expect(statusWarning({ mcpRunning: true, wikiPages: 269, indexedPages: 238 })).toBe("index");
  });

  it("a stopped MCP server outranks a lagging index", () => {
    expect(statusWarning({ mcpRunning: false, wikiPages: 269, indexedPages: 0 })).toBe("mcp");
  });

  it("says nothing while a source has not answered yet", () => {
    expect(statusWarning({ mcpRunning: null, wikiPages: 269, indexedPages: null })).toBeNull();
  });
});

// UX S14: "위키 6개가 인덱스 밖에 있습니다 — 질문에서 검색되지 않습니다. 지금
// 재인덱스" stood under every screen, though the live updater closes that gap
// on its own. The index tile still turns amber; the standing note waits for a
// reindex that failed.
describe("noteShown", () => {
  it("always shows a stopped MCP server", () => {
    for (const stage of ["idle", "indexing", "done", "error"] as const) {
      expect(noteShown("mcp", stage)).toBe(true);
    }
  });

  it("hides a lagging index while a reindex runs or has not failed", () => {
    for (const stage of ["idle", "loading-model", "indexing", "done"] as const) {
      expect(noteShown("index", stage)).toBe(false);
    }
  });

  it("shows a lagging index once a reindex failed", () => {
    expect(noteShown("index", "error")).toBe(true);
  });

  it("shows nothing when nothing is wrong", () => {
    expect(noteShown(null, "error")).toBe(false);
  });

  it("says it in the owner's words", () => {
    expect(STRINGS.ko.sb_st_lagging).toBe("질문에서 찾지 못하는 노트가 {n}개 있어요");
    expect(STRINGS.ko.sb_st_reindex).toBe("다시 색인");
  });
});

// UX S43: the warning card under the strip took 131px of a 664px drawer. It
// folds into the one-line summary as a mark, and opens with the details.
describe("summaryAlert", () => {
  it("marks nothing while the note is not shown", () => {
    expect(summaryAlert("index", false, 6)).toBeNull();
    expect(summaryAlert(null, true, 0)).toBeNull();
  });

  it("counts the notes Ask cannot find", () => {
    expect(summaryAlert("index", true, 6)).toBe("▲ 6");
  });

  it("marks a stopped MCP server without a count", () => {
    expect(summaryAlert("mcp", true, 6)).toBe("▲");
  });
});
