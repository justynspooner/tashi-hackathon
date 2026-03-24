use std::cell::RefCell;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context as _;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::proof::ProofOfCoordination;
use crate::protocol::{MessageKind, PendingRoleChange, SharedState, WireMessage};

// --- Cross-thread channel types ---

#[derive(Debug)]
pub enum WebEvent {
    StateChanged {
        label: String,
        local: SharedState,
        peer: Option<SharedState>,
        last_message_kind: Option<String>,
        last_message_id: Option<String>,
        pending_role_change: Option<PendingRoleChange>,
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
}

#[derive(Debug)]
pub enum NodeCommand {
    SetRole(String),
}

pub type SharedRuntime = Rc<RefCell<RuntimeState>>;

pub struct RuntimeState {
    pub label: String,
    pub local: SharedState,
    pub peer: Option<SharedState>,
    pub local_public_key: String,
    pub expected_peer_id: String,
    pub peer_control_addr: String,
    pub last_message_kind: Option<MessageKind>,
    pub last_message_id: Option<String>,
    pub next_message_seq: u64,
    pub pending_role_change: Option<PendingRoleChange>,
    pub state_file: Option<PathBuf>,
    pub sync_points_seen: u64,
    pub discovery_logged: bool,
    pub handshake_logged: bool,
    pub last_peer_contact_ms: Option<u64>,
    pub stale_logged: bool,
    pub auto_toggle_done: bool,
    pub cmd_file: Option<PathBuf>,
}

impl RuntimeState {
    pub fn new(
        label: String,
        local_public_key: String,
        expected_peer_id: String,
        peer_control_addr: String,
        role: String,
        status: String,
        state_file: Option<PathBuf>,
        cmd_file: Option<PathBuf>,
    ) -> Self {
        Self {
            label,
            local: SharedState {
                peer_id: local_public_key.clone(),
                last_seen_ms: now_ms(),
                role,
                status,
            },
            peer: None,
            local_public_key,
            expected_peer_id,
            peer_control_addr,
            last_message_kind: None,
            last_message_id: None,
            next_message_seq: 1,
            pending_role_change: None,
            state_file,
            sync_points_seen: 0,
            discovery_logged: false,
            handshake_logged: false,
            last_peer_contact_ms: None,
            stale_logged: false,
            auto_toggle_done: false,
            cmd_file,
        }
    }

    pub fn next_message_id(&mut self, kind: &MessageKind, sent_at_ms: u64) -> String {
        let id = format!("{}-{}-{}", kind.as_str(), sent_at_ms, self.next_message_seq);
        self.next_message_seq += 1;
        id
    }
}

pub fn update_peer_state(state: &mut RuntimeState, wire: &WireMessage) {
    let now = now_ms();
    let label = state.label.clone();
    let peer_short = &wire.state.peer_id[..12.min(wire.state.peer_id.len())];

    let was_stale = state
        .peer
        .as_ref()
        .map(|p| p.status == "stale")
        .unwrap_or(false);

    state.peer = Some(wire.state.clone());
    state.last_peer_contact_ms = Some(now);
    state.stale_logged = false;
    state.last_message_kind = Some(wire.kind.clone());
    state.last_message_id = Some(wire.message_id.clone());

    if !state.discovery_logged {
        state.discovery_logged = true;
        log("DISCOVERY", &label, format!("discovered peer {peer_short}"));
    }

    if was_stale {
        log(
            "RECOVERY",
            &label,
            format!("peer {peer_short} resumed after stale period"),
        );
    }
}

#[derive(Debug, Serialize)]
struct PersistedState<'a> {
    label: &'a str,
    local: &'a SharedState,
    peer: &'a Option<SharedState>,
    last_message_kind: Option<&'a str>,
    last_message_id: Option<&'a str>,
    pending_role_change: &'a Option<PendingRoleChange>,
}

pub fn persist_state(state: &RuntimeState) -> anyhow::Result<()> {
    let Some(path) = state.state_file.as_ref() else {
        return Ok(());
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create state directory {}", parent.display()))?;
    }

    let snapshot = PersistedState {
        label: &state.label,
        local: &state.local,
        peer: &state.peer,
        last_message_kind: state.last_message_kind.as_ref().map(MessageKind::as_str),
        last_message_id: state.last_message_id.as_deref(),
        pending_role_change: &state.pending_role_change,
    };

    let json = serde_json::to_vec_pretty(&snapshot)?;
    fs::write(path, json).with_context(|| format!("failed to write {}", path.display()))?;

    send_web_event(WebEvent::StateChanged {
        label: state.label.clone(),
        local: state.local.clone(),
        peer: state.peer.clone(),
        last_message_kind: state.last_message_kind.as_ref().map(|k| k.as_str().to_string()),
        last_message_id: state.last_message_id.clone(),
        pending_role_change: state.pending_role_change.clone(),
    });

    Ok(())
}

// Log path stored in a thread-local so `log()` can remain a free function
// without needing a reference to RuntimeState.
thread_local! {
    static EVENT_LOG_PATH: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    static WEB_TX: RefCell<Option<mpsc::UnboundedSender<WebEvent>>> = const { RefCell::new(None) };
}

/// Set the global event-log path (call once at startup).
pub fn set_event_log_path(path: Option<PathBuf>) {
    EVENT_LOG_PATH.with(|p| *p.borrow_mut() = path);
}

/// Set the global web-event sender (call once at startup when running embedded).
pub fn set_web_sender(tx: Option<mpsc::UnboundedSender<WebEvent>>) {
    WEB_TX.with(|t| *t.borrow_mut() = tx);
}

/// Send an event to the web server (no-op if no sender is set).
pub fn send_web_event(event: WebEvent) {
    WEB_TX.with(|tx| {
        let tx = tx.borrow();
        if let Some(ref tx) = *tx {
            let _ = tx.send(event);
        }
    });
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

    EVENT_LOG_PATH.with(|path| {
        let path = path.borrow();
        let Some(ref path) = *path else { return };
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
    });
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after Unix epoch")
        .as_millis() as u64
}
