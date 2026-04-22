//! Game config types and loader.
//!
//! Configs live at `./games/*.json`. Each node loads all configs at startup so
//! it can evaluate rules against any game that's voted in. The web server
//! loads them too so `GET /api/games` can serve them to the frontend.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityTypeDef {
    pub id: String,
    pub min: u32,
    pub max: u32,
    /// `None` means the entity has no team; `Some("per_team")` means one per
    /// team; otherwise a fixed team name (rare).
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub visual: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlacementRule {
    pub entity: String,
    pub requires: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub on: String,
    #[serde(default)]
    pub when: serde_json::Value,
    #[serde(default)]
    pub effect: serde_json::Value,
}

/// A circular obstacle on the playing field. When `blocks_los` is true, the
/// obstacle breaks line-of-sight for any pair of nodes whose connecting
/// segment passes through the disk — the partition reconciler firewalls such
/// pairs off exactly like an over-range pair. Mirrors the `Obstacle` type in
/// `frontend/src/game/presentation.ts`; keep the two in lockstep.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Obstacle {
    pub x: f32,
    pub y: f32,
    pub r: f32,
    /// Defaults to `true` when omitted — an obstacle with no explicit flag is
    /// assumed to break LOS. Set to `false` for cosmetic-only rendering
    /// decorations.
    #[serde(default = "default_blocks_los")]
    pub blocks_los: bool,
}

fn default_blocks_los() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub teams: Vec<String>,
    pub entity_types: Vec<EntityTypeDef>,
    #[serde(default)]
    pub placement: Vec<PlacementRule>,
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// Optional hard time limit in seconds. Measured from the consensus-pinned
    /// `countdown_zero_ns + 3s` moment when gameplay transitions to `Playing`.
    /// Consumed by the `game_time_elapsed_s` predicate and surfaced to the UI
    /// as an MM:SS countdown. `None` means the game has no built-in timer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<u64>,
    /// Static obstacles on the playing field. The partition reconciler
    /// consults these on every tick so a pair whose connecting segment is
    /// occluded by a blocking obstacle is firewalled off the same way an
    /// over-range pair is. `#[serde(default)]` keeps old configs (no
    /// `obstacles` field) parsing as an empty list.
    #[serde(default)]
    pub obstacles: Vec<Obstacle>,
}

pub fn load_all(dir: &Path) -> anyhow::Result<HashMap<String, GameConfig>> {
    let mut out = HashMap::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let data = fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let cfg: GameConfig = serde_json::from_str(&data)
            .with_context(|| format!("parsing {}", path.display()))?;
        if cfg.id.is_empty() {
            return Err(anyhow!("{} has empty id", path.display()));
        }
        out.insert(cfg.id.clone(), cfg);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    //! Schema drift guards for the shipped game configs. Any change to
    //! `games/*.json` that can't be parsed by the current Rust types will
    //! fail these tests — catching the break at CI rather than boot.
    use super::*;

    const CTF_JSON: &str = include_str!("../games/ctf.json");
    const KOTH_JSON: &str = include_str!("../games/king_of_the_hill.json");
    const TERRITORY_JSON: &str = include_str!("../games/territory.json");

    fn parse(name: &str, raw: &str) -> GameConfig {
        serde_json::from_str(raw)
            .unwrap_or_else(|e| panic!("{name} failed to parse as GameConfig: {e}"))
    }

    #[test]
    fn ctf_parses_and_has_expected_shape() {
        let g = parse("ctf.json", CTF_JSON);
        assert_eq!(g.id, "ctf");
        assert_eq!(g.teams, vec!["red".to_string(), "blue".to_string()]);
        assert!(g.entity_types.iter().any(|e| e.id == "flag" && e.max == 1));
        assert!(g.entity_types.iter().any(|e| e.id == "base" && e.team.as_deref() == Some("per_team")));
        assert_eq!(g.placement.len(), 2);
        // 10-minute timed hold-the-flag scoring:
        //   - `mark_holding` stamps `flag.holding_team` for the UI's current-holder pill.
        //   - `hold_pulse` writes a fresh `flag.hold_pulse_ms` every tick the
        //     flag sits at a base, so the delta-triggered `hold_score` rule
        //     increments the team's score once per node per tick (consensus
        //     converged).
        //   - `time_limit` fires on the flag after `duration_s` elapses and
        //     ends the game with the highest-score team as winner.
        assert_eq!(g.duration_s, Some(600));
        let rule_ids: Vec<&str> = g.rules.iter().map(|r| r.id.as_str()).collect();
        assert!(rule_ids.contains(&"mark_holding"), "rules: {rule_ids:?}");
        assert!(rule_ids.contains(&"hold_pulse"), "rules: {rule_ids:?}");
        assert!(rule_ids.contains(&"hold_score"), "rules: {rule_ids:?}");
        assert!(rule_ids.contains(&"time_limit"), "rules: {rule_ids:?}");
    }

    #[test]
    fn king_of_the_hill_parses() {
        let g = parse("king_of_the_hill.json", KOTH_JSON);
        assert_eq!(g.id, "king_of_the_hill");
        assert!(g.entity_types.iter().any(|e| e.id == "hill"));
        assert_eq!(g.placement.len(), 1);
    }

    #[test]
    fn territory_parses() {
        let g = parse("territory.json", TERRITORY_JSON);
        assert_eq!(g.id, "territory");
        assert!(g.entity_types.iter().any(|e| e.id == "zone"));
        // Territory has no placement rules — Ready-Up gates only on claim.
        assert!(g.placement.is_empty());
    }

    #[test]
    fn all_shipped_configs_have_nonempty_entity_types() {
        for (name, raw) in [
            ("ctf.json", CTF_JSON),
            ("king_of_the_hill.json", KOTH_JSON),
            ("territory.json", TERRITORY_JSON),
        ] {
            let g = parse(name, raw);
            assert!(!g.entity_types.is_empty(), "{name}: entity_types must not be empty");
            for et in &g.entity_types {
                assert!(et.min <= et.max, "{name}: entity_type {} has min > max", et.id);
            }
        }
    }
}
