//! Per-node game state, persisted alongside the existing `*-state.json`.
//!
//! Phase A uses only `my_position`, `entities`, and `phase` fields so the
//! frontend + partition reconciler can pick up entity positions. Later phases
//! expand this with proximity trackers, sensor history, scores, vote windows,
//! countdown_zero_ns, etc.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::Path;

use anyhow::Context as _;
use serde::{Deserialize, Serialize};

use crate::protocol::{Position, WireMessage};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GamePhase {
    NoGame,
    Proposing,
    Voting,
    Loaded,
    PlacingEntities,
    Ready,
    CountingDown,
    Playing,
    Ended,
}

impl Default for GamePhase {
    fn default() -> Self {
        GamePhase::NoGame
    }
}

/// A single entity's view as seen by the local node (all known via consensus).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EntityRecord {
    pub label: String,
    pub peer_id: String,
    pub entity_type: Option<String>,
    pub team: Option<String>,
    pub pos: Option<Position>,
    #[serde(default)]
    pub properties: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub claimed_at_ms: u64,
    #[serde(default)]
    pub last_seen_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProposalWindow {
    pub started_at_ms: u64,
    pub proposers: HashMap<String, String>, // peer_id -> game_id
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VoteWindow {
    pub started_at_ms: u64,
    pub votes: HashMap<String, String>, // peer_id -> game_id
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalGameState {
    pub label: String,
    pub peer_id: String,
    #[serde(default)]
    pub phase: GamePhase,
    #[serde(default)]
    pub active_game_id: Option<String>,
    #[serde(default)]
    pub entities: HashMap<String, EntityRecord>, // keyed by label
    #[serde(default)]
    pub my_position: Option<Position>,
    #[serde(default)]
    pub scores: HashMap<String, i64>,
    #[serde(default)]
    pub proposal_window: Option<ProposalWindow>,
    #[serde(default)]
    pub vote_window: Option<VoteWindow>,
    #[serde(default)]
    pub proximity_tracker: HashMap<String, u64>, // "labelA|labelB" -> start_ms
    #[serde(default, skip_serializing)]
    pub sensor_history: VecDeque<WireMessage>,
    #[serde(default)]
    pub countdown_zero_ns: Option<u128>,
    #[serde(default)]
    pub placement_ok: bool,
    #[serde(default)]
    pub ready_peers: Vec<String>,
    /// Winning team recorded from the `GameEnd` payload when the game
    /// transitioned to `Ended`. `None` means either the game hasn't ended or
    /// ended in a draw. Kept distinct from `scores` so the UI can surface the
    /// decided outcome even after scores drift post-end.
    #[serde(default)]
    pub ended_winner_team: Option<String>,
    /// Human-readable reason captured alongside `GameEnd` (e.g. "10-minute
    /// time limit reached"). Consumed by the frontend's Ended banner.
    #[serde(default)]
    pub ended_reason: Option<String>,
}

impl LocalGameState {
    pub fn new(label: String, peer_id: String, initial: Option<Position>) -> Self {
        let mut entities = HashMap::new();
        entities.insert(
            label.clone(),
            EntityRecord {
                label: label.clone(),
                peer_id: peer_id.clone(),
                pos: initial,
                ..Default::default()
            },
        );
        Self {
            label,
            peer_id,
            phase: GamePhase::NoGame,
            active_game_id: None,
            entities,
            my_position: initial,
            scores: HashMap::new(),
            proposal_window: None,
            vote_window: None,
            proximity_tracker: HashMap::new(),
            sensor_history: VecDeque::new(),
            countdown_zero_ns: None,
            placement_ok: false,
            ready_peers: Vec::new(),
            ended_winner_team: None,
            ended_reason: None,
        }
    }

    /// Push a sensor record to the bounded history ring buffer.
    pub fn record_sensor(&mut self, wire: WireMessage) {
        self.sensor_history.push_back(wire);
        while self.sensor_history.len() > 256 {
            self.sensor_history.pop_front();
        }
    }
}

// Path construction for `{label}-game.json` is inlined at each callsite
// (web.rs, main.rs) to match the pattern used by `-state.json`, `-events.jsonl`,
// `-cmd.json`, and `proofs/{label}/`. Adding a helper for only one of them
// would be inconsistent.

pub fn persist(state: &LocalGameState, path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let json = serde_json::to_vec_pretty(state)?;
    fs::write(path, json).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}
