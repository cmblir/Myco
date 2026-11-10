import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createDiagnosticAnswerContract } from "./diagnosticAnswerContract";
import type { EvidencePassage, ModelContextBudget } from "./modelContextBudget";
import { ModelEvidenceAbstention } from "./answerCitation";
vi.mock("@tauri-apps/api/core", () => ({invoke: vi.fn()}));
const hit = (section: number): EvidencePassage => ({page: "raw/synthetic.md", stem: "synthetic", section, text: `chunk ${section}`, score: 1, similarity: .8});
const args = {task: "query" as const, cwd: "/synthetic", messages: [{role: "user" as const, content: "Synthetic question"}]};
beforeEach(() => vi.resetAllMocks());
it("keeps a native declared abstention distinct from malformed responses and supported answers", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, value) => {
    if ((value as {rawAnswer?: string}).rawAnswer)
      return {answer: "", paths: [], abstained: true, semanticAccepted: false} as never;
    return {system: "policy", user: "original", revision: "fixed", evidence: [hit(1)]} as never;
  });
  const capture = vi.fn(async () => {});
  const adapter: ModelContextBudget = {contextTokens: 4096, outputTokens: 768, countMessages: async () => 100};
  const prepared = await createDiagnosticAnswerContract(adapter, capture)(args, [hit(1)], "");
  await expect(prepared.renderAnswer('{"answer":"","sources":[]}')).rejects.toBeInstanceOf(ModelEvidenceAbstention);
  expect(capture).toHaveBeenCalledWith("contract-rendered", expect.objectContaining({rendered: expect.objectContaining({abstained: true})}));
  vi.mocked(invoke).mockRejectedValueOnce(new Error("changed source"));
  await expect(prepared.renderAnswer('{"answer":"","sources":[]}')).rejects.toThrow("changed source");
});
it("counts the native whole-original packet and keeps omissions without truncating it", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, value) => {
    const input = value as {request: {hits: EvidencePassage[]}; rawAnswer?: string};
    if (input.rawAnswer) return {answer: "Bound answer [[raw/synthetic.md]]", paths: ["raw/synthetic.md"]} as never;
    return {system: "native policy", user: input.request.hits.map(h => `whole turn ${h.section}`).join(" "), revision: "native-revision", evidence: input.request.hits} as never;
  });
  const capture = vi.fn(async () => {});
  const countMessages = vi.fn(async messages => messages[1].content.includes("turn 2") ? 4000 : 2000);
  const adapter: ModelContextBudget = {contextTokens: 4096, outputTokens: 768, countMessages};
  const prepared = await createDiagnosticAnswerContract(adapter, capture)(args, [hit(1), hit(2)], "");
  expect(prepared.messages).toEqual([{role: "system", content: "native policy"}, {role: "user", content: "whole turn 1"}]);
  expect(capture).toHaveBeenCalledWith("contract-packing", expect.objectContaining({promptTokens: 2000, selected: [hit(1)], omitted: [{passage: hit(2), reason: "whole-original packet exceeds token allowance"}]}));
  expect(invoke).toHaveBeenCalledWith("diagnostic_ask_packet", expect.objectContaining({freshIndex: true}));
  await prepared.renderAnswer('{"answer":"Bound answer","sources":["S1"]}');
  expect(invoke).toHaveBeenLastCalledWith("diagnostic_ask_packet", expect.objectContaining({expectedRevision: "native-revision", rawAnswer: expect.any(String)}));
  vi.mocked(invoke).mockRejectedValueOnce(new Error("source changed"));
  await expect(prepared.renderAnswer("raw")).rejects.toThrow("source changed");
});
it("cannot generate if every native source binding is rejected", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("changed after retrieval"));
  const countMessages = vi.fn();
  const capture = vi.fn(async () => {});
  const adapter: ModelContextBudget = {contextTokens: 4096, outputTokens: 768, countMessages};
  await expect(createDiagnosticAnswerContract(adapter, capture)(args, [hit(1)], "")).rejects.toThrow("No verified original packet");
  expect(countMessages).not.toHaveBeenCalled();
  expect(capture).toHaveBeenCalledWith("contract-source-rejected", expect.objectContaining({error: "Error: changed after retrieval"}));
});

it("rejects changed final source bindings before model input is returned", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, value) => {
    const fresh = Boolean((value as {freshIndex?: boolean}).freshIndex);
    return {system: "policy", user: "original", revision: fresh ? "changed" : "first", evidence: [hit(1)]} as never;
  });
  const adapter: ModelContextBudget = {contextTokens: 4096, outputTokens: 768, countMessages: async () => 100};
  await expect(createDiagnosticAnswerContract(adapter, async () => {})(args, [hit(1)], ""))
    .rejects.toThrow("changed before generation");
});
