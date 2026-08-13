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

// Task 3 — build_ontology's return summary (the full cache stays server-side).
export interface OntologySummary {
  clusters: number;
  wiki_pages: number;
  built_at: number;
}

// Task 4 — distill_scan's return summary.
export interface ScanOutcome {
  scored: number;
  quarantined: number;
  rejected: number;
  summaries: number;
  full: number;
  skipped_immature: number;
}

// Task 6 — distill_run's return summary.
export interface RunReport {
  id: string;
  scan: ScanOutcome;
  archived: number;
  trashed: number;
  proposals: number;
  backlog_after: number;
}

// Task 6 — distill_status's return summary.
export interface DistillStatus {
  backlog: number;
  pending_proposals: number;
  last_run: number | null;
  last_backlogs: number[];
}
