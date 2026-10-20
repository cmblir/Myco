import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, Text } from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import {
  CHART,
  chartData,
  freeId,
  taggedTables,
  type ChartModel,
} from "./chart";
import { blockWidgets, liveBlocks } from "./live";
import { HBars, hbarsHtml } from "../../components/DashCharts";
import { mycoMarkdown } from "../editorBlocks";
import { STRINGS } from "../i18n";
import { markdownRenderer } from "../markdown";

const { parser } = mycoMarkdown().language;
const lezer = (src: string) =>
  liveBlocks(parser.parse(src), Text.of(src.split("\n")));

const fence = (body: string) => "```chart\n" + body + "\n```";
const parse = (body: string) => CHART.parse(body + "\n") as ChartModel;
const tables = (md: string) => taggedTables(markdownRenderer.parse(md, {}));

const SALES =
  "| | Q1 | Q2 |\n| --- | --- | --- |\n| Sales | 12 | 19 |\n| Costs | 8 | 1,100 |\n\n^sales";

describe("chart parse (flat YAML, obsidian-charts keys)", () => {
  it("reads inline labels and series", () => {
    expect(
      parse(
        "type: bar\ntitle: Week\nlabels: [Mon, Tue, 3]\nseries:\n  - title: A\n    data: [1, 2, 3]\n  - title: B\n    data: [4,5]",
      ),
    ).toEqual({
      type: "bar",
      title: "Week",
      id: null,
      layout: "columns",
      labels: ["Mon", "Tue", "3"],
      series: [
        { title: "A", data: ["1", "2", "3"] },
        { title: "B", data: ["4", "5"] },
      ],
    });
  });

  it("takes a table id (a leading ^ too) and its layout", () => {
    expect(parse("type: line\nid: ^sales\nlayout: rows")).toMatchObject({
      type: "line",
      id: "sales",
      layout: "rows",
    });
  });

  it("reads doughnut as pie and ignores keys it does not draw", () => {
    expect(
      parse(
        "# a comment\ntype: doughnut # inline\nwidth: 80%\nbeginAtZero: true\nlegend:\n  position: top\nlabels: [a]\nseries:\n  - data: [1]",
      ),
    ).toMatchObject({
      type: "pie",
      labels: ["a"],
      series: [{ title: "", data: ["1"] }],
    });
  });

  it("reads block-style lists too, as Obsidian's YAML does", () => {
    const want = {
      labels: ["Mon", "Tue"],
      series: [{ title: "s", data: ["1", "2"] }],
    };
    expect(
      parse(
        "type: bar\nlabels:\n  - Mon\n  - Tue\nseries:\n  - title: s\n    data:\n      - 1\n      - 2",
      ),
    ).toMatchObject(want);
    // Items at the key's own indent (YAML allows it), a second series.
    expect(
      parse(
        "type: bar\nlabels:\n- Mon\n- Tue\nseries:\n- title: s\n  data:\n  - 1\n  - 2\n- title: t\n  data: [3, 4]",
      ),
    ).toMatchObject({
      labels: ["Mon", "Tue"],
      series: [...want.series, { title: "t", data: ["3", "4"] }],
    });
    // Another key's list under a series is not its data.
    expect(
      parse(
        "type: bar\nlabels: [a]\nseries:\n  - title: s\n    data:\n      - 5\n    tags:\n      - x",
      ),
    ).toMatchObject({ series: [{ title: "s", data: ["5"] }] });
  });

  it("names what it cannot read: a type, a line", () => {
    expect(parse("labels: [a]")).toEqual({ error: "type", arg: "" });
    expect(parse("type: radar")).toEqual({ error: "type", arg: "radar" });
    expect(parse("type: bar\nlabels [a, b]")).toEqual({
      error: "line",
      arg: "2",
    });
    expect(parse("")).toEqual({ error: "type", arg: "" });
  });
});

describe("chartData", () => {
  it("fills inline series to the labels' length, empty cells as 0", () => {
    expect(
      chartData(
        parse(
          "type: bar\nlabels: [a, b, c]\nseries:\n  - title: S\n    data: [1, , 3, 9]",
        ),
        undefined,
      ),
    ).toEqual({
      type: "bar",
      title: "",
      labels: ["a", "b", "c"],
      series: [{ title: "S", data: [1, 0, 3] }],
    });
  });

  it("reads the table tagged ^id: columns (default) and rows", () => {
    const t = tables(SALES);
    expect(chartData(parse("type: bar\nid: sales"), t)).toMatchObject({
      labels: ["Sales", "Costs"],
      series: [
        { title: "Q1", data: [12, 8] },
        { title: "Q2", data: [19, 1100] },
      ],
    });
    expect(
      chartData(parse("type: bar\nid: sales\nlayout: rows"), t),
    ).toMatchObject({
      labels: ["Q1", "Q2"],
      series: [
        { title: "Sales", data: [12, 19] },
        { title: "Costs", data: [8, 1100] },
      ],
    });
  });

  it("says what is missing: data, the table, a number", () => {
    expect(chartData(parse("type: pie"), undefined)).toEqual({
      error: "data",
      arg: "",
    });
    expect(chartData(parse("type: pie\nid: nope"), tables(SALES))).toEqual({
      error: "table",
      arg: "nope",
    });
    expect(
      chartData(
        parse("type: bar\nlabels: [a]\nseries:\n  - data: [12kg]"),
        undefined,
      ),
    ).toEqual({ error: "number", arg: "12kg" });
  });
});

describe("taggedTables", () => {
  it("finds a table by the ^id paragraph under it, cells as visible text", () => {
    const t = tables(
      "| **a** | `b` |\n| - | - |\n| [[n]] | 2 |\n\n^t1\n\n| x |\n| - |\n\nnot a tag",
    );
    expect([...t.keys()]).toEqual(["t1"]);
    expect(t.get("t1")).toEqual([
      ["a", "b"],
      ["n", "2"],
    ]);
    // A label holding math keeps it as written.
    expect(tables("| $\\alpha$ | 1 |\n| - | - |\n\n^m").get("m")).toEqual([
      ["$\\alpha$", "1"],
    ]);
  });

  it("keeps the first of a repeated id; a tag after other text is no tag", () => {
    const t = tables("| a |\n| - |\n| 1 |\n\n^x\n\n| b |\n| - |\n| 2 |\n\n^x");
    expect(t.get("x")).toEqual([["a"], ["1"]]);
    expect(tables("| a |\n| - |\n\ntext\n\n^x").size).toBe(0);
  });
});

describe("freeId", () => {
  it("skips an id a tag or a chart's `id:` already names", () => {
    expect(freeId("")).toBe("chart-data");
    expect(freeId("x\n\n^chart-data\n")).toBe("chart-data-2");
    expect(freeId("```chart\nid: chart-data\n```\n^chart-data-2")).toBe(
      "chart-data-3",
    );
    // A longer id is another id.
    expect(freeId("^chart-data-22\n^chart-datum")).toBe("chart-data");
  });
});

describe("chart rendering", () => {
  const html = (body: string, md = "") =>
    CHART.renderStatic!(parse(body), { headings: [], tables: tables(md) });

  it("draws one series' bars exactly as the dashboard's HBars", () => {
    const out = html(
      "type: bar\nlabels: [a, b]\nseries:\n  - title: S\n    data: [3, 6]",
    );
    const rows = [
      { label: "a", count: 3 },
      { label: "b", count: 6 },
    ];
    expect(hbarsHtml(rows)).toBe(
      renderToStaticMarkup(createElement(HBars, { rows })),
    );
    expect(out).toContain(hbarsHtml(rows));
    // One series needs no legend.
    expect(out).not.toContain("dash-legend");
  });

  it("gives every bar's value the widest one's width, digits grouped", () => {
    const out = html(
      "type: bar\nlabels: [a, b, c]\nseries:\n  - data: [1250000, 98500, 3.14159]",
    );
    // "1,250,000" is 9 characters: each row's value column is that wide
    // (styles.css .md-chart .dash-hbar), so every track has one length.
    expect(out).toContain('<div class="md-chart" data-chart="bar" style="--num-w:9ch">');
    expect(out).toContain('<span class="dash-hbar__num">1,250,000</span>');
    expect(out).toContain('<span class="dash-hbar__num">98,500</span>');
    expect(out).toContain('<span class="dash-hbar__num">3.14159</span>');
    expect(out).toContain('title="a: 1,250,000"');
    // A table cell's grouping reads back the same.
    expect(html("type: bar\nid: sales", SALES)).toContain(
      'title="Costs · Q2: 1,100"',
    );
  });

  it("colours several series from the palette and names them in a legend", () => {
    const out = html("type: bar\nid: sales", SALES);
    expect(out).toContain("var(--c-overview)");
    expect(out).toContain("var(--c-entity)");
    expect(out).toContain('<div class="dash-legend">');
    expect(out).toContain('title="Sales · Q2: 19"');
  });

  it("draws a line per series and a donut slice per positive value", () => {
    const line = html("type: line\nid: sales", SALES);
    expect(line.match(/<polyline/g)).toHaveLength(2);
    const pie = html(
      "type: pie\nlabels: [a, b, c]\nseries:\n  - data: [1, 3, 0]",
    );
    // The track and two slices; the zero draws none but keeps its legend row.
    expect(pie.match(/<circle/g)).toHaveLength(3);
    expect(pie).toContain("a · 1 (25%)");
    expect(pie).toContain("c · 0 (0%)");
  });

  it("prints a line chart's values as text: its scale, each last value", () => {
    // What shows without a mouse: no tags, no hover <title>.
    const visible = (h: string) =>
      h.replace(/<title>[^<]*<\/title>/g, "").replace(/<[^>]*>/g, " ");
    const one = html(
      "type: line\nlabels: [a, b, c]\nseries:\n  - title: s\n    data: [1, 3, 2500]",
    );
    // One series ends its axis with the last value, as DayLine does.
    expect(visible(one)).toContain("c · 2,500");
    // The scale, high then low, left of the plot.
    expect(one).toContain(
      '<div class="dash-lines__scale"><span>2,500</span><span>0</span></div>',
    );
    // Several series: each legend entry carries its series' last value.
    const two = html(
      "type: line\nlabels: [a, b, c]\nseries:\n  - title: s1\n    data: [1, 3, 2]\n  - title: s2\n    data: [2, 1, 3]",
    );
    expect(visible(two)).toContain("s1 · 2");
    expect(visible(two)).toContain("s2 · 3");
    // A bar's legend stays its series' names: the values are on the bars.
    expect(visible(html("type: bar\nid: sales", SALES))).not.toContain("Q2 · ");
  });

  it("escapes every piece of vault text", () => {
    const hostile = `<img src=x onerror=alert(1)>"'`;
    const out = html(
      `type: pie\ntitle: ${hostile}\nlabels: [${hostile}]\nseries:\n  - title: ${hostile}\n    data: [1]`,
    );
    expect(out).not.toMatch(/<img/);
    expect(out).toContain("&lt;img");
    const bad = html(`type: bar\nlabels: [a]\nseries:\n  - data: [${hostile}]`);
    expect(bad).not.toMatch(/<img/);
  });

  it("shows a parse error as a message in the UI's language, never throws", () => {
    expect(html("type: radar")).toContain('class="md-chart is-error"');
    expect(html("type: radar")).toContain("bar, line or pie");
    const ko = CHART.renderStatic!(parse("type: bar\nid: nope"), {
      headings: [],
      env: { strings: STRINGS.ko },
    });
    // The tag is metadata (decision 6): the message never names it.
    expect(ko).toContain(STRINGS.ko.ch_err_table);
    expect(ko).not.toMatch(/\^|nope/);
  });

  it("says what is wrong in plain words: no ^tag, no id, no keys", () => {
    for (const t of Object.values(STRINGS))
      for (const s of [t.ch_err_data, t.ch_err_table, t.ch_f_missing])
        expect(s).not.toMatch(/\^|\{id\}|\bid\b|labels|series/);
  });
});

describe("chart through Preview and Live", () => {
  const note = `# Report\n\n${SALES}\n\n${fence("type: bar\nid: sales\ntitle: Money")}\n\nend`;

  it("Preview draws the fence from the tagged table; an unclosed one stays code", () => {
    const out = markdownRenderer.render(note);
    expect(out).toContain(
      '<div class="md-chart" data-chart="bar" style="--num-w:5ch">',
    );
    expect(out).toContain('title="Costs · Q2: 1,100"');
    expect(out).not.toContain("language-chart");
    const open = markdownRenderer.render("```chart\ntype: bar\n\nmore");
    expect(open).not.toContain("md-chart");
  });

  it("Live and Preview read the same chart from the same note", () => {
    const [chart] = lezer(note).filter((b) => b.spec.id === "chart");
    expect(chart.source).toBe(fence("type: bar\nid: sales\ntitle: Money"));
    const live = CHART.renderStatic!(chart.parsed as ChartModel, {
      headings: [],
      tables: tables(note),
    });
    expect(markdownRenderer.render(note)).toContain(live);
  });

  it("Live redraws the chart when its table changes, not on other edits", () => {
    // A loaded full run can cut CodeMirror's 20 ms parse short of the fence;
    // a clock that leaps makes that happen every time. The view finishes the
    // parse in idle time and the field redraws; chartWidget does the same.
    let t = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
    onTestFinished(() => clock.mockRestore());
    const state = EditorState.create({
      doc: note,
      extensions: [mycoMarkdown(), blockWidgets({})],
    });
    const chartWidget = (start: EditorState): WidgetType => {
      ensureSyntaxTree(start, start.doc.length, Infinity);
      const s = start.update({}).state;
      const found: WidgetType[] = [];
      for (const d of s.facet(EditorView.decorations)) {
        if (typeof d === "function") continue;
        d.between(0, s.doc.length, (from, _to, v) => {
          if (s.doc.sliceString(from, from + 8) === "```chart")
            found.push(v.spec.widget as WidgetType);
        });
      }
      return found[0];
    };
    const before = chartWidget(state);
    const cell = note.indexOf("19");
    const edited = state.update({
      changes: { from: cell, to: cell + 2, insert: "25" },
    }).state;
    expect(chartWidget(edited).eq(before)).toBe(false);
    const end = state.update({
      changes: { from: note.length, insert: "!" },
    }).state;
    expect(chartWidget(end).eq(before)).toBe(true);
  });

  it("an inline chart never parses the whole note, a table chart does", () => {
    const inline = fence("type: bar\nlabels: [a]\nseries:\n  - data: [1]");
    let reads = 0;
    const ctx = {
      headings: [],
      get tables() {
        reads++;
        return tables(SALES);
      },
    };
    const p = parse("type: bar\nlabels: [a]\nseries:\n  - data: [1]");
    CHART.key!(p, ctx);
    CHART.estimatedHeight(p, ctx);
    expect(reads).toBe(0);
    CHART.estimatedHeight(parse("type: bar\nid: sales"), ctx);
    expect(reads).toBe(1);
    // Typing in a note whose only block is that chart.
    const spy = vi.spyOn(markdownRenderer, "parse");
    try {
      let state = EditorState.create({
        doc: `# N\n\n${inline}\n\ntext`,
        extensions: [mycoMarkdown(), blockWidgets({})],
      });
      for (const ch of "abc")
        state = state.update({
          changes: { from: state.doc.length, insert: ch },
        }).state;
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// Decision 6 (2026-10-01): the tag is metadata the chart manages, not text.
describe("a table's ^id tag", () => {
  const callout = "> [!note] T\n> | c |\n> | - |\n> | 1 |\n>\n> ^ct";
  const note = `# N\n\n${CHART.slash!.sample!(STRINGS.en, "")}\n\n^loose\n\n| a |\n| - |\n\n> ^quoted\n\n> | b |\n> | - |\n>\n> ^qt\n\n${callout}\n\nend`;
  const end = (s: string) => note.indexOf(s) + s.length;

  it("renders as nothing in Preview, only right under a table", () => {
    const out = markdownRenderer.render(note);
    expect(out).not.toContain("^chart-data");
    // Under the chart's fence, or not the table's own paragraph: no tag.
    expect(out).toContain("<p>^loose</p>");
    expect(out).toContain("<p>^quoted</p>");
    // A table in a quote or a callout is tagged from inside it.
    expect(out).not.toContain("^qt");
    expect(out).not.toContain("^ct");
    // Still the charts' data.
    expect([...tables(note).keys()]).toEqual(["chart-data", "qt", "ct"]);
  });

  it("is part of its table's block in Live, so it never shows there", () => {
    const blocks = lezer(note).filter((b) => b.spec.id === "table");
    expect(blocks.map((b) => b.to)).toEqual([
      end("^chart-data"),
      end("| a |\n| - |"),
      end("> ^qt"),
      end("> ^ct"),
    ]);
    // The table itself still reads its own lines only.
    expect((blocks[0].parsed as { src: string }).src).not.toContain("^");
    // Not a tag: the paragraph goes on past it.
    const more = lezer("| a |\n| - |\n\n^x\nmore");
    expect(more[0].to).toBe("| a |\n| - |".length);
  });
});
