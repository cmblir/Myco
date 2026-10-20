import { describe, expect, it } from "vitest";
import { chartForm, writeChart, type ChartSource } from "./chartSource";

const SAMPLE = "type: bar\nid: chart-data\ntitle: 예시 차트";
const OBSIDIAN =
  "type: doughnut\n# a comment\nwidth: 80%\nlabels: [Mon, Tue]\nseries:\n  - title: A\n    data: [1, 2]\nbeginAtZero: true\nlegendPosition: top";

const edit = (body: string, change: Partial<ChartSource>) =>
  writeChart(body, { ...chartForm(body), ...change });

describe("chart panel form ↔ fence body", () => {
  it("reads the form from the fence, doughnut as pie", () => {
    expect(chartForm(SAMPLE)).toEqual({
      type: "bar",
      title: "예시 차트",
      id: "chart-data",
      layout: "columns",
      labels: [],
      series: [],
    });
    expect(chartForm(OBSIDIAN)).toMatchObject({
      type: "pie",
      id: null,
      labels: ["Mon", "Tue"],
      series: [{ title: "A", data: ["1", "2"] }],
    });
  });

  it("an untouched form writes the body back byte for byte", () => {
    for (const body of [SAMPLE, OBSIDIAN, "type: line\nlayout: rows\nid: ^t"])
      expect(writeChart(body, chartForm(body))).toBe(body);
  });

  it("changes only the keys the form changed, in place", () => {
    expect(edit(SAMPLE, { type: "line" })).toBe(
      "type: line\nid: chart-data\ntitle: 예시 차트",
    );
    expect(edit(SAMPLE, { title: "매출" })).toBe(
      "type: bar\nid: chart-data\ntitle: 매출",
    );
    // No title: the key goes.
    expect(edit(SAMPLE, { title: "" })).toBe("type: bar\nid: chart-data");
    expect(edit("type: bar\nid: t", { title: "새 제목" })).toBe(
      "type: bar\nid: t\ntitle: 새 제목",
    );
  });

  it("keeps keys and comments it does not know (obsidian-charts' width…)", () => {
    const out = edit(OBSIDIAN, { type: "bar", title: "Week" });
    expect(out).toBe(
      "type: bar\n# a comment\nwidth: 80%\nlabels: [Mon, Tue]\nseries:\n  - title: A\n    data: [1, 2]\ntitle: Week\nbeginAtZero: true\nlegendPosition: top",
    );
    // pie stays the doughnut it was written as.
    expect(edit(OBSIDIAN, { title: "x" }).startsWith("type: doughnut\n")).toBe(
      true,
    );
  });

  it("switches the data between a table and inline series", () => {
    const inline = edit(SAMPLE, {
      id: null,
      labels: ["A", "B"],
      series: [
        { title: "", data: ["1", "2"] },
        { title: "둘", data: ["3"] },
      ],
    });
    expect(inline).toBe(
      "type: bar\ntitle: 예시 차트\nlabels: [A, B]\nseries:\n  - data: [1, 2]\n  - title: 둘\n    data: [3]",
    );
    expect(chartForm(inline).series).toEqual([
      { title: "", data: ["1", "2"] },
      { title: "둘", data: ["3"] },
    ]);
    expect(edit(inline, { id: "sales", layout: "rows" })).toBe(
      "type: bar\ntitle: 예시 차트\nid: sales\nlayout: rows",
    );
    expect(edit(OBSIDIAN, { id: "t" })).toBe(
      "type: doughnut\n# a comment\nwidth: 80%\nid: t\nbeginAtZero: true\nlegendPosition: top",
    );
  });

  it("writes the layout only for rows (columns is the default), new keys after the form's", () => {
    expect(edit(SAMPLE, { layout: "rows" })).toBe(
      "type: bar\nid: chart-data\ntitle: 예시 차트\nlayout: rows",
    );
    expect(edit("type: bar\nid: t\nlayout: rows", { layout: "columns" })).toBe(
      "type: bar\nid: t",
    );
  });

  it("quotes text YAML would misread, and reads it back as typed", () => {
    for (const title of ['"인용"', "# 해시", "a: b", "x #y", "[1]"]) {
      const out = edit(SAMPLE, { title });
      expect(chartForm(out).title, out).toBe(title);
    }
    expect(edit(SAMPLE, { title: "a: b" })).toContain('title: "a: b"');
    const out = edit("type: bar", { labels: ["#1", "b]"], series: [] });
    expect(chartForm(out).labels).toEqual(["#1", "b]"]);
  });

  it("a type it cannot read is written once the form is, a bad line kept", () => {
    expect(chartForm("type: radar\nnot a key").type).toBe("bar");
    expect(
      writeChart("type: radar\nnot a key", chartForm("type: radar\nnot a key")),
    ).toBe("type: bar\nnot a key");
    expect(writeChart("labels: [a]", chartForm("labels: [a]"))).toBe(
      "labels: [a]\ntype: bar",
    );
  });

  it("a repeated key is written once", () => {
    expect(edit("type: bar\ntitle: a\ntitle: b", { title: "c" })).toBe(
      "type: bar\ntitle: c",
    );
  });
});
