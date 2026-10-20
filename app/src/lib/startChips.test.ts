import { describe, expect, it } from "vitest";
import { EditorState, type Transaction } from "@codemirror/state";
import { mycoMarkdown } from "./editorBlocks";
import type { SlashItem } from "./editorCompletions";
import { STRINGS } from "./i18n";
import { applyStartChip, isBodyEmpty, startChips } from "./startChips";

const tpl = (detail: string, template = `${detail} body`): SlashItem => ({
  label: detail.toLowerCase(),
  detail,
  aliases: [],
  icon: "▤",
  section: "templates",
  template,
  caret: template.length,
  apart: true,
});

describe("isBodyEmpty", () => {
  it("counts a note with only frontmatter, a title or blanks as empty", () => {
    expect(isBodyEmpty("")).toBe(true);
    expect(isBodyEmpty("# 2026-10-03\n\n")).toBe(true);
    expect(isBodyEmpty("---\ntitle: x\n---\n\n# x\n")).toBe(true);
    // What vault.rs wiki_page_stub seeds a new wiki note with.
    expect(
      isBodyEmpty(
        "---\ntype: concept\ntags:\ncreated: 2026-10-03\nconfidence: medium\nstatus: active\n---\n\n# chip check\n",
      ),
    ).toBe(true);
  });

  it("is not empty once one character is typed", () => {
    expect(isBodyEmpty("# 2026-10-03\n\na")).toBe(false);
    expect(isBodyEmpty("a")).toBe(false);
    expect(isBodyEmpty("---\ntitle: x\n---\nhello")).toBe(false);
  });
});

describe("startChips", () => {
  it("offers at most three of the vault's templates on a plain note", () => {
    const items = [tpl("A"), tpl("B"), tpl("C"), tpl("D")];
    expect(startChips(items, false, STRINGS.ko).map((c) => c.detail)).toEqual(["A", "B", "C"]);
  });

  it("offers nothing on a plain note when the vault has no templates", () => {
    expect(startChips([], false, STRINGS.ko)).toEqual([]);
  });

  it("offers the three day starters on a daily note, not the templates", () => {
    const chips = startChips([tpl("A")], true, STRINGS.ko);
    expect(chips.map((c) => c.detail)).toEqual(["오늘 할 일", "회의 기록", "생각 정리"]);
    for (const c of chips) {
      expect(c.template).not.toContain("${}");
      expect(c.caret).toBeLessThanOrEqual(c.template.length);
    }
  });
});

describe("applyStartChip", () => {
  const run = (doc: string, item: SlashItem) => {
    let state = EditorState.create({ doc, extensions: [mycoMarkdown()] });
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        state = t.state;
      },
    };
    applyStartChip(view, item);
    const h = state.selection.main.head;
    return state.doc.sliceString(0, h) + "│" + state.doc.sliceString(h);
  };

  it("puts the starter under the daily note's date title", () => {
    const todo = startChips([], true, STRINGS.ko)[0];
    expect(run("# 2026-10-03\n\n", todo)).toBe("# 2026-10-03\n\n## 오늘 할 일\n- [ ] │");
  });

  it("starts a block of its own when the title has no line after it", () => {
    expect(run("# Plan", tpl("A", "body"))).toBe("# Plan\n\nbody│");
  });

  it("fills an empty note from the top", () => {
    expect(run("", tpl("A", "body"))).toBe("body│");
  });
});
