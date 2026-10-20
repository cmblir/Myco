import type { Lang } from "./i18n";

export const OVERVIEW_LAYOUT_COPY: Record<Lang, { saveFailed: string; boardSaveFailed: string }> = {
  en: { saveFailed: "Could not save the Home layout", boardSaveFailed: "Could not save the Home board" },
  ko: { saveFailed: "홈 배치를 저장하지 못했어요", boardSaveFailed: "홈 보드를 저장하지 못했어요" },
  ja: { saveFailed: "ホームのレイアウトを保存できませんでした", boardSaveFailed: "ホームのボードを保存できませんでした" },
};
