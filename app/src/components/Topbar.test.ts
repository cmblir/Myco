// computeModelPopPos is the clamping logic behind the model popover's
// position — the thing the "밀려서 나와" (pushed off-screen) bug report was
// about. Covers the branches that matter: right-aligned in the common case,
// clamped on both edges at a very narrow viewport, width shrunk when the
// popover would otherwise be wider than the viewport, and a floor on
// max-height for a very short window.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { breadcrumbFor, computeModelPopPos, movableNote, runPillOutcome, sessionCompilerLabel } from "./Topbar";
import { STRINGS } from "../lib/i18n";
import type { SessionCompilerDisplay } from "../lib/sessionIngest";

describe("native session compiler telemetry labels", () => {
  const run: SessionCompilerDisplay = { vaultPath: "/synthetic-vault", vaultToken: "synthetic-ui-opening",
    attemptId: "synthetic-attempt", sourceKey: "codex:synthetic", modelId: "qwen3.5-2b-q4_k_m",
    status: "running", stopping: false, processedWindows: 2, eligibleWindows: 31,
    startedAt: 1000, finishedAt: null, error: null };
  it("shows measured elapsed time and native counters without a fabricated ETA", () => {
    const label = sessionCompilerLabel(run, STRINGS.ko, "ko", 62000);
    expect(label).toContain("세션 정리");
    expect(label).toContain("처리한 구간 2/31");
    expect(label).toContain("1:01 경과");
    expect(label).not.toMatch(/예상|평균|검증 완료/);
  });
  it("stopping waits for confirmation and is not labeled stopped", () => {
    const label = sessionCompilerLabel({ ...run, stopping: true }, STRINGS.en, "en", 2000);
    expect(label).toContain(STRINGS.en.session_compile_stopping);
    expect(label).not.toContain(STRINGS.en.workflow_stopped);
  });
  it("a completed retry with no fresh telemetry does not invent counters", () => {
    const label = sessionCompilerLabel({ ...run, status: "success", processedWindows: null,
      eligibleWindows: 31, finishedAt: 31000 }, STRINGS.ja, "ja", 999000);
    expect(label).not.toContain("31/31");
    expect(label).toContain("0:30");
    expect(label).not.toContain("16:38");
  });
  it("a missing local model remains visibly awaiting preparation", () => {
    const label = sessionCompilerLabel({ ...run, status: "pending", preparationRequired: true,
      processedWindows: null, eligibleWindows: null }, STRINGS.ko, "ko", 2000);
    expect(label).toContain("선택한 로컬 모델 준비 필요");
    expect(label).not.toContain(STRINGS.ko.ing_success_title);
  });
});

describe("computeModelPopPos", () => {
  it("right-aligns to the pill on an ordinary desktop width", () => {
    const anchor = { right: 1264, bottom: 44 };
    const pos = computeModelPopPos(anchor, { width: 1280, height: 800 });
    expect(pos.width).toBe(340);
    expect(pos.left).toBe(1264 - 340);
    expect(pos.left + pos.width).toBeLessThanOrEqual(1280 - 8);
  });

  it("never crosses the left edge at a 320px viewport", () => {
    // A pill near the right edge of a 320px window would naively put
    // left = right - 340, deep negative — must clamp to the margin instead.
    const anchor = { right: 312, bottom: 44 };
    const pos = computeModelPopPos(anchor, { width: 320, height: 640 });
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + pos.width).toBeLessThanOrEqual(320 - 4); // 4px slack for rounding
  });

  it("never crosses the right edge even if the anchor reports past it", () => {
    const anchor = { right: 400, bottom: 44 }; // wider than the 320px viewport
    const pos = computeModelPopPos(anchor, { width: 320, height: 640 });
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + pos.width).toBeLessThanOrEqual(320 - 4);
  });

  it("shrinks to viewport width minus margins when 340px would overflow", () => {
    const anchor = { right: 300, bottom: 44 };
    const pos = computeModelPopPos(anchor, { width: 320, height: 640 });
    expect(pos.width).toBe(320 - 16);
  });

  it("floors max-height instead of going negative on a very short window", () => {
    const anchor = { right: 1264, bottom: 44 };
    const pos = computeModelPopPos(anchor, { width: 1280, height: 60 });
    expect(pos.maxHeight).toBeGreaterThanOrEqual(80);
  });

  it("fits fully within the viewport at every checked width (320/375/768/1280)", () => {
    for (const width of [320, 375, 768, 1280]) {
      const anchor = { right: width - 16, bottom: 44 };
      const pos = computeModelPopPos(anchor, { width, height: 800 });
      expect(pos.left).toBeGreaterThanOrEqual(4);
      expect(pos.left + pos.width).toBeLessThanOrEqual(width - 4);
    }
  });
});

// runPillOutcome decides whether a finished-run pill is on screen. Its first
// clause is the invariant that keeps the bar to ONE spinner: while a run is
// live, its pill is not rendered at all — the live half belongs to
// ActivityChip's running list, and nothing else in the bar draws a spinner.
describe("runPillOutcome", () => {
  it.each(["pending", "partial", "stopped"] as const)("preserves %s rather than publishing a done pill", workflowStatus => {
    expect(runPillOutcome({ running: false, outcome: "done", seen: false, workflowStatus })).toBe(workflowStatus);
    expect(runPillOutcome({ running: true, outcome: "done", seen: false, workflowStatus })).toBeNull();
  });
  it("shows no pill while the run is live, whatever the last outcome was", () => {
    for (const outcome of ["done", "error", null] as const) {
      expect(runPillOutcome({ running: true, outcome, seen: false })).toBeNull();
    }
  });

  it("pops the outcome once the run ends", () => {
    expect(runPillOutcome({ running: false, outcome: "done", seen: false })).toBe(
      "done",
    );
    expect(runPillOutcome({ running: false, outcome: "error", seen: false })).toBe(
      "error",
    );
  });

  it("clears once the page that explains the run has been seen", () => {
    expect(
      runPillOutcome({ running: false, outcome: "done", seen: true }),
    ).toBeNull();
    expect(
      runPillOutcome({ running: false, outcome: "error", seen: true }),
    ).toBeNull();
  });

  it("stays silent for a source that has never run — the store default", () => {
    expect(
      runPillOutcome({ running: false, outcome: null, seen: true }),
    ).toBeNull();
    expect(
      runPillOutcome({ running: false, outcome: null, seen: false }),
    ).toBeNull();
  });
});

// Every route names itself in the bar; before, Tasks / Study / the proposal
// queue fell through to the bare project name.
describe("breadcrumbFor a fixed route", () => {
  const t = STRINGS.ko;
  it("names Tasks, Study and the proposal queue with their sidebar icons", () => {
    expect(breadcrumbFor("tasks", "myco", t)).toEqual({ crumb: ["myco", "할 일"], icon: "check" });
    expect(breadcrumbFor("study", "myco", t)).toEqual({ crumb: ["myco", "학습"], icon: "sparkles" });
    expect(breadcrumbFor("feedback", "myco", t)).toEqual({
      crumb: ["myco", "정리 제안"],
      icon: "inbox",
    });
  });

  it("never leaves a route as the project name alone", () => {
    const routes = [
      "overview",
      "ingest",
      "query",
      "graph",
      "history",
      "provenance",
      "tasks",
      "study",
      "feedback",
      "settings",
    ];
    for (const r of routes) {
      const { crumb } = breadcrumbFor(r, "myco", t);
      expect(crumb.at(-1), r).not.toBe("myco");
    }
  });
});

// A note's crumb says where it lives: every folder from the vault root, then
// the name the tree lists it by — never the `.md`, never the absolute path.
describe("breadcrumbFor a page", () => {
  const t = STRINGS.ko;
  const crumb = (path: string, title?: string): string[] =>
    breadcrumbFor(`page:${path}`, "myco", t, "/v", title).crumb;

  it("names each folder under the vault, then the note without .md", () => {
    expect(crumb("/v/wiki/concepts/attention-mechanism.md")).toEqual([
      "myco",
      "wiki",
      "concepts",
      "attention-mechanism",
    ]);
    expect(crumb("/v/daily/2026-09-26.md")).toEqual(["myco", "daily", "2026-09-26"]);
    expect(crumb("/v/welcome.md")).toEqual(["myco", "welcome"]);
  });

  it("names an opaque session page the way the tree does", () => {
    const cc = "source-claude-code-064ddbe4-251d-4da1-8315-da096a5b75ff";
    expect(crumb(`/v/wiki/${cc}.md`)).toEqual(["myco", "wiki", "Claude Code · 064ddbe4"]);
    expect(crumb(`/v/wiki/${cc}.md`, "서버 띄워봐. · Claude Code")).toEqual([
      "myco",
      "wiki",
      "서버 띄워봐. · Claude Code",
    ]);
    // A readable stem keeps its file name, whatever the title says.
    expect(crumb("/v/wiki/attention-mechanism.md", "Attention Mechanism")).toEqual([
      "myco",
      "wiki",
      "attention-mechanism",
    ]);
  });

  it("keeps a file outside the vault to its name", () => {
    expect(crumb("/elsewhere/notes/x.md")).toEqual(["myco", "x"]);
  });
});

// UX backlog S15: a page's folder crumbs move it — except out of raw/, which
// is immutable, and for a file the vault does not hold.
describe("movableNote", () => {
  it("is the open note's path when its folder crumbs may move it", () => {
    expect(movableNote("page:/v/wiki/a.md", "/v")).toBe("/v/wiki/a.md");
    expect(movableNote("page:/v/daily/2026-10-01.md", "/v")).toBe("/v/daily/2026-10-01.md");
  });

  it("is null in raw/, outside the vault, without one, or off a page", () => {
    expect(movableNote("page:/v/raw/paper.md", "/v")).toBeNull();
    expect(movableNote("page:/elsewhere/x.md", "/v")).toBeNull();
    expect(movableNote("page:/v/wiki/a.md", undefined)).toBeNull();
    expect(movableNote("overview", "/v")).toBeNull();
  });
});

// The bar is one fixed-height row, so the trail has to give way somewhere:
// the note's name ellipsizes, folders never wrap, and a narrow bar drops the
// folders between the project and the name (the full path is the name's
// tooltip). Layout itself is checked in a browser; this pins the rules.
describe("the crumb trail's stylesheet", () => {
  const root = postcss.parse(readFileSync(resolve(__dirname, "../styles.css"), "utf8"));
  const decls = (selector: string, media?: string): Record<string, string> => {
    const out: Record<string, string> = {};
    root.walkRules((rule) => {
      const at = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule) : null;
      if (media ? at?.params !== media : at) return;
      if (!rule.selectors.includes(selector)) return;
      rule.walkDecls((d) => {
        out[d.prop] = d.value;
      });
    });
    return out;
  };

  it("keeps each folder on one line and lets only the name shrink", () => {
    expect(decls(".crumb")).toMatchObject({ "white-space": "nowrap", "flex-shrink": "0" });
    expect(decls(".breadcrumb > svg")).toMatchObject({ "flex-shrink": "0" });
    expect(decls(".crumb:last-child")).toMatchObject({ "min-width": "0", "flex-shrink": "1" });
    expect(decls(".crumb:last-child b")).toMatchObject({
      overflow: "hidden",
      "text-overflow": "ellipsis",
    });
    expect(decls(".breadcrumb")).toMatchObject({ "min-width": "0", overflow: "hidden" });
  });

  // UX backlog S15: the folder crumb moves the note, so it has to read as a
  // control before the pointer finds it — not as the project name beside it.
  it("draws the folder crumb as a chip at rest", () => {
    expect(decls(".crumb-folder")["box-shadow"]).toMatch(/^inset 0 0 0 1px var\(--line/);
  });

  it("drops the middle folders at 900px and below", () => {
    expect(decls(".crumb:not(:first-of-type):not(:last-child)", "(max-width: 900px)")).toEqual({
      display: "none",
    });
  });
});
