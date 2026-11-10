import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe,expect,it } from "vitest";
import AskExecutionDetails from "./AskExecutionDetails";
import { STRINGS } from "../lib/i18n";
import type { AskExecution } from "../lib/askExecution";
const t=STRINGS.ko;
const render=(value?:unknown,running=false)=>renderToStaticMarkup(h(AskExecutionDetails,{t,value,running}));
const base=():AskExecution=>({version:1,selected:{providerId:"ollama",modelId:"requested-alias"},answerKind:"none",calls:[]});
describe("execution details",()=>{
  it("shows unknown legacy metadata without inventing a current model",()=>{
    const html=render();expect(html).toContain(t.q_execution_unknown);
    expect(html).not.toContain(t.q_execution_no_calls);
    expect(html).not.toContain("requested-alias");
  });
  it("keeps model request details folded and separate from answer text",()=>{
    const html=render(base());expect(html).toContain(t.q_execution_details);
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
  });
  it("shows both requested and server-reported models without treating the alias as reported",()=>{
    const x=base();x.answerKind="model_response";x.calls=[{id:"a",purpose:"answer",requested:x.selected!,state:"response_received",identity:{modelId:"actual-reported",source:"provider_response"}}];
    const html=render(x);expect(html).toContain("requested-alias");expect(html).toContain("actual-reported");
    expect(html).toContain(t.q_execution_provider_identity);expect(html).toContain(t.q_execution_kind_model_response);
    delete x.calls[0].identity;
    const unreported=render(x);expect(unreported).toContain(t.q_execution_identity_unknown);
    expect(unreported).not.toContain(t.q_execution_provider_identity);
  });
  it("does not label clarification or a received local fallback as a model-generated answer",()=>{
    const clarification=base();clarification.answerKind="clarification";
    const html=render(clarification);expect(html).toContain(t.q_execution_kind_clarification);expect(html).toContain(t.q_execution_no_calls);
    expect(html).not.toContain(t.q_execution_kind_model_response);
    const local={providerId:"builtin-local",modelId:"local"};
    const fallback=render({version:1,selected:local,answerKind:"none",calls:[{id:"a",purpose:"answer",requested:local,state:"response_received",identity:{modelId:"local",source:"local_manifest"}}]});
    expect(fallback).toContain(t.q_execution_local_identity);expect(fallback).toContain(t.q_execution_kind_none);
    expect(fallback).not.toContain(t.q_execution_kind_model_response);
  });
  it("labels an in-progress request without claiming a model is running or an answer is missing",()=>{
    const html=render(base(),true);expect(html).toContain(t.q_execution_pending);
    expect(html).not.toContain(t.q_execution_kind_none);
  });
  it("describes cancellation as stopping the app wait rather than confirming GPU cancellation",()=>{
    const x=base();x.calls=[{id:"a",purpose:"answer",requested:x.selected!,state:"cancelled"}];
    const html=render(x);expect(html).toContain("응답 대기 중단");
    expect(html).not.toContain(t.q_execution_kind_model_response);
    expect(html).not.toContain(t.q_execution_provider_identity);
  });
});
