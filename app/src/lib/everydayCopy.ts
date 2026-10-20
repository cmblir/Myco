import type { Lang } from "./i18n";

const en = {
  home_status: "Notes status",
  home_notes_count: "{n} notes",
  home_title: "A little space for everything you learn.",
  home_intro:
    "Save a file, a link, or a thought. Find it again when you need it.",
  home_add: "Add something",
  home_add_hint: "Files, links, and pasted text",
  home_ask: "Ask your notes",
  home_ask_hint: "Find an answer in what you have saved.",
  home_write: "Write a note",
  home_write_hint: "Keep an idea before it slips away.",
  home_manage: "Review & organize",
  home_manage_hint: "Suggestions, activity, and workspace tools",
  home_hide_manage: "Close workspace tools",
  home_ready: "{n} items to review",
  home_recent_loading: "Loading your recent notes…",
  home_recent_error: "Your recent notes could not be loaded.",
  home_retry: "Try again",
  home_no_vault: "Choose where to keep your notes to get started.",
  home_choose_vault: "Choose a notes folder",
};

export type EverydayStrings = typeof en;

export const EVERYDAY_STRINGS: Record<Lang, EverydayStrings> = {
  en,
  ko: {
    home_status: "볼트 상태",
    home_notes_count: "노트 {n}개",
    home_title: "기억하고 싶은 것들을 한곳에.",
    home_intro:
      "파일, 링크, 떠오른 생각을 모아 두세요. 필요할 때 쉽게 다시 찾을 수 있어요.",
    home_add: "자료 추가하기",
    home_add_hint: "파일 · 링크 · 텍스트 붙여넣기",
    home_ask: "내 노트에 질문하기",
    home_ask_hint: "저장한 내용에서 필요한 답을 찾아보세요.",
    home_write: "새 노트 쓰기",
    home_write_hint: "잊기 전에 떠오른 생각을 적어 두세요.",
    home_manage: "검토하고 정리하기",
    home_manage_hint: "정리 제안, 최근 활동, 볼트 관리",
    home_hide_manage: "관리 도구 접기",
    home_ready: "검토할 항목 {n}개",
    home_recent_loading: "최근 노트를 불러오고 있어요…",
    home_recent_error: "최근 노트를 불러오지 못했어요.",
    home_retry: "다시 시도",
    home_no_vault: "노트를 보관할 폴더를 선택하면 시작할 수 있어요.",
    home_choose_vault: "볼트 폴더 선택하기",
  },
  ja: {
    home_status: "ノートの状態",
    home_notes_count: "ノート {n} 件",
    home_title: "覚えておきたいことを、ひとつの場所に。",
    home_intro:
      "ファイル、リンク、ひらめきを保存。必要なときに、すぐ見つかります。",
    home_add: "資料を追加する",
    home_add_hint: "ファイル・リンク・テキストの貼り付け",
    home_ask: "自分のノートに質問する",
    home_ask_hint: "保存した内容から、必要な答えを探します。",
    home_write: "ノートを書く",
    home_write_hint: "忘れる前に、ひらめきを残しましょう。",
    home_manage: "確認・整理する",
    home_manage_hint: "整理の提案、最近の活動、管理ツール",
    home_hide_manage: "管理ツールを閉じる",
    home_ready: "確認する項目 {n} 件",
    home_recent_loading: "最近のノートを読み込んでいます…",
    home_recent_error: "最近のノートを読み込めませんでした。",
    home_retry: "もう一度試す",
    home_no_vault: "ノートを保存するフォルダーを選んで始めましょう。",
    home_choose_vault: "ノートのフォルダーを選ぶ",
  },
};
