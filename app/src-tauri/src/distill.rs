// Per-vault distillation config. Persists to `<vault>/.myco/distill.json` with
// atomic write (tmp + rename) and missing/corrupt file → defaults. Follows the
// same persistence pattern as schedules.rs.

use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intensity {
    Conservative,
    Standard,
    Aggressive,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GatePreset {
    Strict,
    Normal,
    Loose,
}

fn d_true() -> bool {
    true
}

fn d_count() -> usize {
    50
}

fn d_intensity() -> Intensity {
    Intensity::Standard
}

fn d_preset() -> GatePreset {
    GatePreset::Normal
}

fn d_ttl() -> u32 {
    30
}

fn d_budget() -> usize {
    50
}

fn d_idle() -> u32 {
    10
}

fn d_maturation() -> u32 {
    24
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct DistillConfig {
    #[serde(default = "d_true")]
    pub enabled: bool,
    #[serde(default = "d_count")]
    pub count_trigger: usize,
    #[serde(default = "d_intensity")]
    pub intensity: Intensity,
    #[serde(default = "d_preset")]
    pub gate_preset: GatePreset,
    #[serde(default = "d_ttl")]
    pub quarantine_ttl_days: u32,
    #[serde(default = "d_budget")]
    pub run_budget_items: usize,
    #[serde(default = "d_idle")]
    pub idle_minutes: u32,
    #[serde(default = "d_maturation")]
    pub maturation_hours: u32,
    #[serde(default)]
    pub dormancy_decay: bool,
}

impl Default for DistillConfig {
    fn default() -> Self {
        DistillConfig {
            enabled: d_true(),
            count_trigger: d_count(),
            intensity: d_intensity(),
            gate_preset: d_preset(),
            quarantine_ttl_days: d_ttl(),
            run_budget_items: d_budget(),
            idle_minutes: d_idle(),
            maturation_hours: d_maturation(),
            dormancy_decay: false,
        }
    }
}

fn dir(root: &Path) -> PathBuf {
    crate::vault_dir::dir(root)
}

pub fn config_path(root: &Path) -> PathBuf {
    dir(root).join("distill.json")
}

pub fn config_load(root: &Path) -> DistillConfig {
    let path = config_path(root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return DistillConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Atomic write: stage to a temp file in the same dir, then rename over target.
pub fn config_save(root: &Path, c: &DistillConfig) -> Result<(), String> {
    let d = dir(root);
    std::fs::create_dir_all(&d)
        .map_err(|e| format!("create {} dir: {e}", crate::vault_dir::DIR_NAME))?;
    let raw = serde_json::to_string_pretty(c).map_err(|e| format!("serialize: {e}"))?;
    let target = config_path(root);
    let tmp = d.join(".distill.json.tmp");
    std::fs::write(&tmp, raw.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_roundtrips_and_defaults() {
        let d = tempfile::tempdir().unwrap();
        let c = config_load(d.path()); // no file yet -> defaults
        assert!(c.enabled);
        assert_eq!(c.count_trigger, 50);
        assert_eq!(c.intensity, Intensity::Standard);
        assert_eq!(c.gate_preset, GatePreset::Normal);
        assert_eq!(c.quarantine_ttl_days, 30);
        assert_eq!(c.run_budget_items, 50);
        assert_eq!(c.idle_minutes, 10);
        assert_eq!(c.maturation_hours, 24);
        assert!(!c.dormancy_decay);
        let mut c2 = c.clone();
        c2.count_trigger = 10;
        config_save(d.path(), &c2).unwrap();
        assert_eq!(config_load(d.path()).count_trigger, 10);
    }
}
