import { describe, expect, it } from "vitest";
import { chartOf, fieldsFor, tableOptions, toInline } from "./chartPanel";
import { writeChart } from "./chartSource";
import { STRINGS } from "../i18n";

/** What closing the panel writes when no field was touched. */
const untouched = (body: string) =>
  writeChart(body, chartOf(body, fieldsFor(body, null)));

const FLOW =
  "type: bar\nlabels: [Q1, Q2]\nseries: [{title: 매출, data: [30, 40]}]\nwidth: 80%";
const INLINE = "type: bar\nlabels: [A, B]\nseries:\n  - data: [1, 2]";

describe("chart panel fields ↔ fence body", () => {
  it("opened and closed untouched, writes the body back byte for byte", () => {
    for (const body of [
      "type: bar",
      "type: line\ntitle: 매출\nlabels: [1월, 2월]",
      "type: pie\nid: missing-table",
      'type: doughnut\nlabels: [A, B]\nseries:\n  - title: " 공백 "\n    data: [1, 2]',
      'type: bar\ntitle: " 공백 "',
      FLOW,
    ])
      expect(untouched(body)).toBe(body);
  });

  it("writes only the field changed: a series it cannot read stays", () => {
    const f = fieldsFor(FLOW, null);
    expect(writeChart(FLOW, chartOf(FLOW, { ...f, title: "분기" }))).toBe(
      "type: bar\nlabels: [Q1, Q2]\nseries: [{title: 매출, data: [30, 40]}]\ntitle: 분기\nwidth: 80%",
    );
    // A title typed with spaces at its ends is written trimmed.
    expect(chartOf(FLOW, { ...f, title: " 분기 " }).title).toBe("분기");
  });

  it("a fence with no id is inline data, its own, after ⌘Z too", () => {
    // The panel had turned the data to the table ^t1; ⌘Z brought the
    // inline data back, and the next edit must not write `id: t1` again.
    const f = fieldsFor(INLINE, "t1");
    expect(f).toMatchObject({
      mode: "inline",
      table: "t1",
      labels: "A, B",
      series: [{ title: "", data: ["1", "2"] }],
    });
    expect(writeChart(INLINE, chartOf(INLINE, { ...f, title: "매출" }))).toBe(
      `${INLINE}\ntitle: 매출`,
    );
    expect(fieldsFor("type: bar\nid: t2", "t1")).toMatchObject({
      mode: "table",
      table: "t2",
    });
    expect(writeChart(INLINE, chartOf(INLINE, { ...f, mode: "table" }))).toBe(
      "type: bar\nid: t1",
    );
  });

  it("turned to inline data, a chart with none gets a sample to start from", () => {
    const table = fieldsFor("type: bar\nid: t", null);
    expect(toInline(table)).toMatchObject({
      mode: "inline",
      labels: "A, B",
      series: [{ title: "", data: ["1", "2"] }],
    });
    // Data typed before the switch to a table comes back as it was.
    const typed = { ...table, labels: "x", series: [] };
    expect(toInline(typed)).toMatchObject({ labels: "x", series: [] });
  });
});

describe("chart panel's table picker", () => {
  const ko = STRINGS.ko;
  const tables = new Map([
    [
      "chart-data",
      [
        ["", "A", "B"],
        ["x", "1", "2"],
      ],
    ],
    ["chart-data-2", [["", "", ""]]],
  ]);
  const labels = (o: [string, string][]) => o.map(([, label]) => label);

  it("names the note's tables by place and header row, never their tag", () => {
    const opts = tableOptions(tables, "chart-data", ko);
    expect(labels(opts)).toEqual(["표 1 · A, B", "표 2", ko.ch_f_new_table]);
    // The tag stays the option's value: the fence's `id:` is written from it.
    expect(opts.slice(0, 2).map(([v]) => v)).toEqual([
      "chart-data",
      "chart-data-2",
    ]);
  });

  it("a table the note no longer has is named as missing, its id unsaid", () => {
    const opts = tableOptions(new Map(), "chart-data", ko);
    expect(opts[0][0]).toBe("chart-data");
    expect(labels(opts)).toEqual([ko.ch_f_missing, ko.ch_f_new_table]);
    expect(labels(opts).join()).not.toContain("chart-data");
  });
});
