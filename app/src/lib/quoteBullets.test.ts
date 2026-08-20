import { describe, expect, it } from "vitest";
import {
  cosine,
  dropNearDuplicates,
  NEAR_DUP_COSINE,
  renderQuoteBullets,
  stripFiller,
  trimToSentence,
} from "./quoteBullets";

describe("trimToSentence", () => {
  it("returns text that already fits, untouched and unmarked", () => {
    expect(trimToSentence("short enough.", 40)).toBe("short enough.");
    expect(trimToSentence("정확히 한계까지", 8)).toBe("정확히 한계까지");
  });

  it("cuts an English quote at the sentence end instead of mid-word", () => {
    const text =
      "Bound the marker to content fingerprints. Archive retries only the file move, never the paid call.";
    expect(trimToSentence(text, 60)).toBe("Bound the marker to content fingerprints. …");
  });

  it("cuts a Korean quote at 다. instead of mid-syllable", () => {
    const text =
      "다이제스트 마커를 내용 지문에 묶었습니다. 이어서 진행한 대화는 예전 기록과 일치하지 않으므로 다시 요약됩니다.";
    expect(trimToSentence(text, 40)).toBe("다이제스트 마커를 내용 지문에 묶었습니다. …");
  });

  it("treats a full-width terminator and a period followed straight by Hangul as boundaries", () => {
    // CJK puts no space after the terminator, so requiring whitespace would
    // miss both of these and fall through to a mid-syllable cut.
    expect(trimToSentence("인덱스를 다시 만들었습니다。다음 단계는 재구축입니다。", 20)).toBe(
      "인덱스를 다시 만들었습니다。 …",
    );
    expect(trimToSentence("인덱스를 다시 만들었습니다.다음 단계는 재구축입니다.", 20)).toBe(
      "인덱스를 다시 만들었습니다. …",
    );
  });

  it("cuts at 까? as well as at a period", () => {
    const text = "이 경로를 고칠 수 있을까? 아카이브 재시도가 무한히 반복되고 있습니다.";
    expect(trimToSentence(text, 24)).toBe("이 경로를 고칠 수 있을까? …");
  });

  it("does not mistake a version number or an ellipsis-free tail for a boundary", () => {
    const text = "Upgraded tauri to v2.11.1 and rebuilt the whole app bundle for the release";
    // The dots in 2.11.1 are followed by digits, so the only cut left is hard.
    expect(trimToSentence(text, 30)).toBe("Upgraded tauri to v2.11.1 and…");
  });

  it("ignores a boundary in the first half of the budget rather than throw the quote away", () => {
    const text = "Ok. Then decided to bind the marker to the content fingerprint of each file.";
    const out = trimToSentence(text, 40);
    // The only boundary in the budget is "Ok." at char 2, well under the
    // half-budget floor — a hard cut keeps 40 chars instead of 3.
    expect(out.startsWith("Ok. Then decided to bind the marker")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toBe("Ok. …");
  });
});

describe("stripFiller", () => {
  it("drops a leading English acknowledgment", () => {
    expect(stripFiller("Sure, the retry loop now re-checks each file.")).toBe(
      "the retry loop now re-checks each file.",
    );
  });

  it("drops two stacked acknowledgments but no more", () => {
    expect(stripFiller("Okay. Got it. Decided to archive after the write.")).toBe(
      "Decided to archive after the write.",
    );
  });

  it("drops a leading Korean acknowledgment", () => {
    expect(stripFiller("알겠습니다. 마커를 내용 지문에 묶었습니다.")).toBe(
      "마커를 내용 지문에 묶었습니다.",
    );
    expect(stripFiller("네, 인덱스를 다시 만들었습니다.")).toBe("인덱스를 다시 만들었습니다.");
  });

  it("returns empty for a turn that is nothing but filler", () => {
    // The caller's MIN_UNIT_CHARS filter is what then drops the candidate.
    expect(stripFiller("네, 감사합니다!")).toBe("");
  });

  it("leaves content that merely starts with a filler-looking word", () => {
    expect(stripFiller("Right-click the node to open its page")).toBe(
      "Right-click the node to open its page",
    );
    expect(stripFiller("예상 결과는 인덱스가 줄어드는 것입니다.")).toBe(
      "예상 결과는 인덱스가 줄어드는 것입니다.",
    );
    expect(stripFiller("okay was never the problem here")).toBe("okay was never the problem here");
  });
});

describe("dropNearDuplicates", () => {
  it("keeps the higher-ranked of two near-identical vectors", () => {
    const vectors = [
      [1, 0],
      [1, 0.01],
      [0, 1],
    ];
    expect(cosine(vectors[0], vectors[1])).toBeGreaterThan(NEAR_DUP_COSINE);
    expect(dropNearDuplicates([0, 1, 2], vectors)).toEqual([0, 2]);
  });

  it("keeps a merely similar vector — the threshold is a duplicate test, not a topic test", () => {
    const vectors = [
      [1, 0],
      [1, 1],
    ];
    // cos ≈ 0.707: where two distinct decisions from the same task actually
    // land with bge-m3 (0.6794 measured), so this pair must survive.
    expect(cosine(vectors[0], vectors[1])).toBeLessThan(NEAR_DUP_COSINE);
    expect(dropNearDuplicates([0, 1], vectors)).toEqual([0, 1]);
  });

  it("compares against every kept pick, not just the previous one", () => {
    const vectors = [
      [1, 0],
      [0, 1],
      [1, 0.02],
    ];
    expect(dropNearDuplicates([0, 1, 2], vectors)).toEqual([0, 1]);
  });

  it("preserves rank order and passes an empty list through", () => {
    expect(dropNearDuplicates([2, 0], [[1, 0], [0, 1], [0, 0.5]])).toEqual([2, 0]);
    expect(dropNearDuplicates([], [])).toEqual([]);
  });
});

describe("renderQuoteBullets", () => {
  const units = [
    { text: "bound the marker to content fingerprints", label: "claude-code-abc" },
    { text: "the reindex now prunes the cold tier", label: "codex-def" },
    { text: "archive retries only the file move", label: "claude-code-abc" },
  ];

  it("names each source once and puts its quotes underneath", () => {
    expect(renderQuoteBullets(units, [0, 1, 2], 200)).toBe(
      [
        "**claude-code-abc**",
        '- "bound the marker to content fingerprints"',
        '- "archive retries only the file move"',
        "",
        "**codex-def**",
        '- "the reindex now prunes the cold tier"',
      ].join("\n"),
    );
  });

  it("orders groups by their best-ranked quote", () => {
    const out = renderQuoteBullets(units, [1, 2], 200);
    expect(out.indexOf("codex-def")).toBeLessThan(out.indexOf("claude-code-abc"));
  });

  it("trims each quote at a sentence boundary", () => {
    const long = [
      {
        text: "마커를 내용 지문에 묶었습니다. 이어서 진행한 대화는 예전 기록과 일치하지 않습니다.",
        label: "2026-08-10",
      },
    ];
    expect(renderQuoteBullets(long, [0], 30)).toBe(
      '**2026-08-10**\n- "마커를 내용 지문에 묶었습니다. …"',
    );
  });

  it("renders nothing for an empty selection", () => {
    expect(renderQuoteBullets(units, [], 200)).toBe("");
  });
});
