import {createElement as h} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,it,expect} from "vitest";
import AskEvidenceCoverage from "./AskEvidenceCoverage";
import {STRINGS} from "../lib/i18n";

describe("passage coverage notice",()=>{
 it.each(["en","ko","ja"] as const)("shows observed historical exclusion reasons without invented search totals in %s",lang=>{
  const t=STRINGS[lang];const html=renderToStaticMarkup(h(AskEvidenceCoverage,{t,lang,context:{version:1,historical:{asOf:"2026-10-08",afterCutoff:2,dateUnverified:3}}}));
  expect(html).toContain(t.q_historical_exclusions.replace("{date}","2026-10-08").replace("{after}","2").replace("{undated}","3"));
  expect(html).toContain('ask-historical-exclusions');expect(html).not.toContain('ask-activity-coverage');
 });
 it.each(["en","ko","ja"] as const)("shows partial evidence despite one scanned/cited page in %s",lang=>{
  const t=STRINGS[lang];const html=renderToStaticMarkup(h(AskEvidenceCoverage,{t,lang,context:{version:1,
   packing:{selectedPassages:1,omittedPassages:1,omittedOnIncludedPages:1},activityCoverage:{scannedPages:1,sources:1,incomplete:false}}}));
  expect(html).toContain(t.q_context_packing_limited.replace("{selected}","1").replace("{omitted}","1"));
  expect(html).toContain(t.q_context_packing_same_page.replace("{n}","1"));
  expect(html).toContain(t.q_activity_limited);expect(html).toContain('role="status"');
 });
 it("does not label unknown or zero-omission evidence as incomplete",()=>{
  const props={t:STRINGS.ko,lang:"ko" as const};
  expect(renderToStaticMarkup(h(AskEvidenceCoverage,props))).toBe("");
  expect(renderToStaticMarkup(h(AskEvidenceCoverage,{...props,context:{version:1,packing:{selectedPassages:1,omittedPassages:0,omittedOnIncludedPages:0}}}))).toBe("");
 });
});
