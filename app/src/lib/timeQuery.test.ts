import { describe, expect, it } from "vitest";
import { parseTimeQuery, queryDateRange } from "./timeQuery";

// Fixed clock: Saturday 2026-08-22 (local). ISO week = Mon 08-17 .. Sun 08-23.
const now = new Date(2026, 7, 22);

describe("queryDateRange", () => {
  it("keeps display days and uses the user's local midnight boundaries", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Asia/Seoul";
    try {
      expect(queryDateRange({ start: "2026-08-22", end: "2026-08-22" })).toEqual({
        start: "2026-08-22", end: "2026-08-22",
        startEpoch: Date.parse("2026-08-22T00:00:00+09:00") / 1000,
        endEpoch: Date.parse("2026-08-23T00:00:00+09:00") / 1000,
      });
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
  it("constructs calendar boundaries across 23-hour and 25-hour DST days", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      for (const [day, hours] of [["2026-03-08", 23], ["2026-11-01", 25]] as const) {
        const range = queryDateRange({ start: day, end: day });
        expect(range.endEpoch - range.startEpoch).toBe(hours * 3600);
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
  it("rejects malformed, impossible and reversed date ranges", () => {
    for (const range of [
      { start: "2026-8-22", end: "2026-08-22" },
      { start: "2026-02-31", end: "2026-03-01" },
      { start: "2026-08-23", end: "2026-08-22" },
      { start: "2026-08-22", end: "2026-08-32" },
    ]) expect(() => queryDateRange(range)).toThrow("invalid query date range");
  });
});

describe("parseTimeQuery — ko", () => {
  it("parses the reported recent-month work question without removing its subject", () => {
    expect(parseTimeQuery("내가 최근 한달동안 한 일에 대해서 알려줘", now, "ko")).toEqual({
      range: { start: "2026-07-22", end: "2026-08-22" },
      cleaned: "내가 한 일에 대해서 알려줘",
    });
  });
  it.each(["최근 한 달 동안 한 일", "지난 한달간 한 일", "최근 1달 동안 한 일", "지난 1 개월간에 한 일"])(
    "uses a rolling calendar month through today for %s", (question) => {
      expect(parseTimeQuery(question, now, "ko")).toEqual({
        range: { start: "2026-07-22", end: "2026-08-22" }, cleaned: "한 일",
      });
    },
  );
  it.each([
    [new Date(2026, 2, 31, 23, 59), "2026-02-28", "2026-03-31"],
    [new Date(2024, 2, 31), "2024-02-29", "2024-03-31"],
    [new Date(2026, 0, 31), "2025-12-31", "2026-01-31"],
  ])("clamps the rolling month to the previous month's last valid date at %s", (clock, start, end) => {
    expect(parseTimeQuery("최근 한달동안 한 일", clock, "ko").range).toEqual({ start, end });
  });
  it.each(['"최근 한달동안"', "`최근 한달동안`"])(
    "keeps %s literal while finding a later rolling-month anchor", (literal) => {
      const question = `${literal}이라는 문자열을 검색해줘`;
      expect(parseTimeQuery(question, now, "ko")).toEqual({ range: null, cleaned: question });
      expect(parseTimeQuery(`${literal} 최근 한달동안 한 일`, now, "ko")).toEqual({
        range: { start: "2026-07-22", end: "2026-08-22" }, cleaned: `${literal} 한 일`,
      });
    },
  );
  it.each(["최근 일주일동안 한일", "최근 일주일 동안 한 일", "지난 7일간 한 일"])(
    "uses seven local calendar days including today for %s", (question) => {
      expect(parseTimeQuery(question, now, "ko")).toEqual({
        range: { start: "2026-08-16", end: "2026-08-22" },
        cleaned: question.endsWith("한일") ? "한일" : "한 일",
      });
    },
  );
  it("keeps a quoted recent-week phrase as a literal and handles a rolling year boundary", () => {
    const literal = '"최근 일주일"이라는 문자열을 검색해줘';
    expect(parseTimeQuery(literal, now, "ko")).toEqual({ range: null, cleaned: literal });
    expect(parseTimeQuery("최근 일주일동안 한일", new Date(2026, 0, 2), "ko").range).toEqual({
      start: "2025-12-27", end: "2026-01-02",
    });
  });
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
  it("keeps date-shaped IDs and filenames as literal retrieval terms", () => {
    for (const q of ["SYN-2026-08-05 원문", "wiki/2026-08-05.md", "`2026-08-05` exact", '"2026-08-05" phrase']) {
      expect(parseTimeQuery(q, now, "ko")).toEqual({ range: null, cleaned: q });
    }
  });
  it("finds the later date anchor after a quoted date or date-shaped filename", () => {
    for (const literal of ['"2026-08-05"', "`2026-08-05`", "wiki/2026-08-05.md", "SYN-2026-08-05"]) {
      expect(parseTimeQuery(`${literal} on 2026-08-21`, now, "en")).toEqual({
        range: { start: "2026-08-21", end: "2026-08-21" },
        cleaned: `${literal} on`,
      });
    }
  });
  it("continues after an invalid date without removing the invalid literal", () => {
    expect(parseTimeQuery("2026-02-31 on 2026-08-21", now, "en")).toEqual({
      range: { start: "2026-08-21", end: "2026-08-21" },
      cleaned: "2026-02-31 on",
    });
  });
  it("finds the later relative anchor after the same word in a quoted literal", () => {
    expect(parseTimeQuery('"today" notes today', now, "en")).toEqual({
      range: { start: "2026-08-22", end: "2026-08-22" },
      cleaned: '"today" notes',
    });
  });
  it("supports an inclusive explicit history interval", () => {
    expect(parseTimeQuery("2026-07-01부터 2026-08-05까지 결정 이력", now, "ko")).toEqual({
      range: { start: "2026-07-01", end: "2026-08-05" }, cleaned: "결정 이력",
    });
    expect(parseTimeQuery("decisions from 2026-07-01 to 2026-08-05", now, "en").range).toEqual({
      start: "2026-07-01", end: "2026-08-05",
    });
  });
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
