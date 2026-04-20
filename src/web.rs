use std::collections::{HashMap, HashSet, VecDeque};
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

use crate::defaults::{
    COMM_RADIUS_M, FIELD_HEIGHT_M, FIELD_WIDTH_M, HYSTERESIS_M, MIN_SEP_M, RECONCILER_TICK_MS,
};
use crate::games::{self, GameConfig};
use crate::geom;
use crate::pf::{normalize_pair, PfPartitionManager, PortPair};
use crate::proof::ProofOfCoordination;

/// Target max pairwise distance for a freshly-created swarm. One hysteresis
/// band below the comm radius so no pair starts in the flap zone of the
/// partition reconciler.
const SWARM_MAX_PAIR_SEP_M: f32 = COMM_RADIUS_M - HYSTERESIS_M;
use crate::protocol::{Position, SharedState};
use crate::state::now_ms;

// --- Config types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NodeConfig {
    label: String,
    bind: String,
    secret: String,
    pubkey: String,
    #[serde(default)]
    initial_x: Option<f32>,
    #[serde(default)]
    initial_y: Option<f32>,
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
    status: String,
    initial_x: Option<f32>,
    initial_y: Option<f32>,
}

// --- Internal state ---

#[allow(dead_code)]
struct NodeHandle {
    child: tokio::process::Child,
    cmd_file: PathBuf,
}

#[derive(Clone)]
struct GamesState {
    dir: PathBuf,
    configs: HashMap<String, GameConfig>,
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
    /// Packet filter manager for network partition simulation.
    pf: PfPartitionManager,
    /// User-severed links that override the range-based reconciler. Stored as
    /// sorted label pairs `(lo, hi)`. The reconciler unions this set into the
    /// desired blocked set every tick, so a manual sever survives regardless
    /// of how close the two nodes are on the field. Cleared only by the user
    /// tapping the edge again (via the `/api/partitions/heal` endpoint).
    manual_partitions: Mutex<HashSet<(String, String)>>,
    /// Latest per-node game-state snapshot (the content of `{label}-game.json`),
    /// refreshed by the file watcher. Keyed by label.
    game_snapshots: Mutex<HashMap<String, serde_json::Value>>,
    /// Per-node mtime of `{label}-game.json` to detect changes.
    game_file_mtimes: Mutex<HashMap<String, std::time::SystemTime>>,
    /// Pre-installed game configs loaded at startup.
    games: GamesState,
}

// --- Server entry point ---

pub async fn serve(port: u16) -> anyhow::Result<()> {
    let project_root = std::env::current_dir()?;
    let artifacts_dir = project_root.join("artifacts");
    std::fs::create_dir_all(&artifacts_dir)?;
    let config_path = artifacts_dir.join("node-config.json");
    let config = load_or_create_config(&config_path)?;

    let games_dir = project_root.join("games");
    let game_configs = games::load_all(&games_dir).unwrap_or_else(|e| {
        eprintln!("[games] failed to load from {}: {e:#}", games_dir.display());
        HashMap::new()
    });
    println!(
        "Loaded {} game config(s): {}",
        game_configs.len(),
        game_configs.keys().cloned().collect::<Vec<_>>().join(", "),
    );

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
        pf: PfPartitionManager::new(),
        manual_partitions: Mutex::new(HashSet::new()),
        game_snapshots: Mutex::new(HashMap::new()),
        game_file_mtimes: Mutex::new(HashMap::new()),
        games: GamesState { dir: games_dir, configs: game_configs },
    });

    load_existing_artifacts(&state, &artifacts_dir);

    // File watcher task — polls artifact files for updates from child processes
    let state2 = state.clone();
    tokio::spawn(async move {
        file_watcher(state2).await;
    });

    // Partition reconciler task — keeps pfctl rules in sync with spatial state.
    let state3 = state.clone();
    tokio::spawn(async move {
        partition_reconciler(state3).await;
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
        .route("/api/nodes/{label}/position", post(set_position))
        .route("/api/nodes/{label}/propose-game/{game_id}", post(propose_game))
        .route("/api/nodes/{label}/vote-game/{game_id}", post(vote_game))
        .route("/api/nodes/{label}/entity-type", post(claim_entity))
        .route("/api/nodes/{label}/ready", post(ready_up))
        .route("/api/game-state", get(get_game_snapshots))
        .route("/api/games", get(get_games))
        .route("/api/swarm", post(create_swarm).delete(destroy_swarm))
        .route("/api/partitions", get(get_partitions))
        .route("/api/partitions/create", post(create_partition))
        .route("/api/partitions/heal", post(heal_partition))
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

    // Cleanup: restore pf rules, then kill all child processes
    state.pf.restore().await;
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
                                // Fan out a dedicated SSE discriminant for
                                // RULE_VIOLATION entries. The log entry
                                // itself still flows through `event_log`
                                // below; the banner / violation UI consumes
                                // `rule_violated` for structured access.
                                if entry.tag == "RULE_VIOLATION" {
                                    let (rule_id, reason) = parse_violation(&entry.message);
                                    let _ = state.sse_tx.send(
                                        serde_json::json!({
                                            "type": "rule_violated",
                                            "label": entry.label,
                                            "rule_id": rule_id,
                                            "reason": reason,
                                        }).to_string(),
                                    );
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

            // Read game-state file (positions + phase + entities)
            let game_file = state.project_root.join(format!("artifacts/{label}-game.json"));
            if game_file.exists() {
                if let Ok(meta) = std::fs::metadata(&game_file) {
                    if let Ok(modified) = meta.modified() {
                        let changed = {
                            let mtimes = state.game_file_mtimes.lock().unwrap();
                            mtimes.get(label).copied() != Some(modified)
                        };
                        if changed {
                            if let Ok(data) = std::fs::read_to_string(&game_file) {
                                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                                    state.game_snapshots.lock().unwrap().insert(label.clone(), val.clone());
                                    state.game_file_mtimes.lock().unwrap().insert(label.clone(), modified);
                                    let _ = state.sse_tx.send(
                                        serde_json::json!({
                                            "type": "game_state_changed",
                                            "label": label,
                                            "snapshot": val,
                                        })
                                        .to_string(),
                                    );
                                    any_update = true;
                                }
                            }
                        }
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
                        // Load new proofs — sort numerically by proof index
                        let mut all_files: Vec<_> = files.iter().map(|f| f.path()).collect();
                        all_files.sort_by(|a, b| {
                            let num = |p: &std::path::PathBuf| -> usize {
                                p.file_stem()
                                    .and_then(|s| s.to_string_lossy().strip_prefix("proof-").map(|n| n.parse().unwrap_or(0)))
                                    .unwrap_or(0)
                            };
                            num(a).cmp(&num(b))
                        });
                        for path in &all_files[prev_count..] {
                            if let Ok(data) = std::fs::read_to_string(path) {
                                if let Ok(proof) = serde_json::from_str::<ProofOfCoordination>(&data) {
                                    let fname = path.file_name().unwrap().to_string_lossy().to_string();
                                    let key = format!("{label}/{fname}");
                                    // Dedupe against whatever `load_existing_artifacts` or a
                                    // previous tick may have already pushed — possible when a
                                    // swarm is destroyed+recreated with the same labels, or if
                                    // the reconciler races artifact cleanup.
                                    let mut proofs = state.proofs.lock().unwrap();
                                    if proofs.iter().any(|p| p.file == key) {
                                        continue;
                                    }
                                    proofs.push(ProofResponse {
                                        file: key,
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

/// Extract `(rule_id, reason)` from a RULE_VIOLATION log message of the form
/// `"[rule_id] ... rejected: reason"` (see `report_violation` in node.rs).
/// Best-effort — unparseable forms return the whole message as `reason`.
fn parse_violation(message: &str) -> (String, String) {
    // Accept either "[rule_id] msg_id from peer rejected: reason"
    // or      "[rule_id] from peer: reason"  (observer-side formatting).
    let (rule, rest) = match (message.strip_prefix('['), message.find(']')) {
        (Some(_), Some(idx)) => (
            message[1..idx].to_string(),
            message.get(idx + 1..).unwrap_or("").trim_start().to_string(),
        ),
        _ => (String::new(), message.to_string()),
    };
    let reason = if let Some((_, after)) = rest.split_once("rejected: ") {
        after.to_string()
    } else if let Some((_, after)) = rest.split_once(": ") {
        after.to_string()
    } else {
        rest
    };
    (rule, reason)
}

// --- Partition reconciler: auto-sync pfctl with spatial state ---

/// Extract `(label, Position)` pairs from the latest per-node snapshots. A node
/// appears once at its best-known position (prefer its own `my_position`, then
/// any peer's view of it, finally its node-config initial position).
fn snapshot_positions(state: &AppState) -> Vec<(String, Position)> {
    let snaps = state.game_snapshots.lock().unwrap();
    let config = state.config.lock().unwrap();
    let mut out: Vec<(String, Position)> = Vec::new();

    // Start with the config (so nodes that haven't produced a snapshot yet —
    // e.g. stopped nodes with `initial_x/y` persisted — still appear).
    for n in &config.nodes {
        if let (Some(x), Some(y)) = (n.initial_x, n.initial_y) {
            out.push((n.label.clone(), Position { x, y }));
        }
    }

    // Override with snapshot-derived positions where available.
    for (label, snap) in snaps.iter() {
        let pos_val = snap
            .get("my_position")
            .cloned()
            .or_else(|| snap.get("entities").and_then(|e| e.get(label.as_str())).and_then(|e| e.get("pos")).cloned());
        if let Some(pv) = pos_val {
            let x = pv.get("x").and_then(|v| v.as_f64());
            let y = pv.get("y").and_then(|v| v.as_f64());
            if let (Some(xf), Some(yf)) = (x, y) {
                if let Some(entry) = out.iter_mut().find(|(l, _)| l == label) {
                    entry.1 = Position { x: xf as f32, y: yf as f32 };
                } else {
                    out.push((label.clone(), Position { x: xf as f32, y: yf as f32 }));
                }
            }
        }
    }

    out
}

/// Map label -> UDP port (from the current node-config).
fn label_port_map(state: &AppState) -> HashMap<String, u16> {
    let config = state.config.lock().unwrap();
    let mut map = HashMap::new();
    for n in &config.nodes {
        if let Some(port_str) = n.bind.rsplit(':').next() {
            if let Ok(port) = port_str.parse::<u16>() {
                map.insert(n.label.clone(), port);
            }
        }
    }
    map
}

/// Convert the live `pfctl`-blocked port set into label-pair form so the
/// hysteresis check can look up a pair's current state without needing the
/// port table again. Pairs involving unknown labels (e.g. stopped nodes with
/// stale port mappings) are silently dropped — they'll be rediscovered on
/// the next reconciler pass.
fn blocked_ports_to_labels(
    blocked_ports: &[PortPair],
    port_to_label: &HashMap<u16, String>,
) -> HashSet<(String, String)> {
    let mut out = HashSet::new();
    for (pa, pb) in blocked_ports {
        if let (Some(la), Some(lb)) = (port_to_label.get(pa), port_to_label.get(pb)) {
            let (lo, hi) = if la <= lb {
                (la.clone(), lb.clone())
            } else {
                (lb.clone(), la.clone())
            };
            out.insert((lo, hi));
        }
    }
    out
}

/// Pure hysteresis evaluator — given the current positions, port map, and
/// which pairs are already blocked, return the set of pairs that *should*
/// be blocked now. Hysteresis: a blocked pair only unblocks when distance <
/// radius - HYSTERESIS; an unblocked pair only becomes blocked when distance
/// > radius + HYSTERESIS. Extracted so it's unit-testable independent of
/// `pfctl`, tokio, or the full `AppState`.
fn compute_desired_blocked(
    positions: &[(String, Position)],
    ports: &HashMap<String, u16>,
    currently_blocked_labels: &HashSet<(String, String)>,
    radius_m: f32,
) -> HashSet<PortPair> {
    let unblock_radius = (radius_m - HYSTERESIS_M).max(0.0);
    let block_radius = radius_m + HYSTERESIS_M;
    let mut desired: HashSet<PortPair> = HashSet::new();
    for i in 0..positions.len() {
        for j in (i + 1)..positions.len() {
            let (la, pa) = &positions[i];
            let (lb, pb) = &positions[j];
            let Some(&pa_port) = ports.get(la) else { continue };
            let Some(&pb_port) = ports.get(lb) else { continue };

            let (lo, hi) = if la <= lb {
                (la.clone(), lb.clone())
            } else {
                (lb.clone(), la.clone())
            };
            let was_blocked = currently_blocked_labels.contains(&(lo, hi));

            let should_block = if was_blocked {
                !geom::in_range(*pa, *pb, unblock_radius)
            } else {
                !geom::in_range(*pa, *pb, block_radius)
            };
            if should_block {
                desired.insert(normalize_pair(pa_port, pb_port));
            }
        }
    }
    desired
}

/// Run one reconciliation pass: compute the desired blocked port set from
/// (range-based + hysteresis) ∪ (user manual partitions) and push it through
/// `pf.set_blocked`. Returns the diff when anything changed, or `None` on
/// no-op.
///
/// Called both from the periodic reconciler loop and synchronously from the
/// `create_partition`/`heal_partition` endpoints so user clicks take effect
/// immediately without waiting for the next tick.
async fn reconcile_once(
    state: &Arc<AppState>,
    radius_m: f32,
) -> anyhow::Result<Option<(Vec<PortPair>, Vec<PortPair>)>> {
    let positions = snapshot_positions(state);
    if positions.len() < 2 {
        // Nothing meaningful to reconcile, but still honor manual severances
        // if both endpoints happen to be configured (edge case).
    }

    let current_blocked_ports = state.pf.blocked_pairs();
    let ports = label_port_map(state);
    let port_to_label: HashMap<u16, String> =
        ports.iter().map(|(l, p)| (*p, l.clone())).collect();

    let currently_blocked_labels =
        blocked_ports_to_labels(&current_blocked_ports, &port_to_label);

    let mut desired_blocked =
        compute_desired_blocked(&positions, &ports, &currently_blocked_labels, radius_m);

    // Overlay: user-severed label pairs always block regardless of range.
    {
        let manual = state.manual_partitions.lock().unwrap();
        for (la, lb) in manual.iter() {
            let (Some(&pa), Some(&pb)) = (ports.get(la), ports.get(lb)) else { continue };
            desired_blocked.insert(normalize_pair(pa, pb));
        }
    }

    state.pf.set_blocked(desired_blocked).await
}

async fn partition_reconciler(state: Arc<AppState>) {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(RECONCILER_TICK_MS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Comm radius is a global playing-field constant — it doesn't change
    // when a game loads. Log it once at startup for operator visibility.
    let radius_m = COMM_RADIUS_M;
    println!("[partition_reconciler] comm radius -> {radius_m:.1}m");

    loop {
        interval.tick().await;

        match reconcile_once(&state, radius_m).await {
            Ok(Some((added, removed))) => {
                if !added.is_empty() || !removed.is_empty() {
                    println!(
                        "[partition_reconciler] diff +{} -{} (total blocked={})",
                        added.len(),
                        removed.len(),
                        state.pf.blocked_pairs().len()
                    );
                    let partitions = partition_list(&state);
                    // Emit the generic `partition_changed` for any edge-list
                    // consumers, and an auto-tagged `partition_auto` so the
                    // consensus-stalled banner can tell that this change was
                    // reconciler-driven (vs a human click).
                    let _ = state.sse_tx.send(
                        serde_json::json!({"type": "partition_changed", "partitions": partitions})
                            .to_string(),
                    );
                    let _ = state.sse_tx.send(
                        serde_json::json!({
                            "type": "partition_auto",
                            "partitions": partitions,
                            "radius_m": radius_m,
                        })
                        .to_string(),
                    );
                }
            }
            Ok(None) => { /* no change */ }
            Err(e) => {
                eprintln!("[partition_reconciler] set_blocked failed: {e:#}");
            }
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
                let mut count = 0usize;
                for file_entry in files.flatten() {
                    let fname = file_entry.file_name().to_string_lossy().to_string();
                    if !fname.ends_with(".json") { continue; }
                    count += 1;
                    if let Ok(data) = std::fs::read_to_string(file_entry.path()) {
                        if let Ok(proof) = serde_json::from_str::<ProofOfCoordination>(&data) {
                            let key = format!("{agent}/{fname}");
                            let mut proofs = state.proofs.lock().unwrap();
                            if !proofs.iter().any(|p| p.file == key) {
                                proofs.push(ProofResponse {
                                    file: key,
                                    agent: agent.clone(),
                                    proof,
                                });
                            }
                        }
                    }
                }
                state.proof_counts.lock().unwrap().insert(agent.clone(), count);
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
    // Cap the response to the most recent proofs. The full set is retained
    // in-memory (for `/verify`) and on disk, but the frontend refetches this
    // endpoint on every SSE `update`, and rendering an uncapped list (with
    // no virtualisation) grows the renderer's heap until Chrome terminates
    // the tab. 200 is comfortably above what the UI shows at once.
    const MAX_PROOFS_RETURNED: usize = 200;
    let proofs = state.proofs.lock().unwrap();
    let mut sorted: Vec<ProofResponse> = proofs.iter().cloned().collect();
    drop(proofs);
    sorted.sort_by(|a, b| b.proof.consensus_at.cmp(&a.proof.consensus_at));
    sorted.truncate(MAX_PROOFS_RETURNED);
    Json(sorted)
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
    Json(
        config.nodes.iter().map(|n| {
            let status = if nodes.contains_key(&n.label) { "running" } else { "stopped" };
            NodeInfoResponse {
                label: n.label.clone(),
                bind: n.bind.clone(),
                status: status.to_string(),
                initial_x: n.initial_x,
                initial_y: n.initial_y,
            }
        }).collect(),
    )
}

async fn get_game_snapshots(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let snaps = state.game_snapshots.lock().unwrap();
    let map: serde_json::Map<String, serde_json::Value> =
        snaps.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    Json(serde_json::Value::Object(map))
}

async fn get_games(State(state): State<Arc<AppState>>) -> Json<Vec<GameConfig>> {
    let mut list: Vec<GameConfig> = state.games.configs.values().cloned().collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    Json(list)
}

// --- Node lifecycle ---

fn spawn_node(state: &Arc<AppState>, label: &str) -> bool {
    let (node_config, peers_info) = {
        let config = state.config.lock().unwrap();
        let nc = config.nodes.iter().find(|n| n.label == label).cloned();
        let peers: Vec<(String, String, String)> = config.nodes.iter()
            .filter(|n| n.label != label)
            .map(|n| (n.bind.clone(), n.pubkey.clone(), n.label.clone()))
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

    let game_file = state.project_root.join(format!("artifacts/{label}-game.json"));
    let swarm_size = { state.config.lock().unwrap().nodes.len() };

    let exe = std::env::current_exe().unwrap();
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("run")
        .arg("--bind").arg(&node_config.bind)
        .arg("--secret").arg(&node_config.secret)
        .arg("--label").arg(label)
        .arg("--state-file").arg(&state_file)
        .arg("--proof-dir").arg(&proof_dir)
        .arg("--event-log").arg(&event_log)
        .arg("--cmd-file").arg(&cmd_file)
        .arg("--game-file").arg(&game_file)
        .arg("--games-dir").arg(&state.games.dir)
        .arg("--swarm-size").arg(format!("{swarm_size}"));

    if let Some(x) = node_config.initial_x {
        cmd.arg("--initial-x").arg(format!("{x}"));
    }
    if let Some(y) = node_config.initial_y {
        cmd.arg("--initial-y").arg(format!("{y}"));
    }

    for (addr, pubkey, peer_label) in &peers_info {
        cmd.arg("--peer-addr").arg(addr)
            .arg("--peer-pubkey").arg(pubkey)
            .arg("--peer-label").arg(peer_label);
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
struct PositionRequest {
    x: f32,
    y: f32,
}

/// Write a game command file for the child to pick up in its next control
/// tick. If the child isn't running we still update the cached snapshot and
/// node-config so the UI stays in sync (e.g. dragging a stopped node).
fn write_game_cmd(
    state: &AppState,
    label: &str,
    cmd: serde_json::Value,
) -> Result<(), String> {
    let nodes = state.nodes.lock().unwrap();
    if !nodes.contains_key(label) {
        return Err("node not running".to_string());
    }
    let cmd_file = state.project_root.join(format!("artifacts/{label}-cmd.json"));
    std::fs::write(
        &cmd_file,
        serde_json::to_string(&cmd).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())
}

async fn set_position(
    State(state): State<Arc<AppState>>,
    AxumPath(label): AxumPath<String>,
    Json(body): Json<PositionRequest>,
) -> Json<serde_json::Value> {
    // Clamp to field.
    let x = body.x.clamp(0.0, FIELD_WIDTH_M);
    let y = body.y.clamp(0.0, FIELD_HEIGHT_M);

    // Persist the new position on the node-config so it survives restarts.
    {
        let mut config = state.config.lock().unwrap();
        if let Some(node) = config.nodes.iter_mut().find(|n| n.label == label) {
            node.initial_x = Some(x);
            node.initial_y = Some(y);
        }
        let _ = std::fs::write(
            &state.config_path,
            serde_json::to_string_pretty(&*config).unwrap_or_default(),
        );
    }

    // Update the live snapshot so the frontend gets immediate feedback even
    // before the consensus event comes back through file_watcher.
    {
        let mut snaps = state.game_snapshots.lock().unwrap();
        let snap = snaps.entry(label.clone()).or_insert_with(|| serde_json::json!({}));
        snap["my_position"] = serde_json::json!({"x": x, "y": y});
        if let Some(entities) = snap.get_mut("entities").and_then(|e| e.as_object_mut()) {
            if let Some(entry) = entities.get_mut(&label) {
                entry["pos"] = serde_json::json!({"x": x, "y": y});
            } else {
                entities.insert(
                    label.clone(),
                    serde_json::json!({
                        "label": label,
                        "peer_id": "",
                        "pos": {"x": x, "y": y},
                        "properties": {},
                        "claimed_at_ms": 0,
                        "last_seen_ms": 0
                    }),
                );
            }
        }
        let _ = state.sse_tx.send(
            serde_json::json!({
                "type": "game_state_changed",
                "label": label,
                "snapshot": snap,
            })
            .to_string(),
        );
    }

    // Ask the child (if running) to broadcast a SensorReading with the new
    // position so every node sees it in consensus order.
    let cmd = serde_json::json!({
        "command": "set_position",
        "x": x,
        "y": y,
    });
    let broadcast_status = match write_game_cmd(&state, &label, cmd) {
        Ok(()) => "queued",
        Err(_) => "offline",
    };

    Json(serde_json::json!({
        "status": "ok",
        "x": x,
        "y": y,
        "broadcast": broadcast_status
    }))
}

async fn propose_game(
    State(state): State<Arc<AppState>>,
    AxumPath((label, game_id)): AxumPath<(String, String)>,
) -> Json<serde_json::Value> {
    let cmd = serde_json::json!({ "command": "propose_game", "game_id": game_id });
    match write_game_cmd(&state, &label, cmd) {
        Ok(()) => Json(serde_json::json!({"status": "queued", "game_id": game_id})),
        Err(e) => Json(serde_json::json!({"error": e})),
    }
}

async fn vote_game(
    State(state): State<Arc<AppState>>,
    AxumPath((label, game_id)): AxumPath<(String, String)>,
) -> Json<serde_json::Value> {
    let cmd = serde_json::json!({ "command": "vote_game", "game_id": game_id });
    match write_game_cmd(&state, &label, cmd) {
        Ok(()) => Json(serde_json::json!({"status": "queued", "game_id": game_id})),
        Err(e) => Json(serde_json::json!({"error": e})),
    }
}

#[derive(Deserialize)]
struct EntityTypeRequest {
    entity_type: String,
    #[serde(default)]
    team: Option<String>,
}

async fn claim_entity(
    State(state): State<Arc<AppState>>,
    AxumPath(label): AxumPath<String>,
    Json(body): Json<EntityTypeRequest>,
) -> Json<serde_json::Value> {
    let cmd = serde_json::json!({
        "command": "claim_entity",
        "entity_type": body.entity_type,
        "team": body.team,
    });
    match write_game_cmd(&state, &label, cmd) {
        Ok(()) => Json(serde_json::json!({"status": "queued"})),
        Err(e) => Json(serde_json::json!({"error": e})),
    }
}

async fn ready_up(
    State(state): State<Arc<AppState>>,
    AxumPath(label): AxumPath<String>,
) -> Json<serde_json::Value> {
    let cmd = serde_json::json!({ "command": "ready_up" });
    match write_game_cmd(&state, &label, cmd) {
        Ok(()) => Json(serde_json::json!({"status": "queued"})),
        Err(e) => Json(serde_json::json!({"error": e})),
    }
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
    let mut new_positions: Vec<Position> = Vec::new();

    {
        let mut config = state.config.lock().unwrap();
        // Seed with any already-placed positions to avoid overlaps across
        // create_swarm invocations. Re-creating a swarm after a destroy starts
        // with an empty existing vec.
        let mut existing: Vec<Position> = config
            .nodes
            .iter()
            .filter_map(|n| match (n.initial_x, n.initial_y) {
                (Some(x), Some(y)) => Some(Position { x, y }),
                _ => None,
            })
            .collect();
        let mut rng = rand::thread_rng();

        for i in 0..count {
            let letter = (b'a' + i as u8) as char;
            let label = format!("agent-{letter}");
            let port = 9000 + i as u16;
            let key = KeySecret::generate();
            // Place each node such that it's within comm range of every
            // already-placed node. This keeps the whole swarm connected on
            // boot so the partition reconciler doesn't block anyone before
            // the user has a chance to drag nodes around.
            let pos = geom::place_connected_without_overlap(
                &existing,
                (FIELD_WIDTH_M, FIELD_HEIGHT_M),
                MIN_SEP_M,
                SWARM_MAX_PAIR_SEP_M,
                &mut rng,
            );
            existing.push(pos);
            new_positions.push(pos);

            config.nodes.push(NodeConfig {
                label: label.clone(),
                bind: format!("127.0.0.1:{port}"),
                secret: key.to_string(),
                pubkey: key.public().to_string(),
                initial_x: Some(pos.x),
                initial_y: Some(pos.y),
            });
            labels.push(label);
        }
        let _ = std::fs::write(
            &state.config_path,
            serde_json::to_string_pretty(&*config).unwrap_or_default(),
        );
    }

    // Seed game_snapshots so the frontend can render the field immediately —
    // even before the child processes start and broadcast their seed
    // SensorReadings over consensus.
    {
        let config = state.config.lock().unwrap();
        let mut snaps = state.game_snapshots.lock().unwrap();
        for (label, pos) in labels.iter().zip(new_positions.iter()) {
            let peer_id = config
                .nodes
                .iter()
                .find(|n| &n.label == label)
                .map(|n| n.pubkey.clone())
                .unwrap_or_default();
            let snapshot = serde_json::json!({
                "label": label,
                "peer_id": peer_id,
                "phase": "no_game",
                "active_game_id": null,
                "my_position": { "x": pos.x, "y": pos.y },
                "entities": {
                    label.clone(): {
                        "label": label,
                        "peer_id": peer_id,
                        "entity_type": null,
                        "team": null,
                        "pos": { "x": pos.x, "y": pos.y },
                        "properties": {},
                        "claimed_at_ms": 0,
                        "last_seen_ms": 0
                    }
                },
                "scores": {},
                "proposal_window": null,
                "vote_window": null,
                "proximity_tracker": {},
                "countdown_zero_ns": null,
                "placement_ok": false,
                "ready_peers": []
            });
            snaps.insert(label.clone(), snapshot);
        }
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
    // Restore pf rules
    state.pf.restore().await;

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
    state.game_snapshots.lock().unwrap().clear();
    state.game_file_mtimes.lock().unwrap().clear();
    state.manual_partitions.lock().unwrap().clear();
    println!("Swarm destroyed");

    let _ = state.sse_tx.send(
        serde_json::json!({"type": "swarm_destroyed"}).to_string(),
    );

    Json(serde_json::json!({"status": "ok"}))
}

// --- Network partition simulation ---

#[derive(Deserialize)]
struct PartitionRequest {
    node_a: String,
    node_b: String,
}

fn label_to_port(config: &NodesConfig, label: &str) -> Option<u16> {
    config.nodes.iter()
        .find(|n| n.label == label)
        .and_then(|n| n.bind.rsplit(':').next()?.parse().ok())
}

fn partition_list(state: &AppState) -> Vec<[String; 2]> {
    let config = state.config.lock().unwrap();
    state.pf.blocked_pairs().iter().filter_map(|(pa, pb)| {
        let la = config.nodes.iter().find(|n| {
            n.bind.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) == Some(*pa)
        })?.label.clone();
        let lb = config.nodes.iter().find(|n| {
            n.bind.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) == Some(*pb)
        })?.label.clone();
        Some([la, lb])
    }).collect()
}

async fn get_partitions(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "partitions": partition_list(&state) }))
}

/// Normalize a pair of labels into a stable `(lo, hi)` tuple so the
/// `manual_partitions` set is insensitive to input order.
fn normalize_label_pair(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

async fn create_partition(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartitionRequest>,
) -> Json<serde_json::Value> {
    // Validate the labels before touching state so bad input is a no-op.
    {
        let config = state.config.lock().unwrap();
        if label_to_port(&config, &body.node_a).is_none()
            || label_to_port(&config, &body.node_b).is_none()
        {
            return Json(serde_json::json!({"error": "unknown node label"}));
        }
    }

    // Record the sever in the manual overlay — the reconciler will pick it
    // up and keep the pair blocked even when the range-based check would
    // otherwise allow them to talk.
    {
        let mut manual = state.manual_partitions.lock().unwrap();
        manual.insert(normalize_label_pair(&body.node_a, &body.node_b));
    }

    if let Err(e) = reconcile_once(&state, COMM_RADIUS_M).await {
        return Json(serde_json::json!({"error": e.to_string()}));
    }

    let partitions = partition_list(&state);
    let _ = state.sse_tx.send(
        serde_json::json!({"type": "partition_changed", "partitions": partitions}).to_string(),
    );

    Json(serde_json::json!({"status": "ok", "partitioned": true}))
}

async fn heal_partition(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PartitionRequest>,
) -> Json<serde_json::Value> {
    {
        let config = state.config.lock().unwrap();
        if label_to_port(&config, &body.node_a).is_none()
            || label_to_port(&config, &body.node_b).is_none()
        {
            return Json(serde_json::json!({"error": "unknown node label"}));
        }
    }

    // Clear the manual overlay. The reconciler decides what to do on the next
    // pass: if the pair is still out of range it stays blocked (auto), else
    // it unblocks.
    {
        let mut manual = state.manual_partitions.lock().unwrap();
        manual.remove(&normalize_label_pair(&body.node_a, &body.node_b));
    }

    if let Err(e) = reconcile_once(&state, COMM_RADIUS_M).await {
        return Json(serde_json::json!({"error": e.to_string()}));
    }

    let partitions = partition_list(&state);
    let _ = state.sse_tx.send(
        serde_json::json!({"type": "partition_changed", "partitions": partitions}).to_string(),
    );

    Json(serde_json::json!({"status": "ok", "partitioned": false}))
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
    state.game_snapshots.lock().unwrap().clear();
    state.game_file_mtimes.lock().unwrap().clear();
    state.manual_partitions.lock().unwrap().clear();
    let _ = state.sse_tx.send(
        serde_json::json!({"type": "artifacts_cleared", "ts": now_ms()}).to_string(),
    );

    Json(serde_json::json!({"status": "ok"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Scripted hysteresis scenarios for the partition reconciler ---
    //
    // Proxies for the "cargo run -- stress" harness: the full 7-node
    // integration test requires a library target (the package is bin-only),
    // so we exercise the reconciler's hysteresis boundary directly. These
    // tests catch the specific failure modes the stress harness was designed
    // to find: premature blocking inside the hysteresis window, unbounded
    // flapping at the boundary, and incorrect recovery after a partition.

    fn pos(x: f32, y: f32) -> Position {
        Position { x, y }
    }

    fn two_node_setup() -> (Vec<(String, Position)>, HashMap<String, u16>) {
        let positions = vec![("a".to_string(), pos(0.0, 0.0)), ("b".to_string(), pos(0.0, 0.0))];
        let mut ports = HashMap::new();
        ports.insert("a".to_string(), 40001);
        ports.insert("b".to_string(), 40002);
        (positions, ports)
    }

    #[test]
    fn reconciler_blocks_outside_block_radius() {
        let (mut positions, ports) = two_node_setup();
        // 9m apart with radius=8, hysteresis=0.5 → block_radius=8.5. 9 > 8.5 → block.
        positions[1].1 = pos(9.0, 0.0);
        let blocked: HashSet<(String, String)> = HashSet::new();
        let desired = compute_desired_blocked(&positions, &ports, &blocked, 8.0);
        assert_eq!(desired.len(), 1, "expected one blocked pair");
    }

    #[test]
    fn reconciler_does_not_block_inside_hysteresis_window() {
        let (mut positions, ports) = two_node_setup();
        // 8.2m apart, radius=8, hysteresis=0.5 → block_radius=8.5. 8.2 <= 8.5 → no block.
        positions[1].1 = pos(8.2, 0.0);
        let blocked: HashSet<(String, String)> = HashSet::new();
        let desired = compute_desired_blocked(&positions, &ports, &blocked, 8.0);
        assert!(desired.is_empty(), "expected no blocks in hysteresis window");
    }

    #[test]
    fn reconciler_keeps_blocked_inside_hysteresis_window() {
        let (mut positions, ports) = two_node_setup();
        // Pair is already blocked. At 7.8m (radius=8, unblock=7.5), we stay blocked.
        positions[1].1 = pos(7.8, 0.0);
        let mut blocked: HashSet<(String, String)> = HashSet::new();
        blocked.insert(("a".into(), "b".into()));
        let desired = compute_desired_blocked(&positions, &ports, &blocked, 8.0);
        assert_eq!(desired.len(), 1, "expected still-blocked pair to stay blocked");
    }

    #[test]
    fn reconciler_unblocks_once_inside_unblock_radius() {
        let (mut positions, ports) = two_node_setup();
        // Pair is currently blocked. At 7.4m, inside unblock_radius=7.5 → unblock.
        positions[1].1 = pos(7.4, 0.0);
        let mut blocked: HashSet<(String, String)> = HashSet::new();
        blocked.insert(("a".into(), "b".into()));
        let desired = compute_desired_blocked(&positions, &ports, &blocked, 8.0);
        assert!(desired.is_empty(), "expected pair to unblock");
    }

    #[test]
    fn reconciler_flapping_at_boundary_stays_stable() {
        // A node walking back and forth across exactly radius_m=8.0 shouldn't
        // cause churn, because the block/unblock bands don't overlap at the
        // exact radius. This is the demo-critical property.
        let (mut positions, ports) = two_node_setup();
        let mut blocked: HashSet<(String, String)> = HashSet::new();

        let distances = [7.9_f32, 8.0, 8.1, 8.0, 7.9, 8.1, 7.95, 8.05];
        let mut transition_count = 0;

        for d in distances {
            positions[1].1 = pos(d, 0.0);
            let desired = compute_desired_blocked(&positions, &ports, &blocked, 8.0);
            let now_blocked: HashSet<(String, String)> = desired
                .iter()
                .map(|(a, b)| {
                    let la = if *a == 40001 { "a" } else { "b" };
                    let lb = if *b == 40002 { "b" } else { "a" };
                    let (lo, hi) = if la <= lb { (la, lb) } else { (lb, la) };
                    (lo.to_string(), hi.to_string())
                })
                .collect();
            if now_blocked != blocked {
                transition_count += 1;
            }
            blocked = now_blocked;
        }

        // With 0.5m hysteresis, a ±0.1m flap around radius=8 should never
        // transition — the movement stays inside the hysteresis dead band.
        assert_eq!(transition_count, 0, "hysteresis failed to absorb flapping");
    }

    #[test]
    fn reconciler_recovers_after_full_separation_then_return() {
        // Models the demo's "drag far away → heal" story. 5 ticks at 20m
        // apart: fully blocked. Then 5 ticks at 3m apart: unblocked.
        let (mut positions, ports) = two_node_setup();
        let mut blocked: HashSet<(String, String)> = HashSet::new();

        for _ in 0..5 {
            positions[1].1 = pos(20.0, 0.0);
            let desired = compute_desired_blocked(&positions, &ports, &blocked, 8.0);
            blocked = desired
                .iter()
                .map(|_| ("a".to_string(), "b".to_string()))
                .collect();
            assert_eq!(blocked.len(), 1, "should be blocked when far apart");
        }

        for _ in 0..5 {
            positions[1].1 = pos(3.0, 0.0);
            let desired = compute_desired_blocked(&positions, &ports, &blocked, 8.0);
            blocked = desired
                .iter()
                .map(|_| ("a".to_string(), "b".to_string()))
                .collect();
        }
        assert!(blocked.is_empty(), "should recover after returning to close range");
    }

    #[test]
    fn parse_violation_reporter_form() {
        let (rule, reason) = parse_violation(
            "[cardinality] claim-123 from agent-b rejected: flag already at max cardinality (1)",
        );
        assert_eq!(rule, "cardinality");
        assert_eq!(reason, "flag already at max cardinality (1)");
    }

    #[test]
    fn parse_violation_observer_form() {
        let (rule, reason) = parse_violation("[cardinality] from agent-b: flag already at max");
        assert_eq!(rule, "cardinality");
        assert_eq!(reason, "flag already at max");
    }

    #[test]
    fn parse_violation_unknown_form_preserves_message() {
        let (rule, reason) = parse_violation("something went sideways");
        assert!(rule.is_empty());
        assert_eq!(reason, "something went sideways");
    }

    #[test]
    fn reconciler_three_way_split_isolates_outlier() {
        // 3 nodes: a and b colocated, c 20m away. Only pairs involving c
        // should be blocked.
        let positions = vec![
            ("a".to_string(), pos(0.0, 0.0)),
            ("b".to_string(), pos(1.0, 0.0)),
            ("c".to_string(), pos(20.0, 0.0)),
        ];
        let mut ports = HashMap::new();
        ports.insert("a".into(), 40001);
        ports.insert("b".into(), 40002);
        ports.insert("c".into(), 40003);
        let blocked: HashSet<(String, String)> = HashSet::new();
        let desired = compute_desired_blocked(&positions, &ports, &blocked, 8.0);
        assert_eq!(desired.len(), 2, "expected 2 blocked pairs (a-c, b-c)");
    }
}
