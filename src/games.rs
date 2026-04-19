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
        assert!(g.rules.iter().any(|r| r.id == "flag_capture"));
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
