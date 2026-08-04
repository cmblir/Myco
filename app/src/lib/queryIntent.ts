// Query intent routing (Feature: anti-hallucination). Some Ask questions are
// about the user's OWN recent activity / vault changes — e.g. "what did I do
// recently?", "최근에 내가 한 일이 뭐야?", "変更履歴". Those are NOT answerable from
// wiki *content*; they're git-history questions. A small local model asked such
// a question confabulates (the reported bug). We detect this intent and answer
// factually from `git log` instead of sending it to the LLM.

import type { GitCommit } from "./ipc";
import type { Lang } from "./i18n";

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

/** Render a factual, no-LLM answer listing the vault's most recently modified
 * notes. This answers "what did I add today / which notes changed this week",
 * which page CONTENT cannot: the answer lives in file metadata.
 *
 * `entries` are `[absolutePath, unixSeconds]` exactly as `ipc.fileMtimes`
 * returns them; `now` is injected so the relative dates are testable. Paths are
 * emitted as `[[stem]]` so each row is a working wikilink, the same as every
 * other citation the app renders. */
export function formatRecentFilesAnswer(
  entries: [string, number][],
  lang: Lang,
  now: number = Date.now(),
  limit = 15,
): string {
  const L = FILE_HEADERS[lang] ? lang : "en";
  if (!entries || entries.length === 0) return FILE_EMPTY[L];
  const today = new Date(now);
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const rows = [...entries]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, secs]) => {
      const ms = secs * 1000;
      const stem = (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, "");
      // Day offset from today rather than an elapsed-hours bucket: "yesterday"
      // has to mean the calendar day, or a note written at 23:00 reads as
      // "today" for the next hour.
      const days = Math.floor((startOfToday - ms) / 86_400_000) + (ms >= startOfToday ? 0 : 1);
      const when =
        ms >= startOfToday
          ? RELATIVE[L].today
          : days <= 1
            ? RELATIVE[L].yesterday
            : localDate(ms);
      return `- **${when}** · [[${stem}]]`;
    });
  return `${FILE_HEADERS[L]}\n\n${rows.join("\n")}`;
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
