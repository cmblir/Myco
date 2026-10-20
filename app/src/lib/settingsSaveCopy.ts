import type { Lang } from "./i18n";

export const SETTINGS_SAVE_COPY: Record<
  Lang,
  {
    saving: string;
    saved: string;
    failed: string;
    unavailable: string;
    reload: string;
  }
> = {
  en: {
    saving: "Saving changes…",
    saved: "Changes saved",
    failed:
      "A change could not be saved and was restored to its previous value. Try changing it again.",
    unavailable: "Settings could not be loaded.",
    reload: "Try again",
  },
  ko: {
    saving: "변경 사항 저장 중…",
    saved: "변경 사항 저장됨",
    failed:
      "저장하지 못한 항목을 이전 값으로 되돌렸어요. 해당 설정을 다시 변경해 주세요.",
    unavailable: "설정을 불러오지 못했어요.",
    reload: "다시 시도",
  },
  ja: {
    saving: "変更を保存中…",
    saved: "変更を保存しました",
    failed:
      "保存できなかった項目を以前の値に戻しました。その設定をもう一度変更してください。",
    unavailable: "設定を読み込めませんでした。",
    reload: "再試行",
  },
};
