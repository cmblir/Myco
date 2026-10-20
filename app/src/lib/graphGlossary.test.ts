import { describe, expect, it } from "vitest";
import { GRAPH_LOOK_COPY } from "./graphLookCopy";
import { STRINGS } from "./i18n";

// The graph page calls a note one thing in Korean: 노트. 노드 (the graph term)
// and 메모 (the sidebar's old word) sat on the same screen as 노트 for the
// same object.
const OTHER_WORDS = /노드|메모(?!리)/;

describe("graph page Korean glossary", () => {
  it("says 노트 in every gr_* string and every look caption", () => {
    const ko: [string, string][] = [
      ...Object.entries(STRINGS.ko).filter(([k]) => k.startsWith("gr_")),
      ...Object.entries(GRAPH_LOOK_COPY.ko).map(([k, v]): [string, string] => [`look.${k}`, v]),
    ];
    const offenders = ko.filter(([, v]) => OTHER_WORDS.test(v)).map(([k, v]) => `${k}: ${v}`);
    expect(offenders).toEqual([]);
  });
});

// UX S14: 갭 and 홉 are graph-theory words. The rail is where links are
// missing, and the neighbours encoding is "closer is brighter".
describe("graph words a user does not need to learn", () => {
  it("never says 갭 or 홉 in Korean", () => {
    const offenders = Object.entries(STRINGS.ko)
      .filter(([, v]) => /갭|홉/.test(String(v)))
      .map(([k, v]) => `${k}: ${v}`);
    expect(offenders).toEqual([]);
  });

  it("names the gaps rail 연결이 빠진 곳 and the neighbours key 가까울수록 밝게", () => {
    expect(STRINGS.ko.gr_gaps_title).toBe("연결이 빠진 곳");
    expect(STRINGS.ko.gr_enc_neighbors.startsWith("가까울수록 밝게")).toBe(true);
    expect(STRINGS.en.gr_enc_neighbors).not.toMatch(/hop/i);
    expect(STRINGS.ja.gr_enc_neighbors).not.toMatch(/ホップ/);
  });
});

describe("graph look descriptions in Korean", () => {
  it("all speak one register: a 해요체 sentence", () => {
    const ko = STRINGS.ko as unknown as Record<string, string>;
    const look = GRAPH_LOOK_COPY.ko;
    const descs: [string, string][] = [
      ...Object.keys(ko).filter((k) => /^gr_vibe_.*_desc$/.test(k)).map((k): [string, string] => [k, ko[k]]),
      ...(["galaxyHint", "ribbonHint", "terrainHint", "cityHint"] as const).map(
        (k): [string, string] => [`look.${k}`, look[k]],
      ),
    ];
    expect(descs.length).toBeGreaterThan(12);
    const offenders = descs.filter(([, v]) => !/요[.)]?$/.test(v)).map(([k, v]) => `${k}: ${v}`);
    expect(offenders).toEqual([]);
  });
});
