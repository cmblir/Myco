import { invoke } from "@tauri-apps/api/core";
import type { LocalSynthesisRequest } from "./ipc";
import type { SimpleMessage } from "./chat";
import type { ModelContextBudget, EvidencePassage } from "./modelContextBudget";
import { queryDateRange } from "./timeQuery";
import { ModelEvidenceAbstention } from "./answerCitation";

import { citationEvidenceFromPacket, type CitationEvidence } from "./citationEvidence";

interface Packet { originalPacket?: string; system: string; user: string; revision: string; evidence: EvidencePassage[] }
/** Debug diagnostic registers this explicitly. It does not change a provider's default contract. */
export function createDiagnosticAnswerContract(
  adapter: ModelContextBudget, capture: (kind: string, data: unknown) => Promise<void>,
): NonNullable<ModelContextBudget["prepareInput"]> {
  return async (args, candidates, profileSuffix) => {
    if (profileSuffix) throw new Error("Diagnostic structured contract does not admit profile injection");
    const users = args.messages.filter(message => message.role === "user");
    const base: LocalSynthesisRequest = {
      requestId: `diagnostic-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      question: users.at(-1)?.content ?? "", previousQuestion: users.at(-2)?.content,
      origin: args.origin, roleSnapshot: args.roleSnapshot, expectedVault: args.cwd,
      lang: "ko", scope: args.scope ?? "wiki", paths: args.paths, range: args.range,
      hits: [], maxTokens: adapter.outputTokens,
    };
    const selected: EvidencePassage[] = [], omitted: {passage: EvidencePassage; reason: string}[] = [];
    let packet: Packet | undefined;
    let request = base;
    const messagesFor = (value: Packet): SimpleMessage[] => [
      {role: "system", content: value.system}, {role: "user", content: value.user},
    ];
    const checkStop = () => { if (args.signal?.aborted) throw new Error("stopped"); };
    const count = async (value: Packet) => {
      const tokens = await adapter.countMessages(messagesFor(value));
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("Invalid tokenizer result");
      return tokens;
    };
    const wire = (value: LocalSynthesisRequest) => ({...value,
      range: value.range ? queryDateRange(value.range) : undefined});
    for (const passage of candidates) {
      checkStop();
      if (selected.length >= 12) { omitted.push({passage, reason: "native evidence-count allowance"}); continue; }
      const trial = {...base, hits: [...selected, passage]};
      let next: Packet;
      try {
        next = await invoke<Packet>("diagnostic_ask_packet", {request: wire(trial)});
      } catch (error) {
        await capture("contract-source-rejected", {passage, error: String(error)});
        omitted.push({passage, reason: String(error)}); continue;
      }
      if (await count(next) + adapter.outputTokens > adapter.contextTokens) {
        omitted.push({passage, reason: "whole-original packet exceeds token allowance"}); continue;
      }
      selected.push(passage); packet = next; request = trial;
    }
    checkStop();
    if (!packet) throw new Error("No verified original packet fits the model allowance");
    // Intermediate trials share a captured index. Revalidate against a fresh
    // index before sending any bytes to the model; source changes must stop it.
    const fresh = await invoke<Packet>("diagnostic_ask_packet", {request: wire(request), freshIndex: true});
    if (fresh.revision !== packet.revision || fresh.system !== packet.system || fresh.user !== packet.user)
      throw new Error("Verified source packet changed before generation");
    packet = fresh;
    checkStop();
    const promptTokens = await count(packet);
    if (promptTokens + adapter.outputTokens > adapter.contextTokens) throw new Error("Final structured packet exceeds allowance");
    await capture("contract-packing", {request, packet, selected, omitted, promptTokens,
      contextTokens: adapter.contextTokens, outputTokens: adapter.outputTokens});
    const revision = packet.revision;
    const finalPacket = packet;
    let citationEvidence: CitationEvidence | undefined;
    return {messages: messagesFor(packet), paths: packet.evidence.map(hit => hit.page),
      stems: packet.evidence.map(hit => hit.stem),
      citationEvidence: () => citationEvidence,
      async renderAnswer(raw) {
        citationEvidence = undefined;
        checkStop();
        const rendered = await invoke<{answer: string; paths: string[]; abstained?: boolean}>("diagnostic_ask_packet", {
          request: wire(request), rawAnswer: raw, expectedRevision: revision,
        });
        await capture("contract-rendered", {raw, rendered, revision});
        if (rendered.abstained === true && rendered.answer === "" && rendered.paths.length === 0)
          throw new ModelEvidenceAbstention();
        checkStop();
        citationEvidence = citationEvidenceFromPacket(finalPacket.originalPacket, finalPacket.user, rendered.paths);
        return rendered.answer;
      },
    };
  };
}
