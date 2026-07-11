# Research — Local LLM & Anti-Hallucination for Memex Offline Q&A

Date: 2026-07-11. Method: fan-out web research (google-research-specialist agents) + adversarial fact-verification + codebase grounding, via a background Workflow (12 agents). Prompted by the bundled SEED 0.5B confabulating on Ask (e.g. "최근에 내가 한 일" → invented files/features).

**Status:** behavioral fixes (grounding + git-log routing + provider nudge) SHIPPED (commit 5439745). Model swap = documented follow-up (needs the GGUF asset).

## Model candidates

| Model | Params | License | GGUF / size | Korean/JA |
|---|---|---|---|---|
| Qwen3-0.6B (Instruct) | 0.6B | Apache-2.0 (fully permissive, commercial-safe, n | Yes — official Qwen GGUF + bartowski. Q4_K_M ~0.48 G | Good for the size. Qwen3 officially covers 1 |
| Qwen2.5-0.5B-Instruct | 0.5B | Apache-2.0 (fully permissive). | Yes — official Qwen GGUF. Q4_K_M = 491 MB (near-iden | 29+ languages officially, including Korean a |
| HyperCLOVA X SEED Text-Instruct 1.5B | 1.5B | hyperclovax-seed license — commercial-free under | Community GGUF quantizations available (no first-par | Best-in-class Korean for this tier. Reported |
| Qwen2.5-1.5B-Instruct | 1.5B | Apache-2.0 (fully permissive). | Yes — official Qwen GGUF. Q4_K_M = 1.12 GB. (Qwen3-1 | 29+ languages incl. ko/ja. Solid multilingua |
| Gemma 3 1B (it) | 1B | Gemma Terms of Use (not an OSI license; carries  | Yes — unsloth/others. Q4_K_M = 806 MB. | Gemma 3 as a family claims 140+ languages wi |
| Gemma 3 4B (it) | 4B | Gemma Terms of Use (commercial OK, prohibited-us | Yes. Q4_K_M = 2.49 GB. | Strong — Korean and Japanese are explicitly  |
| Phi-4-mini-instruct | 3.8B | MIT (maximally permissive — the cleanest license | Yes — unsloth/others. Q4_K_M = 2.49 GB. (Phi-3.5-min | 23 languages including Korean and Japanese;  |
| LG EXAONE 3.5 2.4B (Instruct) | 2.4B | EXAONE AI Model License 1.1 - NC = NON-COMMERCIA | Yes — first-party LGAI-EXAONE GGUF. 32K context. (~1 | Excellent — purpose-built Korean+English bil |
| Llama 3.2 1B / 3B (Instruct) | 1B / 3B | Llama 3.2 Community License — custom, not OSI, w | Yes — bartowski, hugging-quants. 1B and 3B Q4_K_M wi | Korean is NOT in Meta's officially supported |
| SmolLM2 360M / 1.7B | 0.36B / 1.7B | Apache-2.0 (permissive). | Yes — HuggingFaceTB official + QuantFactory. Very sm | None meaningful — SmolLM2 is primarily an En |

## Synthesis

This is a synthesis task — the inputs are already provided and verified. I don't need to explore the codebase further; the edit points and verified facts are given. Let me produce the recommendation directly.

# Memex Local-Model & Anti-Hallucination Recommendation

## 1. VERDICT: Local model

**Swap SEED 0.5B → Qwen3-0.6B as the bundled default.** Keep SEED 1.5B as the runner-up / opt-in ko-priority upgrade.

**Why Qwen3-0.6B is the single best drop-in (verified facts only):**
- **Installer cost is a wash.** Q4_K_M = 0.48 GB (~484 MB), essentially identical to the current SEED 0.5B (~0.49 GB). No installer-budget hit — this is the whole reason it wins as a *drop-in*.
- **License is strictly cleaner for the paid model.** Apache-2.0, applied to all Qwen3 dense models incl. the 0.6B. No MAU cap, no competing-service clause. SEED's license is fine today (commercial-free ≤10M MAU) but Apache-2.0 removes the future NAVER-license question entirely — relevant given the memex_web $59/mo distribution.
- **Better at the exact failure mode.** Qwen3 is more reliable at following "answer only from the provided context" grounding prompts than a 0.5B SEED. The verification confirms ko/ja coverage is *deliberate* (Qwen3 blog explicitly names Korean and Japanese among its 119 languages), not incidental.
- **ja coverage matters for a ko/en/ja UI.** SEED's Japanese is weak; Qwen3 covers all three.

**Honest tradeoff:** Korean *depth/cultural knowledge* is weaker than a Korean-native model like SEED. If peak Korean is more important than Japanese and you can spend the installer budget, the runner-up applies.

**Runner-up — HyperCLOVA X SEED 1.5B (verified):** best-in-tier Korean (beats Qwen2.5-1.5B and Gemma-3-1B on KMMLU/HAE-RAE/CLiCK/KoBEST per official 5-shot numbers), 16K context (vs 0.5B's 4K) which directly helps RAG over longer passages, same license family you already ship. **Cost:** community GGUF only (no first-party), q4_k_m = 1.13 GB — roughly +0.65 GB over the 0.5B — and Japanese is not supported. Best as an **opt-in user-downloaded "Korean HQ" model**, not the bundled default.

**Do not bundle:** EXAONE 3.5 2.4B (NC license — forbids commercial use, incompatible with the paid model), Llama 3.2 small (no official ko/ja), SmolLM2 (English-only). Gemma-3-4B / Phi-4-mini are quality-strong but 2.49 GB each — opt-in only, and Gemma Terms add redistribution obligations vs Apache/MIT.

> Note: no model swap fixes "what did I do recently?" — that is a git-log question, not wiki content. See §2.1.

## 2. Anti-hallucination changes to ship NOW (model-independent), ranked by ROI

**1. Grounded/refusal system prompt (effort: low — do first).**
Rewrite `local_llm.rs:318-323` generate prompt and the frontend preambles (`PageQuery.tsx:31-35 SYSTEM_PREAMBLE`, `chat.ts:187-202 withVaultContext`): *"Answer ONLY using the CONTEXT below. If the answer is not in the context, reply exactly: `not in the wiki` (language-matched)."* Pass each chunk's `Record.id` (`<page>#<section>`) so the model can cite. Optionally post-validate emitted `[[...]]` citations against supplied ids and strip invented ones — reuse the existing `classify()` post-validation pattern (`local_llm.rs:245`). Small models follow this imperfectly, so it must sit *on top of* #2/#3, not alone.

**2. Route temporal/meta questions to git_log, never the LLM (effort: medium — highest correctness impact).**
Add a cheap ko/en/ja keyword/regex intent matcher (recently/최근/最近, changed/변경, last edited, history…) in the builtin dispatch (`chat.ts:109-118`) — or before `local_query` in `commands.rs`. On a hit, call `git_log` (`commands.rs:371-378`) / file mtimes and format a factual bullet list in the query language, bypassing the model entirely. This directly kills the reported "what did I do recently?" fabrication.

**3. Retrieval gating + abstention (effort: medium).**
Wire retrieval into the answer path and gate on it: embed query → top-K → if max `Hit.score` < calibrated threshold, return the structured refusal + escalation offer instead of generating. Weak/empty retrieval is the primary confabulation cause; the retrieval score is a more reliable abstain signal than a 0.5B's token probabilities. **Calibrate the threshold empirically against your SEED embeddings — do not hardcode a guessed constant.**

**4. Contextual chunking + hybrid keyword pass (effort: medium).**
In the indexing path, prepend page stem + heading trail (+ optional one-line summary) to each chunk *before* embedding — costs nothing at query time. Add a cheap Rust BM25/keyword pass over the same chunks so exact-name matches (people, filenames) that a 0.6B embedding misses still surface. Improves *what* retrieval returns, which upstreams into #1/#3.

**5. Reranking (effort: high — defer/gate on installer budget).**
Two-stage: bi-encoder top ~20 → keep top 3-5. Start with a *heuristic* rerank (keyword overlap + section-title match + recency) — no model, no installer cost. A GGUF cross-encoder is optional given the ≤~10k-page brute-force store; only add it if the heuristic proves insufficient.

## 3. UX: when the builtin is the wrong tool

When retrieval gating (#3) trips, the query is classified hard/multi-hop, or the model refuses, **never render a fabricated success.** Show the honest empty/refusal state (per the 5-state UI rule) and surface a **non-blocking nudge** in the React answer panel: *"This looks like it needs a stronger model — answer with Claude / OpenAI / Gemini?"* wired to the existing `providers.rs` / `cli_agent.rs` agent-loop paths. This respects offline-first: the local model already tried first, and **no data leaves the machine unless the user explicitly clicks.** Keep any escalated agent loop's stop condition explicit (max iterations + satisfaction check).

## 4. Ordered action list for implementation

1. **Ship the grounded/refusal prompt** (#1) — `local_llm.rs:318-323`, `PageQuery.tsx:31-35`, `chat.ts:187-202`. Language-matched `not in the wiki` refusal + citation ids. *(low effort, immediate)*
2. **Add the temporal/meta intent router** (#2) — `chat.ts:109-118` → `git_log` (`commands.rs:371-378`) / mtimes. Kills the "recent activity" hallucination. *(highest correctness ROI)*
3. **Add retrieval gating + abstention** (#3) into `local_query`/`answer_query` using `VectorStore::search` `Hit.score`; calibrate the threshold on real queries.
4. **Wire the provider-escalation nudge** (§3) to the gate/refusal state in the answer panel → `providers.rs` / `cli_agent.rs`.
5. **Swap the bundled model** SEED 0.5B → **Qwen3-0.6B** (Apache-2.0, ~484 MB q4_k_m). Same install path, non-thinking mode for terse grounded QA. Re-check the grounding prompt reads well on Qwen's tokenizer.
6. **Improve indexing** (#4): contextual chunk prefixes + BM25 hybrid pass.
7. **(Optional, gated on budget)** heuristic rerank first (#5); add a GGUF cross-encoder only if needed. Offer **SEED 1.5B** and **Gemma-3-4B / Phi-4-mini** as opt-in user-downloaded models for ko-HQ / high-quality tiers.

**Sequencing rationale:** steps 1-3 are model-independent and fix the *behavior* (grounding, routing, abstention) — they reduce hallucination even before any swap. The model swap (step 5) is low-risk (same footprint, same install path) but secondary, because a bigger/better model without grounding + routing would still fabricate on temporal questions.
