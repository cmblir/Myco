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

/** Render a factual, no-LLM answer from recent commits. */
export function formatActivityAnswer(commits: GitCommit[], lang: Lang): string {
  const L = HEADERS[lang] ? lang : "en";
  if (!commits || commits.length === 0) return EMPTY[L];
  const lines = commits
    .slice(0, 15)
    .map((c) => `- **${c.date}** · ${c.subject}  \`+${c.created}/~${c.modified}\``);
  return `${HEADERS[L]}\n\n${lines.join("\n")}`;
}
