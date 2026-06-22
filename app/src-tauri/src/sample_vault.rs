// Sample interconnected wiki notes seeded into a fresh vault so the Graph,
// Provenance, and Overview views are populated on first launch instead of
// showing an empty canvas. Every page follows the vault CLAUDE.md schema
// (YAML frontmatter + inline [^src-*] citations + [[wikilinks]]), so the link
// graph forms real communities and the citation coverage view has data.
//
// Seeding is idempotent (write-if-missing), so a user can delete any of these
// and they won't reappear unless the file is gone. Generated content — demo data.

/// (relative path under the vault root, file content).
pub const SAMPLE_NOTES: &[(&str, &str)] = &[
    (
        "wiki/transformer-architecture.md",
        r#"---
title: "Transformer Architecture"
type: concept
tags:
  - concept
created: 2024-01-01
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Transformer Architecture

The [[transformer-architecture|Transformer]] is a neural network design built entirely on the [[attention-mechanism|attention mechanism]], dispensing with recurrence and convolution to enable fully parallel sequence processing.[^src-attention-is-all-you-need] Input text is converted into discrete units by [[tokenization]] and then mapped to dense vectors through [[embeddings]], with [[positional-encoding]] added so the otherwise order-agnostic model can reason about sequence position.[^src-attention-is-all-you-need] Each layer combines attention with a [[feedforward-network]], wrapped in [[residual-connections]] that ease gradient flow through deep stacks. This architecture underpins virtually all modern large language models and is the substrate on which [[scaling-laws]] predict performance gains from larger models and more data.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/attention-mechanism.md",
        r#"---
title: "Attention Mechanism"
type: technique
tags:
  - technique
created: 2024-01-02
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Attention Mechanism

The [[attention-mechanism|attention mechanism]] lets a model weigh the relevance of every input token to every other token, producing context-aware representations by computing weighted sums of value vectors based on query-key similarity.[^src-attention-is-all-you-need] In the [[transformer-architecture|Transformer]] this takes the form of [[self-attention]], where queries, keys, and values all derive from the same sequence of [[embeddings]], and it is typically applied as [[multi-head-attention]] to capture different relational patterns in parallel. Because attention scales quadratically with sequence length, inference systems cache previously computed keys and values in a [[kv-cache]] to avoid recomputation during autoregressive generation. This mechanism replaced recurrence as the primary means of modeling long-range dependencies in sequence data.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/self-attention.md",
        r#"---
title: "Self-Attention"
type: technique
tags:
  - technique
created: 2024-01-03
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Self-Attention

[[self-attention|Self-attention]] is the form of the [[attention-mechanism|attention mechanism]] in which the queries, keys, and values are all projected from the same input sequence, allowing each token to attend to every other token within that sequence.[^src-attention-is-all-you-need] This intra-sequence comparison lets the model build representations where each position is informed by the full surrounding context, which is what enables Transformers to capture long-range dependencies in a single layer. In practice self-attention is run multiple times in parallel as [[multi-head-attention]], with each head learning to focus on distinct syntactic or semantic relationships.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/multi-head-attention.md",
        r#"---
title: "Multi-Head Attention"
type: technique
tags:
  - technique
created: 2024-01-04
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Multi-Head Attention

[[multi-head-attention|Multi-head attention]] runs several independent [[attention-mechanism|attention]] computations in parallel, each operating on a separately learned linear projection of the queries, keys, and values.[^src-attention-is-all-you-need] By splitting the representation into multiple lower-dimensional subspaces, each head can specialize in a different type of relationship — for example one head tracking syntactic dependencies while another tracks coreference — and their outputs are concatenated and projected back to the model dimension. This makes it strictly more expressive than a single [[self-attention]] computation of the same total width, which is why it is the standard attention layer in every modern Transformer.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/embeddings.md",
        r#"---
title: "Embeddings"
type: concept
tags:
  - concept
created: 2024-01-05
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Embeddings

[[embeddings|Embeddings]] are dense, continuous vector representations that map discrete tokens into a geometric space where semantic and syntactic similarity corresponds to spatial proximity. In the [[transformer-architecture|Transformer]], the units produced by [[tokenization]] are looked up in an embedding table to form the input vectors that the [[attention-mechanism|attention mechanism]] operates over.[^src-attention-is-all-you-need] These learned vectors are trained jointly with the rest of the network rather than fixed in advance, so they capture relationships specific to the model's training objective. The same representational idea powers a [[vector-database]], which stores embeddings to enable similarity search over large document collections.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/tokenization.md",
        r#"---
title: "Tokenization"
type: technique
tags:
  - technique
created: 2024-01-06
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Tokenization

[[tokenization|Tokenization]] is the process of splitting raw text into discrete units — tokens — that a model can map to [[embeddings]] before processing. Modern language models built on the [[transformer-architecture|Transformer]] rely on subword tokenization, most commonly [[byte-pair-encoding]], which strikes a balance between character-level and word-level granularity and keeps the vocabulary at a fixed, manageable size.[^src-attention-is-all-you-need] Subword schemes let the model represent rare or unseen words by composing them from smaller known pieces, avoiding the out-of-vocabulary problem of word-level approaches. The choice of tokenizer directly affects sequence length, computational cost, and how efficiently text is encoded.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/byte-pair-encoding.md",
        r#"---
title: "Byte-Pair Encoding"
type: technique
tags:
  - technique
created: 2024-01-07
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Byte-Pair Encoding

[[byte-pair-encoding|Byte-Pair Encoding]] (BPE) is a subword [[tokenization]] algorithm that starts from individual characters or bytes and iteratively merges the most frequently co-occurring pair into a single new token, repeating until a target vocabulary size is reached.[^src-attention-is-all-you-need] The resulting vocabulary represents common words as single tokens while still being able to break rare words into reusable subword fragments, which eliminates out-of-vocabulary failures. Because it learns its merges from corpus statistics, BPE produces a compact, data-driven vocabulary that has become a default choice for large language models.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/positional-encoding.md",
        r#"---
title: "Positional Encoding"
type: technique
tags:
  - technique
created: 2024-01-08
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Positional Encoding

[[positional-encoding|Positional encoding]] injects information about token order into the [[transformer-architecture|Transformer]], which is otherwise permutation-invariant because the [[attention-mechanism|attention mechanism]] treats its inputs as an unordered set.[^src-attention-is-all-you-need] The original Transformer added fixed sinusoidal functions of varying frequency to the input vectors, giving each position a unique signature that the model can use to infer relative and absolute distance.[^src-attention-is-all-you-need] Later variants replaced these with learned or rotary schemes, but the core requirement is unchanged: without positional information attention alone cannot distinguish the order of a sequence.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/residual-connections.md",
        r#"---
title: "Residual Connections"
type: concept
tags:
  - concept
created: 2024-01-09
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Residual Connections

Residual connections are skip connections that add a sublayer's input directly to its output, computed as `x + Sublayer(x)`, allowing gradients to flow unimpeded through deep networks. In the [[transformer-architecture]], a residual connection wraps every attention and feedforward sublayer, which is essential for training the deep stacks of layers that transformers rely on.[^src-attention-is-all-you-need] The residual path is followed by [[layer-normalization]], so the canonical formulation is `LayerNorm(x + Sublayer(x))`. By preserving an identity path, residual connections mitigate the vanishing-gradient problem and let each sublayer learn a refinement of its input rather than a full transformation.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/layer-normalization.md",
        r#"---
title: "Layer Normalization"
type: technique
tags:
  - technique
created: 2024-01-10
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Layer Normalization

Layer normalization normalizes the activations across the feature dimension for each individual token, rescaling them to zero mean and unit variance before applying a learned gain and bias. In the original [[transformer-architecture]] it is applied after each [[residual-connections|residual connection]] in the post-norm configuration `LayerNorm(x + Sublayer(x))`.[^src-attention-is-all-you-need] Unlike batch normalization, it does not depend on batch statistics, which makes it well suited to variable-length sequences and small or single-example batches common in language modeling. Many modern variants instead place the normalization before the sublayer (pre-norm), which tends to stabilize training of very deep transformers.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/feedforward-network.md",
        r#"---
title: "Feedforward Network"
type: concept
tags:
  - concept
created: 2024-01-11
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Feedforward Network

The position-wise feedforward network is the second sublayer in each transformer block, applying two linear transformations with a nonlinearity in between to every token position independently and identically. In the [[transformer-architecture]], it typically expands the model dimension to a larger inner dimension (often four times wider) before projecting back down, giving the model most of its parameters and representational capacity.[^src-attention-is-all-you-need] Because it operates on each position separately, the feedforward network contributes no cross-token mixing; that role is left entirely to the attention sublayers. It can be viewed as a per-token key-value memory that transforms the contextualized representations produced by attention.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/scaling-laws.md",
        r#"---
title: "Scaling Laws"
type: concept
tags:
  - concept
created: 2024-01-12
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Scaling Laws

Scaling laws describe how a language model's loss decreases as a smooth power-law function of three resources: model size (parameters), dataset size, and the [[compute-budget]] spent during [[pretraining]]. Empirically, performance improves predictably across many orders of magnitude, and for a fixed compute budget there is an optimal allocation between making the model larger and training it on more data.[^src-scaling-laws-paper] These relationships hold for the [[transformer-architecture]] in particular and let practitioners forecast the returns of a planned training run before committing resources. The tension between adding parameters versus adding data is examined further in [[analysis-scaling-vs-data]].

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
"#,
    ),
    (
        "wiki/pretraining.md",
        r#"---
title: "Pretraining"
type: technique
tags:
  - technique
created: 2024-01-13
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Pretraining

Pretraining is the initial, large-scale self-supervised training phase in which a model learns general language representations from vast unlabeled text, typically by predicting the next token. It establishes the broad knowledge and capabilities of the [[transformer-architecture]] before any task-specific adaptation, and its returns follow predictable [[scaling-laws]] as model size, data, and compute grow.[^src-scaling-laws-paper] The resulting base model is rarely deployed directly; instead it serves as a foundation for [[fine-tuning]] on narrower objectives or human preferences. Pretraining dominates the total compute cost of building a frontier model, which makes efficient resource allocation central to the process.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
"#,
    ),
    (
        "wiki/compute-budget.md",
        r#"---
title: "Compute Budget"
type: concept
tags:
  - concept
created: 2024-01-14
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Compute Budget

The compute budget is the total amount of computation, usually measured in floating-point operations (FLOPs), available for training a model, and it acts as the primary constraint on what scale of model can be built. Under [[scaling-laws]], a fixed compute budget defines an optimal trade-off between model size and dataset size, since spending more on one means spending less on the other.[^src-scaling-laws-paper] Compute-optimal training seeks the parameter-to-token ratio that minimizes loss for the available budget rather than simply maximizing model size. At inference time, the effective budget can be stretched through techniques such as [[quantization]], which lowers the numerical precision of weights to reduce memory and computation.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
"#,
    ),
    (
        "wiki/fine-tuning.md",
        r#"---
title: "Fine-tuning"
type: technique
tags:
  - technique
created: 2024-01-15
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Fine-tuning

Fine-tuning adapts a [[pretraining|pretrained]] base model to a specific task, domain, or behavior by continuing training on a smaller, targeted dataset. It builds on the broad capabilities a model acquires during pretraining, which follow predictable scaling behavior, and requires far less data and compute than training from scratch.[^src-scaling-laws-paper] Common forms include [[instruction-tuning]] to teach the model to follow natural-language commands and [[rlhf]] to align outputs with human preferences. To make adaptation cheaper, parameter-efficient methods such as [[lora]] update only a small set of low-rank matrices while leaving the original weights frozen.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
"#,
    ),
    (
        "wiki/instruction-tuning.md",
        r#"---
title: "Instruction Tuning"
type: technique
tags:
  - technique
created: 2024-01-16
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Instruction Tuning

Instruction tuning is a form of [[fine-tuning]] that trains a model on many examples of natural-language instructions paired with desired responses, teaching it to follow user commands rather than merely continue text. This transforms a raw next-token predictor into an assistant that generalizes to instructions it has never seen during training.[^src-constitutional-ai-paper] It is typically the first alignment step and is often followed by preference-based methods such as [[rlhf]] that further refine the model's helpfulness and safety. Instruction tuning relies on diverse, high-quality demonstration data, since the breadth of instruction formats it sees largely determines how well it generalizes.

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
"#,
    ),
    (
        "wiki/rlhf.md",
        r#"---
title: "RLHF"
type: technique
tags:
  - technique
created: 2024-01-17
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# RLHF

Reinforcement Learning from Human Feedback (RLHF) is a [[fine-tuning]] method that aligns a pretrained language model with human preferences by training a [[reward-modeling|reward model]] on ranked human comparisons and then optimizing the policy against it, typically with PPO. The reward model converts pairwise human judgments into a scalar signal, and the policy is updated to maximize that reward while a KL penalty keeps it close to the original model. RLHF became the dominant [[alignment]] technique behind instruction-following assistants developed at [[openai]] and [[anthropic]], where it shaped behavior such as helpfulness and harmlessness.[^src-constitutional-ai-paper] Its multi-stage, reinforcement-learning pipeline is comparatively complex and unstable, which motivated simpler alternatives such as [[dpo]] that optimize preferences directly without a separate reward model or RL loop.

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
"#,
    ),
    (
        "wiki/dpo.md",
        r#"---
title: "Direct Preference Optimization"
type: technique
tags:
  - technique
created: 2024-01-18
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Direct Preference Optimization

Direct Preference Optimization (DPO) is a preference-tuning technique that fits a language model to human preference data using a single classification-style loss, eliminating the explicit reward model and reinforcement-learning loop of [[rlhf]]. It derives a closed-form relationship between the optimal policy and the preference distribution, so the model is trained directly on chosen-versus-rejected response pairs. This makes DPO substantially simpler and more stable to train while still pursuing the same [[alignment]] goal of matching human preferences.[^src-constitutional-ai-paper] The practical trade-offs between the two approaches are examined in [[analysis-rlhf-vs-dpo]].

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
"#,
    ),
    (
        "wiki/reward-modeling.md",
        r#"---
title: "Reward Modeling"
type: concept
tags:
  - concept
created: 2024-01-19
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Reward Modeling

Reward modeling is the practice of training a model to predict a scalar quality score for candidate outputs, usually learned from human pairwise comparisons of which response is better. The resulting reward model serves as the optimization target in [[rlhf]], converting noisy human judgments into a differentiable signal that a policy can be trained against. Because it encodes human values into a learned proxy, reward modeling is central to [[alignment]], but it is also vulnerable to reward hacking and to distribution shift as the policy drifts from the data the reward model was trained on.[^src-constitutional-ai-paper] Constitutional methods reduce reliance on dense human labels by using AI-generated feedback to train the reward model.[^src-constitutional-ai-paper]

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
"#,
    ),
    (
        "wiki/lora.md",
        r#"---
title: "LoRA"
type: technique
tags:
  - technique
created: 2024-01-20
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# LoRA

Low-Rank Adaptation (LoRA) is a parameter-efficient [[fine-tuning]] technique that freezes the pretrained weights and injects small trainable low-rank matrices into each layer, so only a tiny fraction of parameters are updated. This dramatically reduces memory and storage costs, since the base model stays fixed and each task only requires storing the compact adapter weights. LoRA composes well with [[quantization]]: in the QLoRA variant the frozen base model is held in 4-bit precision while the low-rank adapters are trained in higher precision, enabling fine-tuning of very large models on a single GPU.[^src-scaling-laws-paper]

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
"#,
    ),
    (
        "wiki/quantization.md",
        r#"---
title: "Quantization"
type: technique
tags:
  - technique
created: 2024-01-21
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Quantization

Quantization reduces the numerical precision of a model's weights and activations, for example from 16-bit floats to 8-bit or 4-bit integers, shrinking memory footprint and speeding up arithmetic. It is a leading form of [[inference-optimization]] because lower-precision matrix multiplications are cheaper and reduce the memory bandwidth that bottlenecks large-model serving.[^src-scaling-laws-paper] Quantization is often combined with [[lora]] for efficient fine-tuning of compressed models and is complementary to [[distillation]], which instead shrinks a model by training a smaller student. By lowering the cost of deploying a fixed model, it shifts the practical [[compute-budget]] from one-time training toward sustainable serving.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
"#,
    ),
    (
        "wiki/distillation.md",
        r#"---
title: "Knowledge Distillation"
type: technique
tags:
  - technique
created: 2024-01-22
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Knowledge Distillation

Knowledge distillation trains a smaller student model to imitate the outputs of a larger teacher model, transferring capability into a more compact and cheaper-to-run network. Rather than learning only from hard labels, the student is typically trained on the teacher's soft probability distributions, which carry richer information about how the teacher generalizes.[^src-scaling-laws-paper] Distillation is a form of [[fine-tuning]] aimed at compression and is complementary to [[quantization]]: distillation reduces the number of parameters while quantization reduces the precision of each one, and the two are often applied together.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
"#,
    ),
    (
        "wiki/inference-optimization.md",
        r#"---
title: "Inference Optimization"
type: concept
tags:
  - concept
created: 2024-01-23
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Inference Optimization

Inference optimization covers the techniques used to lower the latency, throughput, and memory cost of serving a trained language model, as opposed to reducing training cost. Key approaches include [[quantization]] to cut precision, batching, speculative decoding, and the [[kv-cache]], which stores previously computed attention keys and values so each new token avoids recomputing the full sequence.[^src-scaling-laws-paper] Because large-model serving is frequently bound by memory bandwidth rather than raw compute, these methods target the data movement that dominates per-token cost. Effective inference optimization is essential for deploying large models economically at scale.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
"#,
    ),
    (
        "wiki/kv-cache.md",
        r#"---
title: "KV Cache"
type: technique
tags:
  - technique
created: 2024-01-24
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# KV Cache

The KV cache is an [[inference-optimization]] technique that stores the key and value tensors computed by the [[attention-mechanism]] for all previously processed tokens, so they are not recomputed at every decoding step. During autoregressive generation each new token only needs to compute its own query and attend over the cached keys and values, turning per-token attention cost from quadratic recomputation into a single incremental step.[^src-attention-is-all-you-need] The trade-off is memory: the cache grows linearly with sequence length and batch size, making it a primary consumer of GPU memory during long-context generation. This memory pressure motivates further optimizations such as cache quantization, grouped-query attention, and paged cache management.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/alignment.md",
        r#"---
title: "Alignment"
type: concept
tags:
  - concept
created: 2024-01-25
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Alignment

Alignment is the problem of ensuring that a model's behavior reflects human intentions and values, rather than merely optimizing a proxy objective like next-token prediction. Practical alignment pipelines combine techniques such as [[rlhf]] and [[constitutional-ai]], both of which depend on [[reward-modeling]] to convert human or AI preferences into a training signal. Models can be trained to be helpful and harmless by learning from feedback that encodes desired behavior rather than from explicit rules alone[^src-constitutional-ai-paper]. [[interpretability]] complements these behavioral methods by attempting to verify *why* a model acts as it does, and labs such as [[anthropic]] treat alignment as a central research priority spanning both training and analysis.

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
"#,
    ),
    (
        "wiki/constitutional-ai.md",
        r#"---
title: "Constitutional AI"
type: technique
tags:
  - technique
created: 2024-01-26
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Constitutional AI

Constitutional AI (CAI) is an [[alignment]] technique developed at [[anthropic]] in which a model is trained to follow a written set of principles (a "constitution") with minimal human-labeled harmfulness data. The method has two phases: a supervised stage where the model critiques and revises its own responses against the constitution, and a reinforcement-learning stage that uses AI-generated preference labels in place of human ones, a process often called RLAIF[^src-constitutional-ai-paper]. This contrasts with standard [[rlhf]], which relies heavily on human annotators to rank outputs for harmlessness. CAI aims to make models both more harmless and more transparent, since the principles guiding behavior are explicit and auditable[^src-constitutional-ai-paper].

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
"#,
    ),
    (
        "wiki/interpretability.md",
        r#"---
title: "Interpretability"
type: concept
tags:
  - concept
created: 2024-01-27
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Interpretability

Interpretability is the study of understanding the internal mechanisms of neural networks—what features they represent and how those features drive outputs. It is a key complement to behavioral [[alignment]] work, because verifying that a model is safe ideally requires understanding *why* it behaves as it does, not just observing that it produces acceptable outputs. Research labs including [[anthropic]] invest in mechanistic interpretability to make model decision-making auditable, motivated by the view that training models to be transparent and harmless is more robust than relying on outputs alone[^src-constitutional-ai-paper]. Progress in the field aims to turn opaque networks into systems whose reasoning can be inspected and trusted.

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
"#,
    ),
    (
        "wiki/in-context-learning.md",
        r#"---
title: "In-Context Learning"
type: concept
tags:
  - concept
created: 2024-01-28
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# In-Context Learning

In-context learning is the ability of a large language model to perform a new task purely from examples or instructions placed in its prompt, without any gradient updates to its weights. This capability emerges from the [[transformer-architecture]], whose attention mechanism lets the model condition its next-token predictions on patterns demonstrated earlier in the same context window[^src-attention-is-all-you-need]. By supplying a few input-output examples (few-shot prompting), users can steer behavior at inference time, and structured variants like [[chain-of-thought]] extend this by demonstrating intermediate reasoning steps. In-context learning is the foundation for most modern [[prompting]] techniques, since it turns the prompt itself into the primary interface for specifying tasks.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/chain-of-thought.md",
        r#"---
title: "Chain-of-Thought"
type: technique
tags:
  - technique
created: 2024-02-01
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Chain-of-Thought

Chain-of-thought (CoT) is a prompting technique in which a model is encouraged to generate intermediate reasoning steps before producing a final answer. It is a specialization of [[in-context-learning]]: by including worked examples that show step-by-step reasoning, the model learns at inference time to externalize its [[reasoning]] rather than jumping straight to a conclusion. This decomposition tends to improve performance on multi-step problems such as arithmetic and logic, because it lets the model allocate more computation across tokens. CoT is one of the most influential [[prompting]] strategies, and its effectiveness rests on the transformer's capacity to attend over its own generated context[^src-attention-is-all-you-need].

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/prompting.md",
        r#"---
title: "Prompting"
type: technique
tags:
  - technique
created: 2024-02-02
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Prompting

Prompting is the practice of crafting the input text given to a language model in order to elicit a desired behavior or output. Because models exhibit [[in-context-learning]], the prompt functions as a lightweight programming interface: instructions, examples, and formatting all shape the model's response without changing its weights. Techniques range from simple zero-shot instructions to structured methods like [[chain-of-thought]], which adds explicit reasoning steps, and retrieval patterns such as [[rag]], which inject external documents into the prompt. The model's sensitivity to context arises directly from the attention mechanism, which lets every output token depend on the full prompt[^src-attention-is-all-you-need].

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/rag.md",
        r#"---
title: "Retrieval-Augmented Generation"
type: technique
tags:
  - technique
created: 2024-02-03
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Retrieval-Augmented Generation

Retrieval-Augmented Generation (RAG) is a technique that grounds a model's output in external documents retrieved at inference time, rather than relying solely on knowledge stored in its weights. A typical pipeline encodes both queries and documents as [[embeddings]], stores them in a [[vector-database]], retrieves the most semantically similar passages, and injects them into the model's context as part of [[prompting]]. This reduces hallucination and lets models access up-to-date or proprietary information, and retrieval can be exposed to the model as a form of [[tool-use]]. RAG works because the transformer can attend over retrieved context to condition its generation on the supplied evidence[^src-attention-is-all-you-need].

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/vector-database.md",
        r#"---
title: "Vector Database"
type: concept
tags:
  - concept
created: 2024-02-04
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Vector Database

A vector database is a specialized data store that indexes high-dimensional [[embeddings]] and supports fast approximate nearest-neighbor search over them. Instead of matching exact keywords, it retrieves items by semantic similarity, ranking stored vectors by their distance to a query vector. This makes vector databases a core component of [[rag]] systems, where they hold encoded document chunks and return the most relevant passages to be inserted into a model's context. Their effectiveness depends on the quality of the embeddings, which map semantically related text to nearby points in vector space[^src-attention-is-all-you-need].

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/tool-use.md",
        r#"---
title: "Tool Use"
type: technique
tags:
  - technique
created: 2024-02-05
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Tool Use

Tool use is the capability of a language model to invoke external systems—search engines, calculators, databases, or APIs—to extend its reasoning beyond what is stored in its weights. It is the foundational mechanism that turns a passive text generator into one of the [[agents]] capable of acting on the world, typically implemented through [[function-calling]] interfaces that expose structured tool schemas to the model. A common pattern is retrieval, where [[rag]] fetches relevant documents into the context window before generation, grounding outputs in external knowledge. Standardized protocols such as [[mcp]] aim to make tool connections portable across different models and host applications. The Transformer's attention-based architecture, which lets the model condition flexibly on injected context, is what makes consuming tool outputs at inference time practical.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/function-calling.md",
        r#"---
title: "Function Calling"
type: technique
tags:
  - technique
created: 2024-02-06
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Function Calling

Function calling is the technique by which a language model emits a structured request—usually JSON specifying a function name and arguments—that an external runtime executes before returning the result to the model. It is the concrete protocol layer that implements [[tool-use]], turning natural-language intent into machine-executable calls that the surrounding application can dispatch. This mechanism is what allows [[agents]] to interact deterministically with code, databases, and services rather than producing free-form text that must be parsed heuristically. The model's ability to attend over a tool schema and produce well-formed arguments rests on the same attention machinery that lets Transformers map inputs to structured outputs.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/agents.md",
        r#"---
title: "Agents"
type: concept
tags:
  - concept
created: 2024-02-07
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Agents

Agents are systems that wrap a language model in a loop of observation, decision, and action, allowing the model to pursue multi-step goals rather than answer a single prompt. They rely on [[tool-use]] to affect external state and increasingly on standardized interfaces like [[mcp]] to discover and connect to those tools in a portable way. Effective agents decompose problems through [[planning]] and structured [[reasoning]], often surfacing intermediate steps via [[chain-of-thought]] so that errors can be caught and corrected before final actions are taken. The Transformer's self-attention lets a model condition each step on the full trajectory of prior observations and actions held in its context window.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/mcp.md",
        r#"---
title: "Model Context Protocol"
type: concept
tags:
  - concept
created: 2024-02-08
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Model Context Protocol

The Model Context Protocol (MCP) is an open standard for connecting language models to external tools, data sources, and prompts through a uniform client-server interface. Introduced by [[anthropic]], it aims to replace bespoke per-integration glue with a single protocol, letting [[agents]] discover and invoke capabilities without custom code for each backend. MCP servers expose resources and actions that a host application surfaces to the model as structured [[tool-use]] options, decoupling the model from the specific systems it operates on. Because the model consumes these descriptions and results as in-context text, the same attention-based conditioning that powers Transformers is what makes protocol-driven tool integration tractable.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/planning.md",
        r#"---
title: "Planning"
type: concept
tags:
  - concept
created: 2024-02-09
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Planning

Planning is the process by which an agent decomposes a high-level goal into an ordered sequence of subgoals or actions before or during execution. Within [[agents]], planning provides the scaffolding that turns isolated model calls into coherent multi-step behavior, often interleaving with [[reasoning]] to evaluate which next action best advances the objective. Approaches range from generating an explicit plan up front to iterative replanning that revises the strategy as new observations arrive. The model's capacity to hold and revise a plan across many steps depends on attending over the accumulated context, the core operation introduced in the Transformer architecture.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/reasoning.md",
        r#"---
title: "Reasoning"
type: concept
tags:
  - concept
created: 2024-02-10
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Reasoning

Reasoning refers to a language model's ability to derive conclusions through intermediate inferential steps rather than retrieving an answer directly. The most widely used elicitation method is [[chain-of-thought]], which prompts the model to articulate its intermediate steps and measurably improves performance on arithmetic and logic tasks. Reasoning underpins effective [[planning]] in [[agents]], since selecting the next action requires evaluating consequences and constraints over the current state. These capabilities emerge from the Transformer's attention mechanism, which lets the model relate distant tokens and build up multi-step inferences within a single forward pass.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/openai.md",
        r#"---
title: "OpenAI"
type: entity
tags:
  - entity
created: 2024-02-11
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# OpenAI

OpenAI is an AI research company best known for the GPT series of large language models, including [[gpt-4]]. Its researchers authored influential work on [[scaling-laws]], showing that model loss falls as a predictable power-law function of parameters, data, and compute, which shaped the field's bet on ever-larger pretraining runs.[^src-scaling-laws-paper] OpenAI also popularized [[rlhf]] as the dominant technique for aligning base models with human preferences, using it to make conversational systems follow instructions and avoid harmful outputs. The company's products span chat, code generation, and a developer API exposing its frontier models.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
"#,
    ),
    (
        "wiki/anthropic.md",
        r#"---
title: "Anthropic"
type: entity
tags:
  - entity
created: 2024-02-12
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Anthropic

Anthropic is an AI safety research company and the maker of the [[claude]] family of language models. It is the originator of [[constitutional-ai]], a training method that uses a written set of principles to have a model critique and revise its own outputs, reducing reliance on large volumes of human-labeled harmfulness data.[^src-constitutional-ai-paper] The approach builds on [[rlhf]] but substitutes AI-generated feedback for much of the human preference labeling, advancing the company's broader focus on [[alignment]]. Anthropic also introduced the Model Context Protocol ([[mcp]]), an open standard for connecting models to external tools and data sources.

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
"#,
    ),
    (
        "wiki/google-deepmind.md",
        r#"---
title: "Google DeepMind"
type: entity
tags:
  - entity
created: 2024-02-13
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Google DeepMind

Google DeepMind is the artificial intelligence research division of Google, formed in 2023 by merging DeepMind with the Google Brain team. It develops the [[gemini]] family of large multimodal models, which are built on the [[transformer-architecture]] and rely on the [[attention-mechanism]] introduced for sequence modeling [^src-attention-is-all-you-need]. The organization is known for research milestones spanning reinforcement learning, protein structure prediction, and frontier language models. Its work places it among the leading industrial AI labs competing at the frontier of generative models.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/meta-ai.md",
        r#"---
title: "Meta AI"
type: entity
tags:
  - entity
created: 2024-02-14
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Meta AI

Meta AI is the artificial intelligence research organization at Meta Platforms, responsible for the open-weight [[llama]] family of large language models. By releasing model weights publicly, Meta AI has enabled a broad ecosystem of downstream adaptation, including parameter-efficient methods such as [[lora]] that let practitioners customize models on modest hardware. Llama models follow the standard decoder-only design whose core building block is the attention mechanism introduced for transformers [^src-attention-is-all-you-need]. This open-release strategy distinguishes Meta AI from labs that ship only closed, API-gated models.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/gpt-4.md",
        r#"---
title: "GPT-4"
type: entity
tags:
  - entity
created: 2024-02-15
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# GPT-4

GPT-4 is a large multimodal language model developed by [[openai]] and released in 2023, succeeding the GPT-3 line. It is built on the [[transformer-architecture]], whose self-attention foundation enables modeling of long-range dependencies in text [^src-attention-is-all-you-need]. After pretraining, the model was aligned to human preferences using [[rlhf]], which shapes its instruction-following and refusal behavior. GPT-4 demonstrated strong performance across professional and academic benchmarks, marking a notable step up in general capability over earlier generations.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/claude.md",
        r#"---
title: "Claude"
type: entity
tags:
  - entity
created: 2024-02-16
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Claude

Claude is a family of large language models developed by [[anthropic]], designed with an emphasis on helpfulness, harmlessness, and honesty. Its alignment relies heavily on [[constitutional-ai]], a method in which the model critiques and revises its own outputs against a written set of principles rather than depending solely on human-labeled harm feedback [^src-constitutional-ai-paper]. Claude supports the [[mcp]] standard for connecting to external tools and data sources, extending its capabilities beyond text generation. The models are built on the transformer foundation that underpins modern large language models.

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
"#,
    ),
    (
        "wiki/gemini.md",
        r#"---
title: "Gemini"
type: entity
tags:
  - entity
created: 2024-02-17
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Gemini

Gemini is the family of large multimodal models developed by [[google-deepmind]], capable of processing text, images, audio, and other modalities within a single model. It is built on the [[transformer-architecture]], whose attention-based design enables effective modeling of long sequences [^src-attention-is-all-you-need]. Gemini was positioned as Google's flagship competitor to other frontier models, spanning variants tuned for different latency and capability tradeoffs. Its multimodal training is intended to support reasoning that integrates information across input types.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/llama.md",
        r#"---
title: "Llama"
type: entity
tags:
  - entity
created: 2024-02-18
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Llama

Llama is a family of open-weight large language models released by [[meta-ai]], spanning multiple parameter scales for both research and production use. Because the weights are openly available, Llama models are widely used as a base for [[fine-tuning]] on domain-specific tasks. Parameter-efficient techniques such as [[lora]] make this adaptation cheap by training only a small set of low-rank update matrices instead of all weights. Llama uses the decoder-only transformer design whose core mechanism is the attention layer introduced for sequence transduction [^src-attention-is-all-you-need].

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/source-attention-is-all-you-need.md",
        r#"---
title: "Source: Attention Is All You Need"
type: source-summary
tags:
  - source-summary
created: 2024-02-19
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Source: Attention Is All You Need

This 2017 paper introduced the Transformer, a sequence transduction model that dispenses with recurrence and convolutions entirely in favor of attention [^src-attention-is-all-you-need]. Its central contribution is the [[attention-mechanism]] — specifically scaled dot-product and multi-head attention — which lets the model relate all positions in a sequence in parallel. The proposed [[transformer-architecture]] became the foundation for virtually all subsequent large language models. The paper also demonstrated strong machine translation results while being more parallelizable and faster to train than prior recurrent approaches.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
"#,
    ),
    (
        "wiki/source-scaling-laws-paper.md",
        r#"---
title: "Source: Scaling Laws for Neural Language Models"
type: source-summary
tags:
  - source-summary
created: 2024-02-20
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Source: Scaling Laws for Neural Language Models

This paper presents empirical scaling laws for neural language models, showing that loss decreases as a smooth power-law function of model size, dataset size, and compute [^src-scaling-laws-paper]. These [[scaling-laws]] imply that performance improvements are predictable across many orders of magnitude, given balanced increases in the three factors. The work argues that larger models are more sample-efficient and that [[pretraining]] compute should be allocated toward bigger models trained on appropriately sized data. Its findings strongly influenced subsequent decisions about how to spend training budgets at the frontier.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
"#,
    ),
    (
        "wiki/source-constitutional-ai-paper.md",
        r#"---
title: "Source: Constitutional AI"
type: source-summary
tags:
  - source-summary
created: 2024-02-21
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Source: Constitutional AI

The Constitutional AI paper introduces a method for training a harmless AI assistant without relying on human labels for harmful outputs, instead using a written set of principles—a "constitution"—to guide the model's self-critique and revision. Developed at [[anthropic]], the approach replaces much of the human feedback in safety training with AI-generated feedback, a process the paper calls Reinforcement Learning from AI Feedback (RLAIF). The technique underpins the broader [[constitutional-ai]] methodology, in which the model critiques and rewrites its own responses against constitutional principles before a preference model is trained on those revisions.[^src-constitutional-ai-paper] The paper argues that this makes the alignment process more transparent and scalable, since the governing values are stated explicitly rather than implied by thousands of individual human judgments.

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
"#,
    ),
    (
        "wiki/analysis-scaling-vs-data.md",
        r#"---
title: "Scaling vs. Data Quality"
type: analysis
tags:
  - analysis
created: 2024-02-22
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# Scaling vs. Data Quality

The scaling-versus-data-quality debate concerns whether language model performance is driven primarily by raw scale—parameters, compute, and dataset size—or by the curation and quality of training data. Early [[scaling-laws]] research established smooth power-law relationships between model loss and the amount of compute, parameters, and data used during [[pretraining]], suggesting that predictable gains follow from simply scaling up.[^src-scaling-laws-paper] However, later work emphasized that compute-optimal training requires balancing model size against the number of training tokens rather than maximizing parameters alone, shifting attention toward data sufficiency and quality. Since both camps operate on the same [[transformer-architecture]], the practical question is how to allocate a fixed compute budget between bigger models and more—or cleaner—data, with consensus moving toward high-quality, well-balanced datasets as a force multiplier on scale.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
"#,
    ),
    (
        "wiki/analysis-rlhf-vs-dpo.md",
        r#"---
title: "RLHF vs. DPO"
type: analysis
tags:
  - analysis
created: 2024-02-23
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# RLHF vs. DPO

[[rlhf]] (Reinforcement Learning from Human Feedback) and [[dpo]] (Direct Preference Optimization) are two approaches to the same [[alignment]] goal: tuning a language model to produce outputs that match human preferences. RLHF first trains a separate reward model on human preference comparisons, then optimizes the policy against that reward using reinforcement learning, typically PPO, which is powerful but adds complexity and training instability.[^src-constitutional-ai-paper] DPO sidesteps the explicit reward model and RL loop entirely, deriving a closed-form objective that optimizes the language model directly on preference pairs, making it simpler and more stable to train. The trade-off is that RLHF's separate reward model can be reused, audited, and combined with techniques like AI-generated feedback, whereas DPO's streamlined pipeline trades that flexibility for ease of implementation and lower compute overhead.

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
"#,
    ),
];
