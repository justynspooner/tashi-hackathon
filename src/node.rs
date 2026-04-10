use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tashi_vertex::{
    Context as VertexContext, Engine, KeyPublic, KeySecret, Message, Options, Peers, Socket, Transaction,
};
use tokio::sync::mpsc;
use tokio::time::{self, MissedTickBehavior};

use crate::proof::ProofOfCoordination;
use crate::protocol::{MessageKind, WireMessage};
use crate::state::{
    log, now_ms, persist_state, send_web_event, set_event_log_path, set_web_sender,
    short_peer_id, update_peer_state, NodeCommand, PeerInfo, RuntimeState, SharedRuntime, WebEvent,
};

#[derive(Debug, Deserialize)]
struct FileCommand {
    command: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

/// Internal request from the control task to the engine task.
struct TxRequest {
    kind: MessageKind,
    note: Option<String>,
}

pub async fn run(
    bind: String,
    secret: String,
    peers_info: Vec<(String, String)>, // Vec of (addr, pubkey)
    label: String,
    role: String,
    status: String,
    heartbeat_ms: u64,
    stale_after_ms: u64,
    toggle_role_to: Option<String>,
    toggle_after_ms: u64,
    state_file: Option<PathBuf>,
    proof_dir: Option<PathBuf>,
    event_log: Option<PathBuf>,
    cmd_file: Option<PathBuf>,
    web_tx: Option<mpsc::UnboundedSender<WebEvent>>,
    cmd_rx: Option<mpsc::UnboundedReceiver<NodeCommand>>,
    joining: bool,
) -> anyhow::Result<()> {
    set_event_log_path(event_log.clone());
    set_web_sender(web_tx);
    let key: KeySecret = secret.parse()?;

    let mut vertex_peers = Peers::new()?;
    let mut peer_map: HashMap<String, PeerInfo> = HashMap::new();

    for (peer_addr, peer_pubkey) in &peers_info {
        let peer_pub: KeyPublic = peer_pubkey.parse()?;
        vertex_peers.insert(peer_addr, &peer_pub, Default::default())?;
        peer_map.insert(
            peer_pubkey.clone(),
            PeerInfo {
                state: None,
                discovery_logged: false,
                handshake_logged: false,
            },
        );
    }
    vertex_peers.insert(&bind, &key.public(), Default::default())?;

    let context = VertexContext::new()?;
    let socket = {
        let mut attempts = 0;
        loop {
            match Socket::bind(&context, &bind).await {
                Ok(s) => break s,
                Err(_) if attempts < 40 => {
                    attempts += 1;
                    log("BIND", &label, format!("port {} busy, retrying ({attempts}/40)...", bind));
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(e) => anyhow::bail!("failed to bind {bind} after {attempts} retries: {e:?}"),
            }
        }
    };

    log("ENGINE", &label, format!(
        "binding socket on {bind} succeeded, creating engine with {} peers (joining={})",
        peers_info.len(), joining
    ));

    let mut options = Options::default();
    options.set_heartbeat_us(heartbeat_ms.saturating_mul(1_000));
    options.set_fallen_behind_kick_s(((stale_after_ms.max(1) + 999) / 1_000) as i64);
    options.set_enable_state_sharing(true);
    options.set_epoch_states_to_cache(10);
    let engine = Engine::start(&context, socket, options, &key, vertex_peers, joining)?;
    let local_public_key = key.public().to_string();
    log("ENGINE", &label, format!("engine started, local_id=...{}", &local_public_key[local_public_key.len().saturating_sub(8)..]));

    let runtime = Arc::new(Mutex::new(RuntimeState::new(
        label.clone(),
        local_public_key.clone(),
        peer_map,
        role,
        status,
        state_file,
        cmd_file,
    )));

    {
        let state = runtime.lock().unwrap();
        let peer_addrs: Vec<&str> = peers_info.iter().map(|(a, _)| a.as_str()).collect();
        persist_state(&state)?;
        log(
            "BOOT",
            &label,
            format!(
                "vertex_bind={} peers=[{}] id=...{}",
                bind,
                peer_addrs.join(", "),
                &local_public_key[local_public_key.len().saturating_sub(8)..]
            ),
        );
    }

    // Channel for the control task to request transactions without touching the engine directly.
    let (tx_req_sender, tx_req_receiver) = mpsc::unbounded_channel::<TxRequest>();

    tokio::select! {
        r = engine_loop(engine, runtime.clone(), proof_dir, tx_req_receiver) => r?,
        r = control_loop(
            runtime.clone(),
            toggle_role_to,
            toggle_after_ms,
            cmd_rx,
            tx_req_sender,
        ) => r?,
        _ = tokio::signal::ctrl_c() => {
            log("SHUTDOWN", &runtime.lock().unwrap().label, "received signal");
        }
    };

    Ok(())
}

// --- Single engine loop: all Engine access happens here ---

async fn engine_loop(
    engine: Engine,
    runtime: SharedRuntime,
    proof_dir: Option<PathBuf>,
    mut tx_req_rx: mpsc::UnboundedReceiver<TxRequest>,
) -> anyhow::Result<()> {
    let mut proof_seq: u64 = 0;

    // Send the hello on first sync point
    let mut hello_sent = false;

    loop {
        tokio::select! {
            Some(req) = tx_req_rx.recv() => {
                process_tx_request(&engine, &runtime, req);
            }
            result = engine.recv_message() => {
                match &result {
                    Ok(None) => {
                        let label = runtime.lock().unwrap().label.clone();
                        log("ENGINE_CLOSED", &label, "recv_message returned None - engine shut down");
                        return Ok(());
                    }
                    Err(e) => {
                        let label = runtime.lock().unwrap().label.clone();
                        log("RECV_ERR", &label, format!("recv_message error: {e:#}"));
                        anyhow::bail!("recv_message error: {e:#}");
                    }
                    Ok(Some(_)) => {}
                }
                let message = result.unwrap().unwrap();

                match message {
                    Message::SyncPoint(_) => {
                        let mut state = runtime.lock().unwrap();
                        state.sync_points_seen += 1;
                        log(
                            "SYNC",
                            &state.label,
                            format!("SyncPoint #{}", state.sync_points_seen),
                        );
                        if !hello_sent {
                            hello_sent = true;
                            log(
                                "DISCOVERY",
                                &state.label,
                                "first sync point; Vertex session active",
                            );
                            drop(state);

                            let hello = send_vertex_transaction(
                                &engine,
                                &runtime,
                                MessageKind::Hello,
                                Some("signed hello via Vertex".to_string()),
                            )?;
                            let state = runtime.lock().unwrap();
                            log(
                                "HANDSHAKE",
                                &state.label,
                                format!(
                                    "sent HELLO {} role={} status={}",
                                    hello.message_id, state.local.role, state.local.status
                                ),
                            );
                        }
                    }
                    Message::Event(event) => {
                        let creator = event.creator().to_string();
                        let tx_count = event.transaction_count();
                        let is_local = {
                            let state = runtime.lock().unwrap();
                            let creator_short = short_peer_id(&creator);
                            let is_self = creator == state.local_public_key;
                            log(
                                "EVENT",
                                &state.label,
                                format!(
                                    "from {} txns={} consensus_at={} is_local={}",
                                    creator_short,
                                    tx_count,
                                    event.consensus_at(),
                                    is_self
                                ),
                            );
                            is_self
                        };
                        if is_local {
                            continue;
                        }

                        if let Some(ref dir) = proof_dir {
                            if event.transaction_count() > 0 {
                                if let Some(proof) = ProofOfCoordination::from_event(&event) {
                                    let proof_name = format!("proof-{proof_seq}.json");
                                    let path = dir.join(&proof_name);
                                    proof.save(&path)?;
                                    proof_seq += 1;
                                    let state = runtime.lock().unwrap();
                                    send_web_event(WebEvent::ProofSaved {
                                        agent: state.label.clone(),
                                        file: format!("{}/{}", state.label, proof_name),
                                        proof: proof.clone(),
                                    });
                                    log(
                                        "PROOF",
                                        &state.label,
                                        format!(
                                            "wrote {} (finality={}ms, txns={})",
                                            path.display(),
                                            proof.finality_ms,
                                            proof.transactions.len(),
                                        ),
                                    );
                                }
                            }
                        }

                        for tx in event.transactions() {
                            let wire: WireMessage = match serde_json::from_slice(tx) {
                                Ok(w) => w,
                                Err(_) => continue,
                            };
                            if wire.state.peer_id != creator {
                                continue;
                            }
                            if let Some(reply_note) = handle_vertex_message(&runtime, wire)? {
                                let _ = send_vertex_transaction(
                                    &engine,
                                    &runtime,
                                    MessageKind::StateUpdate,
                                    Some(reply_note),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

fn process_tx_request(engine: &Engine, runtime: &SharedRuntime, req: TxRequest) {
    let action = req.note.clone().unwrap_or_else(|| req.kind.as_str().to_string());
    {
        let state = runtime.lock().unwrap();
        log("ACTION", &state.label, format!("sending {action} via Vertex..."));
    }
    match send_vertex_transaction(engine, runtime, req.kind, req.note) {
        Ok(msg) => {
            let state = runtime.lock().unwrap();
            log(
                "ACTION",
                &state.label,
                format!("broadcast {action} as {}", msg.message_id),
            );
        }
        Err(e) => {
            let state = runtime.lock().unwrap();
            log(
                "ACTION_ERR",
                &state.label,
                format!("FAILED to send {action}: {e:#}"),
            );
        }
    }
}

fn handle_vertex_message(runtime: &SharedRuntime, wire: WireMessage) -> anyhow::Result<Option<String>> {
    let mut state = runtime.lock().unwrap();
    let peer_id = wire.state.peer_id.clone();
    let peer_short = short_peer_id(&peer_id);
    let mut reply_note = None;

    update_peer_state(&mut state, &wire);

    match wire.kind {
        MessageKind::Hello => {
            reply_note = Some(format!("current state for {peer_short}"));
            if let Some(peer_info) = state.peers.get_mut(&peer_id) {
                if !peer_info.handshake_logged {
                    peer_info.handshake_logged = true;
                    log(
                        "HANDSHAKE",
                        &state.label,
                        format!(
                            "verified signed HELLO {} from {peer_short}",
                            wire.message_id
                        ),
                    );
                }
            }
        }
        MessageKind::StateUpdate => {
            log(
                "STATE",
                &state.label,
                format!(
                    "peer {peer_short} role={} status={} ({})",
                    wire.state.role, wire.state.status, wire.message_id
                ),
            );
        }
        MessageKind::Heartbeat => {
            // Heartbeat received — update_peer_state already tracked last_contact_ms
        }
    }

    persist_state(&state)?;
    Ok(reply_note)
}

// --- Control loop: sends TxRequests through a channel instead of touching Engine ---

async fn control_loop(
    runtime: SharedRuntime,
    toggle_role_to: Option<String>,
    toggle_after_ms: u64,
    mut cmd_rx: Option<mpsc::UnboundedReceiver<NodeCommand>>,
    tx_sender: mpsc::UnboundedSender<TxRequest>,
) -> anyhow::Result<()> {
    let started_at_ms = now_ms();
    let mut interval = time::interval(Duration::from_millis(200));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        interval.tick().await;
        let now = now_ms();
        let mut should_send_state_update = false;
        let mut target_role = None;

        {
            let mut state = runtime.lock().unwrap();

            // Role toggle (CLI-driven one-shot)
            if let Some(ref new_role) = toggle_role_to {
                if !state.auto_toggle_done && now.saturating_sub(started_at_ms) >= toggle_after_ms {
                    state.auto_toggle_done = true;
                    state.local.role = new_role.clone();
                    target_role = Some(new_role.clone());
                    should_send_state_update = true;
                }
            }

            // Command channel (web-driven)
            if let Some(ref mut rx) = cmd_rx {
                loop {
                    match rx.try_recv() {
                        Ok(NodeCommand::SetRole(new_role)) => {
                            state.local.role = new_role.clone();
                            target_role = Some(new_role);
                            should_send_state_update = true;
                        }
                        Err(mpsc::error::TryRecvError::Empty) => break,
                        Err(mpsc::error::TryRecvError::Disconnected) => {
                            log("SHUTDOWN", &state.label, "command channel closed");
                            return Ok(());
                        }
                    }
                }
            }

            // Command file polling (CLI-driven fallback)
            if cmd_rx.is_none() {
                if let Some(ref cmd_path) = state.cmd_file {
                    if let Ok(data) = fs::read_to_string(cmd_path) {
                        let _ = fs::remove_file(cmd_path);
                        if let Ok(cmd) = serde_json::from_str::<FileCommand>(&data) {
                            match cmd.command.as_str() {
                                "set_role" => {
                                    if let Some(new_role) = cmd.role {
                                        state.local.role = new_role.clone();
                                        target_role = Some(new_role);
                                        should_send_state_update = true;
                                    }
                                }
                                "set_status" => {
                                    if let Some(new_status) = cmd.status {
                                        state.local.status = new_status;
                                        persist_state(&state)?;
                                    }
                                }
                                other => {
                                    log("CMD", &state.label, format!("unknown command: {other}"));
                                }
                            }
                        }
                    }
                }
            }
        }

        if should_send_state_update {
            let role = target_role.unwrap();
            let _ = tx_sender.send(TxRequest {
                kind: MessageKind::StateUpdate,
                note: Some(format!("role -> {role}")),
            });
        }
    }
}

// --- Message sending ---

fn send_vertex_transaction(
    engine: &Engine,
    runtime: &SharedRuntime,
    kind: MessageKind,
    note: Option<String>,
) -> anyhow::Result<WireMessage> {
    let label = { runtime.lock().unwrap().label.clone() };
    let message = build_message(runtime, kind, note)?;
    let data = serde_json::to_vec(&message)?;
    let data_len = data.len();
    let mut tx = Transaction::allocate(data_len);
    tx.copy_from_slice(&data);
    match engine.send_transaction(tx) {
        Ok(()) => {
            log(
                "VERTEX_TX",
                &label,
                format!(
                    "sent {} ({} bytes) id={}",
                    message.kind.as_str(),
                    data_len,
                    message.message_id
                ),
            );
        }
        Err(e) => {
            log(
                "VERTEX_ERR",
                &label,
                format!(
                    "send_transaction FAILED for {} id={}: {e:#}",
                    message.kind.as_str(),
                    message.message_id
                ),
            );
            return Err(e.into());
        }
    }
    Ok(message)
}

fn build_message(
    runtime: &SharedRuntime,
    kind: MessageKind,
    note: Option<String>,
) -> anyhow::Result<WireMessage> {
    let mut state = runtime.lock().unwrap();
    let sent_at_ms = now_ms();
    state.local.last_seen_ms = sent_at_ms;

    let message = WireMessage {
        message_id: state.next_message_id(&kind, sent_at_ms),
        kind,
        sent_at_ms,
        state: state.local.clone(),
        note,
    };

    state.last_message_kind = Some(message.kind.clone());
    state.last_message_id = Some(message.message_id.clone());
    persist_state(&state)?;
    Ok(message)
}
