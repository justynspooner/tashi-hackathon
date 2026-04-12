use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Context;
use tokio::process::Command;

/// Sorted pair of ports representing a blocked connection.
type PortPair = (u16, u16);

fn normalize_pair(a: u16, b: u16) -> PortPair {
    if a <= b { (a, b) } else { (b, a) }
}

pub struct PfPartitionManager {
    blocked: Mutex<HashSet<PortPair>>,
    backup_path: PathBuf,
    backed_up: Mutex<bool>,
}

impl PfPartitionManager {
    pub fn new() -> Self {
        let backup_path = std::env::current_dir()
            .unwrap_or_default()
            .join("artifacts")
            .join("pf.conf.backup");
        Self {
            blocked: Mutex::new(HashSet::new()),
            backup_path,
            backed_up: Mutex::new(false),
        }
    }

    /// Back up /etc/pf.conf and enable pf with loopback filtering.
    /// Only runs once.
    async fn ensure_setup(&self) -> anyhow::Result<()> {
        {
            let backed_up = self.backed_up.lock().unwrap();
            if *backed_up {
                return Ok(());
            }
        }

        // Back up the original pf.conf
        let output = Command::new("sudo")
            .args(["cp", "/etc/pf.conf", self.backup_path.to_str().unwrap()])
            .output()
            .await
            .context("failed to run sudo cp")?;
        if !output.status.success() {
            anyhow::bail!(
                "failed to backup pf.conf: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        println!(
            "Backed up /etc/pf.conf to {}",
            self.backup_path.display()
        );

        // Enable pf
        let _ = Command::new("sudo")
            .args(["pfctl", "-e"])
            .output()
            .await;

        *self.backed_up.lock().unwrap() = true;
        Ok(())
    }

    /// Reload pf rules: the original pf.conf minus `set skip on lo0`, plus our block rules.
    async fn reload_rules(&self) -> anyhow::Result<()> {
        let blocked: HashSet<PortPair> = self.blocked.lock().unwrap().clone();

        // Read current backup to use as base
        let base = if self.backup_path.exists() {
            std::fs::read_to_string(&self.backup_path)
                .unwrap_or_default()
        } else {
            std::fs::read_to_string("/etc/pf.conf").unwrap_or_default()
        };

        // Remove `set skip on lo0` so pf inspects loopback traffic
        let mut lines: Vec<String> = base
            .lines()
            .filter(|line| {
                let trimmed = line.trim();
                !trimmed.starts_with("set skip on lo0")
            })
            .map(String::from)
            .collect();

        // Append our block rules
        if !blocked.is_empty() {
            lines.push(String::new());
            lines.push("# vertex-explorer partition rules".to_string());
            for (port_a, port_b) in &blocked {
                lines.push(format!(
                    "block drop quick on lo0 proto udp from 127.0.0.1 port {port_a} to 127.0.0.1 port {port_b}"
                ));
                lines.push(format!(
                    "block drop quick on lo0 proto udp from 127.0.0.1 port {port_b} to 127.0.0.1 port {port_a}"
                ));
            }
        }

        let ruleset = lines.join("\n") + "\n";

        // Write to a temp file and load it
        let tmp = std::env::temp_dir().join("vertex-pf-rules.conf");
        std::fs::write(&tmp, &ruleset)
            .context("failed to write temp pf rules")?;

        let output = Command::new("sudo")
            .args(["pfctl", "-f", tmp.to_str().unwrap()])
            .output()
            .await
            .context("failed to run pfctl -f")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // pfctl prints "pf enabled" to stderr even on success
            if !stderr.contains("pf enabled") && !stderr.is_empty() {
                anyhow::bail!("pfctl -f failed: {stderr}");
            }
        }

        let _ = std::fs::remove_file(&tmp);
        Ok(())
    }

    /// Block traffic between two ports.
    pub async fn partition(&self, port_a: u16, port_b: u16) -> anyhow::Result<()> {
        self.ensure_setup().await?;
        let pair = normalize_pair(port_a, port_b);
        self.blocked.lock().unwrap().insert(pair);
        self.reload_rules().await?;
        println!("Partitioned ports {} <-> {}", port_a, port_b);
        Ok(())
    }

    /// Restore traffic between two ports.
    pub async fn heal(&self, port_a: u16, port_b: u16) -> anyhow::Result<()> {
        let pair = normalize_pair(port_a, port_b);
        self.blocked.lock().unwrap().remove(&pair);
        self.reload_rules().await?;
        println!("Healed ports {} <-> {}", port_a, port_b);
        Ok(())
    }

    /// Get all currently blocked pairs as port tuples.
    pub fn blocked_pairs(&self) -> Vec<PortPair> {
        self.blocked.lock().unwrap().iter().copied().collect()
    }

    /// Restore original pf.conf and flush all partition rules.
    pub async fn restore(&self) {
        self.blocked.lock().unwrap().clear();

        let backed_up = *self.backed_up.lock().unwrap();
        if !backed_up {
            return;
        }

        if self.backup_path.exists() {
            let result = Command::new("sudo")
                .args(["pfctl", "-f", self.backup_path.to_str().unwrap()])
                .output()
                .await;
            match result {
                Ok(output) if output.status.success() => {
                    println!("Restored original pf.conf from {}", self.backup_path.display());
                }
                Ok(output) => {
                    eprintln!(
                        "Warning: failed to restore pf.conf: {}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                Err(e) => {
                    eprintln!("Warning: failed to run pfctl restore: {e}");
                }
            }
        }
    }
}
