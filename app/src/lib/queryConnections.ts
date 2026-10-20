// Generic discovery answers from resolved graph evidence, without generation
// or an all-pairs similarity pass. A shared tag records a common label, not
// proof that two concepts have the same mechanism or cause.

import type { Adjacency, AskScope } from "./ipc";
import type { Lang } from "./i18n";
import { sourceTier } from "./extractive";
import { chunkCitation } from "./retrievalContext";

const GENERIC_CONNECTIONS = [
  /^(?:내\s*(?:위키|노트)(?:에서|에)?\s*)?(?:서로\s*)?(?:연결되는|연결된|관련된|연관된)\s*(?:아이디어|생각|개념|노트)(?:들)?(?:(?:이|가)?\s*(?:있어|있나요|있을까|뭐야|무엇인가요)|(?:를|을)?\s*(?:찾아줘|보여줘|알려줘))?$/,
  /^(?:내\s*)?(?:아이디어|생각|개념|노트)(?:들)?\s*(?:사이|간)(?:의|에)?\s*(?:연결|관계|연관성)(?:을|이|가)?\s*(?:알려줘|찾아줘|보여줘|있어|있나요)$/,
  /^(?:(?:are there|do i have|show me|find)\s+)?(?:any\s+)?(?:connected|related|interconnected)\s+(?:ideas|concepts|notes)(?:\s+(?:in|across)\s+(?:my\s+)?(?:wiki|notes|vault))?$/i,
  /^(?:show me|find|what are)(?:\s+(?:the|some))?\s+(?:connections|relationships|links)\s+(?:between|among|across)\s+(?:my\s+)?(?:notes|ideas|concepts)$/i,
  /^what\s+(?:ideas|concepts|notes)\s+are\s+(?:connected|related)$/i,
  /^(?:関連する|つながっている)(?:アイデア|概念|ノート)(?:はある|を探して|を見せて)?$/,
  /^(?:ノート|アイデア)(?:間|同士)の(?:つながり|関連)(?:を見せて|を探して|はある)$/,
];

/** Match generic discovery only; topic-specific relationships need retrieval. */
export function isConnectionOverviewQuery(question: string): boolean {
  if (question.length > 160) return false;
  const text = question.trim().replace(/[?？!.。]+$/, "").replace(/\s+/g, " ");
  return GENERIC_CONNECTIONS.some((pattern) => pattern.test(text));
}

/** A session-only search cannot prove the wiki graph's existing relationships. */
export function connectionScopeNotice(lang: Lang): string {
  return {
    ko: "대화 기록 범위에서는 위키 노트의 기존 링크·공통 태그를 확인할 수 없어요. ‘범위 넓혀 다시 찾기’로 노트의 연결을 확인할 수 있습니다.",
    en: "The conversation-only scope cannot establish existing wiki links or shared tags. Search wider to inspect note connections.",
    ja: "会話のみの範囲では、ウィキノートの既存リンクや共通タグを確認できません。範囲を広げてノートのつながりを確認してください。",
  }[lang];
}

export interface ConnectionOverviewOptions {
  root: string;
  scope: AskScope;
  lang: Lang;
  /** Exact vault-relative paths, as used by semantic_search. */
  paths?: readonly string[];
  /** The graph has no source-date evidence for a temporal answer. */
  range?: { start: string; end: string };
}

const COPY = {
  ko: {
    intro: "현재 위키 그래프에 기록된 기존 링크와 공통 태그입니다.",
    links: "기존 링크", tags: "공통 태그",
    empty: "확인한 그래프 기록에는 표시할 기존 링크나 공통 태그가 없습니다.",
    coverage: "그래프 표본: 읽을 수 있는 지식 노트 {n}개. 기존 링크 최대 5쌍, 공통 태그 최대 3개, 태그마다 최대 5개 노트를 표시합니다.",
    partial: "검토 범위 제한에 도달했습니다. 다른 노트의 연결은 더 있을 수 있습니다.",
  },
  en: {
    intro: "These are existing links and shared tags recorded in the current wiki graph.",
    links: "Existing links", tags: "Shared tags",
    empty: "The checked graph records contain no existing links or shared tags to display.",
    coverage: "Graph sample: {n} readable knowledge notes. Showing at most 5 link pairs, 3 shared tags, and 5 notes per tag.",
    partial: "The review limit was reached. Other notes may have more connections.",
  },
  ja: {
    intro: "現在のウィキグラフに記録された既存のリンクと共通タグです。",
    links: "既存のリンク", tags: "共通タグ",
    empty: "確認したグラフ記録には、表示できる既存のリンクや共通タグがありません。",
    coverage: "グラフの標本：読み取れる知識ノート{n}件。リンクは最大5組、共通タグは最大3件、タグごとに最大5件のノートを表示します。",
    partial: "確認範囲の上限に達しました。他のノートに追加のつながりがある可能性があります。",
  },
};

const STRUCTURAL_STEMS = new Set(["readme", "index", "log", "changelog"]);
const PAGE_SCAN_LIMIT = 5000;
const EVIDENCE_SCAN_LIMIT = 20_000;

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) < 32) return true;
  }
  return false;
}

/** Return a bounded, cited graph snapshot; null leaves the normal Ask route.
 * Both endpoints must be known, readable knowledge pages in the requested
 * scope. The graph cannot establish session or date-restricted evidence. */
export function connectionOverview(
  question: string,
  adjacency: Adjacency | null,
  options: ConnectionOverviewOptions,
): string | null {
  const root = options.root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!isConnectionOverviewQuery(question) || !adjacency || !root ||
      options.scope === "sessions" || options.range || options.paths?.length === 0) return null;
  const prefix = `${root}/`;
  const allowed = options.paths ? new Set(options.paths) : null;
  const unread = new Set(adjacency.unread ?? []);
  const pages = new Map<string, string>();
  const seen = new Set<string>();
  let limited = false;

  const relative = (path: string): string | null => {
    const normalized = path.replace(/\\/g, "/");
    if (!normalized.startsWith(prefix) || unread.has(path)) return null;
    const rel = normalized.slice(prefix.length);
    if (rel.length > 1024 || /[[\]|#]/.test(rel) || hasControlCharacter(rel) ||
        !rel.endsWith(".md") || rel.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return null;
    if (allowed && !allowed.has(rel)) return null;
    const tier = sourceTier(rel);
    const stem = rel.split("/").at(-1)!.slice(0, -3).toLowerCase();
    if ((tier !== "note" && tier !== "map") || /^(?:templates|cards)\//.test(rel) ||
        STRUCTURAL_STEMS.has(stem) || stem.startsWith("distill-")) return null;
    return rel;
  };

  // Keys, rather than unverified target strings, establish graph membership.
  scan: for (const record of [adjacency.forward, adjacency.backward, adjacency.tags, adjacency.meta ?? {}]) {
    for (const path in record) {
      if (!Object.hasOwn(record, path) || seen.has(path)) continue;
      if (seen.size >= PAGE_SCAN_LIMIT) { limited = true; break scan; }
      seen.add(path);
      const rel = relative(path);
      if (rel) pages.set(path, rel);
    }
  }
  const cite = (path: string): string => {
    const page = pages.get(path)!;
    const stem = adjacency.meta?.[path]?.title?.trim().slice(0, 100) || page.split("/").at(-1)!.slice(0, -3);
    return chunkCitation({ page, stem });
  };
  const ordered = [...pages.keys()].sort();
  const pairs: string[] = [];
  const paired = new Set<string>();
  let linksChecked = 0;
  links: for (const source of ordered) {
    for (const target of adjacency.forward[source] ?? []) {
      if (++linksChecked > EVIDENCE_SCAN_LIMIT) { limited = true; break links; }
      if (source === target || !pages.has(target)) continue;
      const key = source < target ? `${source}\0${target}` : `${target}\0${source}`;
      if (paired.has(key)) continue;
      paired.add(key);
      pairs.push(`- ${cite(source)} → ${cite(target)}`);
      if (pairs.length === 5) break links;
    }
  }

  const groups = new Map<string, { tag: string; members: string[] }>();
  let tagsChecked = 0;
  tags: for (const path of ordered) {
    const local = new Set<string>();
    for (const tag of adjacency.tags[path] ?? []) {
      if (++tagsChecked > EVIDENCE_SCAN_LIMIT) { limited = true; break tags; }
      if (!tag.trim() || tag.length > 80 || hasControlCharacter(tag)) continue;
      const key = tag.normalize("NFC").toLowerCase();
      if (local.has(key)) continue;
      local.add(key);
      const group = groups.get(key) ?? { tag, members: [] };
      if (group.members.length < 5) group.members.push(path);
      groups.set(key, group);
    }
  }
  const shared = [...groups.values()].filter((group) => group.members.length > 1)
    .sort((a, b) => a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0).slice(0, 3)
    .map(({ tag, members }) => `- #${tag.replace(/[\\`*_[\]<>]/g, "\\$&")}: ${members.map(cite).join(", ")}`);
  const copy = COPY[options.lang];
  const sections = [copy.intro];
  if (pairs.length) sections.push(`**${copy.links}**\n\n${pairs.join("\n")}`);
  if (shared.length) sections.push(`**${copy.tags}**\n\n${shared.join("\n")}`);
  if (!pairs.length && !shared.length) sections.push(copy.empty);
  sections.push(copy.coverage.replace("{n}", new Intl.NumberFormat(options.lang).format(pages.size)));
  if (limited) sections.push(copy.partial);
  return sections.join("\n\n");
}
