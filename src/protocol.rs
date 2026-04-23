use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedState {
    pub peer_id: String,
    pub last_seen_ms: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Hello,
    Heartbeat,
    StateUpdate,
    // Game-related (Phase A+)
    GameProposal,
    GameVote,
    EntityTypeClaim,
    SensorReading,
    ReadyUp,
    GameStateDelta,
    RuleViolation,
    GameEnd,
}

impl MessageKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Hello => "hello",
            Self::Heartbeat => "heartbeat",
            Self::StateUpdate => "state_update",
            Self::GameProposal => "game_proposal",
            Self::GameVote => "game_vote",
            Self::EntityTypeClaim => "entity_type_claim",
            Self::SensorReading => "sensor_reading",
            Self::ReadyUp => "ready_up",
            Self::GameStateDelta => "game_state_delta",
            Self::RuleViolation => "rule_violation",
            Self::GameEnd => "game_end",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Position {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensorDatum {
    pub peer_id: String,
    pub distance_m: f32,
    pub angle_rad: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatePatch {
    pub target_peer_id: String,
    pub key: String,
    pub value: serde_json::Value,
}

/// Game-event payload carried on a `WireMessage`. Only certain `MessageKind`
/// variants set this; older Hello/Heartbeat/StateUpdate leave it `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GamePayload {
    GameProposal {
        game_id: String,
        /// When `true`, the next round preserves each entity's `entity_type`/
        /// `team` — the "Replay with existing roles" post-game option. The
        /// tally treats `(game_id, keep_roles)` as a distinct choice, so a
        /// split 2/2 between Replay and Change-Roles won't silently merge.
        /// Defaults to `false` for backwards-compatibility with older wire
        /// messages that predate the field.
        #[serde(default)]
        keep_roles: bool,
    },
    GameVote {
        game_id: String,
        /// Mirrors `GameProposal.keep_roles` — votes only coalesce with
        /// proposals that share the same intent.
        #[serde(default)]
        keep_roles: bool,
    },
    EntityTypeClaim {
        entity_type: String,
        team: Option<String>,
    },
    SensorReading {
        pos: Position,
        readings: Vec<SensorDatum>,
        observed_at_ms: u64,
    },
    ReadyUp,
    GameStateDelta {
        patches: Vec<StatePatch>,
    },
    RuleViolation {
        rule_id: String,
        offender_msg_id: String,
        reason: String,
    },
    GameEnd {
        winner_team: Option<String>,
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMessage {
    pub kind: MessageKind,
    pub message_id: String,
    pub sent_at_ms: u64,
    pub state: SharedState,
    pub note: Option<String>,
    /// Present for `MessageKind`s that carry a game payload; absent for
    /// Hello/Heartbeat/StateUpdate so older JSON remains parseable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game: Option<GamePayload>,
}
