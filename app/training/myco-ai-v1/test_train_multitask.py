"""Prevent unsupported architectures and unintended all-layer LoRA training."""

from copy import deepcopy
import unittest

from train_multitask import adapter_configuration


class TrainingConfigurationTests(unittest.TestCase):
    def test_supported_architectures_use_explicit_last_layer_count(self):
        for architecture in ("qwen3", "ministral3", "mistral3"):
            config = adapter_configuration(architecture, 36, 4, 8)
            self.assertEqual(config["num_layers"], 4)
            self.assertEqual(config["lora_parameters"], {"rank": 8, "scale": 16.0, "dropout": 0.0})

    def test_rejects_zero_which_upstream_interprets_as_all_layers(self):
        for layers, rank in ((0, 8), (-1, 8), (37, 8), (4, 0)):
            with self.assertRaisesRegex(ValueError, "positive and within"):
                adapter_configuration("qwen3", 36, layers, rank)

    def test_uninspected_hybrid_models_are_not_silently_admitted(self):
        with self.assertRaisesRegex(ValueError, "Unqualified training architecture"):
            adapter_configuration("qwen3_5", 32, 4, 8)

    def test_inspected_phi4_last_four_layers_use_fused_projection_names(self):
        config = adapter_configuration("phi3", 32, 4, 8)
        self.assertEqual(config["num_layers"], 4)
        self.assertEqual(config["lora_parameters"], {
            "rank": 8, "scale": 16.0, "dropout": 0.0,
            "keys": ["self_attn.qkv_proj", "self_attn.o_proj", "mlp.gate_up_proj", "mlp.down_proj"],
        })

    def test_other_phi_layer_counts_are_not_inspected_phi4(self):
        for layer_count in (24, 36, 40):
            with self.subTest(layer_count=layer_count), self.assertRaisesRegex(ValueError, "32-layer Phi-4-mini"):
                adapter_configuration("phi3", layer_count, 4, 8)

    def test_inspected_gemma4_e2b_last_four_layers_use_shared_kv_safe_projections(self):
        config = adapter_configuration("gemma4", 35, 4, 8)
        self.assertEqual(config, {
            "fine_tune_type": "lora", "num_layers": 4,
            "lora_parameters": {
                "rank": 8, "scale": 16.0, "dropout": 0.0,
                "keys": ["self_attn.q_proj", "self_attn.o_proj",
                         "mlp.gate_proj", "mlp.up_proj", "mlp.down_proj"],
            },
        })

    def test_other_gemma_layer_counts_and_model_types_remain_unqualified(self):
        for layer_count in (24, 32, 36, 42, 48, 60):
            with self.subTest(layer_count=layer_count), self.assertRaisesRegex(ValueError, "35-layer Gemma-4 E2B"):
                adapter_configuration("gemma4", layer_count, 4, 8)
        for architecture in ("gemma4_text", "gemma4_unified"):
            with self.subTest(architecture=architecture), self.assertRaisesRegex(ValueError, "Unqualified training architecture"):
                adapter_configuration(architecture, 35, 4, 8)

    def test_gemma4_rejects_invalid_selected_layers_and_rank(self):
        for layers, rank in ((0, 8), (-1, 8), (36, 8), (4, 0)):
            with self.subTest(layers=layers, rank=rank), self.assertRaisesRegex(ValueError, "positive and within"):
                adapter_configuration("gemma4", 35, layers, rank)

    def test_gemma4_configuration_does_not_share_nested_projection_lists(self):
        first = adapter_configuration("gemma4", 35, 4, 8)
        expected = deepcopy(first)
        first["lora_parameters"]["keys"].append("self_attn.k_proj")
        first["lora_parameters"]["rank"] = 16
        self.assertEqual(adapter_configuration("gemma4", 35, 4, 8), expected)


if __name__ == "__main__":
    unittest.main()
