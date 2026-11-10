// Progress, remaining-work, explain and recent-work answers from the native
// workstream facts file (.myco/workstreams.json): imported Claude Code and
// Codex conversations grouped into projects by working folder. Rendered
// without a model; a status here is what a conversation reported, never
// verified completion.

import type { Lang } from "./i18n";
import { isUndatedActivityOverview } from "./queryActivity";
import { chunkCitation } from "./retrievalContext";
import { queryDateRange, type DateRange } from "./timeQuery";

interface Report {
  epoch: number;
  text: string;
}

interface WorkstreamConversation {
  /** Started by a program, not the person (a dashboard helper, a
   * translator): left out of every count, row and answer. */
  automated: boolean;
  fp: string;
  vendor: "claude-code" | "codex";
  id: string;
  /** Vault-relative raw revision, `raw/conversations/...md`. */
  raw: string;
  first_epoch: number;
  last_epoch: number;
  key: string | null;
  cwd_source: "sidecar" | "state" | "rollout" | "inherited" | "none";
  /** Ledger key (`slug:id`) of the session's root thread. It may name a thread
   * that is not in the vault (a sub-agent's parent never imported, or
   * `claude-code:<team>` for an agent team whose lead was not), so a session
   * is cited at one of its own conversations, never at its root. */
  root: string;
  /** A Codex sub-agent thread or a Claude Code agent-team teammate. */
  subagent: boolean;
  request: string | null;
  report: Report | null;
  /** The root thread's newest answer this sub-agent copied in when it forked
   * from it: what came back to the person when that thread is not here. */
  parent_report: Report | null;
}

const TITLE_SOURCES = ["user", "readme", "package", "derived", "key", "folder"] as const;

/** A line a recent session's report leaves open. */
interface OpenItem {
  epoch: number;
  text: string;
  /** Ledger key of the conversation the report was read from. */
  conversation: string;
}

interface Workstream {
  title: string;
  /** The person's names file, the project's README or package name, a word
   * its conversations use distinctively, or else the key. */
  title_source: (typeof TITLE_SOURCES)[number];
  page: string;
  /** Retained page bytes differ from current facts; native ownership is unproven. */
  page_refresh_pending?: boolean;
  first_epoch: number;
  last_epoch: number;
  conversations: number;
  roots: number;
  /** The first paragraph under the README title the name came from. */
  summary: string | null;
  /** What the reports of the latest five sessions leave open, newest first. */
  open_items: OpenItem[];
}

/** `.myco/workstreams.json` version 6, written by the native reconcile. Any
 * other version is not read; the next reconcile rewrites it. */
export interface WorkstreamFacts {
  version: 6;
  last_record_epoch: number;
  unassigned: number;
  workstreams: Record<string, Workstream>;
  conversations: Record<string, WorkstreamConversation>;
}

export type WorkstreamQuestion = { kind: "recent" } | { kind: "progress"; name: string | null } |
  { kind: "remaining" | "explain"; name: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isEpoch = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
const isText = (value: unknown, max: number): boolean => typeof value === "string" && value.length <= max;

/** A vault-relative markdown path under `prefix` that a [[link]] can carry:
 * '#' would start a heading anchor and '^' a block reference. */
function isLinkPath(value: unknown, prefix: string): boolean {
  return typeof value === "string" && value.length <= 1024 && value.startsWith(prefix) && value.endsWith(".md") &&
    !/[[\]|#^\r\n]/.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** An open item cites a conversation of its own workstream. */
const isOpenItem = (value: unknown, key: string, conversations: Record<string, unknown>): boolean =>
  isObject(value) && isEpoch(value.epoch) && isText(value.text, 512) && typeof value.conversation === "string" &&
  Object.hasOwn(conversations, value.conversation) &&
  (conversations[value.conversation] as Record<string, unknown> | undefined)?.key === key;

function isWorkstream(value: unknown, key: string, conversations: Record<string, unknown>): boolean {
  return isObject(value) && isText(value.title, 1024) &&
    (TITLE_SOURCES as readonly unknown[]).includes(value.title_source) &&
    isLinkPath(value.page, "wiki/workstreams/") &&
    (value.page_refresh_pending === undefined || typeof value.page_refresh_pending === "boolean") &&
    [value.first_epoch, value.last_epoch, value.conversations, value.roots].every(isEpoch) &&
    (value.summary === null || isText(value.summary, 1024)) &&
    Array.isArray(value.open_items) && value.open_items.length <= 10 &&
    value.open_items.every((item) => isOpenItem(item, key, conversations));
}

const isReport = (value: unknown): boolean =>
  value === null || (isObject(value) && isEpoch(value.epoch) && isText(value.text, 4096));

function isConversation(value: unknown, workstreams: Record<string, unknown>): boolean {
  if (!isObject(value)) return false;
  const { key } = value;
  return typeof value.automated === "boolean" && typeof value.fp === "string" &&
    (value.vendor === "claude-code" || value.vendor === "codex") &&
    isText(value.id, 256) && isLinkPath(value.raw, "raw/conversations/") &&
    isEpoch(value.first_epoch) && isEpoch(value.last_epoch) &&
    (key === null || (typeof key === "string" && Object.hasOwn(workstreams, key))) &&
    ["sidecar", "state", "rollout", "inherited", "none"].includes(value.cwd_source as string) &&
    typeof value.root === "string" && value.root !== "" && typeof value.subagent === "boolean" &&
    (value.request === null || isText(value.request, 4096)) && isReport(value.report) && isReport(value.parent_report);
}

/** Hand-written contract check; the file sits in the vault and may be edited. */
function isWorkstreamFacts(value: unknown): value is WorkstreamFacts {
  if (!isObject(value) || value.version !== 6 || !isEpoch(value.last_record_epoch) || !isEpoch(value.unassigned))
    return false;
  const { workstreams, conversations } = value;
  return isObject(workstreams) && isObject(conversations) &&
    Object.entries(workstreams).every(([key, workstream]) => isWorkstream(workstream, key, conversations)) &&
    Object.values(conversations).every((conversation) => isConversation(conversation, workstreams));
}

/** The facts file, or null when it is not JSON or breaks the contract. */
export function parseWorkstreamFacts(raw: string): WorkstreamFacts | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isWorkstreamFacts(value) ? value : null;
  } catch {
    return null;
  }
}

// Group 1 holds the words before the question, which may name a project.
// Unnamed English forms come first: "how far along are we" names nobody.
const PROGRESS = [
  /^how\s+far\s+(?:along\s+)?(?:am\s+i|are\s+we|did\s+(?:i|we)\s+get|have\s+(?:i|we)\s+(?:got|gotten|come))(?:\s+(?:now|right\s+now|so\s+far))?$/i,
  /^how\s+far\s+(?:along\s+)?(?:is|are)\s+(.+?)(?:\s+(?:now|right\s+now|so\s+far))?$/i,
  /^how\s+far\s+(?:did|have)\s+(?:i|we)\s+(?:get|got|gotten|come)\s+(?:with|on)\s+(.+?)(?:\s+(?:now|so\s+far))?$/i,
  /^where\s+(?:am\s+i|are\s+we)\s+(?:with|on)\s+(.+?)(?:\s+(?:now|right\s+now))?$/i,
  /^(.*?)\s*어디까지\s*(?:진행\s*)?(?:했|됐|되었|왔)(?:어요|어|지요|지|죠|나요|나|니|냐|는지|더라|습니까)?$/,
  /^(?:(.+?)(?:は|って|の|も))?\s*(?:今|いま|現在)?\s*どこまで\s*(?:進んだ|進んでる|進んでいる|進みました|進んでいます|やった|やりました|できた|できました|した|しました)(?:の|か|っけ)?$/,
];
/** Words beside a project name that do not name one, pronouns and articles
 * included: "How far along is it?" names no project. Compared lowercased. */
const FILLER = new Set(["지금", "현재", "이제", "여태", "지금까지", "여태까지", "현재까지", "그동안", "요즘", "최근", "최근에",
  "내가", "제가", "우리가", "나는", "저는", "우리는", "우리", "이", "그", "저", "이거", "그거", "저거", "이것", "그것", "저것",
  "프로젝트", "私", "私たち", "僕", "今", "これ", "それ", "あれ", "この", "その", "プロジェクト",
  "it", "this", "that", "the", "a", "an", "my", "our", "project"]);

// Group 1 names the project, quoted or not. The word "project" must be said:
// "Lumen에 대해서 설명해줘" may ask about a topic and keeps its route. The
// explain chip asks these (buildExplainQuestion).
const EXPLAIN = [
  /^['‘“"]?(.+?)['’”"]?\s*프로젝트\s*(?:를|을|에\s*대해서?|에\s*관해서?)?\s*(?:좀\s*)?설명(?:해\s*(?:줘요|줘|주세요|줄래|봐)|해|하기)?$/u,
  /^(?:please\s+)?(?:explain|describe)\s+(?:the\s+)?['‘“"]?(.+?)['’”"]?\s+project$/iu,
  /^[「『]?(.+?)[」』]?\s*プロジェクト\s*(?:を|について)?\s*説明(?:して(?:ください|くれ|ほしい)?|する)?$/u,
];

/** Recent work (the undated overview queryActivity already recognizes),
 * project progress, named or not, or a named project explained.
 * Remaining-work questions and anything else return null so Ask keeps its
 * other routes. */
export function classifyWorkstreamQuestion(question: string, lang: Lang, queryTime: Date): WorkstreamQuestion | null {
  const text = question.normalize("NFC").trim().replace(/[\s?？!！.。~]+$/u, "");
  const explained = text.length <= 300 ? EXPLAIN.map((pattern) => pattern.exec(text)).find(Boolean) : null;
  if (explained) {
    // "이 프로젝트 설명해줘" names none; a picked title may be long, and the
    // resolver takes a long name only as a title written exactly so.
    const name = explained[1].trim();
    return FILLER.has(name.toLowerCase()) ? null : { kind: "explain", name };
  }
  if (isUndatedActivityOverview(question, lang, queryTime)) return { kind: "recent" };
  const match = text.length <= 120 ? PROGRESS.map((pattern) => pattern.exec(text)).find(Boolean) : null;
  if (!match) return null;
  const words = (match[1] ?? "").split(/\s+/).filter((word) => word && !FILLER.has(word.toLowerCase()));
  // More words than a project name are a specific question for retrieval.
  if (words.length > 4) return null;
  // A Korean particle after a Latin name ("Lumen은") is not part of it.
  const name = words.join(" ").replace(/(?<=[\p{Script=Latin}\p{N}])(?:은|는|이|가|의|도)$/u, "");
  return { kind: "progress", name: name || null };
}

/** Casefolded runs of letters and digits; emoji, punctuation and spaces split
 * them, and so does a change between Latin and another script, so a Korean
 * particle does not join a Latin name ("Lumen은" holds the word "lumen"). */
const nameWords = (text: string): string[] =>
  text.normalize("NFKC").toLowerCase().match(/[\p{Script=Latin}\p{N}]+|(?:(?!\p{Script=Latin})\p{L})+/gu) ?? [];

/** Whether `inner` occurs as consecutive whole words of `outer`. */
const hasRun = (outer: string[], inner: string[]): boolean =>
  inner.length > 0 && outer.some((_, at) => inner.every((word, i) => outer[at + i] === word));

/** A name as written, ignoring case, character width and spacing. */
const literal = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Conversations that must say a name for it to point at their project. */
const MENTIONS = 3;

/** The workstream key a project name means: a key written exactly so (keys
 * are unique); for a name of more than four words, only a title written
 * exactly so; else the title or key that equals it (ignoring case, emoji,
 * punctuation and spaces; a title written exactly so first, so "Tide Ledger"
 * is not the folder tide_ledger), else the longest one whose whole words
 * hold the name or are held in it. Null when two projects match equally.
 * Whole words only: "it" does not name "GitHub tools", nor "Mail app" a
 * project keyed "ai". When no title or key matches, the project whose
 * conversations say the name (as whole words, in their request or report)
 * in at least 3 conversations and in at least 80% of all conversations in a
 * project that say it, so four times any other project's: a topic word
 * ("테스트", "design") is said across projects, a project's own name is not.
 * Else null. */
export function resolveWorkstream(name: string, facts: WorkstreamFacts): string | null {
  const wanted = nameWords(name);
  const joined = wanted.join("");
  if (!joined) return null;
  const asWritten = literal(name);
  const exactKey = Object.keys(facts.workstreams).find((key) => literal(key) === asWritten);
  if (exactKey !== undefined) return exactKey;
  // More words than a project name: only a title written exactly so (a
  // project picked from the list), never a project a longer topic mentions.
  if (asWritten.split(" ").length > 4) {
    const titled = Object.keys(facts.workstreams).filter((key) => literal(facts.workstreams[key].title) === asWritten);
    return titled.length === 1 ? titled[0] : null;
  }
  let best: string | null = null;
  let bestScore = 0;
  let tied = false;
  for (const [key, workstream] of Object.entries(facts.workstreams)) {
    let score = 0;
    for (const label of [nameWords(workstream.title), nameWords(key)]) {
      const text = label.join("");
      const shared = Math.min(text.length, joined.length);
      if (text === joined) score = Math.max(score, shared * 2 + 1);
      // One shared letter is not a name.
      else if (shared >= 2 && (hasRun(label, wanted) || hasRun(wanted, label))) score = Math.max(score, shared * 2);
    }
    if (score && literal(workstream.title) === asWritten) score += 1;
    if (score > bestScore) [best, bestScore, tied] = [key, score, false];
    else if (score && score === bestScore) tied = true;
  }
  if (best) return tied ? null : best;
  const mentions = new Map<string, number>();
  let total = 0;
  for (const { key, request, report, automated } of Object.values(facts.conversations)) {
    if (automated || key === null || !Object.hasOwn(facts.workstreams, key)) continue;
    if (![request, report?.text].some((text) => text && hasRun(nameWords(text), wanted))) continue;
    mentions.set(key, (mentions.get(key) ?? 0) + 1);
    total += 1;
  }
  const [top] = [...mentions].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]));
  return top && top[1] >= MENTIONS && top[1] * 5 >= total * 4 ? top[0] : null;
}

export interface WorkstreamSources {
  key: string;
  title: string;
  paths: string[];
  range: DateRange | null;
  incomplete: boolean;
}

/** A project follow-up cannot silently answer its old project when another
 * current project key or title is explicitly named as whole words. */
export function mentionsOtherWorkstream(question: string, selectedKey: string, facts: WorkstreamFacts): boolean {
  const words = nameWords(question);
  return Object.entries(facts.workstreams).some(([key, project]) => key !== selectedKey &&
    [key, project.title].some(label => {
      const named = nameWords(label);
      return named.join("").length >= 2 && hasRun(words,named);
    }));
}

/** Project facts select candidates, never establish a task's current state.
 * Only current native-ledger projections may enter the original-source flow. */
export function workstreamSources(name: string, facts: WorkstreamFacts, ledgerRaw: string, queryTime: Date,
  limits: { paths?: readonly string[]; range?: DateRange; asOf?: string } = {}): WorkstreamSources | null {
  const key = resolveWorkstream(name, facts);
  if (!key) return null;
  const members = Object.entries(facts.conversations).filter(([, c]) => c.key === key && !c.automated);
  const day = (epoch: number) => workstreamRecentRange(new Date(epoch * 1000)).end;
  const start = limits.range?.start ?? day(facts.workstreams[key].first_epoch);
  const end = [limits.range?.end, limits.asOf, workstreamRecentRange(queryTime).end]
    .filter((value): value is string => Boolean(value)).sort()[0];
  const range = start <= end ? { start, end } : null;
  const selected: WorkstreamSources = {key, title:facts.workstreams[key].title, paths:[], range, incomplete:false};
  if (!range) return selected;
  // This is a bounded candidate snapshot, not native custody or source proof.
  if (ledgerRaw.length > 8 * 1024 * 1024) return {...selected,incomplete:true};
  let ledger: unknown;
  try { ledger = JSON.parse(ledgerRaw); }
  catch { return {...selected,incomplete:true}; }
  if (!isObject(ledger) || !isObject(ledger.entries) || !isObject(ledger.locations))
    return {...selected,incomplete:true};
  const { entries, locations } = ledger;
  const bounds = queryDateRange(range);
  const candidates = members.filter(([, c]) => c.first_epoch < bounds.endEpoch && c.last_epoch >= bounds.startEpoch);
  const owners = new Map<string, number>();
  for (const [location, path] of Object.entries(locations))
    if (location.startsWith("sessions:") && typeof path === "string") owners.set(path,(owners.get(path) ?? 0) + 1);
  for (const [id, c] of candidates) {
    const path = locations[`sessions:${id}`];
    if (id !== `${c.vendor}:${c.id}` || !/^[a-f0-9]{16}$/.test(c.fp) || entries[id] !== c.fp ||
        !isLinkPath(path,"sessions/") || typeof path !== "string" ||
        [...path].some(char => char === "\\" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || owners.get(path) !== 1) {
      selected.incomplete = true;
      continue;
    }
    if (limits.paths && !limits.paths.includes(path)) continue;
    selected.paths.push(path);
  }
  selected.paths.sort();
  return selected;
}

const EN = {
  progress: "{page} has {roots} sessions ({conversations} conversations) from {first} to {last}. Newest first:",
  asked: "{page} (asked as “{name}”)",
  reportedOnly: "Gathered from what the conversations reported; whether the work is really done was not checked.",
  request: "Asked",
  noReport: "No report yet",
  subagents: "{count} sub-tasks",
  source: "source",
  link: "{host} link",
  more: "{count} older sessions are on the {page}.",
  pageLink: "project page",
  pageRefreshPending: "page refresh pending; existing content was preserved",
  window: "the last 7 days ({start} – {end})",
  emptyWindow: "No conversation from the last 7 days ({start} – {end}) belongs to a project.",
  choosePeriod: "Name a project or ask with explicit dates to search older records.",
  chooseProject: "Name the project whose current work state you want to review.",
  projectNotFound: "I couldn't identify one project. Select it from the project list or enter its exact project name or key.",
  stateModelRequired: "Project state requires a built-in local chat model that supports original-source review. Select one in Model settings, then retry.",
  stateIncomplete: "Some project records could not be checked. The supported state below covers only the available sources; the full current state remains unconfirmed.",
  recent: "In {window}, there were {conversations} conversations across {projects} projects:",
  recentLine: "{conversations} conversations in {roots} sessions, last active {date}",
  assumed: "No project was named, so this assumes {title}, the project with the most conversations in {window}. Name a project to ask about another one.",
  unassigned: "{count} conversations in this period have no project and are not listed ({total} unassigned in all).",
  remaining: "{page}: {count} open items in the reports of the latest sessions, newest first:",
  remainingNone: "{page}: the reports of the latest sessions record no open item.",
  latestSession: "Latest session",
  explain: "{page}",
  readme: "README",
  noReadme: "no summary found",
  period: "Period",
  periodValue: "{first} – {last}, {roots} sessions, {conversations} conversations",
  firstRequest: "First request",
  noRequest: "none recorded",
  latestReport: "Latest report",
};

export const WORKSTREAM_COPY: Record<Lang, Record<keyof typeof EN, string>> = {
  en: EN,
  ko: {
    progress: "{page} 프로젝트는 {first}부터 {last}까지 세션 {roots}개, 대화 {conversations}건이 있습니다. 최근 세션부터 보여 드립니다.",
    asked: "{page}(질문한 이름: {name})",
    reportedOnly: "대화에서 보고된 내용을 모은 것이며, 실제로 끝났는지는 확인하지 않았습니다.",
    request: "요청",
    noReport: "아직 보고 없음",
    subagents: "하위 작업 {count}개",
    source: "원문",
    link: "{host} 링크",
    more: "이전 세션 {count}개는 {page}에서 볼 수 있습니다.",
    pageLink: "프로젝트 페이지",
    pageRefreshPending: "페이지 갱신 대기: 기존 내용을 보존했습니다",
    window: "최근 7일({start} – {end})",
    emptyWindow: "최근 7일({start} – {end})에는 프로젝트로 묶인 대화가 없습니다.",
    choosePeriod: "이전 기록을 보려면 프로젝트 이름이나 원하는 날짜를 넣어 다시 물어보세요.",
    chooseProject: "현재 작업 상태를 확인할 프로젝트 이름을 입력해 주세요.",
    projectNotFound: "프로젝트를 하나로 특정하지 못했습니다. 프로젝트 목록에서 선택하거나 정확한 이름 또는 식별자를 입력해 주세요.",
    stateModelRequired: "프로젝트 상태 확인에는 원문 검토를 지원하는 내장 로컬 대화 모델이 필요합니다. 모델 설정에서 선택한 뒤 다시 시도해 주세요.",
    stateIncomplete: "일부 프로젝트 기록을 확인하지 못했습니다. 아래 상태는 확인 가능한 원문에 한정되며, 전체 현재 상태는 미확인입니다.",
    recent: "{window} 동안 프로젝트 {projects}개에서 대화 {conversations}건이 있었습니다.",
    recentLine: "대화 {conversations}건, 세션 {roots}개, 마지막 활동 {date}",
    assumed: "프로젝트 이름이 없어, {window} 동안 대화가 가장 많은 {title} 프로젝트로 가정했습니다. 다른 프로젝트라면 이름을 넣어 다시 물어보세요.",
    unassigned: "이 기간 대화 중 {count}건은 프로젝트를 정하지 못해 목록에서 뺐습니다(전체 미분류 {total}건).",
    remaining: "{page} 프로젝트의 최근 세션 보고에 남은 일로 적힌 항목이 {count}개 있습니다. 최근 것부터 보여 드립니다.",
    remainingNone: "{page} 프로젝트의 최근 세션 보고에는 남은 일로 적힌 항목이 없습니다.",
    latestSession: "최근 세션",
    explain: "{page} 프로젝트",
    readme: "README",
    noReadme: "요약을 찾지 못했습니다",
    period: "기간",
    periodValue: "{first} – {last}, 세션 {roots}개, 대화 {conversations}건",
    firstRequest: "처음 요청",
    noRequest: "기록 없음",
    latestReport: "최근 보고",
  },
  ja: {
    progress: "{page}は{first}から{last}まで、セッション{roots}件（会話{conversations}件）があります。新しいセッションから表示します。",
    asked: "{page}（質問した名前：{name}）",
    reportedOnly: "会話で報告された内容をまとめたもので、実際に終わったかは確認していません。",
    request: "依頼",
    noReport: "報告なし",
    subagents: "サブタスク{count}件",
    source: "原文",
    link: "{host}のリンク",
    more: "以前のセッション{count}件は{page}で確認できます。",
    pageLink: "プロジェクトページ",
    pageRefreshPending: "ページ更新待ち：既存の内容を保持しました",
    window: "直近7日間（{start}〜{end}）",
    emptyWindow: "直近7日間（{start}〜{end}）には、プロジェクトにまとめられた会話がありません。",
    choosePeriod: "以前の記録を探すには、プロジェクト名か具体的な日付を指定して質問してください。",
    chooseProject: "現在の作業状態を確認するプロジェクト名を入力してください。",
    projectNotFound: "プロジェクトを一つに特定できませんでした。一覧から選ぶか、正確なプロジェクト名または識別子を入力してください。",
    stateModelRequired: "プロジェクトの状態確認には原文レビューに対応した内蔵ローカルチャットモデルが必要です。モデル設定で選択して再試行してください。",
    stateIncomplete: "一部のプロジェクト記録を確認できませんでした。以下は確認可能な原文に限られ、全体の現在の状態は未確認です。",
    recent: "{window}に、{projects}件のプロジェクトで会話が{conversations}件ありました。",
    recentLine: "会話{conversations}件、セッション{roots}件、最終活動 {date}",
    assumed: "プロジェクト名がないため、{window}に会話が最も多い{title}と仮定しました。別のプロジェクトについては、名前を入れて質問してください。",
    unassigned: "この期間の会話のうち{count}件はプロジェクトを特定できず、一覧から除きました（全体の未分類は{total}件）。",
    remaining: "{page}の最近のセッションの報告に、残りとして書かれた項目が{count}件あります。新しい順に表示します。",
    remainingNone: "{page}の最近のセッションの報告には、残りとして書かれた項目がありません。",
    latestSession: "最新のセッション",
    explain: "{page}",
    readme: "README",
    noReadme: "要約が見つかりませんでした",
    period: "期間",
    periodValue: "{first}〜{last}、セッション{roots}件、会話{conversations}件",
    firstRequest: "最初の依頼",
    noRequest: "記録なし",
    latestReport: "最新の報告",
  },
};

/** Root sessions a progress answer lists; the project page keeps the rest. */
const PROGRESS_ROOTS = 5;

type Entry = [ledgerKey: string, conversation: WorkstreamConversation];
interface Span { start: number; end: number }

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const overlaps = (c: WorkstreamConversation, span: Span): boolean => c.last_epoch >= span.start && c.first_epoch <= span.end;
/** Replace `{name}` slots in one pass; values go in literally. */
const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (slot, name: string) => values[name] ?? slot);

/** One reported line, at most `max` characters, inert as markdown. A
 * markdown escape the transcript already holds (`START\_HERE`) is undone
 * first, so it does not show as a backslash. */
function inline(text: string, max = 200): string {
  const characters = [...text.replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(/\s+/g, " ").trim()];
  return (characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : characters.join(""))
    .replace(/[\\`*_[\]<>|]/g, "\\$&");
}

/** The entry with the greatest `at`; ties take the greater ledger key. */
function newest(entries: Entry[], at: (c: WorkstreamConversation) => number | undefined): Entry | undefined {
  let best: Entry | undefined;
  let bestAt = -1;
  for (const entry of entries) {
    const value = at(entry[1]);
    if (value === undefined) continue;
    if (!best || value > bestAt || (value === bestAt && entry[0] > best[0])) [best, bestAt] = [entry, value];
  }
  return best;
}

/** Letters only a report in that UI language has: Hangul for ko, kana for ja. */
const UI_SCRIPT: Partial<Record<Lang, RegExp>> = { ko: /\p{Script=Hangul}/u, ja: /[\p{Script=Hiragana}\p{Script=Katakana}]/u };

/** A parent link proves lineage, not project identity. */
function copiedReport(entries: Entry[], conversation: WorkstreamConversation): Report | null {
  return conversation.key !== null && entries.some(([id, parent]) =>
    id === conversation.root && parent.key === conversation.key) ? conversation.parent_report : null;
}

/** Prefer the person's own report, then a positively same-project copy,
 * then a sub-agent's report; within each, the UI language and latest time. */
function preferredReport(entries: Entry[], lang: Lang): { entry: Entry; report: Report } | undefined {
  const script = UI_SCRIPT[lang];
  const shown = entries.flatMap((entry) => {
    const [, c] = entry;
    return ([[c.subagent ? 0 : 2, c.report], [1, copiedReport(entries, c)]] as const)
      .filter(([, report]) => report?.text.trim())
      .map(([tier, report]) => ({ entry, report: report!, tier, inLang: Number(script?.test(report!.text) ?? false) }));
  });
  return shown.sort((a, b) => b.tier - a.tier || b.inLang - a.inLang || b.report.epoch - a.report.epoch ||
    byText(b.entry[0], a.entry[0]))[0];
}

/** Whether a session has anything to show: a request or a report. A helper
 * session that only named a git branch has neither. */
const hasWords = (members: Entry[]): boolean =>
  members.some(([, c]) => c.request?.trim() || c.report?.text.trim() || copiedReport(members, c)?.text.trim());

function groupBy(entries: Entry[], keyOf: (c: WorkstreamConversation) => string | null): [string, Entry[]][] {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = keyOf(entry[1]);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups];
}

/** The groups newest first by last activity, ties by key. */
const byLatest = (groups: [string, Entry[]][]) => groups
  .map(([key, members]) => ({ key, members, last: Math.max(...members.map(([, c]) => c.last_epoch)) }))
  .sort((a, b) => b.last - a.last || byText(a.key, b.key));

/** Seven local calendar days, including today; shared with saved Ask metadata. */
export function workstreamRecentRange(queryTime: Date): DateRange {
  const day = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { start: day(new Date(queryTime.getFullYear(), queryTime.getMonth(), queryTime.getDate() - 6)), end: day(queryTime) };
}

/** The deterministic answer, or null when the named project is unknown or
 * ambiguous. An empty recent period stays empty and offers an explicit
 * older-record search. Remaining work and explain always name a project. */
export function workstreamAnswer(question: WorkstreamQuestion, facts: WorkstreamFacts, lang: Lang, queryTime: Date): string | null {
  const copy = WORKSTREAM_COPY[lang];
  // Month and day, with the year only when it is not the year asked in. A
  // numeric "2026. 11. 6." at the start of a list item would read as nested
  // ordered lists in markdown, and dates lead every item here.
  const month = lang === "en" ? "short" : "long";
  const thisYear = new Intl.DateTimeFormat(lang, { month, day: "numeric" });
  const otherYear = new Intl.DateTimeFormat(lang, { year: "numeric", month, day: "numeric" });
  const numbers = new Intl.NumberFormat(lang);
  const day = (epoch: number): string => {
    const date = new Date(epoch * 1000);
    return (date.getFullYear() === queryTime.getFullYear() ? thisYear : otherYear).format(date);
  };
  const count = (value: number): string => numbers.format(value);
  // A program's sessions are the person's work nowhere in an answer.
  const entries = Object.entries(facts.conversations).filter(([, c]) => !c.automated);
  const title = (key: string): string => facts.workstreams[key].title.replace(/\s+/g, " ").trim() || key;
  const page = (key: string, label = title(key)): string =>
    chunkCitation({ page: facts.workstreams[key].page, stem: label }) +
    (facts.workstreams[key].page_refresh_pending ? ` (${copy.pageRefreshPending})` : "");
  const source = ([, c]: Entry): string => chunkCitation({ page: c.raw, stem: copy.source });
  /** A request that is only a link reads as its site, not a long URL. */
  const asked = (request: string): string => {
    const link = /^\s*(https?:\/\/[^\s/?#]+)\S*\s*$/i.exec(request);
    if (link) {
      try { return fill(copy.link, { host: inline(new URL(link[1]).host.replace(/^www\./, "")) }); }
      catch { /* not a URL after all: shown as written */ }
    }
    return inline(request, 90);
  };

  /** One session: what came back, and what the person asked with how many
   * sub-tasks ran and the transcript it was read from. The root may not be in
   * the vault, so the citation is the shown report's own conversation, else
   * the session's newest one. */
  const session = (members: Entry[]): { result: string; detail: string } => {
    // What the person asked last: their own thread's latest request, else
    // the latest a sub-agent was given (the thread may not be in the vault).
    const request = [...members]
      .sort(([ak, a], [bk, b]) => Number(a.subagent) - Number(b.subagent) || b.first_epoch - a.first_epoch || byText(bk, ak))
      .find(([, c]) => c.request?.trim())?.[1].request;
    const shown = preferredReport(members, lang);
    const cited = shown?.entry ?? newest(members, (c) => c.last_epoch);
    const subagents = members.filter(([, c]) => c.subagent).length;
    const detail = [request ? `${copy.request}: ${asked(request)}` : "",
      subagents ? `(${fill(copy.subagents, { count: count(subagents) })})` : "", cited ? source(cited) : ""].filter(Boolean).join(" ");
    return { result: shown ? inline(shown.report.text) : copy.noReport, detail };
  };
  /** Lines of one list item, joined by hard breaks (`breaks` is off). */
  const item = (...lines: string[]): string => `- ${lines.filter(Boolean).join("\\\n  ")}`;
  /** A session as a dated item: the date and the result first, the request
   * below it. */
  const dated = (members: Entry[], date: number): string => {
    const { result, detail } = session(members);
    return item(`**${day(date)}** ${result}`, detail);
  };

  /** The project link, with the name asked about when the title does not
   * already hold it ("Tide" in "Tide (타이드)"). */
  const named = (key: string, name: string | null): string => {
    if (!name) return page(key);
    const [wanted, titled] = [nameWords(name), nameWords(title(key))];
    return wanted.join("") === titled.join("") || hasRun(titled, wanted) ? page(key)
      : fill(copy.asked, { page: page(key), name: inline(name) });
  };

  /** The project's sessions, newest activity first. */
  const sessionsOf = (key: string) => byLatest(groupBy(entries, (c) => (c.key === key ? c.root : null)));

  const progress = (key: string, name: string | null): string => {
    const workstream = facts.workstreams[key];
    const roots = sessionsOf(key).filter(({ members }) => hasWords(members));
    const more = roots.length - PROGRESS_ROOTS;
    return [
      fill(copy.progress, { page: named(key, name), roots: count(workstream.roots), conversations: count(workstream.conversations),
        first: day(workstream.first_epoch), last: day(workstream.last_epoch) }),
      roots.slice(0, PROGRESS_ROOTS).map(({ members, last }) => dated(members, last)).join("\n"),
      more > 0 ? fill(copy.more, { count: count(more), page: page(key, copy.pageLink) }) : "",
      copy.reportedOnly,
    ].filter(Boolean).join("\n\n");
  };

  /** The lines the latest sessions' reports leave open, each dated and
   * cited at its transcript; with none, the latest session for context. */
  const remaining = (key: string, name: string): string => {
    const items = facts.workstreams[key].open_items;
    const latest = items.length ? undefined : sessionsOf(key).find(({ members }) => hasWords(members));
    return [
      fill(items.length ? copy.remaining : copy.remainingNone, { page: named(key, name), count: count(items.length) }),
      items.map((item) => `- **${day(item.epoch)}** ${inline(item.text)} ${source([item.conversation, facts.conversations[item.conversation]])}`)
        .join("\n"),
      latest ? `${copy.latestSession}:\n\n${dated(latest.members, latest.last)}` : "",
      copy.reportedOnly,
    ].filter(Boolean).join("\n\n");
  };

  /** The README summary, the period and counts, what the earliest session
   * asked first and the latest report. */
  const explain = (key: string, name: string): string => {
    const workstream = facts.workstreams[key];
    const sessions = sessionsOf(key);
    const earliest = [...sessions]
      .map((group) => ({ ...group, first: Math.min(...group.members.map(([, c]) => c.first_epoch)) }))
      .sort((a, b) => a.first - b.first || byText(a.key, b.key));
    // The person's own thread first, then the first asked.
    const first = earliest.map(({ members }) => [...members]
      .sort(([ak, a], [bk, b]) => Number(a.subagent) - Number(b.subagent) || a.first_epoch - b.first_epoch || byText(ak, bk))
      .find(([, c]) => c.request?.trim())).find(Boolean);
    const reported = sessions.map(({ members }) => preferredReport(members, lang)).find(Boolean);
    return [
      fill(copy.explain, { page: named(key, name) }),
      [
        `**${copy.readme}** ${workstream.summary ? inline(workstream.summary, 400) : copy.noReadme}`,
        `**${copy.period}** ${fill(copy.periodValue, { first: day(workstream.first_epoch), last: day(workstream.last_epoch),
          roots: count(workstream.roots), conversations: count(workstream.conversations) })}`,
        `**${copy.firstRequest}** ${first ? `${day(first[1].first_epoch)}, ${asked(first[1].request!)} ${source(first)}` : copy.noRequest}`,
        `**${copy.latestReport}** ${reported ? `${day(reported.report.epoch)}, ${inline(reported.report.text)} ${source(reported.entry)}`
          : copy.noReport}`,
      ].map((line) => `- ${line}`).join("\n"),
      copy.reportedOnly,
    ].join("\n\n");
  };

  if (question.kind !== "recent" && question.name !== null) {
    const key = resolveWorkstream(question.name, facts);
    if (!key) return null;
    return question.kind === "remaining" ? remaining(key, question.name) :
      question.kind === "explain" ? explain(key, question.name) : progress(key, question.name);
  }
  const period = queryDateRange(workstreamRecentRange(queryTime));
  const window = { start: period.startEpoch, end: Math.floor(queryTime.getTime() / 1000) };
  const inWindow = entries.filter(([, c]) => overlaps(c, window)).map(([key, c]): Entry => [key, {
    ...c,
    // A long conversation can overlap the period while its quoted request or
    // latest report does not. Never carry those outside-period words into it.
    request: c.first_epoch >= window.start && c.first_epoch <= window.end ? c.request : null,
    report: c.report && c.report.epoch >= window.start && c.report.epoch <= window.end ? c.report : null,
    parent_report: c.parent_report && c.parent_report.epoch >= window.start && c.parent_report.epoch <= window.end ? c.parent_report : null,
  }]);
  // Most conversations first, then latest activity: the unnamed default.
  const active = byLatest(groupBy(inWindow, (c) => c.key))
    .sort((a, b) => b.members.length - a.members.length || b.last - a.last || byText(a.key, b.key));
  const range = (span: Span) => ({ start: day(span.start), end: day(span.end) });
  if (!active.length) return [fill(copy.emptyWindow, range(window)), copy.choosePeriod].join("\n\n");
  const label = fill(copy.window, range(window));

  if (question.kind === "progress")
    return [fill(copy.assumed, { window: label, title: inline(title(active[0].key)) }), progress(active[0].key, null)]
      .filter(Boolean).join("\n\n");

  // Each project with its counts, then its latest session in the window with
  // anything to show, read as a progress line is.
  const lines = active.map(({ key, members, last }) => {
    const sessions = byLatest(groupBy(members, (c) => c.root));
    const head = `**${page(key)}** ${fill(copy.recentLine, { roots: count(sessions.length), conversations: count(members.length), date: day(last) })}`;
    const latest = sessions.find((group) => hasWords(group.members));
    const shown = latest ? session(latest.members) : undefined;
    return item(head, shown?.result ?? "", shown?.detail ?? "");
  });
  const unassigned = inWindow.filter(([, c]) => c.key === null).length;
  return [
    fill(copy.recent, { window: label, projects: count(active.length),
      conversations: count(active.reduce((sum, group) => sum + group.members.length, 0)) }),
    lines.join("\n"),
    unassigned ? fill(copy.unassigned, { count: count(unassigned), total: count(facts.unassigned) }) : "",
    copy.reportedOnly,
  ].filter(Boolean).join("\n\n");
}

/** A project the guided question picker offers. */
export interface WorkstreamChoice {
  key: string;
  title: string;
  /** What the question names: the title, else the key when the title does
   * not name this project alone (two projects share it). */
  subject: string;
  last: number;
  conversations: number;
  /** The most active project of the 7 days before the query. */
  suggested: boolean;
}

/** The projects the guided picker offers: the one with the most of the
 * person's conversations in the 7 days before `queryTime` first, marked as
 * suggested, then the rest by latest activity. A project with none of the
 * person's conversations is left out. */
export function workstreamChoices(facts: WorkstreamFacts, queryTime: Date): WorkstreamChoice[] {
  const now = Math.floor(queryTime.getTime() / 1000);
  const week = { start: queryDateRange(workstreamRecentRange(queryTime)).startEpoch, end: now };
  const active = new Map<string, number>();
  for (const c of Object.values(facts.conversations))
    if (!c.automated && c.key !== null && overlaps(c, week)) active.set(c.key, (active.get(c.key) ?? 0) + 1);
  const choices = Object.entries(facts.workstreams)
    .filter(([, workstream]) => workstream.conversations > 0)
    .map(([key, workstream]): WorkstreamChoice => {
      const title = workstream.title.replace(/\s+/g, " ").trim() || key;
      return { key, title, subject: resolveWorkstream(title, facts) === key ? title : key,
        last: workstream.last_epoch, conversations: workstream.conversations, suggested: false };
    })
    .sort((a, b) => b.last - a.last || byText(a.key, b.key));
  // Most conversations, then the latest activity: the unnamed default's order.
  const [top] = [...active].sort((a, b) => b[1] - a[1] ||
    facts.workstreams[b[0]].last_epoch - facts.workstreams[a[0]].last_epoch || byText(a[0], b[0]));
  const at = top ? choices.findIndex((choice) => choice.key === top[0]) : -1;
  if (at >= 0) choices.unshift({ ...choices.splice(at, 1)[0], suggested: true });
  return choices;
}

/** The choices whose title or key holds `text`, ignoring case, width and
 * spacing; all of them for blank text. */
export function filterChoices(choices: WorkstreamChoice[], text: string): WorkstreamChoice[] {
  const wanted = literal(text);
  return wanted ? choices.filter(({ key, title }) => literal(title).includes(wanted) || literal(key).includes(wanted)) : choices;
}
