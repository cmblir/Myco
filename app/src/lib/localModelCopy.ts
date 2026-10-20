import type { Lang } from "./i18n";
import { BUILTIN_CHAT_MODEL, BUILTIN_FAST_CHAT_MODEL } from "./providers";

const COPY = {
  en: {
    title: "Local Ask with Qwen3.5 4B",
    lede: "Use 4B for detailed local answers and import or organization drafts. Local organization uses the explicitly selected import model and preserves remote Ask settings. Summary drafts are saved as requiring review alongside source quotes. E5 search stays unchanged; these local operations send no notes to a server.",
    footprint:
      "Separate download: 2.71 GB of disk space. The model loads when needed for local answers or import and organization drafts and unloads after 3 idle minutes. Intel Mac with 8 GB RAM performance has not been measured.",
    checking: "Checking the installed model…",
    missing: "Not installed. Quote-only answers remain available.",
    downloading: "Downloading and verifying the model…",
    verifying: "Download complete. Verifying the model…",
    cancelling: "Stopping the download and cleaning up…",
    ready: "Model installed and verified.",
    error: "Could not prepare the local model.",
    details: "Error details",
    install: "Download model · 2.71 GB",
    retry: "Download again · 2.71 GB",
    cancel: "Cancel download",
    check: "Check again",
    use: "Use Qwen for Ask",
    selected: "Qwen selected for Ask",
    useForIngest: "Use 4B for import and organization drafts",
    ingestSelected: "4B selected for import and organization drafts",
    quotes: "Use lightweight quote-only answers",
    quotesSelected: "Lightweight quote-only answers selected",
    selectionError: "Could not save the model selection. Try again.",
    progress: "Model download progress",
  },
  ko: {
    title: "Qwen3.5 4B로 로컬 답변",
    lede: "4B로 세부 로컬 답변과 가져오기·정리 초안을 만듭니다. 로컬 정리는 명시적으로 선택한 가져오기 모델을 사용하며 원격 Ask 설정은 유지합니다. 요약 초안은 확인 필요로 표시해 원문 인용과 함께 저장합니다. E5 검색은 그대로이며 이 로컬 작업은 노트를 서버로 보내지 않습니다.",
    footprint:
      "별도 다운로드로 디스크 공간 2.71 GB를 사용합니다. 로컬 답변이나 가져오기·정리 초안에 필요할 때 모델을 로드하고 3분간 사용하지 않으면 메모리에서 해제합니다. Intel Mac·8 GB RAM 성능은 아직 측정하지 않았습니다.",
    checking: "설치된 모델 확인 중…",
    missing:
      "설치되지 않았습니다. 가벼운 원문 인용 답변은 계속 사용할 수 있습니다.",
    downloading: "모델 다운로드·검증 중…",
    verifying: "다운로드 완료. 모델 검증 중…",
    cancelling: "다운로드를 중단하고 임시 파일을 정리하는 중…",
    ready: "모델 설치와 검증을 마쳤습니다.",
    error: "로컬 모델을 준비하지 못했습니다.",
    details: "오류 상세",
    install: "모델 다운로드 · 2.71 GB",
    retry: "다시 다운로드 · 2.71 GB",
    cancel: "다운로드 취소",
    check: "다시 확인",
    use: "질문 답변에 Qwen 사용",
    selected: "질문 답변에 Qwen 선택됨",
    useForIngest: "가져오기·정리 초안에 4B 사용",
    ingestSelected: "가져오기·정리 초안에 4B 선택됨",
    quotes: "가벼운 원문 인용 답변 사용",
    quotesSelected: "가벼운 원문 인용 답변 선택됨",
    selectionError: "모델 선택을 저장하지 못했습니다. 다시 시도해 주세요.",
    progress: "모델 다운로드 진행률",
  },
  ja: {
    title: "Qwen3.5 4Bでローカル回答",
    lede: "4Bで詳細なローカル回答と取り込み・整理の下書きを作ります。ローカル整理には明示的に選んだ取り込みモデルを使い、リモートAskの設定は維持します。要確認の要約下書きを原文引用と共に保存します。E5検索はそのままで、このローカル処理ではノートをサーバーに送信しません。",
    footprint:
      "別途ダウンロードで2.71 GBのディスク容量を使用します。ローカル回答や取り込み・整理の下書きに必要な時にモデルを読み込み、3分間使わないとメモリから解放します。Intel Mac・8 GB RAMでの性能は未測定です。",
    checking: "インストール済みモデルを確認中…",
    missing: "未インストールです。軽量な原文引用の回答は引き続き使えます。",
    downloading: "モデルをダウンロード・検証中…",
    verifying: "ダウンロード完了。モデルを検証中…",
    cancelling: "ダウンロードを停止し、一時ファイルを削除中…",
    ready: "モデルのインストールと検証が完了しました。",
    error: "ローカルモデルを準備できませんでした。",
    details: "エラー詳細",
    install: "モデルをダウンロード · 2.71 GB",
    retry: "再ダウンロード · 2.71 GB",
    cancel: "ダウンロードをキャンセル",
    check: "再確認",
    use: "質問の回答にQwenを使う",
    selected: "質問の回答にQwenを選択中",
    useForIngest: "取り込み・整理の下書きに4Bを使う",
    ingestSelected: "取り込み・整理の下書きに4Bを選択中",
    quotes: "軽量な原文引用の回答を使う",
    quotesSelected: "軽量な原文引用の回答を選択中",
    selectionError:
      "モデルの選択を保存できませんでした。もう一度お試しください。",
    progress: "モデルのダウンロード進捗",
  },
} satisfies Record<Lang, Record<string, string>>;

const FAST_COPY = {
  en: {
    title: "Local Ask with Qwen3.5 2B · smaller download",
    lede: "The smaller 2B artifact is recommended for import and organization drafts, saved as requiring review alongside source quotes. Local organization uses the explicitly selected import model and preserves remote Ask settings. Ask is experimental: validation found incorrect relationships in answers. Keep 4B for Ask by default. E5 search stays unchanged; these local operations send no notes to a server.",
    use: "Use experimental 2B for Ask",
    selected: "Experimental 2B selected for Ask",
    useForIngest: "Use 2B for import and organization drafts",
    ingestSelected: "2B selected for import and organization drafts",
  },
  ko: {
    title: "Qwen3.5 2B · 작은 로컬 모델",
    lede: "다운로드 크기가 작은 2B는 확인 필요로 표시해 원문 인용과 함께 저장하는 가져오기·정리 초안에 추천합니다. 로컬 정리는 명시적으로 선택한 가져오기 모델을 사용하며 원격 Ask 설정은 유지합니다. 질문 답변은 실험적 기능이며 검증에서 잘못된 관계 설명이 확인됐습니다. 질문 답변의 기본 모델은 4B를 유지하세요. E5 검색은 그대로이며 이 로컬 작업은 노트를 서버로 보내지 않습니다.",
    use: "실험적 2B로 질문 답변",
    selected: "질문 답변에 실험적 2B 선택됨",
    useForIngest: "가져오기·정리 초안에 2B 사용",
    ingestSelected: "가져오기·정리 초안에 2B 선택됨",
  },
  ja: {
    title: "Qwen3.5 2B · 小さいダウンロード",
    lede: "ダウンロード容量の小さい2Bは、要確認として原文引用と共に保存する取り込み・整理の下書きに推奨します。ローカル整理には明示的に選んだ取り込みモデルを使い、リモートAskの設定は維持します。質問の回答は実験的な機能で、検証では誤った関係の説明が見つかりました。質問の回答は既定の4Bを維持してください。E5検索はそのままで、このローカル処理ではノートをサーバーに送信しません。",
    use: "実験的な2Bで質問に回答",
    selected: "質問の回答に実験的な2Bを選択中",
    useForIngest: "取り込み・整理の下書きに2Bを使う",
    ingestSelected: "取り込み・整理の下書きに2Bを選択中",
  },
} satisfies Record<Lang, Partial<(typeof COPY)[Lang]>>;

/** Copy describes pinned artifacts and explicit roles, not performance guarantees. */
export function localModelCopy(
  lang: Lang,
  modelId = BUILTIN_CHAT_MODEL,
): (typeof COPY)[Lang] {
  const base = COPY[lang];
  return modelId === BUILTIN_FAST_CHAT_MODEL
    ? {
        ...base,
        ...FAST_COPY[lang],
        footprint: base.footprint.replace("2.71 GB", "1.27 GB"),
        install: base.install.replace("2.71 GB", "1.27 GB"),
        retry: base.retry.replace("2.71 GB", "1.27 GB"),
      }
    : base;
}
