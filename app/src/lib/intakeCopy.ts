import type { Lang } from "./i18n";

interface IntakeCopy {
  addTitle: string;
  addDescription: string;
  addHint: string;
  moreSources: string;
  moreSourcesHint: string;
  processingDetails: string;
  processingSettings: string;
  savedIn: string;
  titleOptional: string;
  sessionsHint: string;
  clipperHint: string;
  connectionHint: string;
  inboxHint: string;
  askDescription: string;
  askOptions: string;
  askExamples: string;
  /** The Ask composer's placeholder: short enough for the one-row composer
   *  at 375 px, unlike the example questions. */
  askPlaceholder: string;
  examples: readonly [string, string, string];
  searchDetails: string;
  sourcesTitle: string;
}

export const INTAKE_COPY: Record<Lang, IntakeCopy> = {
  en: {
    addTitle: "Turn your sources into useful notes",
    addDescription:
      "Choose a file or paste some text. myco will organize it and connect it to what you already know.",
    addHint: "Files, documents, images, audio, or a YouTube link",
    moreSources: "More ways to add sources",
    moreSourcesHint: "Import conversations, research papers, and saved items.",
    processingDetails: "What happened to your sources",
    processingSettings: "Processing settings",
    savedIn: "Save to",
    titleOptional: "Title (optional)",
    sessionsHint: "Conversations from your AI tools",
    clipperHint: "Pages saved from your browser",
    connectionHint: "Sources sent by connected tools",
    inboxHint: "Saved items waiting to be organized",
    askDescription:
      "Ask in your own words. Answers point back to your saved notes.",
    askOptions: "Answer options",
    askExamples: "Try a question",
    askPlaceholder: "Ask about your notes",
    examples: [
      "What are the main ideas in my notes?",
      "Which ideas are connected?",
      "What should I explore next?",
    ],
    searchDetails: "Search details",
    sourcesTitle: "Sources for this answer",
  },
  ko: {
    addTitle: "자료를 넣으면, 쓸 수 있는 노트로",
    addDescription:
      "파일을 선택하거나 글을 붙여넣으세요. myco가 내용을 정리하고 기존 노트와 연결해요.",
    addHint: "파일, 문서, 이미지, 음성 또는 YouTube 링크",
    moreSources: "다른 곳에서 가져오기",
    moreSourcesHint: "AI 대화, 연구 자료, 저장해 둔 자료도 가져올 수 있어요.",
    processingDetails: "자료 처리 내역",
    processingSettings: "처리 설정",
    savedIn: "저장 위치",
    titleOptional: "제목 (선택)",
    sessionsHint: "AI 도구에서 나눈 대화",
    clipperHint: "브라우저에서 저장한 페이지",
    connectionHint: "연결한 도구에서 보낸 자료",
    inboxHint: "정리를 기다리는 자료",
    askDescription:
      "궁금한 것을 편하게 물어보세요. 저장한 노트에서 답과 출처를 찾아드려요.",
    askOptions: "답변 옵션",
    askExamples: "이렇게 물어보세요",
    askPlaceholder: "노트에 대해 물어보세요",
    examples: [
      "내 노트의 핵심 내용을 정리해줘",
      "서로 연결되는 아이디어가 있어?",
      "다음에 더 알아볼 만한 주제는 뭐야?",
    ],
    searchDetails: "검색 세부정보",
    sourcesTitle: "답변의 출처",
  },
  ja: {
    addTitle: "資料を、役立つノートに",
    addDescription:
      "ファイルを選ぶか、文章を貼り付けてください。mycoが内容を整理し、既存のノートとつなげます。",
    addHint: "ファイル、文書、画像、音声、YouTubeリンク",
    moreSources: "ほかの場所から取り込む",
    moreSourcesHint: "AIとの会話、研究資料、保存した資料も取り込めます。",
    processingDetails: "資料の処理履歴",
    processingSettings: "処理の設定",
    savedIn: "保存先",
    titleOptional: "タイトル（任意）",
    sessionsHint: "AIツールでの会話",
    clipperHint: "ブラウザーで保存したページ",
    connectionHint: "連携ツールから届いた資料",
    inboxHint: "整理を待っている資料",
    askDescription:
      "自分の言葉で質問してください。保存したノートから答えと出典を探します。",
    askOptions: "回答のオプション",
    askExamples: "こんな質問から",
    askPlaceholder: "ノートについて質問",
    examples: [
      "ノートの要点をまとめて",
      "つながりのあるアイデアは？",
      "次に調べるとよいテーマは？",
    ],
    searchDetails: "検索の詳細",
    sourcesTitle: "回答の出典",
  },
};
