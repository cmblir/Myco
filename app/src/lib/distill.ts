// TS mirror types for distillation config. Fields match the Rust serde output
// (snake_case from the #[serde(rename_all)] directives).

export type Intensity = "conservative" | "standard" | "aggressive";
export type GatePreset = "strict" | "normal" | "loose";

export interface DistillConfig {
  enabled: boolean;
  count_trigger: number;
  intensity: Intensity;
  gate_preset: GatePreset;
  quarantine_ttl_days: number;
  run_budget_items: number;
  idle_minutes: number;
  maturation_hours: number;
  dormancy_decay: boolean;
}
