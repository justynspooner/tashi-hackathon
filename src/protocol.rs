use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedState {
    pub peer_id: String,
    pub last_seen_ms: u64,
    pub role: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Hello,
    Heartbeat,
    StateUpdate,
}

impl MessageKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Hello => "hello",
            Self::Heartbeat => "heartbeat",
            Self::StateUpdate => "state_update",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMessage {
    pub kind: MessageKind,
    pub message_id: String,
    pub sent_at_ms: u64,
    pub state: SharedState,
    pub note: Option<String>,
}
