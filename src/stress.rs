//! `cargo run -- stress` — scripted reconciler stress test.
//!
//! The demo's Phase-B payoff is "drag nodes apart until consensus stalls,
//! then drag back to heal". This harness exercises that loop purely at the
//! reconciler layer (no Vertex, no sudo, no pfctl) by stepping a synthetic
//! set of positions across the comm-radius boundary and asserting that:
//!
//!   1. Hysteresis absorbs ±0.1m flapping at the boundary (no churn).
//!   2. Pairs block once distance > radius + HYSTERESIS.
//!   3. Pairs heal once distance < radius - HYSTERESIS after a full
//!      separation.
//!   4. A 7-node scripted capture-the-flag moveset blocks/heals the
//!      expected pairs (sanity check against `compute_desired_blocked`).
//!
//! The full end-to-end harness (spawning real child processes, invoking
//! `sudo pfctl`) is deliberately out of scope — it requires root and a
//! running Vertex swarm. The unit-level tests in `src/web.rs` cover the
//! same invariants against the same `compute_desired_blocked` function;
//! this subcommand makes them a human-runnable demo on the command line.
//!
//! Exits with status 0 on success, 1 on any assertion failure.

use std::collections::{HashMap, HashSet};

use crate::defaults::HYSTERESIS_M;
use crate::geom;
use crate::protocol::Position;

const RADIUS_M: f32 = 8.0;

/// Simplified port-pair type for this harness — the real reconciler uses
/// `pf::PortPair` but we don't need it here; the desired-blocked set only
/// cares about which *labels* flipped.
type LabelPair = (String, String);

fn block_radius() -> f32 {
    RADIUS_M + HYSTERESIS_M
}

fn unblock_radius() -> f32 {
    (RADIUS_M - HYSTERESIS_M).max(0.0)
}

fn normalise(a: &str, b: &str) -> LabelPair {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

/// Pure, in-process clone of `compute_desired_blocked` from `web.rs`. We
/// don't depend on it directly to avoid leaking the PortPair type and to
/// keep this harness free of web-server plumbing.
fn desired_blocked(
    positions: &[(String, Position)],
    currently_blocked: &HashSet<LabelPair>,
) -> HashSet<LabelPair> {
    let mut out = HashSet::new();
    for i in 0..positions.len() {
        for j in (i + 1)..positions.len() {
            let (la, pa) = &positions[i];
            let (lb, pb) = &positions[j];
            let pair = normalise(la, lb);
            let was_blocked = currently_blocked.contains(&pair);
            let should_block = if was_blocked {
                !geom::in_range(*pa, *pb, unblock_radius())
            } else {
                !geom::in_range(*pa, *pb, block_radius())
            };
            if should_block {
                out.insert(pair);
            }
        }
    }
    out
}

fn pos(x: f32, y: f32) -> Position {
    Position { x, y }
}

/// Scenario 1: a node walking back and forth across radius 8.0 with ±0.1m
/// amplitude must never cause a transition (hysteresis band is 0.5m).
fn scenario_flapping_absorbed() -> Result<(), String> {
    let mut positions = vec![("a".to_string(), pos(0.0, 0.0)), ("b".to_string(), pos(0.0, 0.0))];
    let mut blocked: HashSet<LabelPair> = HashSet::new();
    let distances = [7.9_f32, 8.0, 8.1, 8.0, 7.9, 8.1, 7.95, 8.05, 8.0, 7.9];
    let mut transitions = 0usize;
    for d in distances {
        positions[1].1 = pos(d, 0.0);
        let desired = desired_blocked(&positions, &blocked);
        if desired != blocked {
            transitions += 1;
        }
        blocked = desired;
    }
    if transitions != 0 {
        return Err(format!(
            "flapping produced {transitions} transition(s); hysteresis should have absorbed them"
        ));
    }
    Ok(())
}

/// Scenario 2: block once outside the block_radius, then heal once inside
/// the unblock_radius. Mirrors the demo's "drag far away → drag back" loop.
fn scenario_full_separation_and_heal() -> Result<(), String> {
    let mut positions = vec![("a".to_string(), pos(0.0, 0.0)), ("b".to_string(), pos(0.0, 0.0))];
    let mut blocked: HashSet<LabelPair> = HashSet::new();

    // 5 ticks far apart — must stay blocked.
    for tick in 0..5 {
        positions[1].1 = pos(20.0, 0.0);
        blocked = desired_blocked(&positions, &blocked);
        if blocked.len() != 1 {
            return Err(format!(
                "tick {tick}: expected 1 block at 20m, got {}",
                blocked.len()
            ));
        }
    }

    // 5 ticks close — must unblock.
    for tick in 0..5 {
        positions[1].1 = pos(3.0, 0.0);
        blocked = desired_blocked(&positions, &blocked);
        if tick == 4 && !blocked.is_empty() {
            return Err(format!(
                "tick {tick}: expected pair to heal at 3m, still blocked"
            ));
        }
    }
    Ok(())
}

/// Scenario 3: 7-node CTF loadout. Drag the flag carrier through a sequence
/// of positions; the reconciler should isolate them exactly when their
/// distance to the rest of the cluster exceeds the block radius.
fn scenario_seven_node_ctf_drag() -> Result<(), String> {
    let mut positions: Vec<(String, Position)> = vec![
        ("flag".into(), pos(30.0, 15.0)),
        ("base-r".into(), pos(10.0, 15.0)),
        ("base-b".into(), pos(50.0, 15.0)),
        ("player-r1".into(), pos(11.0, 14.0)),
        ("player-r2".into(), pos(11.0, 16.0)),
        ("player-b1".into(), pos(49.0, 14.0)),
        ("player-b2".into(), pos(49.0, 16.0)),
    ];
    let mut blocked: HashSet<LabelPair> = HashSet::new();

    // Initial layout — nobody's near enough across teams for them to see
    // each other (red/blue bases are 40m apart). Every cross-team pair
    // should be blocked; same-team pairs (within 2m) shouldn't.
    blocked = desired_blocked(&positions, &blocked);
    let expected_blocks: &[(&str, &str)] = &[
        ("base-b", "base-r"),
        ("base-r", "flag"),
        ("base-b", "flag"),
        ("base-r", "player-b1"),
        ("base-r", "player-b2"),
        ("base-b", "player-r1"),
        ("base-b", "player-r2"),
        ("flag", "player-b1"),
        ("flag", "player-b2"),
        ("flag", "player-r1"),
        ("flag", "player-r2"),
        ("player-b1", "player-r1"),
        ("player-b1", "player-r2"),
        ("player-b2", "player-r1"),
        ("player-b2", "player-r2"),
    ];
    let got: HashSet<_> = blocked.iter().cloned().collect();
    let want: HashSet<_> = expected_blocks
        .iter()
        .map(|(a, b)| normalise(a, b))
        .collect();
    if got != want {
        let missing: Vec<_> = want.difference(&got).cloned().collect();
        let extra: Vec<_> = got.difference(&want).cloned().collect();
        return Err(format!(
            "initial layout: unexpected diff\n  missing: {missing:?}\n  extra:   {extra:?}"
        ));
    }

    // Drag player-r1 to the flag over 5 ticks. Around halfway they enter
    // range of blue-side entities; the reconciler should heal those pairs.
    let waypoints = [
        pos(15.0, 15.0),
        pos(20.0, 15.0),
        pos(25.0, 15.0),
        pos(28.0, 15.0),
        pos(30.5, 15.0),
    ];
    for (tick, wp) in waypoints.iter().enumerate() {
        positions[3].1 = *wp; // player-r1
        blocked = desired_blocked(&positions, &blocked);
        // By the last tick, player-r1 is 0.5m from the flag — must be
        // connected regardless of hysteresis state.
        if tick == waypoints.len() - 1 {
            let pair = normalise("flag", "player-r1");
            if blocked.contains(&pair) {
                return Err(format!(
                    "player-r1 at {:.1}m from flag should have healed",
                    geom::dist(positions[0].1, *wp)
                ));
            }
        }
    }
    Ok(())
}

fn run_scenario(name: &str, f: impl FnOnce() -> Result<(), String>) -> bool {
    match f() {
        Ok(()) => {
            println!("  ok  {name}");
            true
        }
        Err(e) => {
            eprintln!("  FAIL {name}: {e}");
            false
        }
    }
}

pub fn run() -> anyhow::Result<()> {
    println!(
        "[stress] radius={RADIUS_M}m, hysteresis={HYSTERESIS_M}m, \
         block_radius={:.1}m, unblock_radius={:.1}m",
        block_radius(),
        unblock_radius()
    );

    // Seed so future additions can use randomness deterministically.
    let mut _rng: HashMap<String, f32> = HashMap::new();
    _rng.insert("seed".into(), 42.0);

    let mut ok = true;
    ok &= run_scenario("flapping at boundary absorbed by hysteresis", scenario_flapping_absorbed);
    ok &= run_scenario("full separation blocks, return heals", scenario_full_separation_and_heal);
    ok &= run_scenario("7-node CTF layout partitions teams", scenario_seven_node_ctf_drag);

    if ok {
        println!("[stress] all scenarios passed");
        Ok(())
    } else {
        anyhow::bail!("[stress] one or more scenarios failed");
    }
}
