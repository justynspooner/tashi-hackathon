//! Integration test: every shipped `games/*.json` config must parse through
//! the Rust `GameConfig` types and satisfy the invariants we rely on at
//! runtime (non-empty id, min<=max for each entity).
//!
//! This sits as an external `tests/` binary rather than inline in
//! `games.rs` specifically so schema drift — a new field in a JSON, or a
//! rename that the inline test forgot — fails the build on its own rather
//! than silently passing because the inline test only checks a handful of
//! fields. The file list is discovered at test time so adding a fourth
//! game doesn't require editing this file.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use warmup_vertex_rust::games::{load_all, GameConfig};

fn games_dir() -> PathBuf {
    // Cargo sets CARGO_MANIFEST_DIR to the crate root for integration tests.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("games")
}

#[test]
fn loads_every_shipped_game() {
    let dir = games_dir();
    assert!(dir.exists(), "games dir should exist at {}", dir.display());

    let configs = load_all(&dir).expect("load_all should succeed");
    assert!(!configs.is_empty(), "should load at least one game config");

    // Expect the shipped games. If this list diverges, update the
    // test and the plan together — it's intentional prose, not a helper.
    let expected: HashSet<&str> =
        ["ctf", "ctf_park", "king_of_the_hill", "territory", "freeze_tag"]
            .into_iter()
            .collect();
    let got: HashSet<&str> = configs.keys().map(|s| s.as_str()).collect();
    for id in &expected {
        assert!(got.contains(id), "missing shipped game: {id}");
    }
}

#[test]
fn every_shipped_game_has_sane_invariants() {
    let configs = load_all(&games_dir()).expect("load_all");
    for (id, cfg) in &configs {
        assert!(!cfg.id.is_empty(), "{id}: id is empty");
        assert!(!cfg.entity_types.is_empty(), "{id}: must declare entity types");
        for et in &cfg.entity_types {
            assert!(!et.id.is_empty(), "{id}.entity_types: empty id");
            assert!(et.min <= et.max, "{id}.entity_types[{}]: min > max", et.id);
        }
    }
}

#[test]
fn every_rule_has_a_recognised_trigger() {
    // `on` values the runtime knows about. If the rule engine gains a new
    // trigger, add it here and update any affected game JSON.
    const RECOGNISED: &[&str] = &["sensor_reading", "tick", "game_state_delta"];
    let configs = load_all(&games_dir()).expect("load_all");
    for (id, cfg) in &configs {
        for rule in &cfg.rules {
            assert!(
                RECOGNISED.contains(&rule.on.as_str()),
                "{id}.rules[{}]: unknown trigger `{}` — add to the runtime dispatcher",
                rule.id,
                rule.on
            );
        }
    }
}

#[test]
fn every_placement_requires_block_parses_as_json() {
    // We don't fully validate placement schema here (that happens lazily at
    // eval time), but a syntactically invalid `requires` means a typo that
    // would bork the rules engine — catch it now.
    let configs = load_all(&games_dir()).expect("load_all");
    for (id, cfg) in &configs {
        for rule in &cfg.placement {
            assert!(
                rule.requires.is_object(),
                "{id}.placement: `requires` for {} must be an object",
                rule.entity
            );
            assert!(
                rule.requires.get("kind").is_some(),
                "{id}.placement: `requires` for {} missing `kind`",
                rule.entity
            );
        }
    }
}

#[test]
fn loader_rejects_empty_id() {
    // Write a synthetic broken JSON into a temp dir and confirm load_all
    // surfaces the error rather than silently accepting it. Uses a
    // process-scoped tempdir so parallel tests don't stomp each other.
    let tmp = std::env::temp_dir().join(format!(
        "warmup-games-test-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();
    fs::write(
        tmp.join("broken.json"),
        serde_json::to_string(&GameConfig {
            id: String::new(),
            name: "broken".into(),
            teams: vec![],
            entity_types: vec![],
            placement: vec![],
            rules: vec![],
            duration_s: None,
            obstacles: vec![],
        })
        .unwrap(),
    )
    .unwrap();
    let err = load_all(&tmp).expect_err("empty id must fail");
    assert!(err.to_string().contains("empty id"), "unexpected error: {err}");
    let _ = fs::remove_dir_all(&tmp);
}
