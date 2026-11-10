import { describe,expect,it } from "vitest";
import { applyAskExecutionEvent,finishAskExecution,readAskExecution,type AskExecution,type AskExecutionEvent } from "./askExecution";

const selected={providerId:"ollama",modelId:"requested-alias"};
const initial=():AskExecution=>({version:1,answerKind:"none",selected:{...selected},calls:[]});
const event=(patch:Partial<AskExecutionEvent>={}):AskExecutionEvent=>({id:"answer-1",purpose:"answer",requested:{...selected},state:"submitted",...patch});

describe("saved Ask execution provenance",()=>{
  it("keeps absent/legacy or malformed execution unknown",()=>{
    for(const value of [undefined,null,"broken",{}, {version:2,answerKind:"none",calls:[]},
      {version:1,answerKind:"invented",calls:[]}, {version:1,answerKind:"none",calls:[{}]}])
      expect(readAskExecution(value)).toBeUndefined();
  });
  it("keeps requested alias distinct from a reported ID and does not invent missing identity",()=>{
    const sent=applyAskExecutionEvent(initial(),event());
    const returned=applyAskExecutionEvent(sent,event({state:"response_received",identity:{modelId:"server-model",source:"provider_response"}}));
    const saved=finishAskExecution(returned,"model_response");
    expect(readAskExecution(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(saved.selected?.modelId).toBe("requested-alias");
    expect(saved.calls[0].identity?.modelId).toBe("server-model");
    const unreported=applyAskExecutionEvent(sent,event({state:"response_received"}));
    expect(unreported.calls[0].identity).toBeUndefined();
  });
  it("does not mutate snapshots already supplied to the UI/history",()=>{
    const first=initial(), submitted=event();
    const sent=applyAskExecutionEvent(first,submitted);
    submitted.requested.modelId="changed outside";
    expect(first.calls).toEqual([]);
    expect(sent.calls[0].requested.modelId).toBe("requested-alias");
    const returned=applyAskExecutionEvent(sent,event({state:"response_received"}));
    expect(sent.calls[0].state).toBe("submitted");
    expect(returned.calls[0].state).toBe("response_received");
  });
  it("keeps clarification/extractive/application outcomes separate from a model response",()=>{
    for(const kind of ["clarification","extractive","application"] as const){
      const saved=finishAskExecution(initial(),kind);
      expect(saved.answerKind).toBe(kind);expect(saved.calls).toEqual([]);
    }
  });
  it("cancels pending app commands, preserves received identity, and ignores late terminal rewrites",()=>{
    const sent=applyAskExecutionEvent(initial(),event());
    const stopped=finishAskExecution(sent,"none","cancelled");
    expect(stopped.calls[0].state).toBe("cancelled");
    expect(applyAskExecutionEvent(stopped,event({state:"response_received"}))).toBe(stopped);
    const response=applyAskExecutionEvent(sent,event({state:"response_received",identity:{modelId:"reported",source:"provider_response"}}));
    const rejected=finishAskExecution(response,"none","failed");
    expect(rejected.answerKind).toBe("none");
    expect(rejected.calls[0]).toEqual(response.calls[0]);
  });
  it("rejects unmatched, duplicate, or over-limit app-command metadata",()=>{
    expect(()=>applyAskExecutionEvent(initial(),event({state:"response_received"}))).toThrow();
    expect(()=>applyAskExecutionEvent(initial(),event({requested:{providerId:"another",modelId:"model"}}))).toThrow();
    expect(readAskExecution({...initial(),calls:[event(),event()]})).toBeUndefined();
    expect(readAskExecution({...initial(),calls:Array.from({length:33},(_,i)=>event({id:`a-${i}`}))})).toBeUndefined();
    const sent=applyAskExecutionEvent(initial(),event());
    expect(()=>applyAskExecutionEvent(sent,event({purpose:"period_plan"}))).toThrow();
  });
  it("records a local fallback response as local metadata, not successful generation",()=>{
    const local={providerId:"builtin-local",modelId:"local-model"};
    const saved=readAskExecution({version:1,selected:local,answerKind:"none",calls:[
      {id:"a",purpose:"answer",requested:local,state:"response_received",identity:{modelId:"local-model",source:"local_manifest"}},
    ]});
    expect(saved?.answerKind).toBe("none");expect(saved?.calls[0].identity?.source).toBe("local_manifest");
    expect(readAskExecution({...initial(),calls:[event({state:"response_received",identity:{modelId:"fake",source:"local_manifest"}})]})).toBeUndefined();
  });
  it("uses UTF8 byte limits and rejects control characters without guessing a model",()=>{
    expect(readAskExecution({...initial(),selected:{...selected,modelId:"한".repeat(171)}})).toBeUndefined();
    expect(readAskExecution({...initial(),selected:{...selected,providerId:"bad\nprovider"}})).toBeUndefined();
    expect(readAskExecution({...initial(),selected:{...selected,modelId:""}})?.selected?.modelId).toBe("");
  });
  it("requires a received answer command before describing saved text as a model response",()=>{
    for (const calls of [[],[event()],[event({state:"failed"})],[event({purpose:"period_plan",state:"response_received"})]])
      expect(readAskExecution({...initial(),answerKind:"model_response",calls})).toBeUndefined();
  });
});
