import {describe, expect, it} from "vitest";
import {citationEvidenceFromPacket, readCitationEvidence} from "./citationEvidence";
const revision = "a".repeat(64), sha256 = "b".repeat(64);
const span = (id: string, text: string, start = 0) => ({id, text, start, end: start + new TextEncoder().encode(text).length,
  sha256, sourcePath: "raw/record.md", sourceRevision: revision, speaker: "user", turnTime: "2026-10-08T00:00:00Z"});
const raw = {sources: [{id: "S1", path: "raw/record.md", originalSpans: [span("native-1", "첫 요청"), span("native-2", "다음 요청", 30)]},
  {id: "S2", path: "raw/other.md", originalSpans: [{...span("native-3", "다른 기록"), sourcePath: "raw/other.md"}]}]};
const projected = {sources: raw.sources.map(s=>({...s, originalSpans:s.originalSpans.map((p,i)=>({id:`Q${i}`, text:p.text,speaker:p.speaker,turnTime:p.turnTime}))}))};
const bind = (r: unknown = raw, p: unknown = projected, paths = ["raw/record.md"]) => citationEvidenceFromPacket(JSON.stringify(r), JSON.stringify(p), paths);
describe("delivered citation provenance", () => {
 it("keeps all delivered spans in source order and only accepted cited sources", () => {
  const result = bind()!;
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0].spans.map(s=>s.text)).toEqual(["첫 요청", "다음 요청"]);
  expect(result.sources[0].spans[1].start).toBe(30);
  expect(result.sources[0].revision).toBe(revision);
  expect(readCitationEvidence(JSON.parse(JSON.stringify(result)))).toEqual(result);
 });
 it("does not infer a span from mismatched model input or an unbound cited path", () => {
  expect(bind(raw,{sources:[]})).toBeUndefined();
  const wrong=structuredClone(projected); wrong.sources[0].originalSpans[1].text="다른 내용";
  expect(bind(raw,wrong)).toBeUndefined();
  expect(bind(raw,projected,["raw/absent.md"])).toBeUndefined();
  expect(citationEvidenceFromPacket(undefined,"model input",[])).toBeUndefined();
 });
 it("rejects malformed optional history metadata, traversal and byte/character confusion", () => {
  const good=bind()!;
  for(const path of ["../raw/record.md","/raw/record.md","raw\\record.md","raw//record.md","raw/record.md#x"]){
    const bad=structuredClone(good);bad.sources[0].path=path;expect(readCitationEvidence(bad)).toBeUndefined();
  }
  const bad=structuredClone(good);bad.sources[0].spans[0].end=bad.sources[0].spans[0].text.length;
  expect(readCitationEvidence(bad)).toBeUndefined();
  expect(readCitationEvidence({version:99,sources:[]})).toBeUndefined();
  expect(readCitationEvidence("invalid")).toBeUndefined();
 });
});

import {createHash, webcrypto} from "node:crypto";
import {locateCitationSpan} from "./citationEvidence";
it("locates the bound repeated Korean original by bytes and refuses changed revisions or offsets", async () => {
  const doc = "# 앞말 😀\n\n원문…😀\n\n원문…😀\n";
  const text="원문…😀";
  const start = new TextEncoder().encode(doc.slice(0,doc.lastIndexOf(text))).length;
  const digest = (value:string) => createHash("sha256").update(value).digest("hex");
  const s = {id:"original", start, end:start+new TextEncoder().encode(text).length, text, sha256:digest(text), speaker:"user", turnTime:null};
  const source = {path:"raw/record.md",revision:digest(doc),spans:[s]};
  if (!globalThis.crypto) Object.defineProperty(globalThis,"crypto",{value:webcrypto,configurable:true});
  await expect(locateCitationSpan(doc,source,s)).resolves.toEqual({from:5,to:5});
  await expect(locateCitationSpan(doc+"변경",source,s)).resolves.toBeNull();
  await expect(locateCitationSpan(doc,source,{...s,start:start-1,end:s.end-1})).resolves.toBeNull();
  await expect(locateCitationSpan(doc,source,{...s,sha256:"0".repeat(64)})).resolves.toBeNull();
});

import {verifyCitationNavigation} from "./citationEvidence";
describe("fresh native citation navigation", () => {
 const doc = "# 기록\n\n같은 발언 😀\n\n같은 발언 😀\n", text = "같은 발언 😀";
 const digest = (s: string) => createHash("sha256").update(s).digest("hex");
 const start = new TextEncoder().encode(doc.slice(0, doc.lastIndexOf(text))).length;
 const span = {id:"Q2",start,end:start+new TextEncoder().encode(text).length,text,sha256:digest(text),speaker:"user",turnTime:null};
 const source = {path:"raw/test.md",revision:digest(doc),spans:[span]};
 const base = () => ({source,span,readCurrent:async()=>doc,draft:()=>doc,isCurrent:()=>true});
 it("uses fresh bytes and preserves the second repeated occurrence", async()=>{
  expect(await verifyCitationNavigation(base())).toEqual({status:"ready",lines:{from:5,to:5}});
 });
 it("refuses cached old content when the actual disk file changed", async()=>{
  expect(await verifyCitationNavigation({...base(),readCurrent:async()=>doc+'changed'})).toEqual({status:"changed"});
 });
 it("refuses unreadable files", async()=>{
  expect(await verifyCitationNavigation({...base(),readCurrent:async()=>{throw new Error('missing')}})).toEqual({status:"changed"});
 });
 it("refuses current draft and file when both differ from saved revision", async()=>{
  expect(await verifyCitationNavigation({...base(),readCurrent:async()=>doc+'changed',draft:()=>doc+'changed'})).toEqual({status:"changed"});
 });
 it("silently cancels a vault reopen during the native read", async()=>{
  let current=true;let finish!:(s:string)=>void;
  const result=verifyCitationNavigation({...base(),isCurrent:()=>current,readCurrent:()=>new Promise<string>(r=>{finish=r})});
  current=false;finish(doc);expect(await result).toEqual({status:"cancelled"});
 });
 it("refuses edits during the native read", async()=>{
  let draft=doc;let finish!:(s:string)=>void;
  const result=verifyCitationNavigation({...base(),draft:()=>draft,readCurrent:()=>new Promise<string>(r=>{finish=r})});
  draft+='edit';finish(doc);expect(await result).toEqual({status:"changed"});
 });
 it("does not read a superseded intent", async()=>{
  let reads=0;
  expect(await verifyCitationNavigation({...base(),isCurrent:()=>false,readCurrent:async()=>{reads++;return doc}})).toEqual({status:"cancelled"});
  expect(reads).toBe(0);
 });
});
