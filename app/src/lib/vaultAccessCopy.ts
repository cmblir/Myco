import type { Lang } from "./i18n";

export const VAULT_ACCESS_COPY: Record<
  Lang,
  {
    title: string;
    hint: string;
    retry: string;
    choose: string;
    details: string;
  }
> = {
  en: {
    title: "Your notes folder could not be opened",
    hint: "Check that the drive is connected and the folder is accessible, then try again.",
    retry: "Try again",
    choose: "Choose a folder",
    details: "Error details",
  },
  ko: {
    title: "볼트 폴더를 열지 못했어요",
    hint: "저장 장치가 연결되어 있고 폴더에 접근할 수 있는지 확인한 뒤 다시 시도해 주세요.",
    retry: "다시 시도",
    choose: "폴더 선택",
    details: "오류 상세",
  },
  ja: {
    title: "ノートのフォルダーを開けませんでした",
    hint: "ドライブの接続とフォルダーへのアクセスを確認して、もう一度お試しください。",
    retry: "再試行",
    choose: "フォルダーを選択",
    details: "エラーの詳細",
  },
};
