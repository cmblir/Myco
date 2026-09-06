// The first-run sample vault. `src-tauri/src/sample_vault.rs` seeds these 51
// notes into a fresh vault so day one is not a blank screen — and on a real
// owner's vault they are 80% of what the Survey draws (51 sample / 9 own / 4
// unresolved, measured). The graph must say so, and must be able to hide them:
// with the sample hidden the same vault is ~9 nodes, which is the truth.
//
// ponytail: detection is a path match against this constant list, so an own
// note that happens to be named wiki/rag.md counts as sample. The safer marker
// is a `seeded: true` frontmatter line written by sample_vault.rs — when that
// lands (Rust, not this slice), replace this list with an adjacency.meta check.

export const SAMPLE_VAULT_PATHS: readonly string[] = [
  "wiki/transformer-architecture.md",
  "wiki/attention-mechanism.md",
  "wiki/self-attention.md",
  "wiki/multi-head-attention.md",
  "wiki/embeddings.md",
  "wiki/tokenization.md",
  "wiki/byte-pair-encoding.md",
  "wiki/positional-encoding.md",
  "wiki/residual-connections.md",
  "wiki/layer-normalization.md",
  "wiki/feedforward-network.md",
  "wiki/scaling-laws.md",
  "wiki/pretraining.md",
  "wiki/compute-budget.md",
  "wiki/fine-tuning.md",
  "wiki/instruction-tuning.md",
  "wiki/rlhf.md",
  "wiki/dpo.md",
  "wiki/reward-modeling.md",
  "wiki/lora.md",
  "wiki/quantization.md",
  "wiki/distillation.md",
  "wiki/inference-optimization.md",
  "wiki/kv-cache.md",
  "wiki/alignment.md",
  "wiki/constitutional-ai.md",
  "wiki/interpretability.md",
  "wiki/in-context-learning.md",
  "wiki/chain-of-thought.md",
  "wiki/prompting.md",
  "wiki/rag.md",
  "wiki/vector-database.md",
  "wiki/tool-use.md",
  "wiki/function-calling.md",
  "wiki/agents.md",
  "wiki/mcp.md",
  "wiki/planning.md",
  "wiki/reasoning.md",
  "wiki/openai.md",
  "wiki/anthropic.md",
  "wiki/google-deepmind.md",
  "wiki/meta-ai.md",
  "wiki/gpt-4.md",
  "wiki/claude.md",
  "wiki/gemini.md",
  "wiki/llama.md",
  "wiki/source-attention-is-all-you-need.md",
  "wiki/source-scaling-laws-paper.md",
  "wiki/source-constitutional-ai-paper.md",
  "wiki/analysis-scaling-vs-data.md",
  "wiki/analysis-rlhf-vs-dpo.md",
];

const SAMPLE_SET = new Set(SAMPLE_VAULT_PATHS);

/** Is the absolute node id one of the seeded sample notes of `vaultRoot`? */
export function isSamplePath(vaultRoot: string, path: string): boolean {
  if (path.startsWith("ghost:")) return false;
  const root = vaultRoot.replace(/[\\/]+$/, "");
  const rel = (root && path.startsWith(root) ? path.slice(root.length) : path)
    .replace(/^[\\/]+/, "")
    .replace(/\\/g, "/");
  return SAMPLE_SET.has(rel);
}
