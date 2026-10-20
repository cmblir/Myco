import { describe, expect, it } from "vitest";
import type { Adjacency } from "./ipc";
import { connectionOverview, connectionScopeNotice, isConnectionOverviewQuery } from "./queryConnections";

const root = "/synthetic";
const question = "서로 연결되는 아이디어가 있어?";
const options = { root, scope: "wiki" as const, lang: "ko" as const };

function graph(paths = ["wiki/a.md", "wiki/b.md", "wiki/c.md"]): Adjacency {
  return {
    forward: Object.fromEntries(paths.map((path) => [`${root}/${path}`, []])),
    backward: {}, unresolved: {}, tags: {},
  };
}

describe("generic connection discovery intent", () => {
  it.each(["ko", "en", "ja"] as const)("explains the session scope without denying optional local generation in %s", (lang) => {
    const notice = connectionScopeNotice(lang);
    expect(notice).toContain({ ko: "범위 넓혀 다시 찾기", en: "Search wider", ja: "範囲を広げ" }[lang]);
    expect(notice).not.toMatch(/포함되어 있지|not bundled|含まれていません/);
  });

  it.each([
    question, "연결된 아이디어를 찾아줘", "내 위키에서 서로 연결되는 아이디어가 있나요?",
    "노트들 사이의 연결을 보여줘", "connected ideas", "Are there any connected ideas?",
    "Find connections between my notes", "What ideas are connected?", "関連するアイデアはある？",
  ])("matches the generic request %s", (text) => expect(isConnectionOverviewQuery(text)).toBe(true));

  it.each([
    "RAG와 임베딩은 어떻게 연결돼?", "정책 최적화와 보상 모델의 관계", "관련된 RAG 아이디어가 있어?",
    "How do attention and memory relate?", "Find connections between caching and latency",
    "Are there any connected ideas about Rust?", "What is a connected component?",
    "어제 내가 한 일이 뭐야?", "what is attention?", "", " ",
  ])("keeps specific topics and other intents on retrieval: %s", (text) => {
    expect(isConnectionOverviewQuery(text)).toBe(false);
    expect(connectionOverview(text, graph(), options)).toBeNull();
  });
});

describe("connectionOverview", () => {
  it("cites exact paths and reports existing links and shared tags without inventing a relationship", () => {
    const adjacency = graph(["wiki/a.md", "wiki/other/a.md", "wiki/c.md"]);
    adjacency.forward[`${root}/wiki/a.md`] = [`${root}/wiki/other/a.md`];
    adjacency.tags = { [`${root}/wiki/a.md`]: ["retrieval"], [`${root}/wiki/c.md`]: ["retrieval"] };
    adjacency.meta = { [`${root}/wiki/other/a.md`]: { title: "Synthetic other note" } };
    const answer = connectionOverview(question, adjacency, options)!;
    expect(answer).toContain("기존 링크");
    expect(answer).toContain("공통 태그");
    expect(answer).toContain("[[wiki/a|a]] → [[wiki/other/a|Synthetic other note]]");
    expect(answer).toContain("#retrieval");
    expect(answer).toContain("[[wiki/c|c]]");
    expect(answer).toContain("그래프");
    expect(answer).not.toMatch(/원인|증명|새로운 관계를 발견/);
  });

  it("accepts a resolved leaf represented by the backward index", () => {
    const adjacency = graph(["wiki/a.md"]);
    adjacency.forward[`${root}/wiki/a.md`] = [`${root}/wiki/leaf.md`];
    adjacency.backward[`${root}/wiki/leaf.md`] = [`${root}/wiki/a.md`];
    expect(connectionOverview(question, adjacency, options)).toContain("[[wiki/leaf|leaf]]");
  });

  it("excludes unread cached, outside-root, dangling and self targets and deduplicates reverse links", () => {
    const adjacency = graph(["wiki/a.md", "wiki/b.md", "wiki/unread.md"]);
    adjacency.forward[`${root}/wiki/a.md`] = [
      `${root}/wiki/b.md`, `${root}/wiki/b.md`, `${root}/wiki/a.md`, `${root}/wiki/unread.md`,
      `${root}/wiki/missing.md`, "/synthetic-other/wiki/leak.md", `${root}/../other.md`,
    ];
    adjacency.forward[`${root}/wiki/b.md`] = [`${root}/wiki/a.md`];
    adjacency.forward["/synthetic-other/wiki/leak.md"] = [`${root}/wiki/a.md`];
    adjacency.forward[`${root}/../other.md`] = [`${root}/wiki/a.md`];
    adjacency.unread = [`${root}/wiki/unread.md`];
    const answer = connectionOverview(question, adjacency, options)!;
    expect(answer.match(/ → /g)).toHaveLength(1);
    expect(answer).not.toMatch(/unread|missing|leak|other\.md|\.\.\//);
  });

  it("excludes imported, generated, structural, hidden and staging material", () => {
    const forbidden = ["sessions/a.md", "raw/a.md", "daily/a.md", "weekly/a.md", "monthly/a.md", "_inbox/a.md", "ingest-reports/a.md", "templates/a.md", "cards/a.md", ".myco/a.md", "wiki/index.md", "wiki/distill-proposal.md"];
    const adjacency = graph(["wiki/a.md", ...forbidden]);
    adjacency.forward[`${root}/wiki/a.md`] = forbidden.map((path) => `${root}/${path}`);
    const answer = connectionOverview(question, adjacency, options)!;
    for (const path of forbidden) expect(answer).not.toContain(`[[${path.replace(/\.md$/, "")}`);
    expect(answer).not.toContain(" → ");
    expect(answer).toContain("표시할");
  });

  it("honors an explicit path scope for both link endpoints and shared tags", () => {
    const adjacency = graph();
    adjacency.forward[`${root}/wiki/a.md`] = [`${root}/wiki/b.md`, `${root}/wiki/c.md`];
    adjacency.tags = { [`${root}/wiki/a.md`]: ["topic"], [`${root}/wiki/b.md`]: ["topic"], [`${root}/wiki/c.md`]: ["topic"] };
    const answer = connectionOverview(question, adjacency, { ...options, paths: ["wiki/a.md", "wiki/b.md"] })!;
    expect(answer).toContain("[[wiki/b|b]]");
    expect(answer).not.toContain("[[wiki/c|c]]");
    expect(connectionOverview(question, adjacency, { ...options, paths: [] })).toBeNull();
  });

  it("never widens sessions or an active date window to the wiki graph", () => {
    expect(connectionOverview(question, graph(), { ...options, scope: "sessions" })).toBeNull();
    expect(connectionOverview(question, graph(), { ...options, range: { start: "2026-10-01", end: "2026-10-04" } })).toBeNull();
    expect(connectionOverview(question, null, options)).toBeNull();
    expect(connectionOverview(question, graph(), { ...options, root: "" })).toBeNull();
  });

  it("bounds pairs, shared groups and displayed members with an honest coverage note", () => {
    const paths = Array.from({ length: 30 }, (_, index) => `wiki/n${String(index).padStart(2, "0")}.md`);
    const adjacency = graph(paths);
    paths.forEach((path, index) => {
      adjacency.forward[`${root}/${path}`] = [`${root}/${paths[(index + 1) % paths.length]}`];
      adjacency.tags[`${root}/${path}`] = [`topic-${Math.floor(index / 7)}`];
    });
    const answer = connectionOverview(question, adjacency, options)!;
    expect(answer.match(/ → /g)).toHaveLength(5);
    expect(answer.match(/#topic-/g)).toHaveLength(3);
    const groups = answer.split("공통 태그")[1].split("\n").filter((line) => line.startsWith("- "));
    for (const line of groups) expect(line.match(/\[\[/g)!.length).toBeLessThanOrEqual(5);
    expect(answer).toContain("최대");
  });

  it("marks bounded graph scans as partial rather than claiming full-vault coverage", () => {
    const adjacency = graph(Array.from({ length: 5002 }, (_, index) => `wiki/n${index}.md`));
    expect(connectionOverview(question, adjacency, options)).toContain("검토 범위 제한");
  });

  it("does not turn tag duplication, casing or a single-note tag into a shared topic", () => {
    const adjacency = graph();
    adjacency.tags = { [`${root}/wiki/a.md`]: ["Topic", "topic", "only-one"], [`${root}/wiki/b.md`]: ["TOPIC"] };
    const answer = connectionOverview(question, adjacency, options)!;
    expect(answer.match(/#Topic/g)).toHaveLength(1);
    expect(answer).not.toContain("#only-one");
    expect(answer.match(/\[\[wiki\/a\|a\]\]/g)).toHaveLength(1);
  });

  it.each(["en", "ja"] as const)("localizes the overview for %s", (lang) => {
    const adjacency = graph();
    adjacency.forward[`${root}/wiki/a.md`] = [`${root}/wiki/b.md`];
    const answer = connectionOverview(question, adjacency, { ...options, lang })!;
    expect(answer).toContain(lang === "en" ? "Existing links" : "既存のリンク");
    expect(answer).not.toContain("기존 링크");
  });

  it("preserves unicode paths and avoids unrepresentable wikilink targets", () => {
    const adjacency = graph(["wiki/합성.md", "wiki/다른 합성.md", "wiki/bad#section.md"]);
    adjacency.forward[`${root}/wiki/합성.md`] = [`${root}/wiki/다른 합성.md`, `${root}/wiki/bad#section.md`];
    const answer = connectionOverview(question, adjacency, options)!;
    expect(answer).toContain("[[wiki/합성|합성]] → [[wiki/다른 합성|다른 합성]]");
    expect(answer).not.toContain("bad#section");
  });

  it("excludes control characters in citation paths and shared tags", () => {
    const adjacency = graph(["wiki/a.md", "wiki/b.md", "wiki/bad\u0001.md"]);
    adjacency.forward[`${root}/wiki/a.md`] = [`${root}/wiki/b.md`, `${root}/wiki/bad\u0001.md`];
    adjacency.tags = { [`${root}/wiki/a.md`]: ["safe", "bad\u0001"], [`${root}/wiki/b.md`]: ["safe", "bad\u0001"] };
    const answer = connectionOverview(question, adjacency, options)!;
    expect(answer).toContain("[[wiki/b|b]]");
    expect(answer).toContain("#safe");
    expect(answer).not.toContain("bad");
    expect(answer).not.toContain("\u0001");
  });
});
