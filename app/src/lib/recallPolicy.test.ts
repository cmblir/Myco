import { describe, expect, it } from "vitest";
import {
  isMemoryQuestion,
  isActivityOverviewQuery,
  isPersonalActivityQuery,
  recallPolicy,
  RECALL_TIER_WEIGHTS,
} from "./recallPolicy";
import { DEFAULT_TIER_WEIGHTS } from "./extractive";
import { parseTimeQuery } from "./timeQuery";

describe("topic-free activity overview", () => {
  it.each(["내가 최근 한달동안 한 일에 대해서 알려줘", "최근 한 달 동안 한 일", "최근 일주일동안 한일", "어제한 일", "오늘 뭐했지?", "어제 내가 한 일이 뭐야?", "내가 어제 한 일들에 대해서 알려줘", "어제 내가 한 일을 알려줘", "어제 한 일들에 대해 정리해줘", "What did I do yesterday?", "what have we done this week?"])(
    "can directly browse dated evidence for %s", (question) => {
      expect(isActivityOverviewQuery(parseTimeQuery(question, new Date(2026, 9, 4, 12), /[가-힣]/.test(question) ? "ko" : "en").cleaned)).toBe(true);
    },
  );
  it.each(["내가 최근 한달동안 한 일 중 RAG 관련만 보여줘", "최근 한 달 동안 한 일을 임베딩 위주로 알려줘", '"최근 한달동안 한 일"이라는 문자열을 검색해줘', "최근 한달동안 수정한 파일", "최근 한달동안 git commit history", "최근 일주일동안 한일 중 RAG 관련만 보여줘", "어제 한 일 중 RAG 관련만 보여줘", "어제 내가 한 일들에 대해서 RAG 관련만 알려줘", "어제 내가 한 일을 임베딩 위주로 알려줘", "What did I do yesterday about embeddings?", '"어제한 일"이라는 문자열을 검색해줘'])(
    "keeps retrieval subjects intact for %s", (question) => {
      expect(isActivityOverviewQuery(parseTimeQuery(question, new Date(2026, 9, 4, 12), /[가-힣]/.test(question) ? "ko" : "en").cleaned)).toBe(false);
    },
  );
});

describe("personal recall routing", () => {
  it.each(["2026-10-03 한 일", "10월 한 일"])(
    "opens original evidence for a caller-confirmed dated overview: %s", (question) => {
      expect(recallPolicy(question, "wiki", DEFAULT_TIER_WEIGHTS).scope).toBe("wiki");
      expect(recallPolicy(question, "wiki", DEFAULT_TIER_WEIGHTS, undefined, true)).toEqual({
        scope: "all",
        tierWeights: RECALL_TIER_WEIGHTS,
      });
    },
  );

  it.each(["wiki", "sessions"] as const)(
    "keeps an explicit %s scope for a dated overview", (scope) => {
      expect(recallPolicy("2026-10-03 한 일", "wiki", DEFAULT_TIER_WEIGHTS, scope, true).scope)
        .toBe(scope);
    },
  );

  it("preserves custom weights when a dated overview opens the default wiki scope", () => {
    const custom = { ...DEFAULT_TIER_WEIGHTS, session: 0.75 };
    expect(recallPolicy("2026-10-03 한 일", "wiki", custom, undefined, true)).toEqual({
      scope: "all",
      tierWeights: custom,
    });
  });

  it.each([
    "어제한 일",
    "어제 한 일",
    "그저께했던작업",
    "오늘 뭐했지",
    "어제 내가 한 일",
    "이번 주에 한 일",
    "최근 일주일동안 한일",
    "내가 최근 한달동안 한 일에 대해서 알려줘",
    "최근 한 달 동안 한 일",
    "지난 1 개월간 한 일",
    "what did I do yesterday",
    "what have we done this week?",
  ])("recognizes open-ended personal activity without requiring a subject: %s", (q) => {
    expect(isMemoryQuestion(q)).toBe(true);
    expect(recallPolicy(q, "wiki", DEFAULT_TIER_WEIGHTS)).toEqual({
      scope: "all",
      tierWeights: RECALL_TIER_WEIGHTS,
    });
    expect(recallPolicy(q, "wiki", DEFAULT_TIER_WEIGHTS, "wiki").scope).toBe("wiki");
    expect(isPersonalActivityQuery(q)).toBe(true);
  });

  it.each([
    "어제 수정한 파일",
    "오늘 추가된 노트",
    "what files did I add yesterday",
    "git commit history",
    "최근 트랜스포머 연구 동향",
    "오늘 할 일",
    "어제 회의에서 캐시 정책을 왜 바꾸기로 결정했지?",
    '"어제한 일"이라는 문자열을 검색해줘',
    '"최근 한달동안 한 일"이라는 문자열을 검색해줘',
    "최근 한달동안 수정한 파일",
    "최근 한달동안 git commit history",
  ])("does not turn explicit metadata, plans or specific topics into open-ended activity: %s", (q) => {
    expect(isPersonalActivityQuery(q)).toBe(false);
  });

  it.each(["어제 수정한 파일", "오늘 추가된 노트", "what files did I add yesterday"])(
    "keeps explicit file questions out of personal memory: %s", (q) => {
      expect(isMemoryQuestion(q)).toBe(false);
      expect(recallPolicy(q, "wiki", DEFAULT_TIER_WEIGHTS).scope).toBe("wiki");
    },
  );

  it.each([
    "이전에 임베딩 모델을 왜 바꾸기로 결정했지?",
    "현재 배포 정책은 뭐야?",
    "내가 최근에 한 일이 뭐야?",
    "What did we decide about caching?",
    "What did we decide about Git caching?",
    "current status of the rollout",
    "前回の会話で決定した設定は？",
  ])("opens original evidence for %s", (q) => {
    expect(isMemoryQuestion(q)).toBe(true);
    expect(recallPolicy(q, "wiki", DEFAULT_TIER_WEIGHTS)).toEqual({
      scope: "all",
      tierWeights: RECALL_TIER_WEIGHTS,
    });
  });

  it.each([
    "최근 트랜스포머 연구 동향",
    "what is attention?",
    "git commit history",
    "노트 변경 내역",
  ])("keeps normal knowledge or metadata scope for %s", (q) => {
    expect(isMemoryQuestion(q)).toBe(false);
    expect(recallPolicy(q, "wiki", DEFAULT_TIER_WEIGHTS).scope).toBe("wiki");
  });

  it("honors an explicit wiki scope and custom weights", () => {
    expect(
      recallPolicy("What did we decide?", "wiki", DEFAULT_TIER_WEIGHTS, "wiki")
        .scope,
    ).toBe("wiki");
    const custom = { ...DEFAULT_TIER_WEIGHTS, session: 0.75 };
    expect(
      recallPolicy("What did we decide?", "wiki", custom).tierWeights,
    ).toEqual(custom);
    expect(
      recallPolicy("zzqq", "sessions", DEFAULT_TIER_WEIGHTS).tierWeights,
    ).toEqual(RECALL_TIER_WEIGHTS);
  });
});
