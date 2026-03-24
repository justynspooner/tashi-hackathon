use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use anyhow::Context as _;
use serde::Deserialize;
use tashi_vertex::{
    Context as VertexContext, Engine, KeyPublic, KeySecret, Message, Options, Peers, Socket,
    Transaction,
};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::time::{self, MissedTickBehavior};

use crate::proof::ProofOfCoordination;
use crate::protocol::{MessageKind, PendingRoleChange, WireMessage};
use crate::state::{
    log, now_ms, persist_state, send_web_event, set_event_log_path, set_web_sender,
    update_peer_state, NodeCommand, RuntimeState, SharedRuntime, WebEvent,
};

#[derive(Debug, Deserialize)]
struct FileCommand {
    command: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

const CONTROL_PORT_OFFSET: u16 = 1_000;

pub async fn run(
    bind: String,
    secret: String,
    peer_addr: String,
    peer_pubkey: String,
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
) -> anyhow::Result<()> {
    set_event_log_path(event_log.clone());
    set_web_sender(web_tx);
    let key: KeySecret = secret.parse()?;
    let peer_pub: KeyPublic = peer_pubkey.parse()?;
    let control_bind = derive_control_addr(&bind)?;
    let peer_control_addr = derive_control_addr(&peer_addr)?;

    let mut peers = Peers::new()?;
    peers.insert(&peer_addr, &peer_pub, Default::default())?;
    peers.insert(&bind, &key.public(), Default::default())?;

    let context = VertexContext::new()?;
    let socket = Socket::bind(&context, &bind).await?;

    let mut options = Options::default();
    options.set_heartbeat_us(250_000);
    options.set_fallen_behind_kick_s(-1);
    options.set_enable_state_sharing(true);
    options.set_epoch_states_to_cache(8);

    let engine = Rc::new(Engine::start(&context, socket, options, &key, peers)?);
    let control_socket = Rc::new(UdpSocket::bind(&control_bind).await?);
    let local_public_key = key.public().to_string();

    let runtime = Rc::new(std::cell::RefCell::new(RuntimeState::new(
        label.clone(),
        local_public_key.clone(),
        peer_pub.to_string(),
        peer_control_addr.clone(),
        role,
        status,
        state_file,
        cmd_file,
    )));

    {
        let state = runtime.borrow();
        persist_state(&state)?;
        log(
            "BOOT",
            &label,
            format!(
                "vertex_bind={} control_bind={} peer_addr={} peer_control={} peer_id={}",
                bind, control_bind, peer_addr, peer_control_addr, &local_public_key[..12]
            ),
        );
    }

    tokio::select! {
        r = recv_loop(engine.clone(), runtime.clone(), proof_dir) => r?,
        r = udp_recv_loop(control_socket.clone(), runtime.clone()) => r?,
        r = heartbeat_loop(
            control_socket.clone(),
            runtime.clone(),
            peer_control_addr.clone(),
            heartbeat_ms
        ) => r?,
        r = control_loop(
            engine.clone(),
            control_socket,
            runtime,
            peer_control_addr,
            stale_after_ms,
            toggle_role_to,
            toggle_after_ms,
            cmd_rx,
        ) => r?,
    };

    Ok(())
}

// --- Vertex receive loop ---

async fn recv_loop(
    engine: Rc<Engine>,
    runtime: SharedRuntime,
    proof_dir: Option<PathBuf>,
) -> anyhow::Result<()> {
    let mut proof_seq: u64 = 0;

    loop {
        let Some(message) = engine.recv_message().await? else {
            let state = runtime.borrow();
            log("EXIT", &state.label, "engine closed");
            return Ok(());
        };

        match message {
            Message::SyncPoint(_) => {
                let mut state = runtime.borrow_mut();
                state.sync_points_seen += 1;
                if state.sync_points_seen == 1 {
                    log(
                        "DISCOVERY",
                        &state.label,
                        "first sync point; Vertex session active",
                    );
                    drop(state);

                    let hello = send_vertex_transaction(&engine, &runtime, MessageKind::Hello, Some("signed hello via Vertex".to_string()))?;
                    let state = runtime.borrow();
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
                let is_local = {
                    let state = runtime.borrow();
                    creator == state.local_public_key
                };
                if is_local {
                    continue;
                }

                // Generate proof for finalized events with transactions
                if let Some(ref dir) = proof_dir {
                    if event.transaction_count() > 0 {
                        if let Some(proof) = ProofOfCoordination::from_event(&event) {
                            let proof_name = format!("proof-{proof_seq}.json");
                            let path = dir.join(&proof_name);
                            proof.save(&path)?;
                            proof_seq += 1;
                            let state = runtime.borrow();
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
                    handle_vertex_message(&runtime, wire)?;
                }
            }
        }
    }
}

fn handle_vertex_message(runtime: &SharedRuntime, wire: WireMessage) -> anyhow::Result<()> {
    let mut state = runtime.borrow_mut();

    update_peer_state(&mut state, &wire);

    if matches!(wire.kind, MessageKind::Hello) && !state.handshake_logged {
        state.handshake_logged = true;
        let peer_short = &wire.state.peer_id[..12.min(wire.state.peer_id.len())];
        log(
            "HANDSHAKE",
            &state.label,
            format!(
                "verified signed HELLO {} from {peer_short}",
                wire.message_id
            ),
        );
    }

    persist_state(&state)?;
    Ok(())
}

// --- UDP control channel ---

async fn udp_recv_loop(socket: Rc<UdpSocket>, runtime: SharedRuntime) -> anyhow::Result<()> {
    let mut buf = vec![0u8; 8 * 1024];

    loop {
        let (len, _) = socket.recv_from(&mut buf).await?;
        let wire: WireMessage = match serde_json::from_slice(&buf[..len]) {
            Ok(w) => w,
            Err(_) => continue,
        };

        let expected = { runtime.borrow().expected_peer_id.clone() };
        if wire.state.peer_id != expected {
            continue;
        }

        handle_control_message(&socket, &runtime, wire).await?;
    }
}

async fn handle_control_message(
    socket: &UdpSocket,
    runtime: &SharedRuntime,
    wire: WireMessage,
) -> anyhow::Result<()> {
    let now = now_ms();
    let mut send_ack_for: Option<String> = None;
    let mut ack_note: Option<String> = None;

    {
        let mut state = runtime.borrow_mut();
        let label = state.label.clone();
        let peer_short = &wire.state.peer_id[..12.min(wire.state.peer_id.len())];

        update_peer_state(&mut state, &wire);

        match wire.kind {
            MessageKind::Hello => {}
            MessageKind::Heartbeat => {
                // No log for received heartbeats — the sent side already logs,
                // and update_peer_state() above tracks last_seen_ms.
            }
            MessageKind::StateUpdate => {
                let mirror_ms = now.saturating_sub(wire.sent_at_ms);
                log(
                    "STATE",
                    &label,
                    format!(
                        "mirrored peer role={} status={} in {mirror_ms}ms ({})",
                        wire.state.role, wire.state.status, wire.message_id
                    ),
                );
                send_ack_for = Some(wire.message_id.clone());
                ack_note = Some(format!(
                    "mirrored peer role={} in {mirror_ms}ms",
                    wire.state.role
                ));
            }
            MessageKind::StateAck => {
                if let Some(acked_id) = wire.acked_message_id.as_deref() {
                    if let Some(pending) = state.pending_role_change.as_ref() {
                        if pending.message_id == acked_id {
                            let ack_ms = now.saturating_sub(pending.sent_at_ms);
                            log(
                                "ACK",
                                &label,
                                format!(
                                    "peer {peer_short} acknowledged role={} in {ack_ms}ms ({acked_id})",
                                    pending.role
                                ),
                            );
                            state.pending_role_change = None;
                        }
                    }
                }
            }
        }

        persist_state(&state)?;
    }

    if let Some(message_id) = send_ack_for {
        let peer_control_addr = { runtime.borrow().peer_control_addr.clone() };
        let ack = send_control_message(
            socket,
            &peer_control_addr,
            runtime,
            MessageKind::StateAck,
            Some(message_id.clone()),
            ack_note,
        )
        .await?;
        let state = runtime.borrow();
        log(
            "ACK",
            &state.label,
            format!("sent STATE_ACK {} for {message_id}", ack.message_id),
        );
    }

    Ok(())
}

// --- Heartbeat sender ---

async fn heartbeat_loop(
    socket: Rc<UdpSocket>,
    runtime: SharedRuntime,
    peer_control_addr: String,
    heartbeat_ms: u64,
) -> anyhow::Result<()> {
    let mut interval = time::interval(Duration::from_millis(heartbeat_ms));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    interval.tick().await;

    loop {
        interval.tick().await;
        let hb = send_control_message(
            &socket,
            &peer_control_addr,
            &runtime,
            MessageKind::Heartbeat,
            None,
            Some("pulse".to_string()),
        )
        .await?;
        let state = runtime.borrow();
        log(
            "HEARTBEAT",
            &state.label,
            format!(
                "sent {} role={} status={}",
                hb.message_id, state.local.role, state.local.status
            ),
        );
    }
}

// --- Control loop: stale detection + role toggle ---

async fn control_loop(
    engine: Rc<Engine>,
    socket: Rc<UdpSocket>,
    runtime: SharedRuntime,
    peer_control_addr: String,
    stale_after_ms: u64,
    toggle_role_to: Option<String>,
    toggle_after_ms: u64,
    mut cmd_rx: Option<mpsc::UnboundedReceiver<NodeCommand>>,
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
            let mut state = runtime.borrow_mut();

            // Stale detection
            if let Some(last_contact) = state.last_peer_contact_ms {
                let age_ms = now.saturating_sub(last_contact);
                let should_mark_stale = state
                    .peer
                    .as_ref()
                    .map(|p| p.status != "stale" && age_ms > stale_after_ms)
                    .unwrap_or(false);

                if should_mark_stale {
                    let peer_id = {
                        let peer = state.peer.as_mut().expect("peer must exist");
                        peer.status = "stale".to_string();
                        peer.peer_id.clone()
                    };
                    state.stale_logged = true;
                    log(
                        "STALE",
                        &state.label,
                        format!(
                            "peer {} marked stale after {age_ms}ms without traffic",
                            &peer_id[..12]
                        ),
                    );
                    persist_state(&state)?;
                }
            }

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
            // Send via UDP control channel for immediate delivery
            let update = send_control_message(
                &socket,
                &peer_control_addr,
                &runtime,
                MessageKind::StateUpdate,
                None,
                Some(format!("role -> {role}")),
            )
            .await?;
            // Also send via Vertex for consensus proof
            send_vertex_transaction(
                &engine,
                &runtime,
                MessageKind::StateUpdate,
                Some(format!("role -> {role}")),
            )?;
            let mut state = runtime.borrow_mut();
            state.pending_role_change = Some(PendingRoleChange {
                message_id: update.message_id.clone(),
                sent_at_ms: update.sent_at_ms,
                role: role.clone(),
            });
            persist_state(&state)?;
            log(
                "ACTION",
                &state.label,
                format!("local role changed to {role}, broadcast as {}", update.message_id),
            );
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
    let message = build_message(runtime, kind, None, note)?;
    let data = serde_json::to_vec(&message)?;
    let mut tx = Transaction::allocate(data.len());
    tx.copy_from_slice(&data);
    engine.send_transaction(tx)?;
    Ok(message)
}

async fn send_control_message(
    socket: &UdpSocket,
    peer_control_addr: &str,
    runtime: &SharedRuntime,
    kind: MessageKind,
    acked_message_id: Option<String>,
    note: Option<String>,
) -> anyhow::Result<WireMessage> {
    let message = build_message(runtime, kind, acked_message_id, note)?;
    let data = serde_json::to_vec(&message)?;
    socket.send_to(&data, peer_control_addr).await?;
    Ok(message)
}

fn build_message(
    runtime: &SharedRuntime,
    kind: MessageKind,
    acked_message_id: Option<String>,
    note: Option<String>,
) -> anyhow::Result<WireMessage> {
    let mut state = runtime.borrow_mut();
    let sent_at_ms = now_ms();
    state.local.last_seen_ms = sent_at_ms;

    let message = WireMessage {
        message_id: state.next_message_id(&kind, sent_at_ms),
        kind,
        sent_at_ms,
        state: state.local.clone(),
        acked_message_id,
        note,
    };

    state.last_message_kind = Some(message.kind.clone());
    state.last_message_id = Some(message.message_id.clone());
    persist_state(&state)?;
    Ok(message)
}

// --- Helpers ---

fn derive_control_addr(addr: &str) -> anyhow::Result<String> {
    let sa: SocketAddr = addr.parse()?;
    let port = sa
        .port()
        .checked_add(CONTROL_PORT_OFFSET)
        .context("control port overflow")?;
    Ok(SocketAddr::new(sa.ip(), port).to_string())
}
