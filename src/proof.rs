use std::fs;
use std::path::Path;

use anyhow::Context as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use tashi_vertex::Event;

use crate::protocol::WireMessage;

/// A self-contained proof that consensus was reached on a set of transactions.
///
/// The `event_hash` is provided by the Vertex BFT engine and represents
/// cryptographic evidence that a super-majority of peers agreed on the
/// ordering of this event. The `content_hash` is computed locally over the
/// canonical proof fields so a verifier can check integrity without needing
/// access to the Vertex engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProofOfCoordination {
    pub creator: String,
    pub created_at: u64,
    pub consensus_at: u64,
    pub finality_ms: u64,
    pub event_hash: String,
    pub transactions: Vec<WireMessage>,
    pub content_hash: String,
}

impl ProofOfCoordination {
    /// Build a proof from a consensus-finalized event.
    ///
    /// Returns `None` if the event is a gossip event that has not yet
    /// reached consensus (e.g. `consensus_at` is zero) or if accessing
    /// the event's FFI fields fails.
    pub fn from_event(event: &Event) -> Option<Self> {
        let consensus_at = event.consensus_at();
        if consensus_at == 0 {
            return None;
        }

        let creator = event.creator().to_string();
        let created_at = event.created_at();
        let finality_ms = created_at.abs_diff(consensus_at) / 1_000_000;
        let event_hash = hex_encode(event.hash());

        let transactions: Vec<WireMessage> = event
            .transactions()
            .filter_map(|tx| serde_json::from_slice(tx).ok())
            .collect();

        let content_hash = compute_content_hash(
            &creator,
            created_at,
            consensus_at,
            &event_hash,
            &transactions,
        );

        Some(Self {
            creator,
            created_at,
            consensus_at,
            finality_ms,
            event_hash,
            transactions,
            content_hash,
        })
    }

    /// Verify that the content hash matches the proof's fields.
    ///
    /// This confirms the proof has not been tampered with after creation.
    /// It does NOT re-verify the BFT consensus signatures — that happens
    /// inside the Vertex engine when the event is first received.
    pub fn verify(&self) -> bool {
        let expected = compute_content_hash(
            &self.creator,
            self.created_at,
            self.consensus_at,
            &self.event_hash,
            &self.transactions,
        );
        self.content_hash == expected
    }

    /// Write the proof to a JSON file.
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create directory {}", parent.display()))?;
        }
        let json = serde_json::to_vec_pretty(self)?;
        fs::write(path, json).with_context(|| format!("failed to write {}", path.display()))?;
        Ok(())
    }

    /// Load and verify a proof from a JSON file.
    ///
    /// Returns the proof if the file is valid JSON and the content hash
    /// passes verification. Returns an error otherwise.
    pub fn load_and_verify(path: &Path) -> anyhow::Result<Self> {
        let data = fs::read(path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let proof: Self = serde_json::from_slice(&data)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        anyhow::ensure!(proof.verify(), "proof content hash verification failed");
        Ok(proof)
    }
}

/// Compute a SHA-256 hash over the canonical proof fields.
fn compute_content_hash(
    creator: &str,
    created_at: u64,
    consensus_at: u64,
    event_hash: &str,
    transactions: &[WireMessage],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(creator.as_bytes());
    hasher.update(created_at.to_le_bytes());
    hasher.update(consensus_at.to_le_bytes());
    hasher.update(event_hash.as_bytes());
    let tx_json = serde_json::to_vec(transactions).unwrap_or_default();
    hasher.update(&tx_json);
    hex_encode(&hasher.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
