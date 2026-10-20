/** Native selections are separate from connection metadata and legacy display fields. */
export type RoleId = "ask" | "compilation" | "organization" | "reflect" | "lint" | "study" | "audio" | "agent" | "embedding" | "transcription";
export type RoleUsage = "foreground" | "automatic";
export interface ModelRoleSelection {
  providerId: string;
  modelId: string;
  effort: string;
  selection: "local-default" | "explicit-local" | "preserved-local" | "explicit-external";
  automaticExternalAllowed: boolean;
  legacyUnconfirmed: { providerId: string; modelId: string; effort: string } | null;
}
export interface ModelRoleSettings { version: 2; roles: Record<RoleId, ModelRoleSelection> }
export interface RoleRouteSignature {
  role: RoleId;
  providerId: string;
  modelId: string;
  effort: string;
  executionLocation: "in-process" | "loopback" | "remote";
  artifactRevision: string | null;
  artifactSha256: string | null;
  runtimeContract: string;
  signature: string;
}
export interface RoleSnapshot {
  snapshotId: string;
  origin: { vaultPath: string; openingToken: string };
  role: RoleId;
  routeSignature: RoleRouteSignature;
  authorizationRevision: string;
  usage: RoleUsage;
}
export interface RoleSelectionRequest { role: RoleId; providerId: string; modelId: string; effort: string; expectedAuthorizationRevision?: string }
export const SEMANTIC_ROLES: RoleId[] = ["ask", "compilation", "organization", "reflect", "lint", "study", "audio", "agent"];

/** A role map is native-issued by getSettings; legacy provider fields confer no consent. */
export function effectiveRole(settings: { model_roles?: ModelRoleSettings }, role: RoleId): ModelRoleSelection {
  const selected = settings.model_roles?.roles[role];
  if (!selected) throw new Error("native feature selections are unavailable; reload settings");
  return selected;
}

export const ROLE_LABELS = {
  ko: { ask: "질문", compilation: "수확·세션 정리", organization: "요약·정리·지도", reflect: "돌아보기", lint: "위키 점검", study: "학습", audio: "오디오 개요", agent: "에이전트", embedding: "검색 임베딩", transcription: "음성 인식" },
  en: { ask: "Ask", compilation: "Harvest and session compilation", organization: "Summaries and maps", reflect: "Reflect", lint: "Wiki review", study: "Study", audio: "Audio overview", agent: "Agent", embedding: "Search embeddings", transcription: "Transcription" },
  ja: { ask: "質問", compilation: "収穫・セッション整理", organization: "要約・整理・マップ", reflect: "振り返り", lint: "Wiki 点検", study: "学習", audio: "音声概要", agent: "エージェント", embedding: "検索埋め込み", transcription: "音声認識" },
};
export const ROLE_COPY = {
  ko: { policy: "각 기능은 로컬 모델이 기본입니다. 외부 모델은 연결 후 여기서 직접 선택해야 실행됩니다. 모델 파일이 없으면 준비를 기다리며 외부로 전환하지 않습니다.", automatic: "이 역할의 자동 작업에도 외부 모델 사용 허용", legacy: "이전 선택 보존 · 현재 실행에는 사용하지 않음", local: "로컬", external: "직접 선택한 외부 모델" },
  en: { policy: "Each feature defaults to a local model. External models run only after connection and an explicit choice here. Missing local weights wait for preparation without cloud fallback.", automatic: "Allow this external model for automatic work in this role", legacy: "Previous selection retained; not used for execution", local: "Local", external: "Explicit external selection" },
  ja: { policy: "各機能はローカルモデルが既定です。外部モデルは接続後、ここで明示的に選択した場合のみ実行します。モデル未準備時に外部へ切り替えません。", automatic: "この役割の自動処理にも外部モデルを許可", legacy: "以前の選択を保存・現在の実行には不使用", local: "ローカル", external: "明示的に選択した外部モデル" },
};
