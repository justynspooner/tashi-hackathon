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

/// What a peer is proposing/voting for. Bundles the `game_id` with the
/// `keep_roles` intent so the consensus tally treats "replay freeze_tag
/// keeping roles" and "replay freeze_tag clearing roles" as distinct
/// outcomes. Without this, a split 2/2 vote between those two intents could
/// silently merge and pick one arbitrarily — the opposite of what the
/// post-game UI asks players to express.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct GameChoice {
    pub game_id: String,
    /// `true` means the next round preserves each entity's `entity_type`/
    /// `team` (the "Replay with existing roles" post-game option). `false`
    /// means the normal new-game reset — claims are wiped and players have
    /// to re-enter `PlacingEntities`.
    #[serde(default)]
    pub keep_roles: bool,
}

impl GameChoice {
    /// Shorthand constructor for the common "fresh game, clear claims" case.
    /// Used by tests; the wire-message handlers build the struct literally.
    #[cfg(test)]
    pub fn new_game(game_id: impl Into<String>) -> Self {
        Self {
            game_id: game_id.into(),
            keep_roles: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProposalWindow {
    pub started_at_ms: u64,
    pub proposers: HashMap<String, GameChoice>, // peer_id -> choice
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VoteWindow {
    pub started_at_ms: u64,
    pub votes: HashMap<String, GameChoice>, // peer_id -> choice
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

    /// Reset per-game-instance state when a new game locks in. Keeps peer
    /// identity and positions (persistent across rounds) but clears the
    /// countdown anchor, ready set, scores, ended-game metadata, proximity
    /// tracker, and each entity's prior claim. Without this, the stale
    /// `countdown_zero_ns` from the previous game would make
    /// `game_time_elapsed_s` fire immediately on the next round.
    pub fn reset_for_new_game(&mut self) {
        self.reset_round_instance_state();
        for entity in self.entities.values_mut() {
            entity.entity_type = None;
            entity.team = None;
            entity.properties.clear();
        }
    }

    /// "Replay with existing roles" reset: wipes everything `reset_for_new_game`
    /// wipes except each entity's `entity_type` and `team`. Used when the
    /// post-game UI's Replay button wins consensus — the round restarts with
    /// the same lineup so players don't have to re-pick. Per-entity
    /// `properties` (e.g. `frozen_since_ms`) are still cleared: they're
    /// round-local game state, not identity.
    pub fn reset_for_new_round_keeping_roles(&mut self) {
        self.reset_round_instance_state();
        for entity in self.entities.values_mut() {
            entity.properties.clear();
        }
    }

    /// Wipe round-local state (scores, countdown, ready set, ended-metadata,
    /// proximity tracker, placement-ok flag). Leaves per-entity fields alone;
    /// the two public reset methods differ only in whether they also clear
    /// `entity_type`/`team` afterwards.
    fn reset_round_instance_state(&mut self) {
        self.countdown_zero_ns = None;
        self.ready_peers.clear();
        self.scores.clear();
        self.ended_winner_team = None;
        self.ended_reason = None;
        self.placement_ok = false;
        self.proximity_tracker.clear();
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
