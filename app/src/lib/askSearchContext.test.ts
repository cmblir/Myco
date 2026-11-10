import {describe,it,expect} from "vitest";
import {packingCoverageOf,readAskSearchContext} from "./askSearchContext";
import type {ContextPackingAudit} from "./modelContextBudget";

const passage=(section:number)=>({page:"sessions/work.md",stem:"work",section,text:"Synthetic original passage",score:0,similarity:null});
describe("saved search context",()=>{
 it("keeps historical exclusion counts separate from whole retrieval totals",()=>{
  const source={version:1,historical:{asOf:"2026-10-08",afterCutoff:2,dateUnverified:3},packing:{selectedPassages:4,omittedPassages:7,omittedOnIncludedPages:1}};
  const saved=readAskSearchContext(source)!;source.historical.afterCutoff=99;
  expect(saved.historical).toEqual({asOf:"2026-10-08",afterCutoff:2,dateUnverified:3});
  expect(readAskSearchContext({...source,historical:{asOf:"2026-10-08",afterCutoff:-1,dateUnverified:0}})?.packing).toEqual(saved.packing);
 });
 it("keeps a selected historical task independent of a source-date window and clones it",()=>{
  const source={version:1,guidedQuestion:{version:1,intent:"remaining",subject:"Synthetic observatory",asOf:"2026-10-15"},
   paths:["sessions/observatory.md"],packing:{selectedPassages:2,omittedPassages:1,omittedOnIncludedPages:0}};
  const saved=readAskSearchContext(source)!;
  source.guidedQuestion.subject="Later user edit";source.guidedQuestion.asOf="2026-10-16";
  expect(saved.guidedQuestion).toEqual({version:1,intent:"remaining",subject:"Synthetic observatory",asOf:"2026-10-15"});
  expect(saved.range).toBeUndefined();
  expect(saved.paths).toEqual(["sessions/observatory.md"]);
 });
 it("drops malformed optional task metadata while preserving other valid history coverage",()=>{
  const saved=readAskSearchContext({version:1,guidedQuestion:{version:1,intent:"unknown",subject:"Synthetic observatory"},
   range:{start:"2026-10-01",end:"2026-10-15"},packing:{selectedPassages:2,omittedPassages:1,omittedOnIncludedPages:1}})!;
  expect(saved.guidedQuestion).toBeUndefined();
  expect(saved.range).toEqual({start:"2026-10-01",end:"2026-10-15"});
  expect(saved.packing?.omittedPassages).toBe(1);
 });
 it("measures omitted passages even when every supplied page is represented",()=>{
  const audit:ContextPackingAudit={promptTokens:100,contextTokens:4096,outputTokens:768,selected:[passage(0)],omitted:[passage(1)]};
  expect(packingCoverageOf(audit)).toEqual({selectedPassages:1,omittedPassages:1,omittedOnIncludedPages:1});
 });
 it("clones applied dates/paths and never stores source bodies",()=>{
  const source={version:1,range:{start:"2026-10-05",end:"2026-10-07"},paths:["sessions/work.md"],
   packing:{selectedPassages:1,omittedPassages:1,omittedOnIncludedPages:1}};
  const saved=readAskSearchContext(source)!;source.range.start="2026-10-01";source.paths.push("wiki/later.md");
  expect(saved.range?.start).toBe("2026-10-05");expect(saved.paths).toEqual(["sessions/work.md"]);
  expect(JSON.stringify(saved)).not.toContain("Synthetic original passage");
 });
 it.each([{version:2},{version:1,rangeIgnored:false},{version:1,periodClarification:false},
  {version:1,packing:{selectedPassages:1,omittedPassages:0,omittedOnIncludedPages:1}},
  {version:1,range:{start:"2026-02-30",end:"2026-03-01"}}])("drops malformed optional metadata without fabricating a verdict",value=>{
  expect(readAskSearchContext(value)).toBeUndefined();
 });
});
