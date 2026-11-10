import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {expect,it} from "vitest";
import CitationPassages from "./CitationPassages";
it("offers every delivered original as literal text without claiming it is the matching answer clause",()=>{
 const source={path:"raw/record.md",revision:"a".repeat(64),spans:["첫 기록","<script>do not execute</script>"].map((text,i)=>({id:`s${i}`,text,start:0,end:new TextEncoder().encode(text).length,sha256:"b".repeat(64),speaker:"user",turnTime:null}))};
 const html=renderToStaticMarkup(createElement(CitationPassages,{source,lang:"ko",onClose:()=>undefined,onOpen:()=>undefined}));
 expect(html).toContain('role="dialog"');
 expect(html).toContain("답변에 전달된 원문");
 expect(html).toContain("첫 기록");
 expect(html).toContain("&lt;script&gt;");
 expect(html).not.toContain("<script>");
 expect(html.match(/원문에서 보기/g)).toHaveLength(2);
});
