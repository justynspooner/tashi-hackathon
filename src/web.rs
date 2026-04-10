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
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tower_http::cors::CorsLayer;

use crate::proof::ProofOfCoordination;
use crate::protocol::SharedState;
use crate::state::now_ms;

// --- Config types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NodeConfig {
    label: String,
    bind: String,
    secret: String,
    pubkey: String,
    role: String,
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
    peers: HashMap<String, SharedState>,
    last_message_kind: Option<String>,
    last_message_id: Option<String>,
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

#[allow(dead_code)]
struct NodeHandle {
    child: tokio::process::Child,
    cmd_file: PathBuf,
}

struct AppState {
    agent_states: Mutex<HashMap<String, AgentStateResponse>>,
    event_log: Mutex<VecDeque<EventLogEntry>>,
    proofs: Mutex<Vec<ProofResponse>>,
    nodes: Mutex<HashMap<String, NodeHandle>>,
    config: Mutex<NodesConfig>,
    config_path: PathBuf,
    sse_tx: broadcast::Sender<String>,
    project_root: PathBuf,
    /// Per-node byte offset for tailing event log files.
    log_offsets: Mutex<HashMap<String, u64>>,
    /// Per-node proof count for detecting new proofs.
    proof_counts: Mutex<HashMap<String, usize>>,
}

// --- Server entry point ---

pub async fn serve(port: u16) -> anyhow::Result<()> {
    let project_root = std::env::current_dir()?;
    let artifacts_dir = project_root.join("artifacts");
    std::fs::create_dir_all(&artifacts_dir)?;
    let config_path = artifacts_dir.join("node-config.json");
    let config = load_or_create_config(&config_path)?;

    let (sse_tx, _) = broadcast::channel::<String>(256);

    let state = Arc::new(AppState {
        agent_states: Mutex::new(HashMap::new()),
        event_log: Mutex::new(VecDeque::new()),
        proofs: Mutex::new(Vec::new()),
        nodes: Mutex::new(HashMap::new()),
        config: Mutex::new(config.clone()),
        config_path,
        sse_tx,
        project_root,
        log_offsets: Mutex::new(HashMap::new()),
        proof_counts: Mutex::new(HashMap::new()),
    });

    load_existing_artifacts(&state, &artifacts_dir);

    // File watcher task — polls artifact files for updates from child processes
    let state2 = state.clone();
    tokio::spawn(async move {
        file_watcher(state2).await;
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
        .route("/api/swarm", post(create_swarm).delete(destroy_swarm))
        .route("/api/clear-artifacts", post(clear_artifacts))
        .layer(CorsLayer::permissive())
        .with_state(state.clone());

    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    println!("API server listening on http://localhost:{port}");
    if config.nodes.is_empty() {
        println!("No nodes configured. Use the UI to add nodes.");
    } else {
        println!(
            "Nodes configured: {}",
            config.nodes.iter().map(|n| n.label.as_str()).collect::<Vec<_>>().join(", ")
        );
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    // Cleanup: kill all child processes
    {
        let mut nodes = state.nodes.lock().unwrap();
        for (_, mut handle) in nodes.drain() {
            let _ = handle.child.start_kill();
        }
    }

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

    let config = NodesConfig { nodes: vec![] };
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(config_path, serde_json::to_string_pretty(&config)?)?;
    Ok(config)
}

// --- File watcher: polls artifact files for updates from child processes ---

async fn file_watcher(state: Arc<AppState>) {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(200));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        interval.tick().await;

        let labels: Vec<String> = {
            let nodes = state.nodes.lock().unwrap();
            nodes.keys().cloned().collect()
        };

        if labels.is_empty() {
            continue;
        }

        let mut any_update = false;

        for label in &labels {
            // Check for child process exit
            {
                let mut nodes = state.nodes.lock().unwrap();
                if let Some(handle) = nodes.get_mut(label) {
                    if let Ok(Some(_status)) = handle.child.try_wait() {
                        nodes.remove(label);
                        let _ = state.sse_tx.send(
                            serde_json::json!({"type": "node_status", "label": label, "status": "stopped"}).to_string(),
                        );
                        continue;
                    }
                }
            }

            // Tail event log file
            let event_log_path = state.project_root.join(format!("artifacts/{label}-events.jsonl"));
            if event_log_path.exists() {
                let file_len = std::fs::metadata(&event_log_path).map(|m| m.len()).unwrap_or(0);
                let offset = {
                    let offsets = state.log_offsets.lock().unwrap();
                    offsets.get(label).copied().unwrap_or(0)
                };
                if file_len > offset {
                    if let Ok(data) = std::fs::read_to_string(&event_log_path) {
                        let new_bytes = &data[offset as usize..];
                        for line in new_bytes.lines() {
                            if let Ok(entry) = serde_json::from_str::<EventLogEntry>(line) {
                                // Skip verbose Vertex debug logs
                                if entry.tag == "VERTEX_RX" || entry.tag == "VERTEX_TX" {
                                    continue;
                                }
                                let _ = state.sse_tx.send(
                                    serde_json::json!({
                                        "type": "event_log",
                                        "entry": {"ts": entry.ts, "tag": entry.tag, "label": entry.label, "message": entry.message}
                                    }).to_string(),
                                );
                                let mut log = state.event_log.lock().unwrap();
                                log.push_back(entry);
                                while log.len() > 2000 {
                                    log.pop_front();
                                }
                            }
                        }
                        state.log_offsets.lock().unwrap().insert(label.clone(), file_len);
                    }
                }
            }

            // Read state file
            let state_file = state.project_root.join(format!("artifacts/{label}-state.json"));
            if state_file.exists() {
                if let Ok(data) = std::fs::read_to_string(&state_file) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                        if let Some(lbl) = val.get("label").and_then(|v| v.as_str()) {
                            if let Ok(local) = serde_json::from_value::<SharedState>(val["local"].clone()) {
                                let peers: HashMap<String, SharedState> =
                                    val.get("peers").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
                                let resp = AgentStateResponse {
                                    file: format!("{label}-state.json"),
                                    label: lbl.to_string(),
                                    local,
                                    peers,
                                    last_message_kind: val.get("last_message_kind").and_then(|v| v.as_str()).map(String::from),
                                    last_message_id: val.get("last_message_id").and_then(|v| v.as_str()).map(String::from),
                                };
                                state.agent_states.lock().unwrap().insert(lbl.to_string(), resp);
                                any_update = true;
                            }
                        }
                    }
                }
            }

            // Check for new proofs
            let proof_dir = state.project_root.join(format!("artifacts/proofs/{label}"));
            if proof_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&proof_dir) {
                    let files: Vec<_> = entries
                        .flatten()
                        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
                        .collect();
                    let prev_count = state.proof_counts.lock().unwrap().get(label).copied().unwrap_or(0);
                    if files.len() > prev_count {
                        // Load new proofs
                        let mut all_files: Vec<_> = files.iter().map(|f| f.path()).collect();
                        all_files.sort();
                        for path in &all_files[prev_count..] {
                            if let Ok(data) = std::fs::read_to_string(path) {
                                if let Ok(proof) = serde_json::from_str::<ProofOfCoordination>(&data) {
                                    let fname = path.file_name().unwrap().to_string_lossy().to_string();
                                    state.proofs.lock().unwrap().push(ProofResponse {
                                        file: format!("{label}/{fname}"),
                                        agent: label.clone(),
                                        proof,
                                    });
                                    any_update = true;
                                }
                            }
                        }
                        state.proof_counts.lock().unwrap().insert(label.clone(), files.len());
                    }
                }
            }
        }

        if any_update {
            let _ = state.sse_tx.send(
                serde_json::json!({"type": "update", "ts": now_ms()}).to_string(),
            );
        }
    }
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
                                let peers: HashMap<String, SharedState> =
                                    if let Some(peers_val) = val.get("peers") {
                                        serde_json::from_value(peers_val.clone()).unwrap_or_default()
                                    } else if let Some(peer_val) = val.get("peer") {
                                        if let Ok(peer) = serde_json::from_value::<SharedState>(peer_val.clone()) {
                                            let mut m = HashMap::new();
                                            m.insert(peer.peer_id.clone(), peer);
                                            m
                                        } else { HashMap::new() }
                                    } else { HashMap::new() };

                                let resp = AgentStateResponse {
                                    file: name.clone(),
                                    label: label.to_string(),
                                    local,
                                    peers,
                                    last_message_kind: val.get("last_message_kind").and_then(|v| v.as_str()).map(String::from),
                                    last_message_id: val.get("last_message_id").and_then(|v| v.as_str()).map(String::from),
                                };
                                state.agent_states.lock().unwrap().insert(label.to_string(), resp);
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
            if !agent_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let agent = agent_entry.file_name().to_string_lossy().to_string();
            if let Ok(files) = std::fs::read_dir(agent_entry.path()) {
                for file_entry in files.flatten() {
                    let fname = file_entry.file_name().to_string_lossy().to_string();
                    if !fname.ends_with(".json") { continue; }
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
    state.proofs.lock().unwrap().sort_by(|a, b| b.proof.consensus_at.cmp(&a.proof.consensus_at));
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
        (StatusCode::NOT_FOUND, Json(serde_json::json!({"valid": false, "error": "proof not found"}))).into_response()
    }
}

async fn get_nodes(State(state): State<Arc<AppState>>) -> Json<Vec<NodeInfoResponse>> {
    let config = state.config.lock().unwrap();
    let nodes = state.nodes.lock().unwrap();
    let agent_states = state.agent_states.lock().unwrap();
    Json(
        config.nodes.iter().map(|n| {
            let status = if nodes.contains_key(&n.label) { "running" } else { "stopped" };
            let role = agent_states.get(&n.label).map(|s| s.local.role.clone());
            NodeInfoResponse { label: n.label.clone(), bind: n.bind.clone(), role, status: status.to_string() }
        }).collect(),
    )
}

// --- Node lifecycle ---

fn spawn_node(state: &Arc<AppState>, label: &str) -> bool {
    let (node_config, peers_info) = {
        let config = state.config.lock().unwrap();
        let nc = config.nodes.iter().find(|n| n.label == label).cloned();
        let peers: Vec<(String, String)> = config.nodes.iter()
            .filter(|n| n.label != label)
            .map(|n| (n.bind.clone(), n.pubkey.clone()))
            .collect();
        (nc, peers)
    };

    let Some(node_config) = node_config else { return false; };

    // Clean stale event log
    let event_log_path = state.project_root.join(format!("artifacts/{label}-events.jsonl"));
    let _ = std::fs::remove_file(&event_log_path);
    {
        let mut log = state.event_log.lock().unwrap();
        log.retain(|e| e.label != label);
    }
    state.log_offsets.lock().unwrap().remove(label);
    state.proof_counts.lock().unwrap().remove(label);

    let state_file = state.project_root.join(format!("artifacts/{label}-state.json"));
    let proof_dir = state.project_root.join(format!("artifacts/proofs/{label}"));
    let event_log = state.project_root.join(format!("artifacts/{label}-events.jsonl"));
    let cmd_file = state.project_root.join(format!("artifacts/{label}-cmd.json"));

    let exe = std::env::current_exe().unwrap();
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("run")
        .arg("--bind").arg(&node_config.bind)
        .arg("--secret").arg(&node_config.secret)
        .arg("--label").arg(label)
        .arg("--role").arg(&node_config.role)
        .arg("--state-file").arg(&state_file)
        .arg("--proof-dir").arg(&proof_dir)
        .arg("--event-log").arg(&event_log)
        .arg("--cmd-file").arg(&cmd_file);

    for (addr, pubkey) in &peers_info {
        cmd.arg("--peer-addr").arg(addr)
            .arg("--peer-pubkey").arg(pubkey);
    }

    // Restarting a fixed-member node with the same key/port works reliably here
    // when we let it resume the existing address book without the `--joining` flag.
    cmd.kill_on_drop(true);

    match cmd.spawn() {
        Ok(child) => {
            let _ = state.sse_tx.send(
                serde_json::json!({"type": "node_status", "label": label, "status": "running"}).to_string(),
            );
            state.nodes.lock().unwrap().insert(
                label.to_string(),
                NodeHandle { child, cmd_file },
            );
            true
        }
        Err(e) => {
            eprintln!("[{label}] failed to spawn: {e}");
            false
        }
    }
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

    if spawn_node(&state, &label) {
        Json(serde_json::json!({"status": "started"}))
    } else {
        Json(serde_json::json!({"error": format!("Node {label} not found")}))
    }
}

async fn stop_node(
    State(state): State<Arc<AppState>>,
    AxumPath(label): AxumPath<String>,
) -> Json<serde_json::Value> {
    let handle = {
        let mut nodes = state.nodes.lock().unwrap();
        nodes.remove(&label)
    };
    if let Some(mut handle) = handle {
        let _ = handle.child.start_kill();
        let _ = handle.child.wait().await;
        Json(serde_json::json!({"status": "stopped"}))
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

    // Write command file for the child process to pick up
    let nodes = state.nodes.lock().unwrap();
    if nodes.contains_key(&label) {
        let cmd_file = state.project_root.join(format!("artifacts/{label}-cmd.json"));
        let cmd_json = serde_json::json!({"command": "set_role", "role": body.role});
        let _ = std::fs::write(&cmd_file, serde_json::to_string(&cmd_json).unwrap_or_default());
    }

    Json(serde_json::json!({"status": "ok", "role": body.role}))
}

// --- Swarm management ---

#[derive(Deserialize)]
struct SwarmRequest {
    count: usize,
}

async fn create_swarm(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SwarmRequest>,
) -> Json<serde_json::Value> {
    {
        let config = state.config.lock().unwrap();
        if !config.nodes.is_empty() {
            return Json(serde_json::json!({"error": "Swarm already exists. Destroy it first."}));
        }
    }

    let count = body.count.max(1).min(26);
    let mut labels = Vec::new();

    {
        let mut config = state.config.lock().unwrap();
        for i in 0..count {
            let letter = (b'a' + i as u8) as char;
            let label = format!("agent-{letter}");
            let port = 9000 + i as u16;
            let key = KeySecret::generate();

            config.nodes.push(NodeConfig {
                label: label.clone(),
                bind: format!("127.0.0.1:{port}"),
                secret: key.to_string(),
                pubkey: key.public().to_string(),
                role: "carrier".into(),
            });
            labels.push(label);
        }
        let _ = std::fs::write(
            &state.config_path,
            serde_json::to_string_pretty(&*config).unwrap_or_default(),
        );
    }

    println!("Swarm created with {} nodes: {}", count, labels.join(", "));

    let _ = state.sse_tx.send(
        serde_json::json!({"type": "swarm_created", "labels": labels}).to_string(),
    );

    Json(serde_json::json!({"status": "ok", "count": count, "labels": labels}))
}

async fn destroy_swarm(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    // Kill all running child processes
    {
        let mut nodes = state.nodes.lock().unwrap();
        for (_, mut handle) in nodes.drain() {
            let _ = handle.child.start_kill();
        }
    }

    // Clear config
    {
        let mut config = state.config.lock().unwrap();
        config.nodes.clear();
        let _ = std::fs::write(
            &state.config_path,
            serde_json::to_string_pretty(&*config).unwrap_or_default(),
        );
    }

    // Clear in-memory state
    state.agent_states.lock().unwrap().clear();
    state.proofs.lock().unwrap().clear();
    state.log_offsets.lock().unwrap().clear();
    state.proof_counts.lock().unwrap().clear();
    println!("Swarm destroyed");

    let _ = state.sse_tx.send(
        serde_json::json!({"type": "swarm_destroyed"}).to_string(),
    );

    Json(serde_json::json!({"status": "ok"}))
}

async fn clear_artifacts(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    // Kill all nodes
    {
        let mut nodes = state.nodes.lock().unwrap();
        for (_, mut handle) in nodes.drain() {
            let _ = handle.child.start_kill();
        }
    }

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Remove artifact files (keep node-config.json)
    let artifacts_dir = state.project_root.join("artifacts");
    if let Ok(entries) = std::fs::read_dir(&artifacts_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "node-config.json" { continue; }
            let _ = std::fs::remove_dir_all(entry.path())
                .or_else(|_| std::fs::remove_file(entry.path()));
        }
    }

    state.agent_states.lock().unwrap().clear();
    state.event_log.lock().unwrap().clear();
    state.proofs.lock().unwrap().clear();
    state.log_offsets.lock().unwrap().clear();
    state.proof_counts.lock().unwrap().clear();
    let _ = state.sse_tx.send(
        serde_json::json!({"type": "artifacts_cleared", "ts": now_ms()}).to_string(),
    );

    Json(serde_json::json!({"status": "ok"}))
}
