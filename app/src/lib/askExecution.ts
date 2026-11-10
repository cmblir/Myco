/** Ask provenance describes app requests and returned identifiers. It neither
 * grants execution permission nor proves GPU use, weight identity or quality. */
export interface AskRequestedModel { providerId: string; modelId: string }
export interface AskModelIdentity {
  modelId: string;
  source: "provider_response" | "local_manifest";
}
export type AskRequestPurpose = "answer" | "period_plan";
export type AskRequestState = "submitted" | "response_received" | "failed" | "cancelled";
export type AskAnswerKind = "none" | "clarification" | "extractive" | "application" | "model_response";
export interface AskExecutionEvent {
  id: string;
  purpose: AskRequestPurpose;
  requested: AskRequestedModel;
  state: AskRequestState;
  identity?: AskModelIdentity;
}
export interface AskExecution {
  version: 1;
  selected?: AskRequestedModel;
  answerKind: AskAnswerKind;
  /** App generation-command attempts, not transport retries or decoder calls. */
  calls: AskExecutionEvent[];
}

const object = (v: unknown): v is Record<string,unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown, limit: number, empty = false): v is string => typeof v === "string" &&
  (empty || Boolean(v.trim())) && new TextEncoder().encode(v).length <= limit &&
  ![...v].some(char=>{const code=char.codePointAt(0)!;return code<32 || (code>=127 && code<=159);});
const route = (v: unknown): v is AskRequestedModel => object(v) && identifier(v.providerId,128) && identifier(v.modelId,512,true);
const sameRoute = (a: AskRequestedModel,b: AskRequestedModel) => a.providerId === b.providerId && a.modelId === b.modelId;
const kinds: readonly unknown[] = ["none","clarification","extractive","application","model_response"];
const states: readonly unknown[] = ["submitted","response_received","failed","cancelled"];
const purposes: readonly unknown[] = ["answer","period_plan"];

/** Absence means historical execution is unknown. Bad optional metadata must
 * never erase the saved answer or infer its model from today's settings. */
export function readAskExecution(value: unknown): AskExecution | undefined {
  if (!object(value) || value.version !== 1 || !kinds.includes(value.answerKind) ||
      !Array.isArray(value.calls) || value.calls.length > 32 ||
      (value.selected !== undefined && value.selected !== null && !route(value.selected))) return undefined;
  const selected = route(value.selected) ? {...value.selected} : undefined;
  const ids = new Set<string>();
  const calls: AskExecutionEvent[] = [];
  for (const item of value.calls) {
    if (!object(item) || !identifier(item.id,200) || ids.has(item.id) || !purposes.includes(item.purpose) ||
        !states.includes(item.state) || !route(item.requested) || (selected && !sameRoute(selected,item.requested))) return undefined;
    let identity: AskModelIdentity | undefined;
    if (item.identity !== undefined && item.identity !== null) {
      const v=item.identity;
      if (!object(v) || !identifier(v.modelId,512) || item.state !== "response_received" ||
          (v.source !== "provider_response" && v.source !== "local_manifest") ||
          (v.source === "local_manifest") !== (item.requested.providerId === "builtin-local")) return undefined;
      identity={modelId:v.modelId,source:v.source as AskModelIdentity["source"]};
    }
    ids.add(item.id);
    calls.push({id:item.id,purpose:item.purpose as AskRequestPurpose,requested:{...item.requested},
      state:item.state as AskRequestState,...(identity?{identity}:{})});
  }
  if (value.answerKind === "model_response" && !calls.some(call=>
    call.purpose === "answer" && call.state === "response_received")) return undefined;
  return {version:1,...(selected?{selected}:{}),answerKind:value.answerKind as AskAnswerKind,calls};
}

/** Only immutable metadata snapshots leave the per-question recorder. */
export function applyAskExecutionEvent(value: AskExecution,event: AskExecutionEvent): AskExecution {
  const index=value.calls.findIndex(call=>call.id===event.id);
  const previous=value.calls[index];
  if (previous && (previous.purpose !== event.purpose || !sameRoute(previous.requested,event.requested)))
    throw new Error("model request identity changed");
  // A cancelled/finished app request cannot be rewritten by a late callback.
  if (previous && previous.state !== "submitted") return value;
  const calls=[...value.calls];
  if (index<0) {
    if (event.state !== "submitted") throw new Error("model request response has no submission");
    calls.push(event);
  } else calls[index]=event;
  const result=readAskExecution({...value,calls});
  if (!result) throw new Error("invalid model request metadata");
  return result;
}

export function finishAskExecution(value: AskExecution,answerKind: AskAnswerKind,terminal?: "failed" | "cancelled"): AskExecution {
  const result=readAskExecution({...value,answerKind,calls:value.calls.map(call=>
    terminal && call.state === "submitted" ? {...call,state:terminal} : call)});
  if (!result) throw new Error("invalid finished model request metadata");
  return result;
}
