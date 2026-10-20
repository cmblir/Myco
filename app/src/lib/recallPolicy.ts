import type { AskScope, TierWeights } from "./ipc";
import { DEFAULT_TIER_WEIGHTS } from "./extractive";
import { isVaultFilesQuery } from "./queryIntent";

const PERSONAL_ACTIVITY_QUESTIONS = [
  /^\s*(?:(?:내가|우리가|나는|우리)\s*)?(?:오늘|어제|그저께|(?:최근|지난)\s*(?:일\s*주일|1\s*주일|7\s*일|한\s*달|1\s*(?:달|개월))\s*(?:동안|간)?|최근|요즘|방금|(?:이번|지난|저번)\s*(?:주|달))(?:에는|엔|에|는)?\s*(?:(?:내가|우리가|나는|우리)\s*)?(?:한\s*일|했던\s*작업|뭐\s*했|무엇을?\s*했|(?:어떤|무슨)\s*작업(?:을)?\s*했)/,
  /^\s*what\s+(?:did|have|had)\s+(?:i|we)\s+(?:do|done|been\s+(?:doing|working\s+on)|work(?:ed)?\s+on)\b[^\n]{0,40}\b(?:today|yesterday|recently|(?:this|last)\s+(?:week|month))\b/i,
];

/** Personal work recall, including an omitted Korean subject and topic qualifiers.
 * Explicit file or git activity belongs to metadata, not personal history. */
export function isPersonalActivityQuery(question: string): boolean {
  return !isVaultFilesQuery(question) &&
    PERSONAL_ACTIVITY_QUESTIONS.some((pattern) => pattern.test(question));
}

/** Topic-free activity after timeQuery removed the explicit date phrase.
 * Anchoring prevents an overview from discarding a requested subject filter. */
export function isActivityOverviewQuery(cleanedQuestion: string): boolean {
  const question = cleanedQuestion.trim().replace(/[?？!.。]+$/, "").trim();
  return /^(?:(?:내가|우리가|나는|우리)\s*)?(?:한\s*일(?:들)?(?:이\s*뭐야)?|했던\s*작업|뭐\s*했(?:지|어|나요)?|무엇을?\s*했(?:지|어|나요)?|(?:어떤|무슨)\s*작업(?:을)?\s*했(?:지|어|나요)?)(?:(?:을|를)|(?:에\s*대해(?:서)?))?\s*(?:알려줘|보여줘|정리해줘)?$/.test(question) ||
    /^what\s+(?:did|have|had)\s+(?:i|we)\s+(?:do|done|been\s+(?:doing|working\s+on)|work(?:ed)?\s+on)$/i.test(question);
}

const MEMORY_QUESTIONS = [
  /(?:이전|지난|예전|과거|전에|앞서)[^\n]{0,50}(?:결정|합의|대화|세션|통화|문자|메일|이메일|회의|논의|작업)/,
  /(?:내가|우리가|나는|우리)[^\n]{0,45}(?:한\s*일|했던|작업|결정|말했|요청|보냈|받았|논의|약속|합의)/,
  /(?:결정|합의|설정|정책|구현|배포)[^\n]{0,30}(?:이력|내역|기록|언제|왜|바뀌|변경)/,
  /(?:현재|지금|최종|최신)[^\n]{0,40}(?:상태|결정|설정|정책|합의|버전|진행|구현|배포)/,
  /\b(?:what|when|why|how)\b[^\n]{0,50}\b(?:did|have|had)\s+(?:i|we)\b/i,
  /\b(?:previous|earlier|past|our|my)\b[^\n]{0,50}\b(?:decisions?|conversations?|sessions?|meetings?|agreements?|work)\b/i,
  /\b(?:current|final|latest)\s+(?:status|decision|setting|policy|agreement|version)\b/i,
  /(?:前回|以前|過去|私|私たち)[^\n]{0,40}(?:決定|会話|作業|合意|依頼)/,
  /(?:現在|最終|最新)[^\n]{0,30}(?:状況|決定|設定|方針)/,
];

/** Conservative, deterministic routing; no model load or inference call. */
export function isMemoryQuestion(question: string): boolean {
  return (
    !isVaultFilesQuery(question) &&
    (isPersonalActivityQuery(question) || MEMORY_QUESTIONS.some((pattern) => pattern.test(question)))
  );
}

export const RECALL_TIER_WEIGHTS: TierWeights = {
  note: 1,
  map: 1,
  digest: 1,
  rollup: 1,
  session: 1,
  source: 1,
};

/** Personal-history questions can reach original sessions through the default
 * wiki scope. Explicit scope and custom ranking settings remain authoritative. */
export function recallPolicy(
  question: string,
  savedScope: AskScope,
  weights: TierWeights,
  explicitScope?: AskScope,
  isDatedActivityOverview = false,
): { scope: AskScope; tierWeights: TierWeights } {
  const scope =
    explicitScope ??
    (savedScope === "wiki" && (isDatedActivityOverview || isMemoryQuestion(question)) ? "all" : savedScope);
  const isDefault = (
    Object.keys(DEFAULT_TIER_WEIGHTS) as (keyof TierWeights)[]
  ).every((tier) => weights[tier] === DEFAULT_TIER_WEIGHTS[tier]);
  return {
    scope,
    tierWeights: scope !== "wiki" && isDefault ? RECALL_TIER_WEIGHTS : weights,
  };
}
