import type { Lang } from "./i18n";

interface SettingsNavigationCopy {
  intro: string;
  basic: string;
  advanced: string;
  advancedHint: string;
}

export const SETTINGS_NAVIGATION_COPY: Record<Lang, SettingsNavigationCopy> = {
  en: {
    intro:
      "Start with the basics. Search whenever you need a specific setting.",
    basic: "Everyday settings",
    advanced: "More settings",
    advancedHint: "Connections, automation, plugins and app information",
  },
  ko: {
    intro:
      "자주 쓰는 설정부터 확인하세요. 필요한 항목은 검색으로 바로 찾을 수 있어요.",
    basic: "기본 설정",
    advanced: "추가 설정",
    advancedHint: "외부 연결, 자동 정리, 플러그인, 앱 정보",
  },
  ja: {
    intro:
      "よく使う設定から始めましょう。必要な項目は検索ですぐに見つかります。",
    basic: "基本設定",
    advanced: "その他の設定",
    advancedHint: "外部接続、自動整理、プラグイン、アプリ情報",
  },
};
