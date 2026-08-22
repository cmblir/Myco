import { describe, expect, it } from "vitest";
import { parseTimeQuery } from "./timeQuery";

// Fixed clock: Saturday 2026-08-22 (local). ISO week = Mon 08-17 .. Sun 08-23.
const now = new Date(2026, 7, 22);

describe("parseTimeQuery — ko", () => {
  it("이번 주 → Monday..today, phrase (with particle) removed from cleaned", () => {
    const p = parseTimeQuery("이번 주에 배포 관련 뭐 결정했지", now, "ko");
    expect(p.range).toEqual({ start: "2026-08-17", end: "2026-08-22" });
    expect(p.cleaned).toBe("배포 관련 뭐 결정했지");
  });
  it("지난주 → previous Mon..Sun", () => {
    expect(parseTimeQuery("지난주", now, "ko").range).toEqual({
      start: "2026-08-10",
      end: "2026-08-16",
    });
  });
  it("저번 주 → previous Mon..Sun", () => {
    expect(parseTimeQuery("저번 주 회의록", now, "ko").range).toEqual({
      start: "2026-08-10",
      end: "2026-08-16",
    });
  });
  it("오늘 / 어제 / 그저께 → single days", () => {
    expect(parseTimeQuery("오늘 한 일", now, "ko").range).toEqual({
      start: "2026-08-22",
      end: "2026-08-22",
    });
    expect(parseTimeQuery("어제 회의", now, "ko").range).toEqual({
      start: "2026-08-21",
      end: "2026-08-21",
    });
    expect(parseTimeQuery("그저께 메모", now, "ko").range).toEqual({
      start: "2026-08-20",
      end: "2026-08-20",
    });
  });
  it("이번 달 → month start..today; 지난달 → full previous month", () => {
    expect(parseTimeQuery("이번 달 실험", now, "ko").range).toEqual({
      start: "2026-08-01",
      end: "2026-08-22",
    });
    expect(parseTimeQuery("지난달 실험", now, "ko").range).toEqual({
      start: "2026-07-01",
      end: "2026-07-31",
    });
  });
  it("N월 → that month this year, full span, cleaned drops the phrase", () => {
    const p = parseTimeQuery("8월에 임베딩 실험", now, "ko");
    expect(p.range).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(p.cleaned).toBe("임베딩 실험");
  });
  it("N월 in the future → last year", () => {
    expect(parseTimeQuery("12월 회고", now, "ko").range).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });
  it("올해 → Jan 1..today", () => {
    expect(parseTimeQuery("올해 목표", now, "ko").range).toEqual({
      start: "2026-01-01",
      end: "2026-08-22",
    });
  });
  it("매주 (frequency, not anchor) → null", () => {
    const p = parseTimeQuery("매주 회고", now, "ko");
    expect(p.range).toBeNull();
    expect(p.cleaned).toBe("매주 회고");
  });
  it("주간 → null", () => {
    expect(parseTimeQuery("주간 리포트 정리", now, "ko").range).toBeNull();
  });
  it("이번 주말 is not 이번 주", () => {
    expect(parseTimeQuery("이번 주말 계획", now, "ko").range).toBeNull();
  });
});

describe("parseTimeQuery — en", () => {
  it("this week / last week", () => {
    expect(parseTimeQuery("what shipped this week", now, "en").range).toEqual({
      start: "2026-08-17",
      end: "2026-08-22",
    });
    expect(parseTimeQuery("decisions last week", now, "en").range).toEqual({
      start: "2026-08-10",
      end: "2026-08-16",
    });
  });
  it("today / yesterday", () => {
    expect(parseTimeQuery("today's notes", now, "en").range).toEqual({
      start: "2026-08-22",
      end: "2026-08-22",
    });
    expect(parseTimeQuery("what did I do yesterday", now, "en").range).toEqual({
      start: "2026-08-21",
      end: "2026-08-21",
    });
  });
  it("this month / last month", () => {
    expect(parseTimeQuery("this month experiments", now, "en").range).toEqual({
      start: "2026-08-01",
      end: "2026-08-22",
    });
    expect(parseTimeQuery("last month experiments", now, "en").range).toEqual({
      start: "2026-07-01",
      end: "2026-07-31",
    });
  });
  it("in August / bare month name → full month, cleaned drops the phrase", () => {
    const p = parseTimeQuery("embedding runs in August", now, "en");
    expect(p.range).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(p.cleaned).toBe("embedding runs");
    expect(parseTimeQuery("August retro", now, "en").range).toEqual({
      start: "2026-08-01",
      end: "2026-08-31",
    });
  });
  it("future month name → last year", () => {
    expect(parseTimeQuery("notes from December", now, "en").range).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });
  it("weekly (frequency) and weekend do not anchor", () => {
    expect(parseTimeQuery("weekly retro notes", now, "en").range).toBeNull();
    expect(parseTimeQuery("plans for last weekend", now, "en").range).toBeNull();
  });
  it("bare lowercase 'may' (modal verb) does not anchor; 'in May' does", () => {
    expect(parseTimeQuery("how may I improve recall", now, "en").range).toBeNull();
    expect(parseTimeQuery("experiments in May", now, "en").range).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
    });
  });
});

describe("parseTimeQuery — ja", () => {
  it("今週 / 先週", () => {
    expect(parseTimeQuery("今週の決定", now, "ja").range).toEqual({
      start: "2026-08-17",
      end: "2026-08-22",
    });
    expect(parseTimeQuery("先週のメモ", now, "ja").range).toEqual({
      start: "2026-08-10",
      end: "2026-08-16",
    });
  });
  it("今日 / 昨日", () => {
    expect(parseTimeQuery("今日の作業", now, "ja").range).toEqual({
      start: "2026-08-22",
      end: "2026-08-22",
    });
    expect(parseTimeQuery("昨日の会議", now, "ja").range).toEqual({
      start: "2026-08-21",
      end: "2026-08-21",
    });
  });
  it("今月 / 先月", () => {
    expect(parseTimeQuery("今月の実験", now, "ja").range).toEqual({
      start: "2026-08-01",
      end: "2026-08-22",
    });
    expect(parseTimeQuery("先月の実験", now, "ja").range).toEqual({
      start: "2026-07-01",
      end: "2026-07-31",
    });
  });
  it("N月 → full month; future → last year", () => {
    expect(parseTimeQuery("8月に埋め込み実験", now, "ja").range).toEqual({
      start: "2026-08-01",
      end: "2026-08-31",
    });
    expect(parseTimeQuery("12月の振り返り", now, "ja").range).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });
  it("毎週 (frequency) → null", () => {
    expect(parseTimeQuery("毎週の振り返り", now, "ja").range).toBeNull();
  });
});

describe("parseTimeQuery — explicit dates", () => {
  it("YYYY-MM → full month", () => {
    const p = parseTimeQuery("2026-07 임베딩 실험", now, "ko");
    expect(p.range).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(p.cleaned).toBe("임베딩 실험");
  });
  it("YYYY-MM-DD → single day", () => {
    expect(parseTimeQuery("what happened on 2026-08-05", now, "en").range).toEqual({
      start: "2026-08-05",
      end: "2026-08-05",
    });
  });
  it("explicit date beats relative words", () => {
    expect(parseTimeQuery("지난주 말고 2026-07-01 기록", now, "ko").range).toEqual({
      start: "2026-07-01",
      end: "2026-07-01",
    });
  });
  it("invalid explicit dates are ignored", () => {
    expect(parseTimeQuery("build 2026-13 log", now, "en").range).toBeNull();
    expect(parseTimeQuery("id 2026-02-31 dump", now, "en").range).toBeNull();
  });
});

describe("parseTimeQuery — no time phrase", () => {
  it("returns null range and the question untouched", () => {
    const q = "임베딩  정확도를 올리려면?";
    const p = parseTimeQuery(q, now, "ko");
    expect(p.range).toBeNull();
    expect(p.cleaned).toBe(q);
  });
  it("week boundary sanity: Monday 'this week' is a single day", () => {
    const mon = new Date(2026, 7, 17);
    expect(parseTimeQuery("this week", mon, "en").range).toEqual({
      start: "2026-08-17",
      end: "2026-08-17",
    });
  });
  it("year wrap: 지난달 in January is December of last year", () => {
    expect(parseTimeQuery("지난달 로그", new Date(2026, 0, 5), "ko").range).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });
});
