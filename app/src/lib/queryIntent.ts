// Query intent routing (Feature: anti-hallucination). Some Ask questions are
// about the user's OWN recent activity / vault changes — e.g. "what did I do
// recently?", "최근에 내가 한 일이 뭐야?", "変更履歴". Those are NOT answerable from
// wiki *content*; they're git-history questions. A small local model asked such
// a question confabulates (the reported bug). We detect this intent and answer
// factually from `git log` instead of sending it to the LLM.

import type { SearchScope, GitCommit } from "./ipc";
import type { Lang } from "./i18n";
import { sourceTier } from "./extractive";
import { chunkCitation } from "./retrievalContext";
import { queryDateRange, type DateRange } from "./timeQuery";

// Shared by memory routing and metadata fallback: an activity-shaped question
// alone never establishes that file modification times answer it.
const REPOSITORY_HISTORY = /\bgit\s+(?:log|history|commits?)\b|\b(?:commit|edit|version)\s+history\b|\b(?:recent|latest)\s+commits?\b|\bchangelog\b|커밋\s*(?:내역|목록|기록|히스토리|로그)|(?:최근|최신)\s*커밋|편집\s*(?:이력|내역)/i;
const VAULT_FILES_PATTERNS = [
  REPOSITORY_HISTORY,
  /(?:노트|파일|볼트|문서|마크다운)[^\n]{0,30}(?:추가|수정|변경|작성|생성|만들|최근|최신)|(?:추가|수정|변경|작성|생성|만든|쌓인|최신)[^\n]{0,25}(?:노트|파일|볼트|문서|마크다운)/,
  /\b(?:files?|notes?|vault|documents?|markdown)\b[^\n]{0,40}\b(?:add(?:ed|ing)?|chang(?:e[ds]?|ing)|edit(?:ed|ing|s)?|modif(?:y|ied|ying)|creat(?:e[ds]?|ing)|new(?:est)?|recent(?:ly)?)\b|\b(?:added|changed|edited|modified|created|newest|recent)\b[^\n]{0,25}\b(?:files?|notes?|vault|documents?|markdown)\b/i,
  /(?:ノート|ファイル)[^\n]{0,25}(?:追加|編集|変更|作成)|(?:追加|編集|変更|作成)[^\n]{0,25}(?:ノート|ファイル)/,
];

/** Whether the question explicitly asks about repository or file activity. */
export function isVaultFilesQuery(question: string): boolean {
  return VAULT_FILES_PATTERNS.some((pattern) => pattern.test(question));
}

/** Explicit repository history cannot be answered by file modification times. */
export function isRepositoryHistoryQuery(question: string): boolean {
  return REPOSITORY_HISTORY.test(question);
}

// Phrases that signal "tell me about my recent activity / what changed in the
// vault". Curated to target vault-meta questions, NOT topic queries that merely
// contain "recent" (e.g. "recent advances in transformers" must NOT match).
const ACTIVITY_PATTERNS: RegExp[] = [
  // English
  /\bwhat\s+(did|have)\s+i\s+(do|done|been|work|change|add|edit|write)/i,
  /\bwhat('?s| has| have)?\s+(recently\s+)?changed\b/i,
  /\brecent(ly)?\s+(activity|edits?|changes?|work|updates?|commits?)\b/i,
  /\b(edit|change|commit|activity|version)\s+history\b/i,
  /\bchange\s?log\b/i,
  /\bwhat\s+i('?ve| have)\s+been\s+(working|doing)\b/i,
  // Korean — "최근/요즘/방금" + activity/change word, or the common phrasings
  /(최근|요즘|방금|최신)[^\n]{0,10}(한\s*일|했|작업|변경|바뀐|바뀌|추가|편집|수정|커밋|업데이트|일이)/,
  /내가[^\n]{0,10}(한\s*일|했던|작업한)/,
  /(변경|수정)\s*(사항|내역|이력|기록)/,
  /(작업|편집|변경)\s*(내역|이력|기록|히스토리)/,
  /커밋\s*(내역|목록|기록|히스토리)/,
  // Japanese
  /最近[^\n]{0,8}(した|やった|変更|作業|編集|追加|更新)/,
  /(変更|編集|作業)\s*履歴/,
  /何を(した|やった)/,
];

export function isActivityQuery(q: string): boolean {
  const s = q.trim();
  if (!s) return false;
  return ACTIVITY_PATTERNS.some((re) => re.test(s));
}

const HEADERS: Record<Lang, string> = {
  en: "Here's your recent vault activity (from git history):",
  ko: "최근 볼트 작업 내역입니다 (git 기록 기준):",
  ja: "最近のボルト作業履歴です（git 履歴より）：",
};

const EMPTY: Record<Lang, string> = {
  en: "No git history found for this vault yet. Once the vault is a git repo with commits, recent-activity questions are answered from the log.",
  ko: "이 볼트에는 아직 git 기록이 없습니다. 볼트를 git 저장소로 만들고 커밋하면, 최근 작업 질문에 로그로 답합니다.",
  ja: "このボルトにはまだ git 履歴がありません。git リポジトリにしてコミットすると、最近の作業に関する質問に履歴から回答します。",
};

const FILE_HEADERS: Record<Lang, string> = {
  en: "Your most recently changed notes (by file modification time):",
  ko: "최근에 바뀐 노트입니다 (파일 수정 시각 기준):",
  ja: "最近変更されたノートです（ファイル更新時刻順）：",
};

const FILE_EMPTY: Record<Lang, string> = {
  en: "No markdown files found in this vault yet.",
  ko: "이 볼트에는 아직 마크다운 파일이 없습니다.",
  ja: "このボルトにはまだマークダウンファイルがありません。",
};

const FILE_RANGE_EMPTY: Record<Lang, string> = {
  en: "No markdown files were modified in {start}–{end} (by file modification time).",
  ko: "선택한 기간({start}–{end})에 수정된 마크다운 파일이 없습니다 (파일 수정 시각 기준).",
  ja: "選択した期間（{start}–{end}）に変更されたマークダウンファイルはありません（ファイル更新時刻基準）。",
};

const FILE_RANGE_HEADERS: Record<Lang, string> = {
  en: "Notes modified in {start}–{end} (by file modification time):",
  ko: "선택한 기간({start}–{end})에 바뀐 노트입니다 (파일 수정 시각 기준):",
  ja: "選択した期間（{start}–{end}）に変更されたノートです（ファイル更新時刻基準）：",
};

export interface RecentFilesOptions {
  /** Inclusive local calendar dates; this filters modification time only. */
  range?: DateRange;
  /** Capture the answer's vault so citations preserve the exact relative path. */
  vaultRoot?: string;
  /** Requires vaultRoot so absolute entries cannot disguise their source tier. */
  scope?: SearchScope;
}

function recentFilePath(path: string, root?: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.split("/").some((part) => part === "." || part === "..")) return null;
  if (root === undefined) return normalized;
  const normalizedRoot = root.replace(/\\/g, "/");
  if (!/^(?:\/|[A-Za-z]:\/)/.test(normalizedRoot)) return null;
  const prefix = `${normalizedRoot.replace(/\/+$/, "")}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null;
}

function recentFileInScope(path: string, scope?: SearchScope): boolean {
  if (!scope) return true;
  const tier = sourceTier(path);
  if (scope === "sessions") return tier === "session";
  if (scope === "wiki") return tier !== "session" && tier !== "source";
  if (scope === "pages") return tier === "note" || tier === "map";
  return !path.startsWith("raw/") || path.startsWith("raw/conversations/");
}

/** Render a factual, no-LLM answer listing the vault's most recently modified
 * notes. This answers "what did I add today / which notes changed this week",
 * which page CONTENT cannot: the answer lives in file metadata.
 *
 * `entries` are `[absolutePath, unixSeconds]` exactly as `ipc.fileMtimes`
 * returns them; `now` is injected so the relative dates are testable. Paths are
 * emitted as exact relative-path citations when `vaultRoot` is supplied.
 * Existing callers without options retain their stem citation format. */
export function formatRecentFilesAnswer(
  entries: [string, number][],
  lang: Lang,
  now: number = Date.now(),
  limit = 15,
  options: RecentFilesOptions = {},
): string {
  if (options.scope && options.vaultRoot === undefined) {
    throw new Error("vaultRoot is required for scoped recent files");
  }
  const L = FILE_HEADERS[lang] ? lang : "en";
  const range = options.range ? queryDateRange(options.range) : null;
  const clock = new Date(now);
  const today = localDate(now);
  const yesterday = localDate(new Date(clock.getFullYear(), clock.getMonth(), clock.getDate() - 1).getTime());
  const rows = (entries ?? [])
    .flatMap(([path, secs]) => {
      const relative = recentFilePath(path, options.vaultRoot);
      if (!relative || !Number.isFinite(secs) || secs <= 0 ||
          (range && !(range.startEpoch <= secs && secs < range.endEpoch)) ||
          !recentFileInScope(relative, options.scope)) return [];
      return [{ path: relative, secs }];
    })
    .sort((a, b) => b.secs - a.secs)
    .slice(0, limit)
    .map(({ path, secs }) => {
      const ms = secs * 1000;
      const stem = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
      const date = localDate(ms);
      const when = date === today ? RELATIVE[L].today : date === yesterday ? RELATIVE[L].yesterday : date;
      const citation = options.vaultRoot === undefined ? `[[${stem}]]` : chunkCitation({ page: path, stem });
      return `- **${when}** · ${citation}`;
    });
  if (!rows.length) return range
    ? FILE_RANGE_EMPTY[L].replace("{start}", range.start).replace("{end}", range.end)
    : FILE_EMPTY[L];
  const header = range
    ? FILE_RANGE_HEADERS[L].replace("{start}", range.start).replace("{end}", range.end)
    : FILE_HEADERS[L];
  return `${header}\n\n${rows.join("\n")}`;
}

/** `YYYY-MM-DD` in the user's own timezone. `toISOString()` would print the UTC
 * day, which disagrees with the local-day "today"/"yesterday" above — so a note
 * could read as an older date than the day it was written on. */
function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const RELATIVE: Record<Lang, { today: string; yesterday: string }> = {
  en: { today: "today", yesterday: "yesterday" },
  ko: { today: "오늘", yesterday: "어제" },
  ja: { today: "今日", yesterday: "昨日" },
};

/** Render a factual, no-LLM answer from recent commits. */
export function formatActivityAnswer(commits: GitCommit[], lang: Lang): string {
  const L = HEADERS[lang] ? lang : "en";
  if (!commits || commits.length === 0) return EMPTY[L];
  const lines = commits
    .slice(0, 15)
    .map((c) => `- **${c.date}** · ${c.subject}  \`+${c.created}/~${c.modified}\``);
  return `${HEADERS[L]}\n\n${lines.join("\n")}`;
}
