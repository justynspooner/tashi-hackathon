use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context as _;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::game_state::LocalGameState;
use crate::proof::ProofOfCoordination;
use crate::protocol::{MessageKind, Position, SharedState, WireMessage};

// --- Cross-thread channel types ---

#[derive(Debug)]
#[allow(dead_code)]
pub enum WebEvent {
    StateChanged {
        label: String,
        local: SharedState,
        peers: HashMap<String, SharedState>,
        last_message_kind: Option<String>,
        last_message_id: Option<String>,
    },
    LogEntry {
        ts: u64,
        tag: String,
        label: String,
        message: String,
    },
    ProofSaved {
        agent: String,
        file: String,
        proof: ProofOfCoordination,
    },
    NodeStatus {
        label: String,
        status: String,
    },
    GameStateChanged {
        label: String,
        snapshot: serde_json::Value,
    },
    RuleViolated {
        label: String,
        rule_id: String,
        reason: String,
    },
    PartitionAuto {
        partitions: Vec<[String; 2]>,
    },
}

#[derive(Debug)]
#[allow(dead_code)]
pub enum NodeCommand {
    /// `keep_roles` propagates into the `GameProposal` wire payload — `true`
    /// means "replay with existing roles" (the post-game Replay button),
    /// `false` means the normal propose-a-game flow.
    ProposeGame { game_id: String, keep_roles: bool },
    VoteGame { game_id: String, keep_roles: bool },
    ClaimEntity { entity_type: String, team: Option<String> },
    SetPosition { x: f32, y: f32 },
    ReadyUp,
}

pub type SharedRuntime = Arc<Mutex<RuntimeState>>;

pub fn short_peer_id(peer_id: &str) -> String {
    let suffix_len = peer_id.len().min(8);
    format!("...{}", &peer_id[peer_id.len().saturating_sub(suffix_len)..])
}

/// Per-peer tracking information.
pub struct PeerInfo {
    pub state: Option<SharedState>,
    pub discovery_logged: bool,
    pub handshake_logged: bool,
}

pub struct RuntimeState {
    pub label: String,
    pub local: SharedState,
    pub peers: HashMap<String, PeerInfo>,
    pub local_public_key: String,
    pub last_message_kind: Option<MessageKind>,
    pub last_message_id: Option<String>,
    pub next_message_seq: u64,
    pub state_file: Option<PathBuf>,
    pub sync_points_seen: u64,
    pub cmd_file: Option<PathBuf>,
    // Game-related additions (Phase A+)
    pub game_file: Option<PathBuf>,
    pub initial_position: Option<Position>,
    pub seed_broadcast_done: bool,
    pub game_state: LocalGameState,
    /// Authoritative `peer_id -> label` mapping, passed in from the web
    /// server at spawn via `--peer-label`. Includes every peer (not self);
    /// used by the rules engine / log formatting to key by human labels.
    pub peer_labels: HashMap<String, String>,
}

impl RuntimeState {
    pub fn new(
        label: String,
        local_public_key: String,
        peers: HashMap<String, PeerInfo>,
        status: String,
        state_file: Option<PathBuf>,
        cmd_file: Option<PathBuf>,
        game_file: Option<PathBuf>,
        initial_position: Option<Position>,
        peer_labels: HashMap<String, String>,
    ) -> Self {
        let game_state =
            LocalGameState::new(label.clone(), local_public_key.clone(), initial_position);
        Self {
            label,
            local: SharedState {
                peer_id: local_public_key.clone(),
                last_seen_ms: now_ms(),
                status,
            },
            peers,
            local_public_key,
            last_message_kind: None,
            last_message_id: None,
            next_message_seq: 1,
            state_file,
            sync_points_seen: 0,
            cmd_file,
            game_file,
            initial_position,
            seed_broadcast_done: false,
            game_state,
            peer_labels,
        }
    }

    /// Resolve a `peer_id` to its human-readable label. Falls back to the
    /// short-form suffix for unknown peers (e.g. stale keys during restart).
    pub fn label_for_peer(&self, peer_id: &str) -> String {
        if peer_id == self.local_public_key {
            return self.label.clone();
        }
        if let Some(lbl) = self.peer_labels.get(peer_id) {
            return lbl.clone();
        }
        short_peer_id(peer_id)
    }

    pub fn next_message_id(&mut self, kind: &MessageKind, sent_at_ms: u64) -> String {
        let id = format!("{}-{}-{}", kind.as_str(), sent_at_ms, self.next_message_seq);
        self.next_message_seq += 1;
        id
    }

    /// Build a map of peer_id -> SharedState for peers we've heard from.
    pub fn peer_states(&self) -> HashMap<String, SharedState> {
        self.peers
            .iter()
            .filter_map(|(id, info)| info.state.as_ref().map(|s| (id.clone(), s.clone())))
            .collect()
    }
}

pub fn update_peer_state(state: &mut RuntimeState, wire: &WireMessage) {
    let peer_id = &wire.state.peer_id;
    let label = state.label.clone();
    let peer_short = short_peer_id(peer_id);

    if let Some(peer_info) = state.peers.get_mut(peer_id) {
        peer_info.state = Some(wire.state.clone());

        if !peer_info.discovery_logged {
            peer_info.discovery_logged = true;
            log("DISCOVERY", &label, format!("discovered peer {peer_short}"));
        }
    }
}

#[derive(Debug, Serialize)]
struct PersistedState<'a> {
    label: &'a str,
    local: &'a SharedState,
    peers: HashMap<&'a str, &'a SharedState>,
    last_message_kind: Option<&'a str>,
    last_message_id: Option<&'a str>,
}

pub fn persist_state(state: &RuntimeState) -> anyhow::Result<()> {
    let Some(path) = state.state_file.as_ref() else {
        return Ok(());
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create state directory {}", parent.display()))?;
    }

    let peers: HashMap<&str, &SharedState> = state
        .peers
        .iter()
        .filter_map(|(id, info)| info.state.as_ref().map(|s| (id.as_str(), s)))
        .collect();

    let snapshot = PersistedState {
        label: &state.label,
        local: &state.local,
        peers,
        last_message_kind: state.last_message_kind.as_ref().map(MessageKind::as_str),
        last_message_id: state.last_message_id.as_deref(),
    };

    let json = serde_json::to_vec_pretty(&snapshot)?;
    fs::write(path, json).with_context(|| format!("failed to write {}", path.display()))?;

    send_web_event(WebEvent::StateChanged {
        label: state.label.clone(),
        local: state.local.clone(),
        peers: state.peer_states(),
        last_message_kind: state.last_message_kind.as_ref().map(|k| k.as_str().to_string()),
        last_message_id: state.last_message_id.clone(),
    });

    Ok(())
}

// Process-global singletons so every tokio worker thread sees the same value.
//
// Previously these were thread_local!, which silently dropped log entries and
// web events whenever a tokio task resumed on a worker thread that hadn't
// called set_event_log_path / set_web_sender (which is all of them except the
// one that ran the startup code). OnceLock is lock-free after initialisation
// and correct across all threads.
static EVENT_LOG_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static WEB_TX: OnceLock<Option<mpsc::UnboundedSender<WebEvent>>> = OnceLock::new();

/// Set the global event-log path (call once at startup).
pub fn set_event_log_path(path: Option<PathBuf>) {
    let _ = EVENT_LOG_PATH.set(path);
}

/// Set the global web-event sender (call once at startup when running embedded).
pub fn set_web_sender(tx: Option<mpsc::UnboundedSender<WebEvent>>) {
    let _ = WEB_TX.set(tx);
}

/// Send an event to the web server (no-op if no sender is set).
pub fn send_web_event(event: WebEvent) {
    if let Some(Some(tx)) = WEB_TX.get() {
        let _ = tx.send(event);
    }
}

#[derive(Serialize)]
struct LogEntry<'a> {
    ts: u64,
    tag: &'a str,
    label: &'a str,
    message: String,
}

pub fn log(tag: &str, label: &str, msg: impl std::fmt::Display) {
    let message = msg.to_string();
    let ts = now_ms();

    send_web_event(WebEvent::LogEntry {
        ts,
        tag: tag.to_string(),
        label: label.to_string(),
        message: message.clone(),
    });

    if let Some(Some(path)) = EVENT_LOG_PATH.get() {
        let entry = LogEntry {
            ts,
            tag,
            label,
            message: message.clone(),
        };
        if let Ok(mut json) = serde_json::to_string(&entry) {
            json.push('\n');
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = file.write_all(json.as_bytes());
            }
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after Unix epoch")
        .as_millis() as u64
}

pub fn persist_game_state(state: &RuntimeState) -> anyhow::Result<()> {
    let Some(path) = state.game_file.as_ref() else {
        return Ok(());
    };
    crate::game_state::persist(&state.game_state, path)?;
    let snapshot = serde_json::to_value(&state.game_state).unwrap_or(serde_json::Value::Null);
    send_web_event(WebEvent::GameStateChanged {
        label: state.label.clone(),
        snapshot,
    });
    Ok(())
}
