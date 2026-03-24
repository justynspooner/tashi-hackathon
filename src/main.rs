mod node;
mod proof;
mod protocol;
mod state;
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
    /// Run a node and connect to a peer.
    Run {
        #[arg(long)]
        bind: String,
        #[arg(long)]
        secret: String,
        #[arg(long)]
        peer_addr: String,
        #[arg(long)]
        peer_pubkey: String,
        #[arg(long, default_value = "agent")]
        label: String,
        #[arg(long, default_value = "carrier")]
        role: String,
        #[arg(long, default_value = "ready")]
        status: String,
        #[arg(long, default_value_t = 1_000)]
        heartbeat_ms: u64,
        #[arg(long, default_value_t = 10_000)]
        stale_after_ms: u64,
        #[arg(long)]
        toggle_role_to: Option<String>,
        #[arg(long, default_value_t = 5_000)]
        toggle_after_ms: u64,
        #[arg(long)]
        state_file: Option<PathBuf>,
        #[arg(long)]
        proof_dir: Option<PathBuf>,
        #[arg(long)]
        event_log: Option<PathBuf>,
        #[arg(long)]
        cmd_file: Option<PathBuf>,
    },
    /// Start the web server and manage nodes from the browser.
    Serve {
        /// Port to listen on.
        #[arg(long, default_value_t = 3001)]
        port: u16,
    },
}

#[tokio::main(flavor = "current_thread")]
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
            label,
            role,
            status,
            heartbeat_ms,
            stale_after_ms,
            toggle_role_to,
            toggle_after_ms,
            state_file,
            proof_dir,
            event_log,
            cmd_file,
        } => {
            let state_file = state_file
                .unwrap_or_else(|| PathBuf::from(format!("artifacts/{label}-state.json")));
            let proof_dir = proof_dir
                .unwrap_or_else(|| PathBuf::from(format!("artifacts/proofs/{label}")));
            let event_log = event_log
                .unwrap_or_else(|| PathBuf::from(format!("artifacts/{label}-events.jsonl")));
            let cmd_file = cmd_file
                .unwrap_or_else(|| PathBuf::from(format!("artifacts/{label}-cmd.json")));

            node::run(
                bind,
                secret,
                peer_addr,
                peer_pubkey,
                label,
                role,
                status,
                heartbeat_ms,
                stale_after_ms,
                toggle_role_to,
                toggle_after_ms,
                Some(state_file),
                Some(proof_dir),
                Some(event_log),
                Some(cmd_file),
                None,
                None,
            )
            .await?;
        }
        Command::Serve { port } => {
            web::serve(port).await?;
        }
    }

    Ok(())
}
