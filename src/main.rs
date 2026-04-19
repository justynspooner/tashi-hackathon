mod defaults;
mod game_fsm;
mod game_state;
mod games;
mod geom;
mod node;
mod pf;
mod proof;
mod protocol;
mod rules;
mod state;
mod stress;
mod web;

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use tashi_vertex::KeySecret;

use crate::proof::ProofOfCoordination;

#[derive(Parser)]
#[command(name = "node", about = "Tashi Vertex warm-up node")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate a new Ed25519 keypair.
    GenKey,
    /// Verify a proof-of-coordination JSON file.
    Verify {
        /// Path to the proof JSON file.
        #[arg(long)]
        proof_file: PathBuf,
    },
    /// Run a node and connect to peers.
    Run {
        #[arg(long)]
        bind: String,
        #[arg(long)]
        secret: String,
        /// Peer addresses (repeat for multiple peers).
        #[arg(long)]
        peer_addr: Vec<String>,
        /// Peer public keys (repeat for multiple peers, same order as --peer-addr).
        #[arg(long)]
        peer_pubkey: Vec<String>,
        /// Peer labels (repeat for multiple peers, same order as --peer-addr).
        /// Optional: if present, must match the length of `--peer-addr`.
        #[arg(long)]
        peer_label: Vec<String>,
        #[arg(long, default_value = "agent")]
        label: String,
        #[arg(long, default_value = "ready")]
        status: String,
        #[arg(long, default_value_t = 50)]
        heartbeat_ms: u64,
        #[arg(long, default_value_t = 10_000)]
        stale_after_ms: u64,
        #[arg(long)]
        state_file: Option<PathBuf>,
        #[arg(long)]
        proof_dir: Option<PathBuf>,
        #[arg(long)]
        event_log: Option<PathBuf>,
        #[arg(long)]
        cmd_file: Option<PathBuf>,
        /// Optional initial X position (metres on the playing field).
        #[arg(long)]
        initial_x: Option<f32>,
        /// Optional initial Y position (metres on the playing field).
        #[arg(long)]
        initial_y: Option<f32>,
        /// Path for the per-node game-state snapshot (defaults to
        /// `artifacts/{label}-game.json`).
        #[arg(long)]
        game_file: Option<PathBuf>,
        /// Path to a directory of pre-installed game configs (JSON files).
        #[arg(long, default_value = "games")]
        games_dir: PathBuf,
        /// Number of nodes in the swarm — used to compute the majority
        /// threshold for proposals/votes.
        #[arg(long, default_value_t = 1)]
        swarm_size: usize,
        /// Signal that this node is joining an already-running session (reconnect).
        #[arg(long)]
        joining: bool,
    },
    /// Start the web server and manage nodes from the browser.
    Serve {
        /// Port to listen on.
        #[arg(long, default_value_t = 3001)]
        port: u16,
    },
    /// Run the scripted reconciler stress scenarios (no Vertex, no sudo).
    /// Exits non-zero on failure — wire into CI to catch hysteresis
    /// regressions before they reach the demo.
    Stress,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::GenKey => {
            let secret = KeySecret::generate();
            println!("Secret (keep private): {secret}");
            println!("Public (share freely): {}", secret.public());
        }
        Command::Verify { proof_file } => {
            let proof = ProofOfCoordination::load_and_verify(&proof_file)?;
            println!("Proof is VALID");
            println!("  Creator:    {}", proof.creator);
            println!("  Consensus:  {}", proof.consensus_at);
            println!("  Finality:   {}ms", proof.finality_ms);
            println!("  Event hash: {}", proof.event_hash);
            println!("  Txns:       {}", proof.transactions.len());
        }
        Command::Run {
            bind,
            secret,
            peer_addr,
            peer_pubkey,
            peer_label,
            label,
            status,
            heartbeat_ms,
            stale_after_ms,
            state_file,
            proof_dir,
            event_log,
            cmd_file,
            initial_x,
            initial_y,
            game_file,
            games_dir,
            swarm_size,
            joining,
        } => {
            anyhow::ensure!(
                peer_addr.len() == peer_pubkey.len(),
                "Must have equal number of --peer-addr and --peer-pubkey arguments"
            );
            anyhow::ensure!(
                peer_label.is_empty() || peer_label.len() == peer_addr.len(),
                "If --peer-label is provided, it must have the same count as --peer-addr"
            );
            let peers: Vec<(String, String, Option<String>)> = peer_addr
                .into_iter()
                .zip(peer_pubkey.into_iter())
                .enumerate()
                .map(|(i, (a, k))| (a, k, peer_label.get(i).cloned()))
                .collect();

            let state_file = state_file
                .unwrap_or_else(|| PathBuf::from(format!("artifacts/{label}-state.json")));
            let proof_dir = proof_dir
                .unwrap_or_else(|| PathBuf::from(format!("artifacts/proofs/{label}")));
            let event_log = event_log
                .unwrap_or_else(|| PathBuf::from(format!("artifacts/{label}-events.jsonl")));
            let cmd_file = cmd_file
                .unwrap_or_else(|| PathBuf::from(format!("artifacts/{label}-cmd.json")));
            let game_file = game_file
                .unwrap_or_else(|| PathBuf::from(format!("artifacts/{label}-game.json")));

            let initial_position = match (initial_x, initial_y) {
                (Some(x), Some(y)) => Some(protocol::Position { x, y }),
                _ => None,
            };

            let games_map = games::load_all(&games_dir).unwrap_or_default();

            node::run(
                bind,
                secret,
                peers,
                label,
                status,
                heartbeat_ms,
                stale_after_ms,
                Some(state_file),
                Some(proof_dir),
                Some(event_log),
                Some(cmd_file),
                Some(game_file),
                initial_position,
                games_map,
                swarm_size,
                None,
                None,
                joining,
            )
            .await?;
        }
        Command::Serve { port } => {
            web::serve(port).await?;
        }
        Command::Stress => {
            stress::run()?;
        }
    }

    Ok(())
}
