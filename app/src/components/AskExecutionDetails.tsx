import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { readAskExecution, type AskRequestedModel } from "../lib/askExecution";

/** The same saved facts are shown live and after history is reopened. */
export default function AskExecutionDetails({t,value,running=false}: {
  t: Strings; value?: unknown; running?: boolean;
}): JSX.Element {
  const execution=readAskExecution(value);
  const model=(route:AskRequestedModel) => <code style={{wordBreak:"break-all"}}>
    {route.providerId} / {route.modelId.trim() ? route.modelId : t.q_execution_unspecified}
  </code>;
  return <details className="intake-disclosure" data-testid="ask-execution-details" style={{fontSize:"0.8125rem",marginBlock:"0.75rem"}}>
    <summary>{t.q_execution_details}</summary>
    {!execution ? <p className="muted">{t.q_execution_unknown}</p> : <>
      <p data-testid="ask-execution-kind">{t.q_execution_kind}: {running ? t.q_execution_pending : t[`q_execution_kind_${execution.answerKind}`]}</p>
      {execution.selected ? <p>{t.q_execution_selected}: {model(execution.selected)}</p> : null}
      {!execution.calls.length ? <p className="muted">{t.q_execution_no_calls}</p> : <ol>
        {execution.calls.map(call=><li key={call.id} data-testid="ask-execution-call">
          <p>{call.purpose==="answer" ? t.q_execution_call_answer : t.q_execution_call_period} · {t[`q_execution_state_${call.state}`]}</p>
          <p>{t.q_execution_selected}: {model(call.requested)}</p>
          {call.identity ? <p>{call.identity.source==="provider_response" ? t.q_execution_provider_identity : t.q_execution_local_identity}: <code style={{wordBreak:"break-all"}}>{call.identity.modelId}</code></p>
            : call.state==="response_received" ? <p className="muted">{t.q_execution_identity_unknown}</p> : null}
        </li>)}
      </ol>}
      <p className="muted">{t.q_execution_boundary}</p>
    </>}
  </details>;
}
