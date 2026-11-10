import {beforeEach,describe,it,expect,vi} from 'vitest';
import {evidenceCandidates,packModelContext,renderEvidence,registerModelContextBudget,modelContextBudget,runtimeModelContextBudget,ModelContextError,type HistoricalEvidenceExclusion} from './modelContextBudget';
import {ipc, type ScoredChunk,type RelatedPassage} from './ipc';
import {roleFixture} from "./modelRoles.testSupport";
const hit=(page:string,text:string):ScoredChunk=>({page,stem:page,section:0,text,score:1,similarity:.6});
const original=hit('raw/a.md','Plan.');
const related=(section:number,timestamp:number,text:string):RelatedPassage=>({page:'raw/new.md',stem:'new',section,timestamp,text,role:'assistant',source_revision:'sha',message_id:`m-${section}`,relation:'recent_exchange',anchor_page:original.page,anchor_section:0});
describe('exact model context packing',()=>{
 it('counts complete history and output reserve, keeps whole qualifiers and records omissions',async()=>{
  const small=hit('short.md','Verified? No.');const large=hit('long.md','x'.repeat(1000)+' NOT VERIFIED');
  const countMessages=vi.fn(async messages=>messages.reduce((n:number,m:{content:string})=>n+m.content.length,0));
  const record=vi.fn();
  const result=await packModelContext([large,small],{contextTokens:600,outputTokens:100,countMessages,record},ctx=>[{role:'system',content:ctx},{role:'user',content:'History and question'}]);
  expect(result.audit.selected).toEqual([small]);expect(result.audit.omitted).toEqual([large]);
  expect(result.ctx).not.toContain('xxx');expect(result.ctx).toContain('Verified? No.');
  expect(result.audit.promptTokens+100).toBeLessThanOrEqual(600);
  expect(countMessages.mock.calls.at(-1)?.[0].at(-1)?.content).toBe('History and question');
  expect(record).toHaveBeenCalledWith(result.audit);
 });
 it('fails instead of silently discarding history or accepting a failed tokenizer',async()=>{
  await expect(packModelContext([],{contextTokens:100,outputTokens:10,countMessages:async()=>101},()=>[])).rejects.toThrow('conversation exceed');
  await expect(packModelContext([],{contextTokens:100,outputTokens:10,countMessages:async()=>NaN},()=>[])).rejects.toThrow('Invalid tokenizer');
 });
 it('stops between tokenizer calls',async()=>{
  const controller=new AbortController();const countMessages=vi.fn(async()=>{controller.abort();return 1;});
  await expect(packModelContext([original],{contextTokens:100,outputTokens:10,countMessages},()=>[],controller.signal)).rejects.toThrow('stopped');
  expect(countMessages).toHaveBeenCalledTimes(1);
 });
 it('filters unrelated evidence and preserves latest corrections in state priority',()=>{
  const early=related(1,100,'Done.');const late=related(2,200,'Correction: reopened.');
  const unrelated={...related(3,300,'Wrong conversation'),anchor_section:99};
  const queue=evidenceCandidates([original],{passages:[early,late,unrelated],incomplete:false,scanned_pages:2},'아직 남은 작업');
  expect(queue[0]).toEqual(late);expect(queue).not.toContain(unrelated);
  const rendered=renderEvidence(queue);expect(rendered.indexOf('Done.')).toBeLessThan(rendered.indexOf('Correction: reopened.'));
 });
 it('balances verified conversation revisions together without removing unique older evidence',()=>{
  const old=hit('raw/old.md','Old distinct report');
  const latest=hit('raw/latest.md','Latest anchor');
  const other=hit('raw/other.md','Other project');
  const recent={...related(9,300,'Final completion'),page:latest.page,anchor_page:latest.page};
  const early={...related(2,100,'Earlier plan'),page:old.page,anchor_page:old.page};
  const result=evidenceCandidates([old,other,latest],{passages:[early,recent],incomplete:false,scanned_pages:3,
    source_groups:{[old.page]:'verified-conversation-A',[latest.page]:'verified-conversation-A',[other.page]:'verified-conversation-B'}},'progress');
  expect(result[0]).toEqual(recent);
  expect(result[1]).toEqual(other);
  expect(result).toContain(early); expect(result).toContain(old); expect(result).toContain(latest);
 });
 it('keeps a requested original statement ahead of newer unrelated turns and a matching rollup',()=>{
  const anchor=hit('raw/thread.md','Search anchor about the canvas exporter');
  const request={...related(1,100,'Please group canvas exporter sessions by topic so I can find earlier discussions.'),
    page:anchor.page,anchor_page:anchor.page,role:'user'};
  const unrelated={...related(9,900,'The travel booking is complete; verification remains.'),page:anchor.page,anchor_page:anchor.page};
  const summary=hit('wiki/month.md','Canvas exporter sessions topic decisions and all recent discussion summaries.');
  const candidates=evidenceCandidates([anchor,summary],{passages:[unrelated,request],incomplete:false,scanned_pages:2},
    'Find the original request to group canvas exporter sessions by topic.','recall');
  expect(candidates[0]).toEqual(request);
  expect(candidates).toContain(unrelated);
  expect(candidates.indexOf(request)).toBeLessThan(candidates.indexOf(summary));
 });
 it('prioritizes a topical later correction for a status question, then renders it after earlier reports',()=>{
  const early=related(1,100,'Canvas exporter deployed and complete.');
  const correction=related(2,200,'Correction: canvas exporter deployment was not verified; reopen the task.');
  const unrelated=related(3,300,'The travel booking is complete.');
  const candidates=evidenceCandidates([original],{passages:[early,unrelated,correction],incomplete:false,scanned_pages:2},
    'Canvas exporter progress','progress');
  expect(candidates[0]).toEqual(correction);
  expect(renderEvidence(candidates).indexOf(early.text)).toBeLessThan(renderEvidence(candidates).indexOf(correction.text));
 });
 it('gives an explicit question type the best-ranked source group first, then round-robins the other groups',()=>{
  const top=hit('raw/top.md','Top anchor');const second=hit('raw/second.md','Second anchor');const third=hit('raw/third.md','Third anchor');
  const topTurns=[1,2,3,4].map(i=>({...related(i,100*i,`Top conversation turn ${i}`),page:top.page,anchor_page:top.page}));
  const secondTurn={...related(1,50,'Second conversation turn'),page:second.page,anchor_page:second.page};
  const thirdTurn={...related(1,60,'Third conversation turn'),page:third.page,anchor_page:third.page};
  const context={passages:[...topTurns,secondTurn,thirdTurn],incomplete:false,scanned_pages:3};
  const explicit=evidenceCandidates([top,second,third],context,'subject','progress');
  const lastTop=Math.max(...[...topTurns,top].map(p=>explicit.indexOf(p)));
  const firstOther=Math.min(...[second,secondTurn,third,thirdTurn].map(p=>explicit.indexOf(p)));
  expect(lastTop).toBeLessThan(firstOther);
  expect(explicit).toHaveLength(9);
  const untyped=evidenceCandidates([top,second,third],context,'subject');
  expect(untyped.slice(0,3).map(p=>p.page)).toEqual([top.page,second.page,third.page]);
 });
 it('leads an explicit recall with the group holding the exact-match original, not the best fused rank',()=>{
  const restatement={...hit('raw/conversations/other/thread.md','Assistant restates the request to group canvas exporter sessions.'),similarity:0.50};
  const original={...hit('raw/conversations/codex/thread.md','Please keep grouping the CanvasExporter sessions by name.'),similarity:0.74,exact_match:true};
  const restatementTurns=[1,2,3].map(i=>({...related(i,100*i,`Other conversation turn ${i}`),page:restatement.page,anchor_page:restatement.page}));
  const originalTurn={...related(1,50,'Original conversation adjacent turn'),page:original.page,anchor_page:original.page};
  const context={passages:[...restatementTurns,originalTurn],incomplete:false,scanned_pages:2};
  const recall=evidenceCandidates([restatement,original],context,'canvas exporter sessions','recall');
  expect(Math.max(recall.indexOf(original),recall.indexOf(originalTurn))).toBeLessThan(Math.min(recall.indexOf(restatement),...restatementTurns.map(p=>recall.indexOf(p))));
  const progress=evidenceCandidates([restatement,original],context,'canvas exporter sessions','progress');
  expect(progress.indexOf(restatement)).toBeLessThan(progress.indexOf(original));
 });
 it('orders the latest state report ahead of an earlier turn with more topical words for progress, not for decision',()=>{
  const earlier=related(1,100,'Canvas exporter deployment plan: canvas exporter steps are complete.');
  const latest=related(2,200,'Final report: deployment complete.');
  const context={passages:[earlier,latest],incomplete:false,scanned_pages:1};
  expect(evidenceCandidates([original],context,'canvas exporter deployment','progress')[0]).toEqual(latest);
  expect(evidenceCandidates([original],context,'canvas exporter deployment','remaining')[0]).toEqual(latest);
  expect(evidenceCandidates([original],context,'canvas exporter deployment','decision')[0]).toEqual(earlier);
 });
 it('distinguishes a passage that never fits from one crowded out by earlier selections',async()=>{
  const first=hit('first.md','A'.repeat(200));const crowded=hit('second.md','B'.repeat(200));const giant=hit('third.md','C'.repeat(2000));
  const packed=await packModelContext([first,crowded,giant],{contextTokens:600,outputTokens:100,
    countMessages:async messages=>messages.reduce((n,m)=>n+m.content.length,0)},ctx=>[{role:'system',content:ctx}]);
  expect(packed.audit.selected).toEqual([first]);
  expect(packed.audit.omitted).toEqual([crowded,giant]);
  expect(packed.audit.omissionReasons?.[JSON.stringify([crowded.page,0])]).toBe('budget_exhausted');
  expect(packed.audit.omissionReasons?.[JSON.stringify([giant.page,0])]).toBe('whole_passage_exceeds_allowance');
 });
 it('requires source-bound original dates and excludes undated hits at a historical cutoff',()=>{
  const anchor=hit('raw/thread.md','Undated anchor.');
  const day=new Date(2026,8,15);
  const before={...related(1,day.getTime()/1000-60,'Earlier reported state.'),source_revision:'a'.repeat(64),page:anchor.page,anchor_page:anchor.page};
  const within={...related(2,day.getTime()/1000+12*3600,'Same-day correction.'),source_revision:'a'.repeat(64),page:anchor.page,anchor_page:anchor.page};
  const future={...related(3,new Date(2026,8,16).getTime()/1000,'Future result must not leak.'),source_revision:'a'.repeat(64),page:anchor.page,anchor_page:anchor.page};
  const duplicate={...anchor,section:future.section,text:future.text};
  const candidates=evidenceCandidates([anchor,duplicate],{passages:[before,within,future],incomplete:false,scanned_pages:1},
    'reported state','progress','2026-09-15');
  expect(candidates).toContain(before);expect(candidates).toContain(within);expect(candidates).not.toContain(anchor);
  expect(candidates).not.toContain(future);expect(candidates).not.toContain(duplicate);
  expect(renderEvidence(candidates)).not.toContain('speaker: unknown');
  expect(()=>evidenceCandidates([anchor],undefined,'state','progress','2026-02-30')).toThrow('reference date');
 });
 it('does not let an oversized unrelated recent turn suppress older original requests or reports',async()=>{
  const latest=related(9,900,'Unrelated travel receipt. '+'X'.repeat(3000));
  const request={...related(1,100,'Please organize the canvas exporter by topic.'),role:'user'};
  const report=related(2,200,'Canvas exporter was reported complete; independent verification remains.');
  const packed=await packModelContext([latest,request,report],{contextTokens:1300,outputTokens:100,
    countMessages:async messages=>messages.reduce((n,m)=>n+m.content.length,0)},ctx=>[{role:'system',content:ctx}]);
  expect(packed.audit.selected).toEqual([request,report]);
  expect(packed.audit.omitted).toEqual([latest]);
  expect(packed.ctx).toContain(request.text);expect(packed.ctx).toContain(report.text);
 });
 it('retains the original user request while withholding a stale status invalidated by an omitted correction',async()=>{
  const correction=related(9,900,'Correction: deployment was not verified. '+'X'.repeat(3000));
  const request={...related(1,100,'Please complete deployment after the source review.'),role:'user'};
  const stale=related(2,200,'Deployment complete.');
  const packed=await packModelContext([correction,request,stale],{contextTokens:1000,outputTokens:100,
    countMessages:async messages=>messages.reduce((n,m)=>n+m.content.length,0)},ctx=>[{role:'system',content:ctx}]);
  expect(packed.audit.selected).toEqual([request]);
  expect(packed.audit.omitted).toEqual([correction,stale]);
  expect(packed.audit.omissionReasons?.[JSON.stringify([stale.page,stale.section])]).toBe('newer_source_omitted');
  expect(packed.ctx).toContain('speaker: user');
  expect(packed.ctx).not.toContain(stale.text);
 });
 it('does not treat a different-topic correction in the same long conversation as superseding a status claim',async()=>{
  const correction=related(9,900,'Correction: travel booking was not verified. '+'X'.repeat(3000));
  const report=related(2,200,'Canvas exporter deployment complete.');
  const packed=await packModelContext([correction,report],{contextTokens:1000,outputTokens:100,
    countMessages:async messages=>messages.reduce((n,m)=>n+m.content.length,0)},ctx=>[{role:'system',content:ctx}]);
  expect(packed.audit.selected).toEqual([report]);
  expect(packed.audit.omitted).toEqual([correction]);
 });
 it('binds tokenizer adapters to the exact selected route and supports disposal',()=>{
  const adapter={contextTokens:4096,outputTokens:768,countMessages:async()=>1};
  const dispose=registerModelContextBudget('local','model',adapter);
  expect(modelContextBudget('other','model')).toBeUndefined();expect(modelContextBudget('local','model')).toBe(adapter);
  expect(()=>registerModelContextBudget('local','model',adapter)).toThrow('already registered');
  dispose();expect(modelContextBudget('local','model')).toBeUndefined();
 });
});


describe("runtime capability and exact messages",()=>{
 const origin={vaultPath:"/synthetic",openingToken:"same-opening"};
 const model="user-selected-trained-model-without-name-table";
 const binding={provider:"ollama",model,origin,roleSnapshot:roleFixture("ask","ollama",model,origin)};
 const capability={model,contextTokens:4096,outputTokens:768,tokenizerRevision:"template-and-tokenizer-sha"};
 beforeEach(()=>{vi.restoreAllMocks();});
 it("discovers the selected runtime allowance, binds every count and records metadata without source text",async()=>{
  vi.spyOn(ipc,"modelContextBudget").mockResolvedValue(capability);
  const count=vi.spyOn(ipc,"countModelContext").mockResolvedValue({...capability,promptTokens:3209});
  const record=vi.spyOn(ipc,"recordContextPacking").mockResolvedValue(undefined);
  const adapter=await runtimeModelContextBudget(binding);
  const passage=related(8,200,"PRIVATE WHOLE CORRECTION — not independently verified.");
  const history=[{role:"assistant" as const,content:"Earlier user-visible answer"},{role:"user" as const,content:"Current question"}];
  const retrieval={denseSkipped:"no embedding index for this vault yet",hits:[{page:passage.page,section:8,scoreRrf:0.016,scoreFinal:0.016,similarity:null,exactMatch:true}]};
  const packed=await packModelContext([passage],adapter!,ctx=>[{role:"system",content:`Rules + profile + template context: ${ctx}`},...history],undefined,undefined,[],retrieval);
  expect(packed.messages).toEqual(count.mock.calls.at(-1)?.[0].messages);
  expect(packed.audit.promptTokens+packed.audit.outputTokens).toBe(3977);
  // The prompt carries what the model needs to attribute a statement; hashes
  // and message identifiers stay in the audit record only.
  expect(packed.messages[0].content).toContain("source_path: raw/new.md");
  expect(packed.messages[0].content).toContain("speaker: assistant");
  // Local time with an explicit offset: the same instant, never a bare UTC "Z" date.
  const shown=/message_time: (\S+)/.exec(packed.messages[0].content)?.[1] ?? "";
  expect(Date.parse(shown)).toBe(200_000);
  expect(shown).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  expect(packed.messages[0].content).toContain("relation: recent_exchange");
  expect(packed.messages[0].content).not.toContain("message_id:");
  expect(packed.messages[0].content).not.toContain("source_revision:");
  expect(packed.messages[0].content).not.toContain("anchor:");
  expect(record.mock.calls[0][0]).toMatchObject({...binding,audit:{status:"packed",tokenizerRevision:capability.tokenizerRevision,
    selected:[{page:passage.page,speaker:"assistant",messageId:"m-8",textSha256:expect.stringMatching(/^[a-f0-9]{64}$/)}],retrieval}});
  expect(JSON.stringify(record.mock.calls[0][0])).not.toContain("PRIVATE WHOLE CORRECTION");
  expect(count.mock.calls.every(([request])=>request.tokenizerRevision===capability.tokenizerRevision)).toBe(true);
 });
 it.each(["wrong model","changed revision","changed allowance","invalid count"])("fails closed for %s",async mode=>{
  vi.spyOn(ipc,"modelContextBudget").mockResolvedValue(capability);
  const result={...capability,promptTokens:100};
  if(mode==="wrong model")result.model="different-model";
  if(mode==="changed revision")result.tokenizerRevision="different-template";
  if(mode==="changed allowance")result.outputTokens=1;
  if(mode==="invalid count")result.promptTokens=NaN;
  vi.spyOn(ipc,"countModelContext").mockResolvedValue(result);
  const adapter=await runtimeModelContextBudget(binding);
  await expect(adapter!.countMessages([{role:"user",content:"Question"}])).rejects.toBeInstanceOf(ModelContextError);
 });
 it("does not invent limits for an unsupported endpoint or use another provider",async()=>{
  const discover=vi.spyOn(ipc,"modelContextBudget").mockResolvedValue(null);
  expect(await runtimeModelContextBudget(binding)).toBeUndefined();
  expect(await runtimeModelContextBudget({...binding,provider:"openai-api"})).toBeUndefined();
  expect(discover).toHaveBeenCalledTimes(1);
 });
 it("never retains an older matching state claim when a newer correction from the same verified conversation is omitted",async()=>{
  const latest={...related(9,300,"Deployment correction: not verified. "+"X".repeat(2000)),page:"raw/latest.md"};
  const older={...related(1,100,"Deployment reported done."),page:"raw/old.md"};
  const other=hit("wiki/other.md","Other source fact.");
  const packed=await packModelContext([latest,older,other],{contextTokens:800,outputTokens:100,
    countMessages:async messages=>messages.reduce((n,m)=>n+m.content.length,0)},ctx=>[{role:"system",content:ctx},{role:"user",content:"Question"}],undefined,
    {[latest.page]:"conversation-A",[older.page]:"conversation-A"});
  expect(packed.audit.selected).toEqual([other]);
  expect(packed.audit.omitted).toEqual([latest,older]);
  expect(packed.audit.omissionReasons?.[JSON.stringify([older.page,older.section])]).toBe("newer_source_omitted");
  expect(packed.ctx).not.toContain("Deployment reported done");
 });
 it("records base overflow without dropping history or testing source trials",async()=>{
  const countMessages=vi.fn(async()=>4000),record=vi.fn();
  await expect(packModelContext([original],{contextTokens:4096,outputTokens:768,countMessages,record},()=>[
    {role:"system",content:"All system instructions and profile"},{role:"assistant",content:"Complete history"},{role:"user",content:"Full question"}
  ])).rejects.toMatchObject({code:"base_overflow"});
  expect(countMessages).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledWith(expect.objectContaining({status:"base_overflow",promptTokens:4000,selected:[],omitted:[original]}));
 });
 it("rechecks final ordering and detects a tokenizer mutating its input",async()=>{
  const record=vi.fn(),countMessages=vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(100);
  await expect(packModelContext([original],{contextTokens:100,outputTokens:10,countMessages,record},ctx=>[{role:"user",content:ctx}])).rejects.toMatchObject({code:"final_overflow"});
  expect(record).toHaveBeenCalledWith(expect.objectContaining({status:"final_overflow"}));
  await expect(packModelContext([],{contextTokens:100,outputTokens:10,countMessages:async messages=>{messages[0].content="mutated";return 1;}},()=>[{role:"user",content:"Original"}])).rejects.toThrow("mutated");
 });
});


describe('strict historical evidence eligibility',()=>{
 const day='2026-09-15';
 const end=new Date(2026,8,16).getTime()/1000;
 const anchor=hit('raw/conversations/fictional/thread.md','Undated source excerpt quoting an older date.');
 const dated=(section:number,time:number,text:string):RelatedPassage=>({...related(section,time,text),
   page:anchor.page,anchor_page:anchor.page,source_revision:'b'.repeat(64),message_id:`original-${section}`});
 it('never promotes an unknown raw capture or undated legitimate note from body dates into historical proof',()=>{
  const laterCapture=hit('raw/conversations/fictional/later.md','2026-09-01 record: copied expected answer table from a later evaluation.');
  const legitimateUndated=hit('wiki/library-plan.md','A genuine undated plan without source event metadata.');
  const verified=dated(1,end-60,'The original user requested a library sign before the cutoff.');
  const excluded:HistoricalEvidenceExclusion[]=[];
  const candidates=evidenceCandidates([anchor,laterCapture,legitimateUndated],{passages:[verified],incomplete:false,scanned_pages:1},'library sign','recall',day,e=>excluded.push(e));
  expect(candidates).toEqual([verified]);
  expect(excluded.map(e=>e.passage)).toEqual(expect.arrayContaining([anchor,laterCapture,legitimateUndated]));
  expect(excluded.every(e=>e.reason==='historical_date_unverified')).toBe(true);
  expect(renderEvidence(candidates)).not.toContain('copied expected answer');
  expect(evidenceCandidates([laterCapture,legitimateUndated],undefined,'library sign')).toEqual([laterCapture,legitimateUndated]);
 });
 it('rejects incomplete or malformed source-date proof even if a timestamp alone looks old',()=>{
  const valid=dated(1,end-10,'Valid bounded original.');
  const missingDate={...dated(2,end-10,'Unknown event date.'),timestamp:NaN};
  const missingRevision={...dated(3,end-10,'Unbound revision.'),source_revision:'not-a-sha'};
  const missingMessage={...dated(4,end-10,'No original message.'),message_id:''};
  const unknownSpeaker={...dated(5,end-10,'No original speaker.'),role:'unknown'};
  const unexpectedRole={...dated(6,end-10,'Unsupported role metadata.'),role:'imported-summary'};
  const validTool={...dated(7,end-10,'Original tool result with supported role.'),role:'tool'};
  const excluded:HistoricalEvidenceExclusion[]=[];
  const candidates=evidenceCandidates([anchor],{passages:[valid,validTool,missingDate,missingRevision,missingMessage,unknownSpeaker,unexpectedRole],incomplete:false,scanned_pages:1},'bounded original','progress',day,e=>excluded.push(e));
  expect(candidates).toEqual([valid,validTool]);
  expect(excluded.filter(e=>e.reason==='historical_date_unverified')).toHaveLength(6);
 });
 it('audits future exclusions separately and preserves eligible original state instead of letting a later correction supersede it',async()=>{
  const past=dated(1,end-60,'Library sign installation was reported complete.');
  const future=dated(2,end,'Correction: library sign installation was reopened after the historical cutoff.');
  const duplicate={...anchor,section:future.section,text:future.text};
  const excluded:HistoricalEvidenceExclusion[]=[];
  const candidates=evidenceCandidates([anchor,duplicate],{passages:[past,future],incomplete:false,scanned_pages:1},'library sign status','progress',day,e=>excluded.push(e));
  const packed=await packModelContext(candidates,{contextTokens:4096,outputTokens:768,countMessages:async()=>100},
    ctx=>[{role:'system',content:ctx}],undefined,undefined,excluded);
  expect(packed.audit.selected).toEqual([past]);
  expect(packed.audit.omitted).toEqual(expect.arrayContaining([anchor,future]));
  expect(Object.values(packed.audit.omissionReasons!)).toEqual(expect.arrayContaining(['after_historical_cutoff','historical_date_unverified']));
  expect(Object.values(packed.audit.omissionReasons!)).not.toContain('newer_source_omitted');
  expect(packed.ctx).toContain(past.text);expect(packed.ctx).not.toContain(future.text);
 });
});
