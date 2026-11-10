import {useId, useRef} from "react";
import type {Lang} from "../lib/i18n";
import type {CitationSource, CitationSpan} from "../lib/citationEvidence";
import {useModalFocus} from "./useModalFocus";

/** A list of delivered originals, not invented claim-to-span attribution. */
export default function CitationPassages({source, lang, onOpen, onClose}: {
  source: CitationSource; lang: Lang; onOpen: (span: CitationSpan) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null), title = useId();
  const {onKeyDown} = useModalFocus(ref, {open: source, onEscape: onClose});
  const copy = lang === "ko" ? {title:"답변에 전달된 원문", detail:"이 출처에서 답변 작성에 전달된 구절입니다. 확인할 구절을 선택하세요.", open:"원문에서 보기", close:"닫기"}
    : lang === "ja" ? {title:"回答に渡された原文",detail:"この出典から回答に渡された箇所です。確認する箇所を選んでください。",open:"原文で見る",close:"閉じる"}
    : {title:"Original passages supplied for this answer",detail:"These passages from this source were supplied when answering. Choose a passage to inspect.",open:"View in original",close:"Close"};
  return <div className="myco-modal__backdrop">
    <div className="myco-modal" role="dialog" aria-modal="true" aria-labelledby={title} ref={ref} tabIndex={-1} onKeyDown={onKeyDown}
      style={{maxWidth:760, maxHeight:"85vh", overflow:"auto", padding:24}}>
      <h2 id={title}>{copy.title}</h2>
      <p>{copy.detail}</p><p className="muted" style={{overflowWrap:"anywhere"}}>{source.path}</p>
      <button className="btn btn-ghost" onClick={onClose}>{copy.close}</button>
      <ol>{source.spans.map(span => <li key={span.id} style={{marginTop:20}}>
        <small>{span.speaker}{span.turnTime ? ` · ${span.turnTime}` : ""}</small>
        <pre style={{whiteSpace:"pre-wrap", overflowWrap:"anywhere", fontFamily:"inherit"}}>{span.text}</pre>
        <button className="btn" onClick={() => onOpen(span)}>{copy.open}</button>
      </li>)}</ol>
    </div>
  </div>;
}
