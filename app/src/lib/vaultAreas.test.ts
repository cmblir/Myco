import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STRINGS } from "./i18n";
import { areaRank, byArea, classifyTopLevel, kindName, newNoteDir } from "./vaultAreas";

describe("classifyTopLevel", () => {
  it("names the folders myco writes and keeps as managed", () => {
    for (const name of [
      "raw",
      "sessions",
      "cards",
      "ingest-reports",
      "work",
      "_inbox",
      "templates",
      "audio",
      "CLAUDE.md",
    ]) {
      expect(classifyTopLevel(name), name).toBe("managed");
    }
  });

  // vault.rs search_vault visits these last, so ⌘K's body hits fill with mine.
  it("matches the managed list the vault's search orders by", () => {
    const rs = readFileSync(resolve(__dirname, "../../src-tauri/src/vault.rs"), "utf8");
    const list = /const MANAGED_TOP: &\[&str\] = &\[([^\]]*)\]/.exec(rs)?.[1] ?? "";
    const names = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toHaveLength(9);
    for (const name of names) expect(classifyTopLevel(name), name).toBe("managed");
  });

  it("leaves wiki, daily and the user's own folders and files as mine", () => {
    for (const name of ["wiki", "daily", "projects", "welcome.md", "constructor", "__proto__"]) {
      expect(classifyTopLevel(name), name).toBe("mine");
    }
  });
});

describe("kindName", () => {
  const ko = STRINGS.ko;
  it("calls a managed result by what it is, not by its folder", () => {
    expect(kindName("cards/attention-mechanism.md", ko)).toBe("학습 카드");
    expect(kindName("ingest-reports/2026-07-15-attention.md", ko)).toBe("자료 추가 보고서");
    expect(kindName("work/feedback/2026-08-12-map-candidate-attention.md", ko)).toBe("정리 후보");
  });

  it("has a name for every managed folder in every language", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      for (const top of ["raw", "sessions", "cards", "ingest-reports", "work", "_inbox", "templates", "audio"]) {
        expect(kindName(`${top}/x.md`, STRINGS[lang]), `${lang} ${top}`).toBeTruthy();
      }
      expect(kindName("CLAUDE.md", STRINGS[lang]), lang).toBeTruthy();
    }
  });

  it("is null for a note of mine", () => {
    expect(kindName("wiki/attention-mechanism.md", ko)).toBeNull();
    expect(kindName("daily/2026-10-01.md", ko)).toBeNull();
    expect(kindName("welcome.md", ko)).toBeNull();
  });
});

describe("areaRank and byArea", () => {
  // authorship_index: wiki/ rel -> ever committed by the agent author.
  const index = { "wiki/agent.md": true, "wiki/human.md": false };

  it("ranks human on record, then unknown mine, then myco's, then managed", () => {
    expect(areaRank("wiki/human.md", index)).toBe(0);
    expect(areaRank("wiki/untracked.md", index)).toBe(1);
    expect(areaRank("daily/2026-10-01.md", index)).toBe(1);
    expect(areaRank("wiki/agent.md", index)).toBe(2);
    expect(areaRank("cards/deck.md", index)).toBe(3);
    // A managed file never ranks as mine, whatever the index says of it.
    expect(areaRank("work/feedback/x.md", { "work/feedback/x.md": false })).toBe(3);
  });

  it("treats a vault with no history (empty index) as all mine, unmarked", () => {
    expect(areaRank("wiki/agent.md", {})).toBe(1);
  });

  it("puts a human note before a myco note of the same score, keeping order within a rank", () => {
    const items = [
      "work/feedback/candidate-attention.md",
      "wiki/agent.md",
      "cards/attention.md",
      "wiki/untracked-b.md",
      "wiki/human.md",
      "wiki/untracked-a.md",
    ];
    expect(byArea(items, (rel) => rel, index)).toEqual([
      "wiki/human.md",
      "wiki/untracked-b.md",
      "wiki/untracked-a.md",
      "wiki/agent.md",
      "work/feedback/candidate-attention.md",
      "cards/attention.md",
    ]);
  });
});

describe("newNoteDir", () => {
  it("is the open note's folder when that folder is mine", () => {
    expect(newNoteDir("/v/daily/2026-10-01.md", "/v")).toBe("/v/daily");
    expect(newNoteDir("/v/wiki/roadmaps/q4.md", "/v")).toBe("/v/wiki/roadmaps");
    expect(newNoteDir("/v/projects/a.md", "/v")).toBe("/v/projects");
  });

  // The vault root is not indexed for Ask (commands.rs collect_pages walks
  // wiki/, daily/, sessions/ …), and a root note has no folder crumb to move it.
  it("falls back to the default (wiki/) from a note at the vault root", () => {
    expect(newNoteDir("/v/welcome.md", "/v")).toBeNull();
  });

  it("falls back to the default (wiki/) in a managed folder, raw/ included", () => {
    expect(newNoteDir("/v/cards/attention-mechanism.md", "/v")).toBeNull();
    expect(newNoteDir("/v/raw/paper.md", "/v")).toBeNull();
    expect(newNoteDir("/v/work/feedback/x.md", "/v")).toBeNull();
    expect(newNoteDir("/v/CLAUDE.md", "/v")).toBeNull();
  });

  it("falls back with nothing open, no vault, or a path outside the vault", () => {
    expect(newNoteDir(null, "/v")).toBeNull();
    expect(newNoteDir("/v/daily/a.md", "")).toBeNull();
    expect(newNoteDir("/vault2/daily/a.md", "/v")).toBeNull();
  });
});
