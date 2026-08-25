import { describe, expect, it } from "vitest";
import {
  composeTitle,
  extractLinks,
  extractTags,
  stripTokens,
} from "./taskTokens";

describe("extractTags", () => {
  it("reads latin and korean tags, deduped, in order", () => {
    expect(extractTags("배포 준비 #dev #배포 #dev")).toEqual(["dev", "배포"]);
  });
  it("stops at punctuation and ignores a bare #", () => {
    expect(extractTags("fix #api. then # rest")).toEqual(["api"]);
  });
});

describe("extractLinks", () => {
  it("reads targets and drops display aliases", () => {
    expect(extractLinks("리뷰 [[myco-q4-roadmap]] [[graph|그래프]]")).toEqual([
      "myco-q4-roadmap",
      "graph",
    ]);
  });
});

describe("stripTokens", () => {
  it("removes tags and links and collapses whitespace", () => {
    expect(stripTokens("리뷰 반영 #dev [[roadmap]] 마무리")).toBe(
      "리뷰 반영 마무리",
    );
  });
});

describe("composeTitle", () => {
  it("appends tags then links", () => {
    expect(composeTitle("배포", ["dev"], ["myco"])).toBe("배포 #dev [[myco]]");
  });
  it("does not double a token already typed inline", () => {
    expect(composeTitle("배포 #dev", ["dev", "infra"], [])).toBe(
      "배포 #dev #infra",
    );
    expect(composeTitle("배포 [[myco]]", [], ["myco"])).toBe("배포 [[myco]]");
  });
  it("skips empty chips", () => {
    expect(composeTitle("배포", [""], [""])).toBe("배포");
  });
});
