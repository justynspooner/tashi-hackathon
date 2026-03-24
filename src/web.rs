use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tashi_vertex::KeySecret;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tower_http::cors::CorsLayer;

use crate::proof::ProofOfCoordination;
use crate::protocol::{PendingRoleChange, SharedState};
use crate::state::{now_ms, NodeCommand, WebEvent};

// --- Config types (compatible with existing node-config.json) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NodeConfig {
    label: String,
    bind: String,
    #[serde(rename = "peerAddr")]
    peer_addr: String,
    secret: String,
    pubkey: String,
    role: String,
    status: String,
    #[serde(rename = "heartbeatMs")]
    heartbeat_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NodesConfig {
    nodes: Vec<NodeConfig>,
}

// --- API response types ---

#[derive(Debug, Clone, Serialize)]
struct AgentStateResponse {
    file: String,
    label: String,
    local: SharedState,
    peer: Option<SharedState>,
    last_message_kind: Option<String>,
    last_message_id: Option<String>,
    pending_role_change: Option<PendingRoleChange>,
}

#[derive(Debug, Clone, Serialize)]
struct ProofResponse {
    file: String,
    agent: String,
    #[serde(flatten)]
    proof: ProofOfCoordination,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EventLogEntry {
    ts: u64,
    tag: String,
    label: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct NodeInfoResponse {
    label: String,
    bind: String,
    role: Option<String>,
    status: String,
}

// --- Internal state ---

struct NodeHandle {
    cmd_tx: mpsc::UnboundedSender<NodeCommand>,
    _thread: std::thread::JoinHandle<anyhow::Result<()>>,
}

struct AppState {
    agent_states: Mutex<HashMap<String, AgentStateResponse>>,
    event_log: Mutex<VecDeque<EventLogEntry>>,
    proofs: Mutex<Vec<ProofResponse>>,
    nodes: Mutex<HashMap<String, NodeHandle>>,
    config: Mutex<NodesConfig>,
    config_path: PathBuf,
    sse_tx: broadcast::Sender<String>,
    web_tx: mpsc::UnboundedSender<WebEvent>,
    project_root: PathBuf,
}

// --- Server entry point ---

pub async fn serve(port: u16) -> anyhow::Result<()> {
    let project_root = std::env::current_dir()?;
    let artifacts_dir = project_root.join("artifacts");
    std::fs::create_dir_all(&artifacts_dir)?;
    let config_path = artifacts_dir.join("node-config.json");
    let config = load_or_create_config(&config_path)?;

    let (web_tx, web_rx) = mpsc::unbounded_channel();
    let (sse_tx, _) = broadcast::channel::<String>(256);

    let state = Arc::new(AppState {
        agent_states: Mutex::new(HashMap::new()),
        event_log: Mutex::new(VecDeque::new()),
        proofs: Mutex::new(Vec::new()),
        nodes: Mutex::new(HashMap::new()),
        config: Mutex::new(config.clone()),
        config_path,
        sse_tx,
        web_tx,
        project_root,
    });

    load_existing_artifacts(&state, &artifacts_dir);

    let state2 = state.clone();
    tokio::spawn(async move {
        process_events(state2, web_rx).await;
    });

    let app = Router::new()
        .route("/api/events", get(sse_handler))
        .route("/api/state", get(get_state))
        .route("/api/proofs", get(get_proofs))
        .route("/api/event-log", get(get_event_log))
        .route("/api/proofs/{agent}/{file}/verify", get(verify_proof_handler))
        .route("/api/nodes", get(get_nodes))
        .route("/api/nodes/{label}/start", post(start_node))
        .route("/api/nodes/{label}/stop", post(stop_node))
        .route("/api/nodes/{label}/role", post(set_role))
        .route("/api/clear-artifacts", post(clear_artifacts))
        .layer(CorsLayer::permissive())
        .with_state(state.clone());

    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    println!("API server listening on http://localhost:{port}");
    println!(
        "Nodes configured: {}",
        config
            .nodes
            .iter()
            .map(|n| n.label.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    // Cleanup: drop all command senders to signal nodes to stop
    state.nodes.lock().unwrap().clear();

    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c().await.ok();
    println!("\nShutting down...");
}

// --- Config management ---

fn load_or_create_config(config_path: &Path) -> anyhow::Result<NodesConfig> {
    if config_path.exists() {
        let data = std::fs::read_to_string(config_path)?;
        return Ok(serde_json::from_str(&data)?);
    }

    println!("Generating keypairs for agent-a and agent-b...");
    let key_a = KeySecret::generate();
    let key_b = KeySecret::generate();

    let config = NodesConfig {
        nodes: vec![
            NodeConfig {
                label: "agent-a".into(),
                bind: "127.0.0.1:9000".into(),
                peer_addr: "127.0.0.1:9001".into(),
                secret: key_a.to_string(),
                pubkey: key_a.public().to_string(),
                role: "carrier".into(),
                status: "ready".into(),
                heartbeat_ms: 1000,
            },
            NodeConfig {
                label: "agent-b".into(),
                bind: "127.0.0.1:9001".into(),
                peer_addr: "127.0.0.1:9000".into(),
                secret: key_b.to_string(),
                pubkey: key_b.public().to_string(),
                role: "carrier".into(),
                status: "ready".into(),
                heartbeat_ms: 1000,
            },
        ],
    };

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(config_path, serde_json::to_string_pretty(&config)?)?;
    println!("Node config saved to {}", config_path.display());
    Ok(config)
}

// --- Load existing state from disk on startup ---

fn load_existing_artifacts(state: &AppState, artifacts_dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(artifacts_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();

            if name.ends_with("-state.json") {
                if let Ok(data) = std::fs::read_to_string(entry.path()) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                        if let Some(label) = val.get("label").and_then(|v| v.as_str()) {
                            if let Ok(local) =
                                serde_json::from_value::<SharedState>(val["local"].clone())
                            {
                                let resp = AgentStateResponse {
                                    file: name.clone(),
                                    label: label.to_string(),
                                    local,
                                    peer: serde_json::from_value(val["peer"].clone()).ok(),
                                    last_message_kind: val
                                        .get("last_message_kind")
                                        .and_then(|v| v.as_str())
                                        .map(String::from),
                                    last_message_id: val
                                        .get("last_message_id")
                                        .and_then(|v| v.as_str())
                                        .map(String::from),
                                    pending_role_change: val
                                        .get("pending_role_change")
                                        .and_then(|v| {
                                            if v.is_null() {
                                                None
                                            } else {
                                                serde_json::from_value(v.clone()).ok()
                                            }
                                        }),
                                };
                                state
                                    .agent_states
                                    .lock()
                                    .unwrap()
                                    .insert(label.to_string(), resp);
                            }
                        }
                    }
                }
            }

            if name.ends_with("-events.jsonl") {
                if let Ok(data) = std::fs::read_to_string(entry.path()) {
                    let mut log = state.event_log.lock().unwrap();
                    for line in data.lines() {
                        if let Ok(entry) = serde_json::from_str::<EventLogEntry>(line) {
                            log.push_back(entry);
                        }
                    }
                }
            }
        }
    }

    // Load proofs
    let proofs_dir = artifacts_dir.join("proofs");
    if let Ok(agents) = std::fs::read_dir(&proofs_dir) {
        for agent_entry in agents.flatten() {
            if !agent_entry
                .file_type()
                .map(|t| t.is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            let agent = agent_entry.file_name().to_string_lossy().to_string();
            if let Ok(files) = std::fs::read_dir(agent_entry.path()) {
                for file_entry in files.flatten() {
                    let fname = file_entry.file_name().to_string_lossy().to_string();
                    if !fname.ends_with(".json") {
                        continue;
                    }
                    if let Ok(data) = std::fs::read_to_string(file_entry.path()) {
                        if let Ok(proof) = serde_json::from_str::<ProofOfCoordination>(&data) {
                            state.proofs.lock().unwrap().push(ProofResponse {
                                file: format!("{agent}/{fname}"),
                                agent: agent.clone(),
                                proof,
                            });
                        }
                    }
                }
            }
        }
    }

    // Sort event log by timestamp, keep last 2000
    let mut log = state.event_log.lock().unwrap();
    let mut entries: Vec<_> = log.drain(..).collect();
    entries.sort_by_key(|e| e.ts);
    let start = entries.len().saturating_sub(2000);
    for e in &entries[start..] {
        log.push_back(e.clone());
    }

    // Sort proofs by consensus_at descending
    state
        .proofs
        .lock()
        .unwrap()
        .sort_by(|a, b| b.proof.consensus_at.cmp(&a.proof.consensus_at));
}

// --- Event processing loop ---

async fn process_events(state: Arc<AppState>, mut web_rx: mpsc::UnboundedReceiver<WebEvent>) {
    while let Some(event) = web_rx.recv().await {
        match event {
            WebEvent::StateChanged {
                label,
                local,
                peer,
                last_message_kind,
                last_message_id,
                pending_role_change,
            } => {
                let resp = AgentStateResponse {
                    file: format!("{label}-state.json"),
                    label: label.clone(),
                    local,
                    peer,
                    last_message_kind,
                    last_message_id,
                    pending_role_change,
                };
                state.agent_states.lock().unwrap().insert(label, resp);
                let _ = state.sse_tx.send(
                    serde_json::json!({"type": "update", "ts": now_ms()}).to_string(),
                );
            }
            WebEvent::LogEntry {
                ts,
                tag,
                label,
                message,
            } => {
                let entry = EventLogEntry {
                    ts,
                    tag: tag.clone(),
                    label: label.clone(),
                    message: message.clone(),
                };
                {
                    let mut log = state.event_log.lock().unwrap();
                    log.push_back(entry);
                    while log.len() > 2000 {
                        log.pop_front();
                    }
                }
                let _ = state.sse_tx.send(
                    serde_json::json!({
                        "type": "event_log",
                        "entry": {"ts": ts, "tag": tag, "label": label, "message": message}
                    })
                    .to_string(),
                );
            }
            WebEvent::ProofSaved { agent, file, proof } => {
                state.proofs.lock().unwrap().push(ProofResponse {
                    file,
                    agent,
                    proof,
                });
                let _ = state.sse_tx.send(
                    serde_json::json!({"type": "update", "ts": now_ms()}).to_string(),
                );
            }
            WebEvent::NodeStatus { label, status } => {
                if status == "stopped" {
                    state.nodes.lock().unwrap().remove(&label);
                }
                let _ = state.sse_tx.send(
                    serde_json::json!({
                        "type": "node_status", "label": label, "status": status
                    })
                    .to_string(),
                );
            }
        }
    }
}

// --- Handlers ---

async fn sse_handler(
    State(state): State<Arc<AppState>>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.sse_tx.subscribe();
    let initial = tokio_stream::iter(vec![Ok::<_, Infallible>(
        Event::default().data(r#"{"type":"connected"}"#),
    )]);
    let updates = BroadcastStream::new(rx)
        .filter_map(|r| r.ok())
        .map(|data| Ok(Event::default().data(data)));
    Sse::new(initial.chain(updates)).keep_alive(KeepAlive::default())
}

async fn get_state(State(state): State<Arc<AppState>>) -> Json<Vec<AgentStateResponse>> {
    Json(state.agent_states.lock().unwrap().values().cloned().collect())
}

async fn get_proofs(State(state): State<Arc<AppState>>) -> Json<Vec<ProofResponse>> {
    Json(state.proofs.lock().unwrap().clone())
}

#[derive(Deserialize)]
struct EventLogQuery {
    tail: Option<usize>,
}

async fn get_event_log(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EventLogQuery>,
) -> Json<Vec<EventLogEntry>> {
    let tail = query.tail.unwrap_or(200).min(2000);
    let log = state.event_log.lock().unwrap();
    let entries: Vec<_> = log.iter().rev().take(tail).cloned().collect();
    let mut result = entries;
    result.reverse();
    Json(result)
}

async fn verify_proof_handler(
    State(state): State<Arc<AppState>>,
    AxumPath((agent, file)): AxumPath<(String, String)>,
) -> impl IntoResponse {
    let proofs = state.proofs.lock().unwrap();
    let key = format!("{agent}/{file}");
    if let Some(p) = proofs.iter().find(|p| p.file == key) {
        let valid = p.proof.verify();
        Json(serde_json::json!({"valid": valid, "proof": p.proof})).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"valid": false, "error": "proof not found"})),
        )
            .into_response()
    }
}

async fn get_nodes(State(state): State<Arc<AppState>>) -> Json<Vec<NodeInfoResponse>> {
    let config = state.config.lock().unwrap();
    let nodes = state.nodes.lock().unwrap();
    let agent_states = state.agent_states.lock().unwrap();
    Json(
        config
            .nodes
            .iter()
            .map(|n| {
                let status = if nodes.contains_key(&n.label) {
                    "running"
                } else {
                    "stopped"
                };
                let role = agent_states.get(&n.label).map(|s| s.local.role.clone());
                NodeInfoResponse {
                    label: n.label.clone(),
                    bind: n.bind.clone(),
                    role,
                    status: status.to_string(),
                }
            })
            .collect(),
    )
}

async fn start_node(
    State(state): State<Arc<AppState>>,
    AxumPath(label): AxumPath<String>,
) -> Json<serde_json::Value> {
    {
        let nodes = state.nodes.lock().unwrap();
        if nodes.contains_key(&label) {
            return Json(serde_json::json!({"status": "already_running"}));
        }
    }

    let (node_config, peer_pubkey) = {
        let config = state.config.lock().unwrap();
        let nc = config.nodes.iter().find(|n| n.label == label).cloned();
        let pp = config
            .nodes
            .iter()
            .find(|n| n.label != label)
            .map(|n| n.pubkey.clone())
            .unwrap_or_default();
        (nc, pp)
    };

    let Some(node_config) = node_config else {
        return Json(serde_json::json!({"error": format!("Node {label} not found")}));
    };

    // Clean stale event log
    let event_log_path = state
        .project_root
        .join(format!("artifacts/{}-events.jsonl", label));
    let _ = std::fs::remove_file(&event_log_path);
    {
        let mut log = state.event_log.lock().unwrap();
        log.retain(|e| e.label != label);
    }

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let web_tx = state.web_tx.clone();
    let web_tx2 = state.web_tx.clone();
    let label2 = label.clone();
    let label3 = label.clone();
    let project_root = state.project_root.clone();

    let thread = std::thread::spawn(move || -> anyhow::Result<()> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;

        let result = rt.block_on(async {
            let state_file = project_root.join(format!("artifacts/{}-state.json", label2));
            let proof_dir = project_root.join(format!("artifacts/proofs/{}", label2));
            let event_log = project_root.join(format!("artifacts/{}-events.jsonl", label2));

            crate::node::run(
                node_config.bind,
                node_config.secret,
                node_config.peer_addr,
                peer_pubkey,
                label2.clone(),
                node_config.role,
                node_config.status,
                node_config.heartbeat_ms,
                10_000,
                None,
                5_000,
                Some(state_file),
                Some(proof_dir),
                Some(event_log),
                None, // no cmd_file when using channels
                Some(web_tx),
                Some(cmd_rx),
            )
            .await
        });

        let _ = web_tx2.send(WebEvent::NodeStatus {
            label: label3,
            status: "stopped".into(),
        });

        result
    });

    let _ = state.sse_tx.send(
        serde_json::json!({"type": "node_status", "label": &label, "status": "running"})
            .to_string(),
    );

    state.nodes.lock().unwrap().insert(
        label,
        NodeHandle {
            cmd_tx,
            _thread: thread,
        },
    );

    Json(serde_json::json!({"status": "started"}))
}

async fn stop_node(
    State(state): State<Arc<AppState>>,
    AxumPath(label): AxumPath<String>,
) -> Json<serde_json::Value> {
    if state.nodes.lock().unwrap().remove(&label).is_some() {
        Json(serde_json::json!({"status": "stopping"}))
    } else {
        Json(serde_json::json!({"status": "already_stopped"}))
    }
}

#[derive(Deserialize)]
struct RoleRequest {
    role: String,
}

async fn set_role(
    State(state): State<Arc<AppState>>,
    AxumPath(label): AxumPath<String>,
    Json(body): Json<RoleRequest>,
) -> Json<serde_json::Value> {
    {
        let mut config = state.config.lock().unwrap();
        if let Some(node) = config.nodes.iter_mut().find(|n| n.label == label) {
            node.role = body.role.clone();
        }
        let _ = std::fs::write(
            &state.config_path,
            serde_json::to_string_pretty(&*config).unwrap_or_default(),
        );
    }

    if let Some(handle) = state.nodes.lock().unwrap().get(&label) {
        let _ = handle.cmd_tx.send(NodeCommand::SetRole(body.role.clone()));
    }

    Json(serde_json::json!({"status": "ok", "role": body.role}))
}

async fn clear_artifacts(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    // Stop all nodes
    state.nodes.lock().unwrap().clear();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Remove artifact files (keep node-config.json)
    let artifacts_dir = state.project_root.join("artifacts");
    if let Ok(entries) = std::fs::read_dir(&artifacts_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "node-config.json" {
                continue;
            }
            let _ = std::fs::remove_dir_all(entry.path())
                .or_else(|_| std::fs::remove_file(entry.path()));
        }
    }

    // Clear in-memory state
    state.agent_states.lock().unwrap().clear();
    state.event_log.lock().unwrap().clear();
    state.proofs.lock().unwrap().clear();

    let _ = state.sse_tx.send(
        serde_json::json!({"type": "artifacts_cleared", "ts": now_ms()}).to_string(),
    );

    Json(serde_json::json!({"status": "ok"}))
}
