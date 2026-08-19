// pendingInboxRows feeds the "waiting in _inbox" list on PageIngest — the
// place the inflow "보기 →" lands. Ordering and the today flag are what make
// "+N arrived" findable, so they get pinned here.

import { describe, expect, it } from "vitest";
import { pendingInboxRows } from "./autoIngest";

const NOW = new Date(2026, 7, 19, 14, 0); // local 2026-08-19 14:00
const secs = (d: Date): number => Math.floor(d.getTime() / 1000);

describe("pendingInboxRows", () => {
  it("sorts newest first and flags today's arrivals", () => {
    const today = secs(new Date(2026, 7, 19, 9, 30));
    const yesterday = secs(new Date(2026, 7, 18, 23, 50));
    const rows = pendingInboxRows(
      [
        { name: "old.md", path: "/v/_inbox/old.md" },
        { name: "new.md", path: "/v/_inbox/new.md" },
      ],
      new Map([
        ["/v/_inbox/old.md", yesterday],
        ["/v/_inbox/new.md", today],
      ]),
      NOW,
    );
    expect(rows.map((r) => r.name)).toEqual(["new.md", "old.md"]);
    expect(rows.map((r) => r.today)).toEqual([true, false]);
  });

  it("puts files with no known mtime last, with mtime null and today false", () => {
    const rows = pendingInboxRows(
      [
        { name: "unknown.md", path: "/v/_inbox/unknown.md" },
        { name: "known.md", path: "/v/_inbox/known.md" },
      ],
      new Map([["/v/_inbox/known.md", secs(NOW)]]),
      NOW,
    );
    expect(rows[0].name).toBe("known.md");
    expect(rows[1]).toMatchObject({ name: "unknown.md", mtime: null, today: false });
  });

  it("returns [] for an empty inbox", () => {
    expect(pendingInboxRows([], new Map(), NOW)).toEqual([]);
  });
});
