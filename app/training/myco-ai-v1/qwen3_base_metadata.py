"""Write pinned Qwen3-8B metadata from an already supplied tokenizer object.

No model, tokenizer, file, or array package is loaded here. The caller must bind
the actual input files and tokenizer version separately. A recognized probe is
not evidence of complete tokenizer or native inference parity.

Probe and vocabulary rules derive from llama.cpp conversion/base.py and
gguf-py/gguf/vocab.py at 9e3b928fd8c9d14dbf15a8768b9fdd7e5c721d66.

MIT License
Copyright (c) 2023-2026 The ggml authors
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from collections.abc import Mapping
from hashlib import sha256

from export_qwen3 import base_profile

VOCAB_SIZE = 151936
# Exact string value from conversion/base.py:1383; \x60 is the backtick.
PRETOKENIZER_PROBE = '\n \n\n \n\n\n \t \t\t \t\n  \n   \n    \n     \n🚀 (normal) 😶\u200d🌫️ (multiple emojis concatenated) ✅ 🦙🦙 3 33 333 3333 33333 333333 3333333 33333333 3.3 3..3 3...3 កាន់តែពិសេសអាច😁 ?我想在apple工作1314151天～ ------======= нещо на Български \'\'\'\'\'\'\x60\x60\x60\x60\x60\x60\x60""""......!!!!!!?????? I\'ve been \'told he\'s there, \'RE you sure? \'M not sure I\'ll make it, \'D you like some tea? We\'Ve a\'lL'
# The two official get_vocab_base_pre entries mapping to "qwen2":
# base.py:1495 (Qwen1.5-7B), base.py:1435 (Qwen3-Embedding-0.6B).
QWEN2_PROBE_HASHES = frozenset({
    "e636dc30a262dcc0d8c323492e32ae2b70728f4df7dfe9737d9f920a282b8aea",
    "d4540891389ea895b53b399da6ac824becc30f2fba0e9ddbb98f92e55ca0e97c",
})


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _is_sha256(value):
    return (isinstance(value, str) and len(value) == 64
            and all(character in "0123456789abcdef" for character in value))


def tokenizer_probe_sha256(tokenizer):
    """Apply the official default encode probe without changing token options."""
    token_ids = tokenizer.encode(PRETOKENIZER_PROBE)
    _require(isinstance(token_ids, list) and token_ids
             and all(type(value) is int and 0 <= value < VOCAB_SIZE for value in token_ids),
             "Tokenizer probe must return nonempty in-range integer IDs")
    return sha256(str(token_ids).encode()).hexdigest()


def _looks_special(token):
    return (token in {"<pad>", "<mask>", "<2mass>", "[@BOS@]"}
            or (token.startswith("<|") and token.endswith("|>"))
            or (token.startswith("<｜") and token.endswith("｜>"))
            or (token.startswith("<unused") and token.endswith(">")))


def _vocabulary(tokenizer):
    vocabulary = tokenizer.vocab
    added = tokenizer.get_added_vocab()
    decoder = tokenizer.added_tokens_decoder
    _require(isinstance(vocabulary, Mapping) and vocabulary
             and isinstance(added, Mapping) and isinstance(decoder, Mapping),
             "Expected supplied tokenizer vocabulary and added-token mappings")
    _require(all(isinstance(token, str) and type(index) is int and 0 <= index < VOCAB_SIZE
                 for token, index in vocabulary.items())
             and len(set(vocabulary.values())) == len(vocabulary),
             "Vocabulary must have unique in-range integer IDs")
    _require(all(isinstance(token, str) and type(index) is int
                 and vocabulary.get(token) == index for token, index in added.items()),
             "Added vocabulary must agree with the complete vocabulary")
    reverse = {index: token for token, index in vocabulary.items()}
    tokens, token_types = [], []
    for index in range(VOCAB_SIZE):
        if index not in reverse:
            tokens.append(f"[PAD{index}]")
            token_types.append(5)  # gguf.TokenType.UNUSED
            continue
        token = reverse[index]
        token_type = 1  # gguf.TokenType.NORMAL
        if token in added:
            entry = decoder.get(index)
            _require(type(getattr(entry, "normalized", None)) is bool
                     and type(getattr(entry, "special", None)) is bool,
                     "Added tokens require explicit normalized/special flags")
            if not entry.normalized:
                token = tokenizer.decode(tokenizer.encode(token, add_special_tokens=False))
                _require(isinstance(token, str), "Normalized added token must be text")
            if entry.special or _looks_special(token):
                token_type = 3  # gguf.TokenType.CONTROL
            else:
                token = token.replace("▁", " ")
                token_type = 4  # gguf.TokenType.USER_DEFINED
        tokens.append(token)
        token_types.append(token_type)
    return tokens, token_types


def write_qwen3_base_metadata(config, tokenizer, writer, gguf, *, expected_probe_sha256):
    """Write the dense 8B Q4_1 metadata and official GPT-2 vocabulary projection.

    Construct the supplied writer with architecture "qwen3". The caller must pin
    the actual tokenizer files and one expected official probe hash before use.
    SpecialVocab is deliberately handled separately after its strict guard.
    """
    _require(base_profile(config) == "8b", "Expected the pinned Qwen3-8B profile")
    _require(getattr(writer, "arch", None) == "qwen3", "Expected a qwen3 GGUF writer")
    _require(_is_sha256(expected_probe_sha256) and expected_probe_sha256 in QWEN2_PROBE_HASHES,
             "Expected a separately pinned official qwen2 probe SHA256")
    actual_probe = tokenizer_probe_sha256(tokenizer)
    _require(actual_probe == expected_probe_sha256, "Tokenizer pre-tokenizer probe SHA256 mismatch")
    _require(gguf.GGML_QUANT_VERSION == 2 and int(gguf.LlamaFileType.MOSTLY_Q4_1) == 3,
             "Expected the pinned Q4_1 GGUF metadata constants")
    tokens, token_types = _vocabulary(tokenizer)
    writer.add_type("model")
    writer.add_quantization_version(gguf.GGML_QUANT_VERSION)
    writer.add_block_count(config["num_hidden_layers"])
    writer.add_context_length(config["max_position_embeddings"])
    writer.add_embedding_length(config["hidden_size"])
    writer.add_feed_forward_length(config["intermediate_size"])
    writer.add_head_count(config["num_attention_heads"])
    writer.add_head_count_kv(config["num_key_value_heads"])
    writer.add_rope_freq_base(config["rope_theta"])
    writer.add_layer_norm_rms_eps(config["rms_norm_eps"])
    writer.add_key_length(config["head_dim"])
    writer.add_value_length(config["head_dim"])
    writer.add_file_type(gguf.LlamaFileType.MOSTLY_Q4_1)
    writer.add_tokenizer_model("gpt2")
    writer.add_tokenizer_pre("qwen2")
    writer.add_token_list(tokens)
    writer.add_token_types(token_types)
    return {"vocab_size": len(tokens), "pretokenizer_probe_sha256": actual_probe,
            "tokenizer_parity_verified": False, "native_equivalence_verified": False}


def validate_qwen3_special_vocab(special_vocab, *, expected_chat_template_sha256):
    """Guard the pinned SpecialVocab result before the caller adds it to GGUF.

    The caller constructs gguf.SpecialVocab(model_dir, load_merges=True,
    n_vocab=151936), calls this guard, then special_vocab.add_to_gguf(writer).
    The pinned implementation owns merge conversion, special-token precedence,
    add-token flags, and chat-template extraction; this helper does not reparse
    those input files or establish their provenance.
    """
    _require(_is_sha256(expected_chat_template_sha256), "Expected a frozen chat-template SHA256")
    _require(getattr(special_vocab, "load_merges", None) is True
             and type(getattr(special_vocab, "n_vocab", None)) is int
             and special_vocab.n_vocab == VOCAB_SIZE,
             "SpecialVocab requires load_merges=True and n_vocab=151936")
    merges = getattr(special_vocab, "merges", None)
    _require(isinstance(merges, list) and merges
             and all(isinstance(merge, str) and len(merge.split(" ")) == 2
                     and all(merge.split(" ")) and "\0" not in merge for merge in merges),
             "Expected nonempty Qwen BPE merges with two encoded components")
    ids = getattr(special_vocab, "special_token_ids", None)
    flags = getattr(special_vocab, "add_special_token", None)
    _require(isinstance(ids, Mapping) and "eos" in ids
             and set(ids) <= {"bos", "eos", "unk", "sep", "pad", "mask", "eot", "eom"}
             and all(type(index) is int and 0 <= index < VOCAB_SIZE for index in ids.values()),
             "Special token IDs must have supported handlers and remain in vocabulary")
    _require(isinstance(flags, Mapping) and set(flags) <= {"bos", "eos", "sep"}
             and all(type(value) is bool for value in flags.values()),
             "Add-token flags require supported boolean handlers")
    _require(getattr(special_vocab, "normalizer_lowercase", None) is None
             or type(special_vocab.normalizer_lowercase) is bool,
             "Unsupported lowercase normalizer metadata")
    template = getattr(special_vocab, "chat_template", None)
    _require(isinstance(template, str) and bool(template)
             and sha256(template.encode()).hexdigest() == expected_chat_template_sha256,
             "Expected the exact pinned string chat template")
    return {"merges": len(merges), "special_token_ids": dict(ids),
            "add_special_token": dict(flags),
            "chat_template_sha256": expected_chat_template_sha256,
            "tokenizer_parity_verified": False}
