import { describe, expect, it } from "vitest";
import {
  classifyWorkstreamQuestion,
  filterChoices,
  parseWorkstreamFacts,
  resolveWorkstream,
  workstreamAnswer,
  workstreamChoices,
  workstreamRecentRange,
  workstreamSources,
  type WorkstreamFacts,
} from "./queryWorkstreams";
import { buildExplainQuestion } from "./guidedQuestion";
// Written by the native writer's test (workstreams.rs
// facts_match_the_shared_reader_fixture), which fails when its output drifts.
import WRITER_FIXTURE from "./workstreamFacts.fixture.json";

// Synthetic facts only: no real conversation, folder or person.
const at = (iso: string): number => Date.parse(iso) / 1000;
const NOW = new Date("2026-11-08T12:00:00Z");
/** The renderer's local month and day, so the expectations hold in any time
 * zone, with the year only when it is not the year of `asked`, the query time. */
const day = (iso: string, lang: "en" | "ko" | "ja" = "ko", asked = NOW): string => {
  const date = new Date(at(iso) * 1000);
  return new Intl.DateTimeFormat(lang, { year: date.getFullYear() === asked.getFullYear() ? undefined : "numeric",
    month: lang === "en" ? "short" : "long", day: "numeric" }).format(date);
};
/** A transcript as an answer cites it, labeled in the UI language. */
const cite = (raw: string, lang: "en" | "ko" | "ja" = "ko"): string =>
  `[[${raw}|${{ en: "source", ko: "원문", ja: "原文" }[lang]}]]`;
/** A hard break: the next line of the same list item. */
const BR = "\\\n  ";
/** A list's items; a hard break continues an item on its next line. */
const listItems = (list: string): string[] => list.split(/\n(?=- )/);
/** Every answer's last paragraph. */
const REPORTED_ONLY = {
  en: "Gathered from what the conversations reported; whether the work is really done was not checked.",
  ko: "대화에서 보고된 내용을 모은 것이며, 실제로 끝났는지는 확인하지 않았습니다.",
  ja: "会話で報告された内容をまとめたもので、実際に終わったかは確認していません。",
};

type Conversation = WorkstreamFacts["conversations"][string];
function conversation(ledger: string, fields: Partial<Conversation>): [string, Conversation] {
  const [vendor, id] = ledger.split(":") as [Conversation["vendor"], string];
  return [ledger, {
    fp: "0123456789abcdef", vendor, id, raw: `raw/conversations/${vendor}/${vendor}-${id}-0123456789abcdef.md`,
    first_epoch: at("2026-11-05T09:00:00Z"), last_epoch: at("2026-11-05T10:00:00Z"), key: null,
    cwd_source: "sidecar", root: ledger, subagent: false, request: null, report: null, parent_report: null, automated: false, ...fields,
  }];
}

const ROOT = "codex:c0ffee01-0000-7000-8000-000000000001";
const SUBAGENT = "codex:c0ffee02-0000-7000-8000-000000000002";
const ROOT_RAW = "raw/conversations/codex/codex-c0ffee01-0000-7000-8000-000000000001-0123456789abcdef";
const CHART_RAW = "raw/conversations/codex/codex-c0ffee04-0000-7000-8000-000000000004-0123456789abcdef";
const ESCAPED_REPORT = "Review found \\*\\*two\\*\\* issues in \\[the\\] scheduler.";

function facts(): WorkstreamFacts {
  const older = Array.from({ length: 5 }, (_, i) => conversation(`claude-code:0000000${i}-0000-4000-8000-000000000000`, {
    key: "prj_lumen", first_epoch: at(`2026-10-0${i + 1}T09:00:00Z`), last_epoch: at(`2026-10-0${i + 1}T10:00:00Z`),
    request: `Older synthetic step ${i}`, report: { epoch: at(`2026-10-0${i + 1}T10:00:00Z`), text: `Finished older step ${i}.` },
  }));
  return {
    version: 5,
    last_record_epoch: at("2026-11-07T12:30:00Z"),
    unassigned: 3,
    workstreams: {
      prj_lumen: { title: "🌙 Lumen", title_source: "readme", page: "wiki/workstreams/prj_lumen.md",
        first_epoch: at("2026-10-01T09:00:00Z"), last_epoch: at("2026-11-07T12:30:00Z"), conversations: 8, roots: 7,
        summary: "A synthetic prayer reminder app for **testing**.",
        open_items: [
          { epoch: at("2026-11-07T10:00:00Z"), text: "Retry window for the [reminder] scheduler", conversation: ROOT },
          { epoch: at("2026-10-05T10:00:00Z"), text: "Translate the settings screen", conversation: "claude-code:00000004-0000-4000-8000-000000000000" },
        ] },
      "chart-lab": { title: "Chart Lab", title_source: "readme", page: "wiki/workstreams/chart-lab.md",
        first_epoch: at("2026-11-04T09:00:00Z"), last_epoch: at("2026-11-04T10:00:00Z"), conversations: 1, roots: 1,
        summary: null, open_items: [] },
      chart: { title: "chart", title_source: "key", page: "wiki/workstreams/chart.md",
        first_epoch: at("2026-09-01T09:00:00Z"), last_epoch: at("2026-09-01T10:00:00Z"), conversations: 0, roots: 0,
        summary: null, open_items: [] },
    },
    conversations: Object.fromEntries([
      conversation(ROOT, { key: "prj_lumen", cwd_source: "state", first_epoch: at("2026-11-06T09:00:00Z"),
        last_epoch: at("2026-11-07T11:00:00Z"), request: "Add prayer reminders to the synthetic app",
        report: { epoch: at("2026-11-07T10:00:00Z"), text: "Implemented the reminder scheduler." } }),
      conversation(SUBAGENT, { key: "prj_lumen", cwd_source: "inherited", root: ROOT, subagent: true,
        first_epoch: at("2026-11-07T11:30:00Z"), last_epoch: at("2026-11-07T12:30:00Z"), request: "Review the reminder diff",
        report: { epoch: at("2026-11-07T12:30:00Z"), text: "Review found **two** issues in [the] scheduler." } }),
      conversation("claude-code:aaaa1111-0000-4000-8000-000000000003", { key: "prj_lumen",
        request: "Package the synthetic voice pack" }),
      ...older,
      conversation("codex:c0ffee04-0000-7000-8000-000000000004", { key: "chart-lab", cwd_source: "rollout",
        first_epoch: at("2026-11-04T09:00:00Z"), last_epoch: at("2026-11-04T10:00:00Z"), request: "Fix the chart",
        report: { epoch: at("2026-11-04T10:00:00Z"), text: "Updated the portfolio chart." } }),
      conversation("claude-code:bbbb2222-0000-4000-8000-000000000005", { cwd_source: "none",
        first_epoch: at("2026-11-06T09:00:00Z"), last_epoch: at("2026-11-06T10:00:00Z") }),
    ]),
  };
}

describe("workstream source selection", () => {
  it("uses current project projections, never another project's same-named task", () => {
    const source = facts();
    const entries = Object.fromEntries(Object.entries(source.conversations).map(([key, value]) => [key, value.fp]));
    const locations = Object.fromEntries(Object.keys(entries).map((key, index) => [`sessions:${key}`, `sessions/source-${index}.md`]));
    const selected = workstreamSources("Lumen", source, JSON.stringify({entries, locations}), NOW);
    expect(selected?.paths).toContain(locations[`sessions:${ROOT}`]);
    expect(selected?.paths).not.toContain(locations["sessions:codex:c0ffee04-0000-7000-8000-000000000004"]);
    expect(selected?.range).toEqual({start:"2026-10-01",end:"2026-11-08"});
    expect(selected?.incomplete).toBe(false);
  });

  it("intersects explicit paths and dates, and exposes stale or missing project projections", () => {
    const source = facts();
    const selected = workstreamSources("Lumen", source, JSON.stringify({
      entries:{[ROOT]:source.conversations[ROOT].fp,[SUBAGENT]:"changed-revision"},
      locations:{[`sessions:${ROOT}`]:"sessions/allowed.md",[`sessions:${SUBAGENT}`]:"sessions/stale.md"},
    }), NOW, {paths:["sessions/allowed.md","sessions/unrelated.md"],range:{start:"2026-11-06",end:"2026-11-07"}});
    expect(selected).toMatchObject({paths:["sessions/allowed.md"],range:{start:"2026-11-06",end:"2026-11-07"},incomplete:true});
    expect(workstreamSources("Lumen",source,"{}",NOW)?.paths).toEqual([]);
    expect(workstreamSources("Lumen",source,"{}",NOW)?.incomplete).toBe(true);
  });

  it("does not invent a current interval when the cutoff predates the project", () => {
    expect(workstreamSources("Lumen",facts(),"{}",NOW,{asOf:"2026-09-01"})?.range).toBeNull();
  });

  it.each(["sessions/../beta.md", "sessions/./beta.md", "sessions//beta.md", "sessions/beta.md\n", "sessions/beta\t.md", "sessions/beta\\x.md", "wiki/beta.md"])(
    "rejects malformed or outside-session projection %s", path => {
      const source = facts();
      const selected = workstreamSources("Lumen",source,JSON.stringify({entries:{[ROOT]:source.conversations[ROOT].fp},
        locations:{[`sessions:${ROOT}`]:path}}),NOW);
      expect(selected).toMatchObject({paths:[],incomplete:true});
    });

  it("rejects a projection assigned to multiple conversation identities", () => {
    const source = facts();
    const selected = workstreamSources("Lumen",source,JSON.stringify({entries:{[ROOT]:source.conversations[ROOT].fp},
      locations:{[`sessions:${ROOT}`]:"sessions/shared.md","sessions:codex:beta":"sessions/shared.md"}}),NOW);
    expect(selected).toMatchObject({paths:[],incomplete:true});
  });

  it.each(["not-json", "null", "[]", '{"entries":[],"locations":{}}', " ".repeat(8 * 1024 * 1024 + 1)])(
    "keeps malformed or oversized ledger snapshots incomplete", ledger => {
      expect(workstreamSources("Lumen",facts(),ledger,NOW)).toMatchObject({paths:[],incomplete:true});
    });
});

describe("classifyWorkstreamQuestion", () => {
  it.each([
    ["Lumen 지금 어디까지 했어?", "ko", { kind: "progress", name: "Lumen" }],
    ["Lumen은 지금 어디까지 했어?", "ko", { kind: "progress", name: "Lumen" }],
    ["지금 Lumen 어디까지 진행됐어?", "ko", { kind: "progress", name: "Lumen" }],
    ["지금 어디까지 했어?", "ko", { kind: "progress", name: null }],
    ["내가 지금 어디까지 했지", "ko", { kind: "progress", name: null }],
    ["내가 최근에 한 일이 뭐야?", "ko", { kind: "recent" }],
    ["최근에 한일", "ko", { kind: "recent" }],
    ["How far along is Lumen now?", "en", { kind: "progress", name: "Lumen" }],
    ["How far did I get with Chart Lab?", "en", { kind: "progress", name: "Chart Lab" }],
    ["How far along am I?", "en", { kind: "progress", name: null }],
    ["What did I do recently?", "en", { kind: "recent" }],
    ["Lumenは今どこまで進んだ？", "ja", { kind: "progress", name: "Lumen" }],
    ["今どこまで進んだ？", "ja", { kind: "progress", name: null }],
    ["最近やったことをまとめて", "ja", { kind: "recent" }],
    // A pronoun or "the project" names nothing: the unnamed default answers.
    ["How far along is it?", "en", { kind: "progress", name: null }],
    ["where am I with it", "en", { kind: "progress", name: null }],
    ["How far along is the project?", "en", { kind: "progress", name: null }],
    ["그거 어디까지 했어?", "ko", { kind: "progress", name: null }],
    ["이 프로젝트 지금 어디까지 했어?", "ko", { kind: "progress", name: null }],
    ["それはどこまで進んだ？", "ja", { kind: "progress", name: null }],
    // A named project explained, as the explain chip asks it or typed.
    ["‘Lumen’ 프로젝트를 설명해줘.", "ko", { kind: "explain", name: "Lumen" }],
    ["Lumen 프로젝트 설명해줘", "ko", { kind: "explain", name: "Lumen" }],
    ["Lumen 프로젝트에 대해서 좀 설명해 줘", "ko", { kind: "explain", name: "Lumen" }],
    ["Explain the Chart Lab project.", "en", { kind: "explain", name: "Chart Lab" }],
    ["describe the Lumen project", "en", { kind: "explain", name: "Lumen" }],
    ["「Lumen」プロジェクトを説明して。", "ja", { kind: "explain", name: "Lumen" }],
  ] as const)("routes %s", (question, lang, expected) => {
    expect(classifyWorkstreamQuestion(question, lang, NOW)).toEqual(expected);
  });

  it.each(["en", "ko", "ja"] as const)("reads the explain chip's %s question back as the name it was built with", (lang) => {
    for (const name of ["Lumen", "Harbor Run (하버 런)", "Tide Ledger Planner Of The Week"])
      expect(classifyWorkstreamQuestion(buildExplainQuestion(name, lang), lang, NOW)).toEqual({ kind: "explain", name });
    expect(buildExplainQuestion("  ", lang)).toBe("");
  });

  it.each([
    "Lumen에 대해서 설명해줘",
    "이 프로젝트 설명해줘",
    "프로젝트 설명해줘",
    "Explain this project",
    "얼마나 남았어?",
    "Lumen 남은 일이 뭐야?",
    "지난주에 한 일",
    "attention이 뭐야?",
    "이 책 어디까지 읽었어?",
    "회의에서 말한 알림 기능 구현과 테스트 정리는 어디까지 했어?",
  ])("leaves other questions to the existing routes: %s", (question) => {
    expect(classifyWorkstreamQuestion(question, "ko", NOW)).toBeNull();
  });
});

describe("parseWorkstreamFacts", () => {
  const broken = (patch: (value: WorkstreamFacts) => void): string => {
    const value = facts();
    patch(value);
    return JSON.stringify(value);
  };
  type Loose = Record<string, unknown>;

  it("accepts the version 5 contract, user and derived titles, a copied report and a program's session included", () => {
    expect(parseWorkstreamFacts(JSON.stringify(facts()))).toEqual(facts());
    const titled = facts();
    titled.workstreams.prj_lumen.title_source = "user";
    titled.workstreams.chart.title_source = "derived";
    titled.conversations[SUBAGENT].parent_report = { epoch: at("2026-11-07T10:00:00Z"), text: "Copied answer" };
    titled.conversations[ROOT].automated = true;
    expect(parseWorkstreamFacts(JSON.stringify(titled))).toEqual(titled);
  });

  it.each([
    ["invalid JSON", "{"],
    ["a non-object", "null"],
    // Version 1 facts carried every sub-agent as its own session; they are not read.
    ["version 1 facts", broken((value) => { (value as unknown as Loose).version = 1; })],
    // Version 2 facts counted a program's sessions as the person's; they are not read.
    ["version 2 facts", broken((value) => { (value as unknown as Loose).version = 2; })],
    // Version 3 facts had no README summary or open items; they are not read.
    ["version 3 facts", broken((value) => { (value as unknown as Loose).version = 3; })],
    ["version 4 basename identities", broken((value) => { (value as unknown as Loose).version = 4; })],
    ["a later version", broken((value) => { (value as unknown as Loose).version = 6; })],
    ["no summary field", broken((value) => { delete (value.workstreams.chart as unknown as Loose).summary; })],
    ["a non-text summary", broken((value) => { (value.workstreams.chart as unknown as Loose).summary = 7; })],
    ["a summary past 1024 characters", broken((value) => { value.workstreams.chart.summary = "x".repeat(1025); })],
    ["no open items", broken((value) => { delete (value.workstreams.chart as unknown as Loose).open_items; })],
    ["more than ten open items", broken((value) => {
      value.workstreams.prj_lumen.open_items = Array.from({ length: 11 }, () => ({ ...value.workstreams.prj_lumen.open_items[0] }));
    })],
    ["an open item without text", broken((value) => { delete (value.workstreams.prj_lumen.open_items[0] as unknown as Loose).text; })],
    ["an open item past 512 characters", broken((value) => { value.workstreams.prj_lumen.open_items[0].text = "x".repeat(513); })],
    ["an open item citing no conversation", broken((value) => { value.workstreams.prj_lumen.open_items[0].conversation = "codex:missing"; })],
    ["an open item citing another project's conversation", broken((value) => {
      value.workstreams.prj_lumen.open_items[0].conversation = "codex:c0ffee04-0000-7000-8000-000000000004";
    })],
    ["no automated flag", broken((value) => { delete (value.conversations[ROOT] as unknown as Loose).automated; })],
    ["a non-boolean automated flag", broken((value) => { (value.conversations[ROOT] as unknown as Loose).automated = "no"; })],
    ["an unknown title source", broken((value) => { (value.workstreams.chart as unknown as Loose).title_source = "guess"; })],
    ["a key without a workstream", broken((value) => { value.conversations[ROOT].key = "missing"; })],
    ["a raw path that leaves raw/conversations", broken((value) => { value.conversations[ROOT].raw = "raw/conversations/../notes.md"; })],
    ["a page outside wiki/workstreams", broken((value) => { value.workstreams.prj_lumen.page = "wiki/prj_lumen.md"; })],
    ["a link-breaking page path", broken((value) => { value.workstreams.prj_lumen.page = "wiki/workstreams/a|b.md"; })],
    ["a page path a link would cut at '#'", broken((value) => { value.workstreams.prj_lumen.page = "wiki/workstreams/c#.md"; })],
    ["a fractional epoch", broken((value) => { value.conversations[ROOT].last_epoch = 1.5; })],
    ["a report without text", broken((value) => { (value.conversations[ROOT] as unknown as Loose).report = { epoch: 1 }; })],
    ["a copied report without text", broken((value) => { (value.conversations[SUBAGENT] as unknown as Loose).parent_report = { epoch: 1 }; })],
    ["no copied-report field", broken((value) => { delete (value.conversations[SUBAGENT] as unknown as Loose).parent_report; })],
    ["an unknown vendor", broken((value) => { (value.conversations[ROOT] as unknown as Loose).vendor = "chatgpt"; })],
  ])("rejects %s", (_, raw) => {
    expect(parseWorkstreamFacts(raw)).toBeNull();
  });
});

describe("resolveWorkstream", () => {
  it("keeps equal display names ambiguous across distinct opaque project identities", () => {
    const value = facts();
    const first = `p5-${"a".repeat(64)}`;
    const second = `p5-${"b".repeat(64)}`;
    value.workstreams = {
      [first]: { ...value.workstreams.prj_lumen, title: "Atlas" },
      [second]: { ...value.workstreams["chart-lab"], title: "Atlas" },
    };
    expect(resolveWorkstream("Atlas", value)).toBeNull();
    expect(workstreamAnswer({ kind: "progress", name: "Atlas" }, value, "en", NOW)).toBeNull();
    expect(resolveWorkstream(first, value)).toBe(first);
    expect(resolveWorkstream(second, value)).toBe(second);
  });

  it.each(["en", "ko", "ja"] as const)("discloses retained stale project pages in %s answers", (lang) => {
    const value = facts();
    value.workstreams.prj_lumen.page_refresh_pending = true;
    const answer = workstreamAnswer({ kind: "progress", name: "Lumen" }, value, lang, NOW)!;
    const message = { en: "page refresh pending; existing content was preserved",
      ko: "페이지 갱신 대기: 기존 내용을 보존했습니다", ja: "ページ更新待ち：既存の内容を保持しました" }[lang];
    expect(answer).toContain(message);
    expect(answer).toContain(ROOT_RAW);
    value.workstreams.prj_lumen.page_refresh_pending = false;
    expect(workstreamAnswer({ kind: "progress", name: "Lumen" }, value, lang, NOW)).not.toContain(message);
  });

  it.each([
    ["Lumen", "prj_lumen"],
    ["LUMEN 프로젝트", "prj_lumen"],
    ["prj_lumen", "prj_lumen"],
    ["Chart Lab app", "chart-lab"],
    ["chart", "chart"],
    ["Unknown thing", null],
    ["🌙", null],
  ])("resolves %s to %s", (name, key) => {
    expect(resolveWorkstream(name, facts())).toBe(key);
  });

  it("gives null when two projects match equally", () => {
    const value = facts();
    value.workstreams.chart.title = "Lumen ✨";
    expect(resolveWorkstream("Lumen", value)).toBeNull();
  });

  it("prefers a key, then a title, written exactly as asked over ones that only read the same", () => {
    const value = facts();
    const other = (title: string, title_source: "readme" | "key") => ({ ...value.workstreams.chart, title, title_source });
    // One project split across folders whose names differ in '-' and '_'.
    value.workstreams = { "tide-ledger": other("Tide Ledger", "readme"), tide_ledger: other("tide_ledger", "key") };
    expect(resolveWorkstream("Tide Ledger", value)).toBe("tide-ledger");
    expect(resolveWorkstream("tide_ledger", value)).toBe("tide_ledger");
    expect(resolveWorkstream("Tide-Ledger", value)).toBe("tide-ledger");
    expect(resolveWorkstream("tideledger", value)).toBeNull();
    // A key beats another project's title written the same way.
    value.workstreams.kestrel = other("kestrel", "key");
    value.workstreams.prj_halo = other("Kestrel", "readme");
    expect(resolveWorkstream("Kestrel", value)).toBe("kestrel");
  });

  it("takes a name of more than four words only as a title written exactly so", () => {
    const value = facts();
    value.workstreams.tide = { ...value.workstreams.chart, title: "Tide Ledger Planner Of The Week", page: "wiki/workstreams/tide.md" };
    expect(resolveWorkstream("tide ledger  planner of the week", value)).toBe("tide");
    // A longer topic that mentions a project is a question for retrieval.
    expect(resolveWorkstream("Lumen reminder scheduler retry window", value)).toBeNull();
    value.workstreams.twin = { ...value.workstreams.tide, page: "wiki/workstreams/twin.md" };
    expect(resolveWorkstream("Tide Ledger Planner Of The Week", value)).toBeNull();
  });

  it("matches whole words only, so a short key is not found inside another word", () => {
    const value = facts();
    const other = (title: string) => ({ ...value.workstreams.chart, title, title_source: "key" as const });
    value.workstreams = { ai: other("ai"), "github-tools": other("github-tools"), "happy-app": other("happy-app") };
    for (const name of ["it", "Mail app", "Maintenance", "Brain dump", "hub"]) expect(resolveWorkstream(name, value)).toBeNull();
    expect(resolveWorkstream("AI", value)).toBe("ai");
    expect(resolveWorkstream("github", value)).toBe("github-tools");
    // A whole word of one project's name still names it.
    expect(resolveWorkstream("app", value)).toBe("happy-app");
  });
});

describe("resolveWorkstream by mentions", () => {
  // A project keyed by its folder whose `own` conversations call it something
  // else, and other projects whose conversations say that name too.
  function mentioned(own: number, others: number[] = []): WorkstreamFacts {
    const value = facts();
    const workstream = (key: string) => ({ ...value.workstreams.chart, title: key, page: `wiki/workstreams/${key}.md` });
    value.workstreams.prj_halo = workstream("prj_halo");
    const said = ["NIMBUS_IMPLEMENTATION_GOAL.md", "Ship the nimbus onboarding", "Nimbus의 홈 화면을 고쳐 줘"];
    for (let i = 0; i < own; i++) {
      const [ledger, row] = conversation(`codex:aaaa000${i}-0000-7000-8000-000000000000`, { key: "prj_halo", request: said[i % 3] });
      value.conversations[ledger] = row;
    }
    others.forEach((n, project) => {
      value.workstreams[`other-${project}`] = workstream(`other-${project}`);
      for (let i = 0; i < n; i++) {
        const [ledger, row] = conversation(`codex:bbbb${project}00${i}-0000-7000-8000-000000000000`, { key: `other-${project}`,
          report: { epoch: at("2026-11-04T10:00:00Z"), text: "Compared the chart with Nimbus." } });
        value.conversations[ledger] = row;
      }
    });
    return value;
  }

  it("names the project that says the name at least 3 times and in at least 80% of the conversations that do", () => {
    expect(resolveWorkstream("Nimbus", mentioned(3))).toBe("prj_halo");
    expect(resolveWorkstream("NIMBUS", mentioned(4, [1]))).toBe("prj_halo");
  });

  it("refuses too few mentions, a close project, a word said across projects, and part of a word", () => {
    expect(resolveWorkstream("Nimbus", mentioned(2))).toBeNull();
    expect(resolveWorkstream("Nimbus", mentioned(3, [1]))).toBeNull();
    // Like a topic word ("테스트", "design"): three times any other project's, yet only half of all.
    expect(resolveWorkstream("Nimbus", mentioned(6, [2, 2, 2]))).toBeNull();
    expect(resolveWorkstream("Nimb", mentioned(3))).toBeNull();
  });

  it("answers with the title and the name asked about", () => {
    const answer = workstreamAnswer({ kind: "progress", name: "Nimbus" }, mentioned(3), "ko", NOW)!;
    expect(answer).toMatch(/^\[\[wiki\/workstreams\/prj_halo\|prj_halo\]\]\(질문한 이름: Nimbus\) 프로젝트는 /);
    const en = workstreamAnswer({ kind: "progress", name: "prj_lumen" }, facts(), "en", NOW)!;
    expect(en).toMatch(/^\[\[wiki\/workstreams\/prj_lumen\|🌙 Lumen\]\] \(asked as “prj\\_lumen”\) has /);
    // The title itself, in another case, is not repeated, nor whole words of it.
    expect(workstreamAnswer({ kind: "progress", name: "LUMEN" }, facts(), "en", NOW)).toMatch(/^\[\[wiki\/workstreams\/prj_lumen\|🌙 Lumen\]\] has /);
    const bilingual = facts();
    bilingual.workstreams["chart-lab"].title = "Chart Lab (차트 랩)";
    for (const name of ["Chart Lab", "차트 랩"]) {
      const titled = workstreamAnswer({ kind: "progress", name }, bilingual, "ko", NOW)!;
      expect(titled.startsWith("[[wiki/workstreams/chart-lab|Chart Lab (차트 랩)]] 프로젝트는 "), titled).toBe(true);
    }
  });
});

describe("workstreamAnswer progress", () => {
  it("lists root sessions newest first with the request, the person's report, the sub-agent count and links", () => {
    const answer = workstreamAnswer({ kind: "progress", name: "Lumen" }, facts(), "ko", NOW)!;
    const [summary, list, more, reported] = answer.split("\n\n");
    expect(summary).toBe(`[[wiki/workstreams/prj_lumen|🌙 Lumen]] 프로젝트는 ${day("2026-10-01T09:00:00Z")}부터 ` +
      `${day("2026-11-07T12:30:00Z")}까지 세션 7개, 대화 8건이 있습니다. 최근 세션부터 보여 드립니다.`);
    const items = listItems(list);
    expect(items).toHaveLength(5);
    // The root thread's own report over its sub-agent's later one, which is only counted.
    expect(items[0]).toBe(`- **${day("2026-11-07T12:30:00Z")}** Implemented the reminder scheduler.${BR}` +
      `요청: Add prayer reminders to the synthetic app (하위 작업 1개) ${cite(ROOT_RAW)}`);
    expect(list).not.toContain(ESCAPED_REPORT);
    expect(items[1]).toBe(`- **${day("2026-11-05T10:00:00Z")}** 아직 보고 없음${BR}요청: Package the synthetic voice pack ` +
      cite("raw/conversations/claude-code/claude-code-aaaa1111-0000-4000-8000-000000000003-0123456789abcdef"));
    expect(items[2]).toContain(`** Finished older step 4.${BR}`);
    expect(more).toBe("이전 세션 2개는 [[wiki/workstreams/prj_lumen|프로젝트 페이지]]에서 볼 수 있습니다.");
    expect(reported).toBe(REPORTED_ONLY.ko);
  });

  it("renders English and Japanese markers", () => {
    const en = workstreamAnswer({ kind: "progress", name: "chart lab" }, facts(), "en", NOW)!;
    expect(en).toBe(`[[wiki/workstreams/chart-lab|Chart Lab]] has 1 sessions (1 conversations) from ${day("2026-11-04T09:00:00Z", "en")} ` +
      `to ${day("2026-11-04T10:00:00Z", "en")}. Newest first:\n\n` +
      `- **${day("2026-11-04T10:00:00Z", "en")}** Updated the portfolio chart.${BR}Asked: Fix the chart ${cite(CHART_RAW, "en")}\n\n` +
      REPORTED_ONLY.en);
    const ja = workstreamAnswer({ kind: "progress", name: "Chart Lab" }, facts(), "ja", NOW)!;
    expect(ja).toContain("新しいセッションから表示します。\n\n");
    expect(ja).toContain(`** Updated the portfolio chart.${BR}依頼: Fix the chart ${cite(CHART_RAW, "ja")}`);
    expect(ja.endsWith(`\n\n${REPORTED_ONLY.ja}`)).toBe(true);
  });

  it("prefers the person's thread, then the UI language, then the latest report, and cites a missing root's session at its own transcript", () => {
    const value = facts();
    const unseen = "codex:c0ffee99-0000-7000-8000-000000000099";
    const sub = (n: number, epoch: string, text: string | null) => conversation(`codex:c0ffee9${n}-0000-7000-8000-00000000009${n}`, {
      key: "chart-lab", cwd_source: "rollout", root: unseen, subagent: true, request: `Sub-agent step ${n}`,
      first_epoch: at(epoch), last_epoch: at(epoch), report: text ? { epoch: at(epoch), text } : null });
    // Sub-agents only: their parent thread was never imported.
    for (const [ledger, row] of [sub(1, "2026-11-06T09:00:00Z", "차트 축을 고쳤습니다."), sub(2, "2026-11-06T10:00:00Z", "Axis fixed."),
      sub(3, "2026-11-06T11:00:00Z", "軸を直しました。"), sub(4, "2026-11-06T12:00:00Z", null)]) value.conversations[ledger] = row;
    const latest = (lang: "en" | "ko" | "ja") => listItems(workstreamAnswer({ kind: "progress", name: "Chart Lab" }, value, lang, NOW)!
      .split("\n\n")[1])[0];
    const link = (n: number, lang: "en" | "ko" | "ja" = "ko") =>
      cite(`raw/conversations/codex/codex-c0ffee9${n}-0000-7000-8000-00000000009${n}-0123456789abcdef`, lang);
    // The latest request a sub-agent was given, beside the report chosen.
    expect(latest("ko")).toBe(`- **${day("2026-11-06T12:00:00Z")}** 차트 축을 고쳤습니다.${BR}요청: Sub-agent step 4 (하위 작업 4개) ${link(1)}`);
    expect(latest("ja")).toContain(`** 軸を直しました。${BR}依頼: Sub-agent step 4 (サブタスク4件) ${link(3, "ja")}`);
    expect(latest("en")).toContain(`** 軸を直しました。${BR}Asked: Sub-agent step 4 (4 sub-tasks) ${link(3, "en")}`);
    // Preserve the copy, but an unseen parent's project is unconfirmed.
    const copier = value.conversations["codex:c0ffee94-0000-7000-8000-000000000094"];
    copier.parent_report = { epoch: at("2026-11-06T08:00:00Z"), text: "Plan approved." };
    for (const lang of ["ko", "ja", "en"] as const) expect(latest(lang)).not.toContain("Plan approved.");
    expect(copier.parent_report.text).toBe("Plan approved.");
    // Positive same-project evidence permits reuse when the imported root
    // has no report of its own; a different project still cannot contribute.
    value.conversations[unseen] = conversation(unseen, { key: "chart-lab" })[1];
    for (const lang of ["ko", "ja", "en"] as const) expect(latest(lang)).toContain(`** Plan approved.${BR}`);
    expect(latest("en")).toContain(`** Plan approved.${BR}Asked: Sub-agent step 4 (4 sub-tasks) ${link(4, "en")}`);
    value.conversations[unseen].key = "prj_lumen";
    expect(latest("en")).not.toContain("Plan approved.");
    delete value.conversations[unseen];
    copier.parent_report = null;
    // Without any report, the session's newest conversation is cited.
    for (const n of [1, 2, 3]) value.conversations[`codex:c0ffee9${n}-0000-7000-8000-00000000009${n}`].report = null;
    expect(latest("en")).toContain(`** No report yet${BR}Asked: Sub-agent step 4 (4 sub-tasks) ${link(4, "en")}`);
    expect(latest("en")).not.toContain(unseen.slice(6, 14));
  });

  it("shows a session's latest request: the person's own thread first, else the latest non-empty sub-agent request", () => {
    const value = facts();
    const first = (question: "progress" | "recent") => listItems(workstreamAnswer(question === "recent" ? { kind: "recent" } :
      { kind: "progress", name: "Lumen" }, value, "en", NOW)!.split("\n\n")[1])[0];
    // The person's own thread first, though its sub-agent was told something later.
    expect(first("progress")).toContain("Asked: Add prayer reminders to the synthetic app (1 sub-tasks) ");
    // That thread was never imported: an earlier, the latest and a blank sub-agent request.
    delete value.conversations[ROOT];
    for (const [ledger, row] of [
      conversation("codex:c0ffee06-0000-7000-8000-000000000006", { key: "prj_lumen", cwd_source: "inherited", root: ROOT,
        subagent: true, first_epoch: at("2026-11-06T09:30:00Z"), last_epoch: at("2026-11-06T10:00:00Z"), request: "Plan the reminders" }),
      conversation("codex:c0ffee07-0000-7000-8000-000000000007", { key: "prj_lumen", cwd_source: "inherited", root: ROOT,
        subagent: true, first_epoch: at("2026-11-07T12:00:00Z"), last_epoch: at("2026-11-07T12:10:00Z"), request: "  " }),
    ]) value.conversations[ledger] = row;
    expect(first("progress")).toContain("Asked: Review the reminder diff (3 sub-tasks) ");
    expect(first("recent")).toContain("Asked: Review the reminder diff (3 sub-tasks) ");
  });

  it("shows a markdown escape the transcript already holds once, not as a backslash", () => {
    const value = facts();
    value.conversations[ROOT].request = "Read START\\_HERE.txt in C:\\Users\\synthetic first";
    value.conversations[ROOT].report = { epoch: at("2026-11-07T10:00:00Z"), text: "Read \\*all\\* of it." };
    const item = listItems(workstreamAnswer({ kind: "progress", name: "Lumen" }, value, "en", NOW)!.split("\n\n")[1])[0];
    expect(item).toContain(`** Read \\*all\\* of it.${BR}Asked: Read START\\_HERE.txt in C:\\\\Users\\\\synthetic first (1 sub-tasks) `);
  });

  it("leaves out sessions with neither a request nor a report, in progress and recent answers", () => {
    const value = facts();
    // Like a helper session that only named a git branch.
    const [ledger, row] = conversation("claude-code:dddd0001-0000-4000-8000-000000000000", { key: "prj_lumen",
      first_epoch: at("2026-11-08T01:00:00Z"), last_epoch: at("2026-11-08T01:01:00Z") });
    value.conversations[ledger] = row;
    const [, list, more] = workstreamAnswer({ kind: "progress", name: "Lumen" }, value, "ko", NOW)!.split("\n\n");
    expect(listItems(list)[0]).toContain("요청: Add prayer reminders to the synthetic app");
    expect(list).not.toContain("dddd0001");
    expect(more).toBe("이전 세션 2개는 [[wiki/workstreams/prj_lumen|프로젝트 페이지]]에서 볼 수 있습니다.");
    const recent = workstreamAnswer({ kind: "recent" }, value, "ko", NOW)!;
    expect(recent).toContain(`- **[[wiki/workstreams/prj_lumen|🌙 Lumen]]** 대화 4건, 세션 3개, 마지막 활동 ${day("2026-11-08T01:01:00Z")}${BR}` +
      `Implemented the reminder scheduler.${BR}요청: Add prayer reminders to the synthetic app (하위 작업 1개) ${cite(ROOT_RAW)}`);
    expect(recent).not.toContain("dddd0001");
  });

  it("gives null for an unknown or ambiguous name", () => {
    expect(workstreamAnswer({ kind: "progress", name: "Unknown thing" }, facts(), "ko", NOW)).toBeNull();
  });

  it("assumes the project with the most conversations in the window and says so", () => {
    const answer = workstreamAnswer({ kind: "progress", name: null }, facts(), "ko", NOW)!;
    const [assumption, summary] = answer.split("\n\n");
    expect(assumption).toBe(`프로젝트 이름이 없어, 최근 7일(${day("2026-11-02T00:00:00")} – ${day("2026-11-08T12:00:00Z")}) ` +
      "동안 대화가 가장 많은 🌙 Lumen 프로젝트로 가정했습니다. 다른 프로젝트라면 이름을 넣어 다시 물어보세요.");
    expect(summary).toMatch(/^\[\[wiki\/workstreams\/prj_lumen\|🌙 Lumen\]\] 프로젝트는 /);
  });

  it("breaks an equal conversation count by the latest activity", () => {
    const value = facts();
    delete value.conversations[SUBAGENT];
    delete value.conversations["claude-code:aaaa1111-0000-4000-8000-000000000003"];
    expect(workstreamAnswer({ kind: "progress", name: null }, value, "en", NOW)).toContain("assumes 🌙 Lumen,");
    value.conversations["codex:c0ffee04-0000-7000-8000-000000000004"].last_epoch = at("2026-11-08T10:00:00Z");
    expect(workstreamAnswer({ kind: "progress", name: null }, value, "en", NOW)).toContain("assumes Chart Lab,");
  });

  it("requires a named project or explicit period instead of assuming an older project", () => {
    const asked = new Date("2026-11-20T12:00:00Z");
    const answer = workstreamAnswer({ kind: "progress", name: null }, facts(), "en", asked)!;
    expect(answer.split("\n\n").slice(0, 2)).toEqual([
      `No conversation from the last 7 days (${day("2026-11-14T00:00:00", "en", asked)} – ${day("2026-11-20T12:00:00Z", "en", asked)}) ` +
        "belongs to a project.",
      "Name a project or ask with explicit dates to search older records.",
    ]);
    expect(answer).not.toContain("Lumen");
  });
});

describe("a program's sessions (automated)", () => {
  // A dashboard's helper that ran in Chart Lab's folder all week.
  function withHelper(): WorkstreamFacts {
    const value = facts();
    for (let i = 0; i < 4; i++) {
      const [ledger, row] = conversation(`claude-code:eeee000${i}-0000-4000-8000-000000000000`, { key: "chart-lab", automated: true,
        first_epoch: at(`2026-11-0${5 + (i % 3)}T09:00:00Z`), last_epoch: at("2026-11-08T11:00:00Z"),
        request: "You are the Nimbus dashboard's guide. Answer the question.",
        report: { epoch: at("2026-11-08T11:00:00Z"), text: "Answered the Nimbus dashboard question." } });
      value.conversations[ledger] = row;
    }
    return value;
  }

  it("are left out of the recent answer, its counts and the unnamed default", () => {
    const recent = workstreamAnswer({ kind: "recent" }, withHelper(), "en", NOW)!;
    expect(recent).not.toContain("Nimbus");
    expect(recent).toContain("there were 4 conversations across 2 projects:");
    expect(recent).toContain(`**[[wiki/workstreams/chart-lab|Chart Lab]]** 1 conversations in 1 sessions, last active ${day("2026-11-04T10:00:00Z", "en")}`);
    expect(workstreamAnswer({ kind: "progress", name: null }, withHelper(), "en", NOW)).toContain("assumes 🌙 Lumen,");
  });

  it("are left out of progress rows, and their words name no project", () => {
    const [, list] = workstreamAnswer({ kind: "progress", name: "Chart Lab" }, withHelper(), "en", NOW)!.split("\n\n");
    expect(listItems(list)).toEqual([`- **${day("2026-11-04T10:00:00Z", "en")}** Updated the portfolio chart.${BR}` +
      `Asked: Fix the chart ${cite(CHART_RAW, "en")}`]);
    expect(resolveWorkstream("Nimbus", withHelper())).toBeNull();
  });
});

describe("workstreamAnswer recent", () => {
  it("groups the last 7 days by project with counts, the latest session and the unassigned count", () => {
    expect(workstreamAnswer({ kind: "recent" }, facts(), "ko", NOW)!.split("\n\n")).toEqual([
      `최근 7일(${day("2026-11-02T00:00:00")} – ${day("2026-11-08T12:00:00Z")}) 동안 프로젝트 2개에서 대화 4건이 있었습니다.`,
      `- **[[wiki/workstreams/prj_lumen|🌙 Lumen]]** 대화 3건, 세션 2개, 마지막 활동 ${day("2026-11-07T12:30:00Z")}${BR}` +
        `Implemented the reminder scheduler.${BR}요청: Add prayer reminders to the synthetic app (하위 작업 1개) ${cite(ROOT_RAW)}\n` +
        `- **[[wiki/workstreams/chart-lab|Chart Lab]]** 대화 1건, 세션 1개, 마지막 활동 ${day("2026-11-04T10:00:00Z")}${BR}` +
        `Updated the portfolio chart.${BR}요청: Fix the chart ${cite(CHART_RAW)}`,
      "이 기간 대화 중 1건은 프로젝트를 정하지 못해 목록에서 뺐습니다(전체 미분류 3건).",
      REPORTED_ONLY.ko,
    ]);
  });

  it("keeps an empty recent window empty and offers an explicit older-record search", () => {
    const asked = new Date("2026-11-20T12:00:00Z");
    const paragraphs = workstreamAnswer({ kind: "recent" }, facts(), "ko", asked)!.split("\n\n");
    const [empty, suggestion] = paragraphs;
    expect(empty).toBe(`최근 7일(${day("2026-11-14T00:00:00", "ko", asked)} – ${day("2026-11-20T12:00:00Z", "ko", asked)})` +
      "에는 프로젝트로 묶인 대화가 없습니다.");
    expect(suggestion).toBe("이전 기록을 보려면 프로젝트 이름이나 원하는 날짜를 넣어 다시 물어보세요.");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs.join("\n")).not.toContain("Implemented the reminder scheduler");
  });

  it("does not widen a period containing only unassigned conversations", () => {
    const value = facts();
    const loose = value.conversations["claude-code:bbbb2222-0000-4000-8000-000000000005"];
    [loose.first_epoch, loose.last_epoch] = [at("2026-11-14T09:00:00Z"), at("2026-11-14T10:00:00Z")];
    value.last_record_epoch = loose.last_epoch;
    const asked = new Date("2026-11-15T12:00:00Z");
    const [empty, suggestion, ...other] = workstreamAnswer({ kind: "recent" }, value, "ko", asked)!.split("\n\n");
    expect(empty).toBe(`최근 7일(${day("2026-11-09T00:00:00", "ko", asked)} – ${day("2026-11-15T12:00:00Z", "ko", asked)})` +
      "에는 프로젝트로 묶인 대화가 없습니다.");
    expect(suggestion).toContain("날짜를 넣어 다시 물어보세요");
    expect(other).toEqual([]);
  });

  it("explains an empty or entirely unassigned period without falling into model generation", () => {
    expect(workstreamAnswer({ kind: "recent" }, { ...facts(), conversations: {} }, "ko", NOW)).toContain("프로젝트로 묶인 대화가 없습니다");
    const unassigned = facts();
    for (const conversation of Object.values(unassigned.conversations)) conversation.key = null;
    expect(workstreamAnswer({ kind: "recent" }, unassigned, "ko", NOW)).toContain("프로젝트로 묶인 대화가 없습니다");
  });

  it("excludes outside-period words from a long conversation that overlaps the period", () => {
    const value = facts();
    value.conversations[ROOT].first_epoch = at("2026-10-01T00:00:00Z");
    value.conversations[ROOT].request = "OLD_REQUEST_MUST_NOT_APPEAR";
    value.conversations[ROOT].report = { epoch: at("2026-11-09T00:00:00Z"), text: "FUTURE_REPORT_MUST_NOT_APPEAR" };
    const answer = workstreamAnswer({ kind: "recent" }, value, "en", NOW)!;
    expect(answer).not.toContain("OLD_REQUEST_MUST_NOT_APPEAR");
    expect(answer).not.toContain("FUTURE_REPORT_MUST_NOT_APPEAR");
    expect(answer).toContain("Review found");
  });

  it("uses seven local calendar dates even across a month boundary", () => {
    expect(workstreamRecentRange(new Date(2026, 10, 2, 0, 5))).toEqual({ start: "2026-10-27", end: "2026-11-02" });
  });
});

const OLDEST_RAW = "raw/conversations/claude-code/claude-code-00000000-0000-4000-8000-000000000000-0123456789abcdef";
const OLDER_RAW = "raw/conversations/claude-code/claude-code-00000004-0000-4000-8000-000000000000-0123456789abcdef";

describe("workstreamAnswer remaining", () => {
  it("lists the open items newest first with their dates and sources, without the latest session", () => {
    const [summary, list, ...rest] = workstreamAnswer({ kind: "remaining", name: "Lumen" }, facts(), "ko", NOW)!.split("\n\n");
    expect(summary).toBe("[[wiki/workstreams/prj_lumen|🌙 Lumen]] 프로젝트의 최근 세션 보고에 남은 일로 적힌 항목이 2개 있습니다. " +
      "최근 것부터 보여 드립니다.");
    expect(list.split("\n")).toEqual([
      `- **${day("2026-11-07T10:00:00Z")}** Retry window for the \\[reminder\\] scheduler ${cite(ROOT_RAW)}`,
      `- **${day("2026-10-05T10:00:00Z")}** Translate the settings screen ${cite(OLDER_RAW)}`,
    ]);
    // The latest session is shown only when no item is open.
    expect(rest).toEqual([REPORTED_ONLY.ko]);
  });

  it("says plainly when the latest reports record no open item, in each language", () => {
    expect(workstreamAnswer({ kind: "remaining", name: "Chart Lab" }, facts(), "en", NOW)!.split("\n\n")).toEqual([
      "[[wiki/workstreams/chart-lab|Chart Lab]]: the reports of the latest sessions record no open item.",
      "Latest session:",
      `- **${day("2026-11-04T10:00:00Z", "en")}** Updated the portfolio chart.${BR}Asked: Fix the chart ${cite(CHART_RAW, "en")}`,
      REPORTED_ONLY.en,
    ]);
    const ja = workstreamAnswer({ kind: "remaining", name: "Chart Lab" }, facts(), "ja", NOW)!;
    expect(ja).toMatch(/^\[\[wiki\/workstreams\/chart-lab\|Chart Lab\]\]の最近のセッションの報告には、残りとして書かれた項目がありません。\n\n/);
    expect(ja.endsWith(`\n\n${REPORTED_ONLY.ja}`)).toBe(true);
    expect(workstreamAnswer({ kind: "remaining", name: "Chart Lab" }, facts(), "ko", NOW))
      .toContain("최근 세션 보고에는 남은 일로 적힌 항목이 없습니다.");
  });

  it("names the project asked about and gives null for an unknown one", () => {
    expect(workstreamAnswer({ kind: "remaining", name: "prj_lumen" }, facts(), "en", NOW))
      .toMatch(/^\[\[wiki\/workstreams\/prj_lumen\|🌙 Lumen\]\] \(asked as “prj\\_lumen”\): 2 open items/);
    expect(workstreamAnswer({ kind: "remaining", name: "Unknown thing" }, facts(), "ko", NOW)).toBeNull();
  });
});

describe("workstreamAnswer explain", () => {
  it("gives the README summary, the period and counts, the first request and the latest report", () => {
    expect(workstreamAnswer({ kind: "explain", name: "Lumen" }, facts(), "en", NOW)!.split("\n\n")).toEqual([
      "[[wiki/workstreams/prj_lumen|🌙 Lumen]]",
      [
        "- **README** A synthetic prayer reminder app for \\*\\*testing\\*\\*.",
        `- **Period** ${day("2026-10-01T09:00:00Z", "en")} – ${day("2026-11-07T12:30:00Z", "en")}, 7 sessions, 8 conversations`,
        `- **First request** ${day("2026-10-01T09:00:00Z", "en")}, Older synthetic step 0 ${cite(OLDEST_RAW, "en")}`,
        `- **Latest report** ${day("2026-11-07T10:00:00Z", "en")}, Implemented the reminder scheduler. ${cite(ROOT_RAW, "en")}`,
      ].join("\n"),
      REPORTED_ONLY.en,
    ]);
  });

  it("says when no README summary or report is known, in Korean and Japanese", () => {
    const value = facts();
    value.conversations["codex:c0ffee04-0000-7000-8000-000000000004"].report = null;
    const ko = workstreamAnswer({ kind: "explain", name: "Chart Lab" }, value, "ko", NOW)!;
    expect(ko.split("\n\n")[1].split("\n")).toEqual([
      "- **README** 요약을 찾지 못했습니다",
      `- **기간** ${day("2026-11-04T09:00:00Z")} – ${day("2026-11-04T10:00:00Z")}, 세션 1개, 대화 1건`,
      `- **처음 요청** ${day("2026-11-04T09:00:00Z")}, Fix the chart ${cite(CHART_RAW)}`,
      "- **최근 보고** 아직 보고 없음",
    ]);
    expect(ko.endsWith(`\n\n${REPORTED_ONLY.ko}`)).toBe(true);
    expect(workstreamAnswer({ kind: "explain", name: "Chart Lab" }, value, "ja", NOW)).toContain("- **README** 要約が見つかりませんでした");
  });

  it("takes the earliest session's own thread first, and leaves a program's sessions out", () => {
    const value = facts();
    const [ledger, row] = conversation("claude-code:eeee0009-0000-4000-8000-000000000000", { key: "prj_lumen", automated: true,
      first_epoch: at("2026-09-01T09:00:00Z"), last_epoch: at("2026-09-01T10:00:00Z"), request: "You are the Lumen helper." });
    value.conversations[ledger] = row;
    const answer = workstreamAnswer({ kind: "explain", name: "Lumen" }, value, "en", NOW)!;
    expect(answer).toContain(`- **First request** ${day("2026-10-01T09:00:00Z", "en")}, Older synthetic step 0 ${cite(OLDEST_RAW, "en")}`);
    expect(answer).not.toContain("helper");
  });
});

describe("workstreamChoices", () => {
  it("puts the most active project of the last 7 days first as suggested, then the rest by latest activity", () => {
    expect(workstreamChoices(facts(), NOW)).toEqual([
      { key: "prj_lumen", title: "🌙 Lumen", subject: "🌙 Lumen", last: at("2026-11-07T12:30:00Z"), conversations: 8, suggested: true },
      { key: "chart-lab", title: "Chart Lab", subject: "Chart Lab", last: at("2026-11-04T10:00:00Z"), conversations: 1, suggested: false },
    ]);
    // More conversations in the week, though older: suggested and first.
    const value = facts();
    for (let i = 0; i < 3; i++) {
      const [ledger, row] = conversation(`codex:c0ffee5${i}-0000-7000-8000-00000000005${i}`, { key: "chart-lab",
        first_epoch: at("2026-11-03T09:00:00Z"), last_epoch: at("2026-11-03T10:00:00Z") });
      value.conversations[ledger] = row;
    }
    expect(workstreamChoices(value, NOW).map(({ key, suggested }) => [key, suggested]))
      .toEqual([["chart-lab", true], ["prj_lumen", false]]);
  });

  it("suggests none when nothing was active in the last 7 days, and names a shared title by its key", () => {
    expect(workstreamChoices(facts(), new Date("2026-12-20T12:00:00Z")).map(({ key, suggested }) => [key, suggested]))
      .toEqual([["prj_lumen", false], ["chart-lab", false]]);
    const value = facts();
    value.workstreams.chart = { ...value.workstreams.chart, title: "Chart Lab", conversations: 1 };
    expect(workstreamChoices(value, NOW).map(({ key, subject }) => [key, subject]))
      .toEqual([["prj_lumen", "🌙 Lumen"], ["chart-lab", "chart-lab"], ["chart", "chart"]]);
  });

  it("filters by title or key, ignoring case and spacing", () => {
    const choices = workstreamChoices(facts(), NOW);
    expect(filterChoices(choices, "")).toEqual(choices);
    expect(filterChoices(choices, " LAB ").map(({ key }) => key)).toEqual(["chart-lab"]);
    expect(filterChoices(choices, "prj_").map(({ key }) => key)).toEqual(["prj_lumen"]);
    expect(filterChoices(choices, "chart  lab").map(({ key }) => key)).toEqual(["chart-lab"]);
    expect(filterChoices(choices, "zzz")).toEqual([]);
  });
});

describe("the native writer's facts (shared fixture)", () => {
  const facts = parseWorkstreamFacts(JSON.stringify(WRITER_FIXTURE));
  const keyOf = (id: string): string => facts!.conversations[id].key!;
  const labKey = (): string => keyOf("codex:00000000-0000-4000-8000-0000000000f1");

  it("passes the reader's contract as a whole", () => {
    expect(facts).not.toBeNull();
    expect(Object.keys(facts!.workstreams)).toHaveLength(7);
    expect(Object.keys(facts!.workstreams).every(key => /^p5-[0-9a-f]{64}$/.test(key))).toBe(true);
    expect(Object.values(facts!.workstreams).map(project => project.title.normalize("NFC")).sort())
      .toEqual([".dotfiles", "a|b", "C Sharp Port", "Orbital", "foo [old]", "노트", "scratch"].sort());
  });

  it("names every project, and its answer links the page and sources as working links", () => {
    for (const [key, workstream] of Object.entries(facts!.workstreams)) {
      expect(resolveWorkstream(key, facts!)).toBe(key);
      const answer = workstreamAnswer({ kind: "progress", name: key }, facts!, "en", NOW)!;
      const targets = [...answer.matchAll(/\[\[([^|\]]+)\|/g)].map((match) => match[1]);
      expect(targets[0]).toBe(workstream.page.replace(/\.md$/, ""));
      for (const target of targets) {
        expect(target).not.toMatch(/[#^[\]|]/);
        // Every source is a conversation in the facts, never a root that is not.
        if (target.startsWith("raw/")) expect(Object.values(facts!.conversations).map((c) => c.raw)).toContain(`${target}.md`);
      }
    }
  });

  it("reads the writer's derived and user titles, and one session under a parent never imported", () => {
    const lab = facts!.workstreams[labKey()];
    expect([lab.title, lab.title_source, lab.conversations, lab.roots]).toEqual(["Orbital", "derived", 4, 2]);
    expect([facts!.workstreams[keyOf("claude-code:fx-hash")].title, facts!.workstreams[keyOf("claude-code:fx-hash")].title_source]).toEqual(["C Sharp Port", "user"]);
    expect(resolveWorkstream("Orbital", facts!)).toBe(labKey());
    const sessions = (lang: "en" | "ko") => listItems(workstreamAnswer({ kind: "progress", name: "Orbital" }, facts!, lang, NOW)!
      .split("\n\n")[1]);
    const [en, ko] = [sessions("en"), sessions("ko")];
    expect(en).toHaveLength(2);
    // The never-imported parent's copy remains source data, but its project
    // is unconfirmed and cannot replace the sub-agents' own reports.
    const copier = "raw/conversations/codex/codex-00000000-0000-4000-8000-0000000000f3-000000000000000b";
    expect(facts!.conversations["codex:00000000-0000-4000-8000-0000000000f3"].parent_report?.text).toBe("궤도 계획을 확정했습니다.");
    expect(en[0]).toContain(`** Orbital checks pass${BR}Asked: ORBITAL\\_LAB\\_GOAL.md (2 sub-tasks) ${cite(copier, "en")}`);
    expect(ko[0]).toContain(`** 궤도 점검을 마쳤습니다.${BR}요청: ORBITAL\\_LAB\\_GOAL.md (하위 작업 2개) `);
    // The lab's own thread reported before its sub-agent did.
    expect(en[1]).toContain(`** Lab ready${BR}Asked: Set up the lab from ORBITAL\\_LAB\\_GOAL.md (1 sub-tasks) `);
  });

  it("leaves the writer's automated helper session out of the lab's counts and rows", () => {
    const helper = facts!.conversations["claude-code:fx-helper"];
    expect([helper.automated, helper.key, helper.request]).toEqual([true, labKey(),
      "당신은 Orbital 대시보드의 안내 도우미입니다. 사용자의 질문에 답하세요."]);
    const answer = workstreamAnswer({ kind: "progress", name: "Orbital" }, facts!, "ko", NOW)!;
    expect(answer).toContain("세션 2개, 대화 4건");
    expect(answer).not.toContain("fx-helper");
    expect(answer).not.toContain("도우미");
  });

  it("lists what the writer's latest reports leave open, and explains a project from its facts", () => {
    const sub = cite("raw/conversations/codex/codex-00000000-0000-4000-8000-0000000000f3-000000000000000b", "en");
    const lab = cite("raw/conversations/codex/codex-00000000-0000-4000-8000-0000000000f1-0000000000000007", "en");
    const [, items] = workstreamAnswer({ kind: "remaining", name: "Orbital" }, facts!, "en", NOW)!.split("\n\n");
    expect(items.split("\n")).toEqual([
      `- **${day("2026-10-27T05:00:00Z", "en")}** Pending: the review of the sensors. ${lab}`,
    ]);
    expect(workstreamAnswer({ kind: "remaining", name: ".dotfiles" }, facts!, "en", NOW))
      .toContain("the reports of the latest sessions record no open item.");
    const explained = workstreamAnswer(classifyWorkstreamQuestion(buildExplainQuestion("Orbital", "en"), "en", NOW)!, facts!, "en", NOW)!;
    expect(explained).toContain("- **README** no summary found\n");
    expect(explained).toContain("- **First request** ");
    expect(explained).toContain(`, Set up the lab from ORBITAL\\_LAB\\_GOAL.md ${lab}`);
    expect(explained).toContain(`- **Latest report** ${day("2026-10-27T07:30:00Z", "en")}, Orbital checks pass ${sub}`);
  });

  it("counts a Claude Code teammate in its lead's session", () => {
    const foo = facts!.workstreams[keyOf("claude-code:fx-bracket")];
    expect([foo.conversations, foo.roots]).toEqual([2, 1]);
    const [, list] = workstreamAnswer({ kind: "progress", name: "foo [old]" }, facts!, "en", NOW)!.split("\n\n");
    expect(listItems(list)).toHaveLength(1);
    expect(list).toContain(`** Renamed the folder; tests pass.${BR}Asked: Rename the \\[old\\] folder (1 sub-tasks) ` +
      cite("raw/conversations/claude-code/claude-code-fx-bracket-0000000000000001", "en"));
  });
});

describe("workstreamAnswer layout details", () => {
  it("shows a link-only request as its site, trims a long request, and dates another year with the year", () => {
    const linkOnly = conversation("codex:c0ffee51-0000-7000-8000-000000000051", { key: "solo",
      first_epoch: at("2025-12-30T09:00:00Z"), last_epoch: at("2025-12-30T10:00:00Z"),
      request: "https://www.instagram.com/p/SyntheticPost/?igsh=abc",
      report: { epoch: at("2025-12-30T10:00:00Z"), text: "Saved the post's text." } });
    const long = conversation("codex:c0ffee52-0000-7000-8000-000000000052", { key: "solo",
      first_epoch: at("2026-11-06T09:00:00Z"), last_epoch: at("2026-11-06T10:00:00Z"),
      request: "가".repeat(120), report: { epoch: at("2026-11-06T10:00:00Z"), text: "Done with the long one." } });
    const data: WorkstreamFacts = { version: 5, last_record_epoch: at("2026-11-06T10:00:00Z"), unassigned: 0,
      workstreams: { solo: { title: "Solo", title_source: "readme", page: "wiki/workstreams/solo.md",
        first_epoch: at("2025-12-30T09:00:00Z"), last_epoch: at("2026-11-06T10:00:00Z"), conversations: 2, roots: 2,
        summary: null, open_items: [] } },
      conversations: Object.fromEntries([linkOnly, long]) };
    const answer = workstreamAnswer({ kind: "progress", name: "Solo" }, data, "ko", NOW)!;
    expect(listItems(answer.split("\n\n")[1])).toEqual([
      `- **${day("2026-11-06T10:00:00Z")}** Done with the long one.${BR}요청: ${"가".repeat(89)}… ` +
        cite("raw/conversations/codex/codex-c0ffee52-0000-7000-8000-000000000052-0123456789abcdef"),
      `- **${day("2025-12-30T10:00:00Z")}** Saved the post's text.${BR}요청: instagram.com 링크 ` +
        cite("raw/conversations/codex/codex-c0ffee51-0000-7000-8000-000000000051-0123456789abcdef"),
    ]);
    // Another year's date carries its year, so no list item opens with a bare number.
    expect(day("2025-12-30T10:00:00Z")).toMatch(/^2025년 /);
    expect(answer).not.toMatch(/^- \d/m);
  });
});
