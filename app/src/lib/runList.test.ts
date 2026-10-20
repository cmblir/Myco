import { describe, expect, it } from "vitest";
import { formatRunLine, runTitle } from "./runList";

describe("formatRunLine", () => {
  it("shows relative time and non-zero counts only", () => {
    const now = Math.floor(Date.now() / 1000);
    const line = formatRunLine(
      { id: "digest-1", started_at: now - 3600, moves: 3, trashed: 0, created: 2 },
      "en",
    );
    expect(line).toMatch(/hour/);
    expect(line).toContain("3");
    expect(line).toContain("2");
    expect(line).not.toContain("trash");
  });
});

// S29: a run reads as its date and kind, never "digest-1755740000".
describe("runTitle", () => {
  const run = (id: string) => ({ id, started_at: 1755740000, moves: 0, trashed: 0, created: 0 });
  const t = {
    history_run_kind_digest: "대화 기록 요약",
    history_run_kind_llm: "모델 정리",
    history_run_kind_distill: "자동 정리",
  };

  it("names the kind from the id's shape", () => {
    expect(runTitle(run("digest-1755740000"), "ko", t)).toMatch(/^대화 기록 요약 · /);
    expect(runTitle(run("llm-1755740000-2"), "ko", t)).toMatch(/^모델 정리 · /);
    expect(runTitle(run("20250821T013320"), "ko", t)).toMatch(/^자동 정리 · /);
  });

  it("dates it from started_at in the app's language, not the raw stamp", () => {
    const title = runTitle(run("digest-1755740000"), "ko", t);
    expect(title).not.toContain("1755740000");
    expect(title).toContain("2025");
    expect(title).toContain("8월");
  });
});
