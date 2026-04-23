use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tashi_vertex::{
    Context as VertexContext, Engine, KeyPublic, KeySecret, Message, Options, Peers, Socket, Transaction,
};
use tokio::sync::mpsc;
use tokio::time::{self, MissedTickBehavior};

use crate::game_fsm::{self, FsmEffect};
use crate::game_state::{EntityRecord, GamePhase};
use crate::games::GameConfig;
use crate::proof::ProofOfCoordination;
use crate::protocol::{GamePayload, MessageKind, Position, SensorDatum, WireMessage};
use crate::rules::{self, RuleContext, RuleDecision};
use crate::state::{
    log, now_ms, persist_state, send_web_event, set_event_log_path, set_web_sender,
    short_peer_id, update_peer_state, NodeCommand, PeerInfo, RuntimeState, SharedRuntime, WebEvent,
};

/// Helper for the two places we log a rule violation — keeps the log entry,
/// SSE fan-out, and (optional) consensus broadcast in one spot.
fn report_violation(
    state: &RuntimeState,
    outcome: &mut VertexOutcome,
    rule_id: String,
    reason: String,
    offender_msg_id: String,
    peer_id: &str,
    peer_short: &str,
) {
    log(
        "RULE_VIOLATION",
        &state.label,
        format!("[{rule_id}] {offender_msg_id} from {peer_short} rejected: {reason}"),
    );
    send_web_event(WebEvent::RuleViolated {
        label: state.label.clone(),
        rule_id: rule_id.clone(),
        reason: reason.clone(),
    });
    // Only the originator broadcasts the RuleViolation through consensus so
    // every node observes the same ordered event. Non-originators already
    // logged the verdict from their own evaluation above.
    if peer_id == state.local_public_key {
        outcome.follow_up_txs.push((
            MessageKind::RuleViolation,
            Some(format!("violated {rule_id}")),
            Some(GamePayload::RuleViolation {
                rule_id,
                offender_msg_id,
                reason,
            }),
        ));
    }
}

#[derive(Debug, Deserialize)]
struct FileCommand {
    command: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    game_id: Option<String>,
    #[serde(default)]
    entity_type: Option<String>,
    #[serde(default)]
    team: Option<String>,
    #[serde(default)]
    x: Option<f32>,
    #[serde(default)]
    y: Option<f32>,
    /// Threaded into `GameProposal`/`GameVote` payloads. The "propose-replay"
    /// HTTP endpoint sets this to `true`; the legacy `propose-game/:id` path
    /// omits it and serde defaults it to `false`.
    #[serde(default)]
    keep_roles: bool,
}

/// Internal request from the control task to the engine task.
struct TxRequest {
    kind: MessageKind,
    note: Option<String>,
    payload: Option<GamePayload>,
}

pub async fn run(
    bind: String,
    secret: String,
    peers_info: Vec<(String, String, Option<String>)>, // Vec of (addr, pubkey, Option<label>)
    label: String,
    status: String,
    heartbeat_ms: u64,
    stale_after_ms: u64,
    state_file: Option<PathBuf>,
    proof_dir: Option<PathBuf>,
    event_log: Option<PathBuf>,
    cmd_file: Option<PathBuf>,
    game_file: Option<PathBuf>,
    initial_position: Option<Position>,
    games: HashMap<String, GameConfig>,
    swarm_size: usize,
    web_tx: Option<mpsc::UnboundedSender<WebEvent>>,
    cmd_rx: Option<mpsc::UnboundedReceiver<NodeCommand>>,
    joining: bool,
) -> anyhow::Result<()> {
    set_event_log_path(event_log.clone());
    set_web_sender(web_tx);
    let key: KeySecret = secret.parse()?;

    let mut vertex_peers = Peers::new()?;
    let mut peer_map: HashMap<String, PeerInfo> = HashMap::new();
    let mut peer_labels: HashMap<String, String> = HashMap::new();

    for (peer_addr, peer_pubkey, peer_label) in &peers_info {
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
        if let Some(lbl) = peer_label {
            peer_labels.insert(peer_pubkey.clone(), lbl.clone());
        }
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
    // options.set_enable_state_sharing(true);
    options.set_epoch_states_to_cache(10);
    let engine = Engine::start(&context, socket, options, &key, vertex_peers, joining)?;
    let local_public_key = key.public().to_string();
    log("ENGINE", &label, format!("engine started, local_id=...{}", &local_public_key[local_public_key.len().saturating_sub(8)..]));

    let runtime = Arc::new(Mutex::new(RuntimeState::new(
        label.clone(),
        local_public_key.clone(),
        peer_map,
        status,
        state_file,
        cmd_file,
        game_file,
        initial_position,
        peer_labels,
    )));

    {
        let state = runtime.lock().unwrap();
        let peer_addrs: Vec<&str> = peers_info.iter().map(|(a, _, _)| a.as_str()).collect();
        persist_state(&state)?;
        crate::state::persist_game_state(&state)?;
        log(
            "BOOT",
            &label,
            format!(
                "vertex_bind={} peers=[{}] id=...{} initial_pos={:?}",
                bind,
                peer_addrs.join(", "),
                &local_public_key[local_public_key.len().saturating_sub(8)..],
                state.initial_position,
            ),
        );
    }

    // Channel for the control task to request transactions without touching the engine directly.
    let (tx_req_sender, tx_req_receiver) = mpsc::unbounded_channel::<TxRequest>();

    let games = Arc::new(games);

    // Run the engine-bound tasks inside a LocalSet. The Engine and Message
    // types from tashi-vertex are !Send (they wrap NonNull<T>), so we can't
    // hand them to tokio::spawn on the multi-threaded runtime. A LocalSet
    // runs spawn_local tasks on the current thread and lets us share the
    // engine as Rc<Engine> between the recv task and the main loop.
    //
    // Why a recv task at all: tashi-vertex 0.13.0's `recv_message` future is
    // not cancellation-safe — dropping it mid-poll triggers a use-after-free
    // inside the C library. A dedicated recv task in a plain loop (no
    // select!) guarantees each future is awaited to completion, which lets
    // the main engine_loop use tokio::select! freely on cancel-safe mpsc
    // channels. See TASHI_VERTEX_RECV_CANCEL_BUG.md for the gory details.
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async move {
            let engine = Rc::new(engine);
            tokio::select! {
                r = engine_loop(
                    engine.clone(),
                    runtime.clone(),
                    proof_dir,
                    tx_req_receiver,
                    tx_req_sender.clone(),
                    games.clone(),
                    swarm_size,
                ) => r?,
                r = control_loop(
                    runtime.clone(),
                    cmd_rx,
                    tx_req_sender,
                    games.clone(),
                    swarm_size,
                ) => r?,
                _ = tokio::signal::ctrl_c() => {
                    log("SHUTDOWN", &runtime.lock().unwrap().label, "received signal");
                }
            }
            Ok::<(), anyhow::Error>(())
        })
        .await?;

    Ok(())
}

// --- Main engine loop: consumes consensus messages + outbound tx requests ---
//
// Architecture: a dedicated spawn_local task owns `recv_message` polling and
// forwards results through an mpsc channel. The main loop below `select!`s on
// that channel + the tx-request channel. Both are mpsc receivers, which are
// documented cancel-safe — so the main loop can freely use tokio::select!
// concurrency without ever cancelling a `recv_message` future mid-poll.
//
// This structure sidesteps the tashi-vertex 0.13.0 use-after-free: the only
// code path that awaits recv_message is the recv task, which runs the future
// to completion in a plain loop (no select!). See TASHI_VERTEX_RECV_CANCEL_BUG.md.

async fn engine_loop(
    engine: Rc<Engine>,
    runtime: SharedRuntime,
    proof_dir: Option<PathBuf>,
    mut tx_req_rx: mpsc::UnboundedReceiver<TxRequest>,
    tx_req_sender: mpsc::UnboundedSender<TxRequest>,
    games: Arc<HashMap<String, GameConfig>>,
    swarm_size: usize,
) -> anyhow::Result<()> {
    let mut proof_seq: u64 = 0;

    // Send the hello on first sync point
    let mut hello_sent = false;

    // Dedicated recv task: runs recv_message to completion every iteration
    // and forwards the result via mpsc. The future is never dropped mid-poll
    // because this task does not use select!.
    let (msg_tx, mut msg_rx) =
        mpsc::unbounded_channel::<tashi_vertex::Result<Option<Message>>>();
    let engine_for_recv = engine.clone();
    let _recv_handle = tokio::task::spawn_local(async move {
        loop {
            let result = engine_for_recv.recv_message().await;
            let terminal = !matches!(&result, Ok(Some(_)));
            if msg_tx.send(result).is_err() {
                break;
            }
            if terminal {
                break;
            }
        }
    });

    loop {
        tokio::select! {
            // Both arms select on mpsc receivers — cancel-safe by tokio's
            // contract, so the losing arm's future is safely dropped on the
            // next iteration without any C-side state at risk.
            Some(req) = tx_req_rx.recv() => {
                process_tx_request(&engine, &runtime, req);
            }
            maybe = msg_rx.recv() => {
                let result = match maybe {
                    Some(r) => r,
                    None => {
                        let label = runtime.lock().unwrap().label.clone();
                        log("ENGINE_CLOSED", &label, "recv task channel closed");
                        return Ok(());
                    }
                };
                let message = match result {
                    Ok(Some(m)) => m,
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
                };

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
                                None,
                            )?;
                            {
                                let state = runtime.lock().unwrap();
                                log(
                                    "HANDSHAKE",
                                    &state.label,
                                    format!(
                                        "sent HELLO {} status={}",
                                        hello.message_id, state.local.status
                                    ),
                                );
                            }

                            // Broadcast seed SensorReading carrying our initial
                            // position so every peer observes our starting
                            // location in consensus order.
                            let seed_pos = { runtime.lock().unwrap().initial_position };
                            if let Some(pos) = seed_pos {
                                let payload = GamePayload::SensorReading {
                                    pos,
                                    readings: Vec::new(),
                                    observed_at_ms: now_ms(),
                                };
                                let _ = send_vertex_transaction(
                                    &engine,
                                    &runtime,
                                    MessageKind::SensorReading,
                                    Some(format!("seed position ({:.2}, {:.2})", pos.x, pos.y)),
                                    Some(payload),
                                );
                                let mut state = runtime.lock().unwrap();
                                state.seed_broadcast_done = true;
                            }
                        }
                    }
                    Message::Event(event) => {
                        let creator = event.creator().to_string();
                        let tx_count = event.transaction_count();
                        {
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
                        }
                        // Intentionally do NOT skip self-authored events: the
                        // local node needs to observe its own ReadyUp,
                        // GameProposal, etc. in consensus order so it joins
                        // the same FSM state every other node reaches. Each
                        // handler inside `handle_vertex_message` guards
                        // against duplicate broadcasts using
                        // `peer_id == state.local_public_key`.

                        // Log finality for consensus events that carry transactions
                        if event.transaction_count() > 0 {
                            let created = event.created_at();
                            let consensus = event.consensus_at();
                            let finality = created.abs_diff(consensus) / 1_000_000;
                            let kinds: Vec<String> = event.transactions()
                                .filter_map(|tx| serde_json::from_slice::<WireMessage>(tx).ok())
                                .map(|w| w.kind.as_str().to_string())
                                .collect();
                            if !kinds.is_empty() {
                                let kind_str = kinds.join(",");
                                let state = runtime.lock().unwrap();
                                log(
                                    "FINALITY",
                                    &state.label,
                                    format!("{}ms kind={}", finality, kind_str),
                                );
                            }
                        }

                        if let Some(ref dir) = proof_dir {
                            // Create proofs for role changes and for game-significant
                            // consensus events (deltas, violations, end). Hellos and
                            // heartbeats are excluded to keep the proof set focused.
                            let has_state_update = event.transactions().any(|tx| {
                                serde_json::from_slice::<WireMessage>(tx)
                                    .map(|w| {
                                        matches!(
                                            w.kind,
                                            MessageKind::StateUpdate
                                                | MessageKind::GameStateDelta
                                                | MessageKind::RuleViolation
                                                | MessageKind::GameEnd
                                        )
                                    })
                                    .unwrap_or(false)
                            });
                            if has_state_update {
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

                        let consensus_at_ns = event.consensus_at() as u128;
                        for tx in event.transactions() {
                            let wire: WireMessage = match serde_json::from_slice(tx) {
                                Ok(w) => w,
                                Err(_) => continue,
                            };
                            if wire.state.peer_id != creator {
                                continue;
                            }
                            let outcome = handle_vertex_message(
                                &runtime,
                                wire.clone(),
                                consensus_at_ns,
                                &games,
                                swarm_size,
                            )?;
                            if let Some(reply_note) = outcome.reply_note {
                                let _ = send_vertex_transaction(
                                    &engine,
                                    &runtime,
                                    MessageKind::StateUpdate,
                                    Some(reply_note),
                                    None,
                                );
                            }
                            for (kind, note, payload) in outcome.follow_up_txs {
                                let _ = tx_req_sender.send(TxRequest { kind, note, payload });
                            }
                        }
                    }
                }
            }
        }
    }
}

fn process_tx_request(engine: &Engine, runtime: &SharedRuntime, req: TxRequest) {
    let is_heartbeat = matches!(req.kind, MessageKind::Heartbeat);
    let action = req.note.clone().unwrap_or_else(|| req.kind.as_str().to_string());
    if !is_heartbeat {
        let state = runtime.lock().unwrap();
        log("ACTION", &state.label, format!("sending {action} via Vertex..."));
    }
    match send_vertex_transaction(engine, runtime, req.kind, req.note, req.payload) {
        Ok(msg) => {
            let state = runtime.lock().unwrap();
            let tag = if is_heartbeat { "HEARTBEAT" } else { "ACTION" };
            log(
                tag,
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

#[derive(Default)]
struct VertexOutcome {
    reply_note: Option<String>,
    follow_up_txs: Vec<(MessageKind, Option<String>, Option<GamePayload>)>,
}

fn handle_vertex_message(
    runtime: &SharedRuntime,
    wire: WireMessage,
    consensus_at_ns: u128,
    games: &HashMap<String, GameConfig>,
    swarm_size: usize,
) -> anyhow::Result<VertexOutcome> {
    let mut state = runtime.lock().unwrap();
    let peer_id = wire.state.peer_id.clone();
    let peer_short = short_peer_id(&peer_id);
    let mut outcome = VertexOutcome::default();
    let mut game_changed = false;
    let now = now_ms();

    update_peer_state(&mut state, &wire);

    // Consensus-clock countdown check. Every event carries a consensus
    // timestamp identical across all nodes; once that exceeds
    // `countdown_zero_ns + 3s` we flip to Playing. Because the same event
    // reaches the threshold on every node, this transition is exactly
    // synchronised — no wall-clock skew, no broadcast messages.
    if state.game_state.phase == GamePhase::CountingDown {
        if let Some(zero) = state.game_state.countdown_zero_ns {
            if consensus_at_ns >= zero.saturating_add(3_000_000_000) {
                state.game_state.phase = GamePhase::Playing;
                // Clean up any wall-clock bookkeeping keys that might
                // have slipped in from an older build.
                state.game_state.scores.remove("__countdown_start_ms");
                log(
                    "GAME_EVENT",
                    &state.label,
                    format!(
                        "countdown complete → Playing (consensus_at={consensus_at_ns}, zero={zero})"
                    ),
                );
                game_changed = true;
            }
        }
    }

    match wire.kind {
        MessageKind::Hello => {
            // Only reply to *other* peers' Hellos — don't echo our own back
            // through consensus.
            if peer_id != state.local_public_key {
                outcome.reply_note = Some(format!("current state for {peer_short}"));
            }
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
                    "peer {peer_short} status={} ({})",
                    wire.state.status, wire.message_id
                ),
            );
        }
        MessageKind::Heartbeat => {
            // Heartbeat received — update_peer_state already tracked last_contact_ms
        }
        MessageKind::SensorReading => {
            if let Some(GamePayload::SensorReading {
                pos,
                observed_at_ms,
                ..
            }) = &wire.game
            {
                // Bad-actor check first — evaluate physical plausibility against
                // the *pre-update* entity position. If rejected, log and skip the
                // position update so all nodes reach the same conclusion.
                let pre_check_ctx_ok = state
                    .game_state
                    .active_game_id
                    .as_ref()
                    .and_then(|id| games.get(id))
                    .map(|game_cfg| {
                        let ctx = RuleContext {
                            game: game_cfg,
                            local: &state.game_state,
                            now_ms: now,
                        };
                        rules::evaluate(&ctx, &wire)
                    })
                    .unwrap_or_else(|| vec![RuleDecision::Accept]);

                let mut rejected_physics = false;
                for dec in &pre_check_ctx_ok {
                    if let RuleDecision::Reject { rule_id, reason } = dec {
                        if rule_id == "physically_plausible" {
                            rejected_physics = true;
                            report_violation(
                                &state,
                                &mut outcome,
                                rule_id.clone(),
                                reason.clone(),
                                wire.message_id.clone(),
                                &peer_id,
                                &peer_short,
                            );
                        }
                    }
                }

                if !rejected_physics {
                    let peer_label = peer_id_to_label(&state, &peer_id);
                    let entity = state
                        .game_state
                        .entities
                        .entry(peer_label.clone())
                        .or_insert_with(|| EntityRecord {
                            label: peer_label.clone(),
                            peer_id: peer_id.clone(),
                            ..Default::default()
                        });
                    entity.peer_id = peer_id.clone();
                    entity.pos = Some(*pos);
                    entity.last_seen_ms = *observed_at_ms;
                    if peer_id == state.local_public_key {
                        state.game_state.my_position = Some(*pos);
                    }
                    state.game_state.record_sensor(wire.clone());
                    game_changed = true;
                    log(
                        "SENSOR",
                        &state.label,
                        format!(
                            "peer {peer_short} pos=({:.2},{:.2}) t={observed_at_ms} ({})",
                            pos.x, pos.y, wire.message_id
                        ),
                    );

                    // Re-evaluate rules after the position update: refresh the
                    // proximity tracker, then run `on: sensor_reading` rules.
                    // Only the *originating* node broadcasts resulting deltas to
                    // avoid N redundant broadcasts per rule fire.
                    if let Some(game_id) = state.game_state.active_game_id.clone() {
                        if let Some(game_cfg) = games.get(&game_id) {
                            rules::update_proximity(&mut state.game_state, game_cfg, now);
                            let ctx = RuleContext {
                                game: game_cfg,
                                local: &state.game_state,
                                now_ms: now,
                            };
                            let decisions = rules::evaluate(&ctx, &wire);
                            let is_originator = peer_id == state.local_public_key;
                            for dec in decisions {
                                match dec {
                                    RuleDecision::Emit { rule_id, patches } if is_originator => {
                                        log(
                                            "RULE",
                                            &state.label,
                                            format!("fire {rule_id} -> delta({} patches)", patches.len()),
                                        );
                                        outcome.follow_up_txs.push((
                                            MessageKind::GameStateDelta,
                                            Some(format!("rule {rule_id}")),
                                            Some(GamePayload::GameStateDelta { patches }),
                                        ));
                                    }
                                    RuleDecision::End { winner_team, reason } if is_originator => {
                                        outcome.follow_up_txs.push((
                                            MessageKind::GameEnd,
                                            Some("rule end".into()),
                                            Some(GamePayload::GameEnd {
                                                winner_team,
                                                reason,
                                            }),
                                        ));
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            }
        }
        MessageKind::GameProposal => {
            if let Some(GamePayload::GameProposal { game_id, keep_roles }) = &wire.game {
                let tag = if *keep_roles { " (replay)" } else { "" };
                log(
                    "GAME_EVENT",
                    &state.label,
                    format!(
                        "proposal from {peer_short}: {game_id}{tag} ({})",
                        wire.message_id
                    ),
                );
                let choice = crate::game_state::GameChoice {
                    game_id: game_id.clone(),
                    keep_roles: *keep_roles,
                };
                let effects = game_fsm::apply_proposal(
                    &mut state.game_state,
                    peer_id.clone(),
                    choice,
                    now,
                    swarm_size,
                );
                for eff in effects {
                    match eff {
                        FsmEffect::AutoVote { choice } => {
                            outcome.follow_up_txs.push((
                                MessageKind::GameVote,
                                Some(format!("auto-vote {}", choice.game_id)),
                                Some(GamePayload::GameVote {
                                    game_id: choice.game_id,
                                    keep_roles: choice.keep_roles,
                                }),
                            ));
                        }
                        FsmEffect::LoadGame { choice } => {
                            // `reset_for_new_*` has already run inside the FSM.
                            // Always drop into `PlacingEntities` — even for
                            // a keep_roles replay — so the placement
                            // constraint re-validates against fresh sensor
                            // readings (players may have moved between
                            // rounds). The UI renders `ClaimedView` instead
                            // of `ClaimForm` when `entity_type` is already
                            // set, so preserved claims skip the pick-a-role
                            // step without skipping the position check.
                            state.game_state.active_game_id = Some(choice.game_id.clone());
                            state.game_state.phase = GamePhase::PlacingEntities;
                            log(
                                "GAME_EVENT",
                                &state.label,
                                format!(
                                    "loaded game: {}{}",
                                    choice.game_id,
                                    if choice.keep_roles { " (replay)" } else { "" },
                                ),
                            );
                        }
                    }
                }
                game_changed = true;
            }
        }
        MessageKind::GameVote => {
            if let Some(GamePayload::GameVote { game_id, keep_roles }) = &wire.game {
                let tag = if *keep_roles { " (replay)" } else { "" };
                log(
                    "GAME_EVENT",
                    &state.label,
                    format!(
                        "vote from {peer_short}: {game_id}{tag} ({})",
                        wire.message_id
                    ),
                );
                let choice = crate::game_state::GameChoice {
                    game_id: game_id.clone(),
                    keep_roles: *keep_roles,
                };
                let effects = game_fsm::apply_vote(
                    &mut state.game_state,
                    peer_id.clone(),
                    choice,
                    now,
                    swarm_size,
                );
                for eff in effects {
                    if let FsmEffect::LoadGame { choice } = eff {
                        // Same rationale as the GameProposal handler: always
                        // drop into PlacingEntities so the placement check
                        // re-runs, even when keep_roles preserves claims.
                        state.game_state.active_game_id = Some(choice.game_id.clone());
                        state.game_state.phase = GamePhase::PlacingEntities;
                        log(
                            "GAME_EVENT",
                            &state.label,
                            format!(
                                "loaded game: {}{}",
                                choice.game_id,
                                if choice.keep_roles { " (replay)" } else { "" },
                            ),
                        );
                    }
                }
                game_changed = true;
            }
        }
        MessageKind::EntityTypeClaim => {
            if let (Some(GamePayload::EntityTypeClaim { entity_type, team }), Some(game_id)) =
                (&wire.game, state.game_state.active_game_id.clone())
            {
                if let Some(game_cfg) = games.get(&game_id) {
                    let ctx = RuleContext {
                        game: game_cfg,
                        local: &state.game_state,
                        now_ms: now,
                    };
                    let decisions = rules::evaluate(&ctx, &wire);
                    let mut rejected = false;
                    for dec in decisions {
                        if let RuleDecision::Reject { rule_id, reason } = dec {
                            rejected = true;
                            report_violation(
                                &state,
                                &mut outcome,
                                rule_id,
                                reason,
                                wire.message_id.clone(),
                                &peer_id,
                                &peer_short,
                            );
                        }
                    }
                    if !rejected {
                        // Accept the claim — record it on the entity.
                        let peer_label = peer_id_to_label(&state, &peer_id);
                        let entity = state
                            .game_state
                            .entities
                            .entry(peer_label.clone())
                            .or_insert_with(|| EntityRecord {
                                label: peer_label.clone(),
                                peer_id: peer_id.clone(),
                                ..Default::default()
                            });
                        entity.entity_type = Some(entity_type.clone());
                        entity.team = team.clone();
                        entity.claimed_at_ms = now;
                        game_changed = true;
                        log(
                            "GAME_EVENT",
                            &state.label,
                            format!(
                                "claim accepted {peer_short} -> {entity_type}{} ({})",
                                team.as_ref().map(|t| format!("/{t}")).unwrap_or_default(),
                                wire.message_id
                            ),
                        );

                        // Rescan the bounded sensor_history: predicates that
                        // reference this entity type may have been silently
                        // failing earlier (unknown entity) and should now
                        // produce a consistent decision. Only the originating
                        // node broadcasts any resulting deltas, mirroring the
                        // sensor_reading handler.
                        if let Some(game_cfg) = games.get(&game_id) {
                            rules::update_proximity(&mut state.game_state, game_cfg, now);
                            let history: Vec<WireMessage> = state
                                .game_state
                                .sensor_history
                                .iter()
                                .cloned()
                                .collect();
                            for past in history {
                                let sender = past.state.peer_id.clone();
                                let ctx = RuleContext {
                                    game: game_cfg,
                                    local: &state.game_state,
                                    now_ms: now,
                                };
                                let decisions = rules::evaluate(&ctx, &past);
                                let is_originator = sender == state.local_public_key;
                                for dec in decisions {
                                    match dec {
                                        RuleDecision::Emit { rule_id, patches }
                                            if is_originator =>
                                        {
                                            log(
                                                "RULE",
                                                &state.label,
                                                format!(
                                                    "rescan fire {rule_id} -> delta({} patches)",
                                                    patches.len()
                                                ),
                                            );
                                            outcome.follow_up_txs.push((
                                                MessageKind::GameStateDelta,
                                                Some(format!("rule {rule_id} (rescan)")),
                                                Some(GamePayload::GameStateDelta { patches }),
                                            ));
                                        }
                                        RuleDecision::End { winner_team, reason }
                                            if is_originator =>
                                        {
                                            outcome.follow_up_txs.push((
                                                MessageKind::GameEnd,
                                                Some("rule end (rescan)".into()),
                                                Some(GamePayload::GameEnd {
                                                    winner_team,
                                                    reason,
                                                }),
                                            ));
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }
                } else {
                    log(
                        "GAME_EVENT",
                        &state.label,
                        format!("claim without loaded game (game_id={game_id}); ignoring"),
                    );
                }
            }
        }
        MessageKind::ReadyUp => {
            if !state.game_state.ready_peers.iter().any(|p| p == &peer_id) {
                state.game_state.ready_peers.push(peer_id.clone());
            }
            let ready_count = state.game_state.ready_peers.len();
            log(
                "GAME_EVENT",
                &state.label,
                format!(
                    "ready-up from {peer_short} ({}/{} ready)",
                    ready_count, swarm_size
                ),
            );
            if ready_count >= swarm_size && state.game_state.countdown_zero_ns.is_none() {
                // Pin `countdown_zero_ns` to the consensus timestamp of the
                // event that pushed the count over — this is identical on
                // every node, so the 3s countdown fires in lockstep.
                state.game_state.countdown_zero_ns = Some(consensus_at_ns);
                state.game_state.phase = GamePhase::CountingDown;
            }
            game_changed = true;
        }
        MessageKind::GameStateDelta => {
            if let Some(GamePayload::GameStateDelta { patches }) = &wire.game {
                log(
                    "GAME_EVENT",
                    &state.label,
                    format!(
                        "delta from {peer_short} ({} patches, {})",
                        patches.len(),
                        wire.message_id
                    ),
                );

                // Apply each patch, tracking the ones that actually change
                // local state — subsequent idempotent re-applies are no-ops
                // and must not fire chained rules like property_changed.
                let mut real_changes: Vec<crate::protocol::StatePatch> = Vec::new();
                for patch in patches {
                    let mut matched = false;
                    for entity in state.game_state.entities.values_mut() {
                        if entity.peer_id != patch.target_peer_id {
                            continue;
                        }
                        matched = true;
                        let current = entity.properties.get(&patch.key).cloned();
                        if current.as_ref() != Some(&patch.value) {
                            entity
                                .properties
                                .insert(patch.key.clone(), patch.value.clone());
                            real_changes.push(patch.clone());
                        }
                        break;
                    }
                    if !matched {
                        // Unknown target — could be a late-arriving delta for an
                        // entity we haven't seen yet. Log and ignore; a later
                        // re-scan would be needed for strict convergence.
                        log(
                            "GAME_EVENT",
                            &state.label,
                            format!(
                                "delta patch targets unknown peer {} (key={})",
                                &patch.target_peer_id[..6.min(patch.target_peer_id.len())],
                                patch.key
                            ),
                        );
                    }
                }
                game_changed = true;

                // Fire `on: game_state_delta` rules against the real changes.
                // Only the sender of the originating delta broadcasts any
                // follow-up deltas to keep volume down; but IncrementScore is
                // applied locally on every node so scores converge.
                if !real_changes.is_empty() {
                    if let Some(game_id) = state.game_state.active_game_id.clone() {
                        if let Some(game_cfg) = games.get(&game_id) {
                            rules::update_proximity(&mut state.game_state, game_cfg, now);
                            let ctx = RuleContext {
                                game: game_cfg,
                                local: &state.game_state,
                                now_ms: now,
                            };
                            let decisions = rules::evaluate_delta(&ctx, &peer_id, &real_changes);
                            let is_originator = peer_id == state.local_public_key;
                            for dec in decisions {
                                match dec {
                                    RuleDecision::Emit { rule_id, patches } if is_originator => {
                                        log(
                                            "RULE",
                                            &state.label,
                                            format!(
                                                "fire {rule_id} -> delta({} patches)",
                                                patches.len()
                                            ),
                                        );
                                        outcome.follow_up_txs.push((
                                            MessageKind::GameStateDelta,
                                            Some(format!("rule {rule_id}")),
                                            Some(GamePayload::GameStateDelta { patches }),
                                        ));
                                    }
                                    RuleDecision::IncrementScore { rule_id, team, by } => {
                                        let new_score = {
                                            let entry = state
                                                .game_state
                                                .scores
                                                .entry(team.clone())
                                                .or_insert(0);
                                            *entry += by;
                                            *entry
                                        };
                                        log(
                                            "RULE",
                                            &state.label,
                                            format!(
                                                "fire {rule_id} -> score[{team}] += {by} (now {new_score})"
                                            ),
                                        );
                                    }
                                    RuleDecision::End { winner_team, reason }
                                        if is_originator =>
                                    {
                                        outcome.follow_up_txs.push((
                                            MessageKind::GameEnd,
                                            Some("rule end".into()),
                                            Some(GamePayload::GameEnd {
                                                winner_team,
                                                reason,
                                            }),
                                        ));
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            }
        }
        MessageKind::RuleViolation => {
            if let Some(GamePayload::RuleViolation { rule_id, reason, .. }) = &wire.game {
                log(
                    "RULE_VIOLATION",
                    &state.label,
                    format!("[{rule_id}] from {peer_short}: {reason}"),
                );
                // Surface the consensus-observed violation over SSE so the
                // frontend gets a dedicated signal per node (vs the
                // reporter-only emit in report_violation).
                send_web_event(WebEvent::RuleViolated {
                    label: state.label.clone(),
                    rule_id: rule_id.clone(),
                    reason: reason.clone(),
                });
            }
        }
        MessageKind::GameEnd => {
            // Preserve winner/reason from the payload so the UI can surface
            // the outcome in the Ended state. First arrival wins — later
            // GameEnd broadcasts (e.g. from multiple nodes racing the time
            // limit) don't overwrite.
            if let Some(GamePayload::GameEnd { winner_team, reason }) = &wire.game {
                if state.game_state.ended_reason.is_none() {
                    state.game_state.ended_winner_team = winner_team.clone();
                    state.game_state.ended_reason = Some(reason.clone());
                }
            }
            state.game_state.phase = GamePhase::Ended;
            log(
                "GAME_EVENT",
                &state.label,
                format!(
                    "game_end from {peer_short}: winner={:?} reason={:?}",
                    state.game_state.ended_winner_team, state.game_state.ended_reason
                ),
            );
            game_changed = true;
        }
    }

    persist_state(&state)?;
    if game_changed {
        // Recompute placement_ok for the local node before persisting —
        // frontend reads this to gate the Ready-Up button. When placement_ok
        // flips, also drive the PlacingEntities ↔ Ready transition so
        // downstream consumers (NodeControl, overlays) can distinguish
        // "positions still need adjusting" from "good to go, waiting on
        // peers".
        if let Some(game_id) = &state.game_state.active_game_id {
            if let Some(game_cfg) = games.get(game_id) {
                let new_ok = rules::evaluate_placement(
                    game_cfg,
                    &state.label,
                    &state.game_state.entities,
                );
                if new_ok != state.game_state.placement_ok {
                    log(
                        "GAME_EVENT",
                        &state.label,
                        format!("placement_ok -> {new_ok}"),
                    );
                    state.game_state.placement_ok = new_ok;
                    match (state.game_state.phase, new_ok) {
                        (GamePhase::PlacingEntities, true) => {
                            state.game_state.phase = GamePhase::Ready;
                        }
                        (GamePhase::Ready, false) => {
                            state.game_state.phase = GamePhase::PlacingEntities;
                        }
                        _ => {}
                    }
                }
            }
        }
        crate::state::persist_game_state(&state)?;
    }
    Ok(outcome)
}

/// Resolve a `peer_id` to its human label. Delegates to the authoritative
/// `RuntimeState::label_for_peer` which consults the `peer_labels` map
/// populated from `--peer-label` flags at spawn time. Falls back to the
/// short-form suffix for peers we don't know about (e.g. if labels weren't
/// provided in a CLI-only run).
fn peer_id_to_label(state: &RuntimeState, peer_id: &str) -> String {
    state.label_for_peer(peer_id)
}

// --- Control loop: sends TxRequests through a channel instead of touching Engine ---

async fn control_loop(
    runtime: SharedRuntime,
    mut cmd_rx: Option<mpsc::UnboundedReceiver<NodeCommand>>,
    tx_sender: mpsc::UnboundedSender<TxRequest>,
    games: Arc<HashMap<String, GameConfig>>,
    swarm_size: usize,
) -> anyhow::Result<()> {
    let mut interval = time::interval(Duration::from_millis(200));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_heartbeat_ms = 0u64;
    let mut last_fsm_tick_ms = 0u64;
    let mut last_rules_tick_ms = 0u64;

    loop {
        interval.tick().await;
        let now = now_ms();
        let mut should_send_heartbeat = false;
        // Queue of game-payload transactions to broadcast after releasing the lock.
        let mut game_txs: Vec<(MessageKind, Option<String>, Option<GamePayload>)> = Vec::new();

        // Application-level heartbeat every 2 seconds
        if now.saturating_sub(last_heartbeat_ms) >= 2_000 {
            should_send_heartbeat = true;
            last_heartbeat_ms = now;
        }

        {
            let mut state = runtime.lock().unwrap();

            // Command channel (web-driven)
            if let Some(ref mut rx) = cmd_rx {
                loop {
                    match rx.try_recv() {
                        Ok(NodeCommand::ProposeGame { game_id, keep_roles }) => {
                            let note = if keep_roles {
                                format!("propose {game_id} (replay)")
                            } else {
                                format!("propose {game_id}")
                            };
                            game_txs.push((
                                MessageKind::GameProposal,
                                Some(note),
                                Some(GamePayload::GameProposal { game_id, keep_roles }),
                            ));
                        }
                        Ok(NodeCommand::VoteGame { game_id, keep_roles }) => {
                            let note = if keep_roles {
                                format!("vote {game_id} (replay)")
                            } else {
                                format!("vote {game_id}")
                            };
                            game_txs.push((
                                MessageKind::GameVote,
                                Some(note),
                                Some(GamePayload::GameVote { game_id, keep_roles }),
                            ));
                        }
                        Ok(NodeCommand::ClaimEntity { entity_type, team }) => {
                            let note = match &team {
                                Some(t) => format!("claim {entity_type}/{t}"),
                                None => format!("claim {entity_type}"),
                            };
                            game_txs.push((
                                MessageKind::EntityTypeClaim,
                                Some(note),
                                Some(GamePayload::EntityTypeClaim { entity_type, team }),
                            ));
                        }
                        Ok(NodeCommand::SetPosition { x, y }) => {
                            let pos = Position { x, y };
                            state.game_state.my_position = Some(pos);
                            let my_label = state.label.clone();
                            if let Some(entity) = state.game_state.entities.get_mut(&my_label) {
                                entity.pos = Some(pos);
                                entity.last_seen_ms = now;
                            }
                            // We'll persist the game state after the lock block.
                            let readings: Vec<SensorDatum> = state
                                .game_state
                                .entities
                                .iter()
                                .filter(|(lbl, _)| lbl != &&state.label)
                                .filter_map(|(_, e)| {
                                    let peer_pos = e.pos?;
                                    let dx = peer_pos.x - pos.x;
                                    let dy = peer_pos.y - pos.y;
                                    let distance_m = (dx * dx + dy * dy).sqrt();
                                    let angle_rad = dy.atan2(dx);
                                    Some(SensorDatum {
                                        peer_id: e.peer_id.clone(),
                                        distance_m,
                                        angle_rad,
                                    })
                                })
                                .collect();
                            let payload = GamePayload::SensorReading {
                                pos,
                                readings,
                                observed_at_ms: now,
                            };
                            game_txs.push((
                                MessageKind::SensorReading,
                                Some(format!("position -> ({:.2},{:.2})", x, y)),
                                Some(payload),
                            ));
                        }
                        Ok(NodeCommand::ReadyUp) => {
                            game_txs.push((
                                MessageKind::ReadyUp,
                                Some("ready".to_string()),
                                Some(GamePayload::ReadyUp),
                            ));
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
                                "set_status" => {
                                    if let Some(new_status) = cmd.status {
                                        state.local.status = new_status;
                                        persist_state(&state)?;
                                    }
                                }
                                "propose_game" => {
                                    if let Some(game_id) = cmd.game_id {
                                        let keep_roles = cmd.keep_roles;
                                        let note = if keep_roles {
                                            format!("propose {game_id} (replay)")
                                        } else {
                                            format!("propose {game_id}")
                                        };
                                        game_txs.push((
                                            MessageKind::GameProposal,
                                            Some(note),
                                            Some(GamePayload::GameProposal {
                                                game_id,
                                                keep_roles,
                                            }),
                                        ));
                                    }
                                }
                                "vote_game" => {
                                    if let Some(game_id) = cmd.game_id {
                                        let keep_roles = cmd.keep_roles;
                                        let note = if keep_roles {
                                            format!("vote {game_id} (replay)")
                                        } else {
                                            format!("vote {game_id}")
                                        };
                                        game_txs.push((
                                            MessageKind::GameVote,
                                            Some(note),
                                            Some(GamePayload::GameVote {
                                                game_id,
                                                keep_roles,
                                            }),
                                        ));
                                    }
                                }
                                "claim_entity" => {
                                    if let Some(entity_type) = cmd.entity_type {
                                        let team = cmd.team;
                                        let note = match &team {
                                            Some(t) => format!("claim {entity_type}/{t}"),
                                            None => format!("claim {entity_type}"),
                                        };
                                        game_txs.push((
                                            MessageKind::EntityTypeClaim,
                                            Some(note),
                                            Some(GamePayload::EntityTypeClaim { entity_type, team }),
                                        ));
                                    }
                                }
                                "set_position" => {
                                    if let (Some(x), Some(y)) = (cmd.x, cmd.y) {
                                        let pos = Position { x, y };
                                        state.game_state.my_position = Some(pos);
                                        let my_label = state.label.clone();
                                        if let Some(entity) = state.game_state.entities.get_mut(&my_label) {
                                            entity.pos = Some(pos);
                                            entity.last_seen_ms = now;
                                        }
                                        let readings: Vec<SensorDatum> = state
                                            .game_state
                                            .entities
                                            .iter()
                                            .filter(|(lbl, _)| lbl != &&state.label)
                                            .filter_map(|(_, e)| {
                                                let peer_pos = e.pos?;
                                                let dx = peer_pos.x - pos.x;
                                                let dy = peer_pos.y - pos.y;
                                                let distance_m = (dx * dx + dy * dy).sqrt();
                                                let angle_rad = dy.atan2(dx);
                                                Some(SensorDatum {
                                                    peer_id: e.peer_id.clone(),
                                                    distance_m,
                                                    angle_rad,
                                                })
                                            })
                                            .collect();
                                        let payload = GamePayload::SensorReading {
                                            pos,
                                            readings,
                                            observed_at_ms: now,
                                        };
                                        game_txs.push((
                                            MessageKind::SensorReading,
                                            Some(format!("position -> ({:.2},{:.2})", x, y)),
                                            Some(payload),
                                        ));
                                    }
                                }
                                "ready_up" => {
                                    game_txs.push((
                                        MessageKind::ReadyUp,
                                        Some("ready".to_string()),
                                        Some(GamePayload::ReadyUp),
                                    ));
                                }
                                other => {
                                    log("CMD", &state.label, format!("unknown command: {other}"));
                                }
                            }
                        }
                    }
                }
            }

            // 1 Hz FSM tick for proposal/vote window timeouts.
            if now.saturating_sub(last_fsm_tick_ms) >= 1_000 {
                last_fsm_tick_ms = now;
                let effects = game_fsm::on_tick(&mut state.game_state, now, swarm_size);
                for eff in effects {
                    if let FsmEffect::LoadGame { choice } = eff {
                        state.game_state.active_game_id = Some(choice.game_id.clone());
                        state.game_state.phase = GamePhase::PlacingEntities;
                        log(
                            "GAME_EVENT",
                            &state.label,
                            format!(
                                "loaded game (timeout): {}{}",
                                choice.game_id,
                                if choice.keep_roles { " (replay)" } else { "" },
                            ),
                        );
                        crate::state::persist_game_state(&state)?;
                    }
                }
            }

            // 1 Hz rule tick — fires `on: tick` rules (KotH hold_the_hill,
            // Territory claim_zone). Refreshes proximity tracker first so
            // duration predicates see fresh pair states.
            if state.game_state.phase == GamePhase::Playing
                && now.saturating_sub(last_rules_tick_ms) >= 1_000
            {
                last_rules_tick_ms = now;
                if let Some(game_id) = state.game_state.active_game_id.clone() {
                    if let Some(game_cfg) = games.get(&game_id) {
                        rules::update_proximity(&mut state.game_state, game_cfg, now);
                        let ctx = RuleContext {
                            game: game_cfg,
                            local: &state.game_state,
                            now_ms: now,
                        };
                        let decisions = rules::tick(&ctx);
                        for dec in decisions {
                            match dec {
                                RuleDecision::Emit { rule_id, patches } => {
                                    log(
                                        "RULE",
                                        &state.label,
                                        format!(
                                            "tick fire {rule_id} -> delta({} patches)",
                                            patches.len()
                                        ),
                                    );
                                    game_txs.push((
                                        MessageKind::GameStateDelta,
                                        Some(format!("rule {rule_id}")),
                                        Some(GamePayload::GameStateDelta { patches }),
                                    ));
                                }
                                RuleDecision::IncrementScore { rule_id, team, by } => {
                                    let new_score = {
                                        let entry = state
                                            .game_state
                                            .scores
                                            .entry(team.clone())
                                            .or_insert(0);
                                        *entry += by;
                                        *entry
                                    };
                                    log(
                                        "RULE",
                                        &state.label,
                                        format!(
                                            "tick fire {rule_id} -> score[{team}] += {by} (now {new_score})"
                                        ),
                                    );
                                    crate::state::persist_game_state(&state)?;
                                }
                                RuleDecision::End { winner_team, reason } => {
                                    game_txs.push((
                                        MessageKind::GameEnd,
                                        Some("rule end".into()),
                                        Some(GamePayload::GameEnd {
                                            winner_team,
                                            reason,
                                        }),
                                    ));
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }

            // Countdown → Playing is driven by consensus timestamps in
            // `handle_vertex_message`, not wall-clock here. Heartbeats (2s
            // cadence) keep consensus time advancing even when no gameplay
            // events are broadcast, so the transition fires in lockstep on
            // every node.

            // Persist game state if any of the game commands touched it.
            if !game_txs.is_empty() {
                crate::state::persist_game_state(&state)?;
            }
        }

        if should_send_heartbeat {
            let _ = tx_sender.send(TxRequest {
                kind: MessageKind::Heartbeat,
                note: None,
                payload: None,
            });
        }

        for (kind, note, payload) in game_txs.drain(..) {
            let _ = tx_sender.send(TxRequest { kind, note, payload });
        }
    }
}

// --- Message sending ---

fn send_vertex_transaction(
    engine: &Engine,
    runtime: &SharedRuntime,
    kind: MessageKind,
    note: Option<String>,
    payload: Option<GamePayload>,
) -> anyhow::Result<WireMessage> {
    let label = { runtime.lock().unwrap().label.clone() };
    let message = build_message(runtime, kind, note, payload)?;
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
    payload: Option<GamePayload>,
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
        game: payload,
    };

    state.last_message_kind = Some(message.kind.clone());
    state.last_message_id = Some(message.message_id.clone());
    persist_state(&state)?;
    Ok(message)
}
