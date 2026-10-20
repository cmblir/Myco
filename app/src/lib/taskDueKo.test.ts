import { describe, expect, it } from "vitest";
import { formatDue, parseKoDue } from "./taskDueKo";

// Saturday 2026-10-03, 10:00 local.
const NOW = new Date(2026, 9, 3, 10, 0);

describe("parseKoDue", () => {
  it("reads 내일 오후 3시 and takes it out of the title", () => {
    expect(parseKoDue("치과 예약 내일 오후 3시", NOW)).toEqual({
      due: "2026-10-04T15:00",
      title: "치과 예약",
    });
  });

  it("rolls 내일 over the end of the month", () => {
    expect(parseKoDue("보고 내일 오후 3시", new Date(2026, 9, 31, 9))).toEqual({
      due: "2026-11-01T15:00",
      title: "보고",
    });
    expect(parseKoDue("마감 내일", new Date(2026, 11, 31))?.due).toBe(
      "2027-01-01",
    );
  });

  it("reads 오늘, 모레 and a day with a particle", () => {
    expect(parseKoDue("오늘 장보기", NOW)).toEqual({
      due: "2026-10-03",
      title: "장보기",
    });
    expect(parseKoDue("모레까지 보고서 제출", NOW)).toEqual({
      due: "2026-10-05",
      title: "보고서 제출",
    });
  });

  it("reads 다음 주 월요일 as Monday of next week", () => {
    expect(parseKoDue("다음 주 월요일 회의", NOW)?.due).toBe("2026-10-05");
    expect(parseKoDue("다음주 금요일 회의", NOW)?.due).toBe("2026-10-09");
    // From a Monday, next week's Monday is seven days on.
    expect(parseKoDue("다음 주 월요일", new Date(2026, 9, 5))?.due).toBe(
      "2026-10-12",
    );
  });

  it("reads a bare weekday as that day of this week, Monday to Sunday", () => {
    // Saturday: Tuesday has passed and still means this week's Tuesday.
    expect(parseKoDue("화요일 운동", NOW)?.due).toBe("2026-09-29");
    expect(parseKoDue("토요일 운동", NOW)?.due).toBe("2026-10-03");
    expect(parseKoDue("일요일 운동", NOW)?.due).toBe("2026-10-04");
    // From a Sunday, 월요일 is six days back, not tomorrow.
    expect(parseKoDue("월요일", new Date(2026, 9, 4))?.due).toBe("2026-09-28");
  });

  it("reads a time with no 오전/오후: 7-11 morning, 12 noon, 1-6 afternoon", () => {
    expect(parseKoDue("내일 9시 회의", NOW)?.due).toBe("2026-10-04T09:00");
    expect(parseKoDue("내일 7시", NOW)?.due).toBe("2026-10-04T07:00");
    expect(parseKoDue("내일 11시 반", NOW)?.due).toBe("2026-10-04T11:30");
    expect(parseKoDue("내일 12시", NOW)?.due).toBe("2026-10-04T12:00");
    expect(parseKoDue("내일 1시", NOW)?.due).toBe("2026-10-04T13:00");
    expect(parseKoDue("6시 저녁 약속", NOW)).toEqual({
      due: "2026-10-03T18:00",
      title: "저녁 약속",
    });
  });

  it("reads a 24-hour hour, 13-23시, as written", () => {
    expect(parseKoDue("내일 14시 회의", NOW)).toEqual({
      due: "2026-10-04T14:00",
      title: "회의",
    });
    expect(parseKoDue("내일 18시 30분", NOW)?.due).toBe("2026-10-04T18:30");
    expect(parseKoDue("금요일 18시 마감", NOW)?.due).toBe("2026-10-02T18:00");
    expect(parseKoDue("모레 13시 30분 발표", NOW)?.due).toBe(
      "2026-10-05T13:30",
    );
    expect(parseKoDue("13시 회의", NOW)?.due).toBe("2026-10-03T13:00");
  });

  it("keeps the day when the hour beside it is not on a clock", () => {
    expect(parseKoDue("내일 24시 편의점", NOW)).toEqual({
      due: "2026-10-04",
      title: "24시 편의점",
    });
    expect(parseKoDue("내일 오후 13시", NOW)).toEqual({
      due: "2026-10-04",
      title: "오후 13시",
    });
  });

  it("reads 반, 분, 오전 12시 and 오후 12시", () => {
    expect(parseKoDue("내일 오전 9시 반 출발", NOW)?.due).toBe(
      "2026-10-04T09:30",
    );
    expect(parseKoDue("내일 오후 2시 15분 통화", NOW)?.due).toBe(
      "2026-10-04T14:15",
    );
    expect(parseKoDue("내일 오전 12시", NOW)?.due).toBe("2026-10-04T00:00");
    expect(parseKoDue("내일 오후 12시", NOW)?.due).toBe("2026-10-04T12:00");
  });

  it("puts a time with no day on today", () => {
    expect(parseKoDue("오후 6시 저녁 약속", NOW)).toEqual({
      due: "2026-10-03T18:00",
      title: "저녁 약속",
    });
  });

  it("leaves a sentence with no date alone", () => {
    expect(parseKoDue("보고서 정리하기", NOW)).toBeNull();
    expect(parseKoDue("", NOW)).toBeNull();
  });

  it("does not read numbers that are not a date", () => {
    expect(parseKoDue("오후 3시간 공부", NOW)).toBeNull();
    expect(parseKoDue("3시간 회의", NOW)).toBeNull();
    expect(parseKoDue("오늘날의 문제", NOW)).toBeNull();
    expect(parseKoDue("오후 13시", NOW)).toBeNull();
    // The day still reads when the time beside it is not a time.
    expect(parseKoDue("내일 오후 3시간 공부", NOW)).toEqual({
      due: "2026-10-04",
      title: "오후 3시간 공부",
    });
  });
});

describe("formatDue", () => {
  it("formats a date and a timed due in the app's language", () => {
    expect(formatDue("2026-10-04", "ko")).toBe(
      new Intl.DateTimeFormat("ko", {
        month: "short",
        day: "numeric",
        weekday: "short",
      }).format(new Date(2026, 9, 4)),
    );
    expect(formatDue("2026-10-04T15:00", "ko")).toContain("오후 3:00");
  });

  it("returns anything unreadable as written", () => {
    expect(formatDue("someday", "en")).toBe("someday");
  });
});
