//! Pure geometry helpers for range checks and random entity placement.
//!
//! The backend deliberately does not implement line-of-sight — obstacles are
//! frontend-only rendering concerns and do not influence `pfctl` partitions.
//!
//! Note: there's no all-pairs `connected_pairs` helper — the partition
//! reconciler needs separate block/unblock radii for hysteresis, so it walks
//! pairs itself using `in_range` at each threshold rather than reducing to a
//! single radius.

use rand::Rng;

use crate::protocol::Position;

/// Squared 2D distance.
#[inline]
pub fn dist_sq(a: Position, b: Position) -> f32 {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    dx * dx + dy * dy
}

#[inline]
pub fn dist(a: Position, b: Position) -> f32 {
    dist_sq(a, b).sqrt()
}

#[inline]
pub fn in_range(a: Position, b: Position, radius_m: f32) -> bool {
    dist_sq(a, b) <= radius_m * radius_m
}

/// Draw a position uniformly in the field, rejecting if within `min_sep_m` of
/// any existing position. Falls back to a deterministic grid sweep if retry
/// limit is hit.
///
/// Kept as a public helper (and exercised by unit tests) for callers that
/// don't need pairwise connectivity. Production swarm creation uses
/// [`place_connected_without_overlap`] instead.
#[allow(dead_code)]
pub fn place_randomly_without_overlap(
    existing: &[Position],
    field: (f32, f32),
    min_sep_m: f32,
    rng: &mut impl Rng,
) -> Position {
    place_randomly_inner(existing, field, min_sep_m, None, rng)
}

/// Like `place_randomly_without_overlap` but additionally requires the new
/// position to be within `max_sep_m` of every existing node, so that every
/// pair of nodes in the resulting swarm starts inside the communication
/// radius. Callers pass the effective pre-game comm radius (typically a touch
/// below it to survive reconciler hysteresis).
///
/// The first placement (empty `existing`) is constrained to a central region
/// so the entire connected cluster fits inside the field — without this, a
/// first node near a corner leaves too little feasible area for the rest.
pub fn place_connected_without_overlap(
    existing: &[Position],
    field: (f32, f32),
    min_sep_m: f32,
    max_sep_m: f32,
    rng: &mut impl Rng,
) -> Position {
    place_randomly_inner(existing, field, min_sep_m, Some(max_sep_m), rng)
}

fn place_randomly_inner(
    existing: &[Position],
    field: (f32, f32),
    min_sep_m: f32,
    max_sep_m: Option<f32>,
    rng: &mut impl Rng,
) -> Position {
    let (w, h) = field;
    // When a max_sep is set and this is the first placement, seed the node in
    // a central rect so the upcoming cluster (diameter ≤ max_sep_m) fits.
    let margin = if existing.is_empty() {
        match max_sep_m {
            Some(r) => (r * 0.5).max(min_sep_m.max(1.0)),
            None => min_sep_m.max(1.0),
        }
    } else {
        min_sep_m.max(1.0)
    };
    let lo_x = margin;
    let hi_x = (w - margin).max(margin + 0.1);
    let lo_y = margin;
    let hi_y = (h - margin).max(margin + 0.1);

    let min_sq = min_sep_m * min_sep_m;
    let max_sq = max_sep_m.map(|r| r * r);

    let satisfies = |candidate: Position| -> bool {
        existing.iter().all(|p| {
            let d2 = dist_sq(*p, candidate);
            if d2 < min_sq {
                return false;
            }
            if let Some(ms) = max_sq {
                if d2 > ms {
                    return false;
                }
            }
            true
        })
    };

    // A few extra retries when the max_sep lens is tight; otherwise the grid
    // fallback handles it deterministically.
    let retries = if max_sep_m.is_some() { 400 } else { 200 };
    for _ in 0..retries {
        let x = rng.gen_range(lo_x..hi_x);
        let y = rng.gen_range(lo_y..hi_y);
        let candidate = Position { x, y };
        if satisfies(candidate) {
            return candidate;
        }
    }

    // Grid fallback: walk a regular lattice, pick the first cell that
    // satisfies both min_sep and (if set) max_sep against every existing
    // point. Guaranteed to find a cell unless the field is genuinely
    // saturated, in which case we return the last cell we visited (caller is
    // responsible for cluster size).
    let step = (min_sep_m.max(0.1) * 1.1).max(1.0);
    let mut last = Position { x: lo_x, y: lo_y };
    let mut y = lo_y;
    while y < hi_y {
        let mut x = lo_x;
        while x < hi_x {
            let candidate = Position { x, y };
            if satisfies(candidate) {
                return candidate;
            }
            last = candidate;
            x += step;
        }
        y += step;
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn in_range_boundary() {
        let pa = Position { x: 0.0, y: 0.0 };
        let pb = Position { x: 3.0, y: 4.0 };
        assert!(in_range(pa, pb, 5.0));
        assert!(!in_range(pa, pb, 4.9));
    }

    #[test]
    fn place_random_respects_min_sep() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(42);
        let mut placed: Vec<Position> = Vec::new();
        for _ in 0..8 {
            let p = place_randomly_without_overlap(&placed, (60.0, 30.0), 2.5, &mut rng);
            for q in &placed {
                assert!(dist(*q, p) >= 2.5 - 1e-3, "min sep violated: {:?} vs {:?}", q, p);
            }
            placed.push(p);
        }
    }

    #[test]
    fn place_random_grid_fallback_covers_field() {
        // Saturate a small field so random draws nearly always collide.
        let mut placed: Vec<Position> = Vec::new();
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        for _ in 0..20 {
            let p = place_randomly_without_overlap(&placed, (10.0, 10.0), 1.5, &mut rng);
            placed.push(p);
        }
        // Should never panic / always return a Position within the field
        for p in &placed {
            assert!(p.x >= 0.0 && p.x <= 10.0);
            assert!(p.y >= 0.0 && p.y <= 10.0);
        }
    }

    #[test]
    fn place_connected_keeps_every_pair_within_max_sep() {
        // Realistic swarm sizes on the 60x30 field with the global comm
        // radius. Every pair of nodes must start within max_sep_m so the
        // partition reconciler does not block any pair on boot.
        let field = (60.0, 30.0);
        let min_sep = 2.5;
        let max_sep = 14.5; // COMM_RADIUS_M - HYSTERESIS_M
        for (seed, n) in [(1u64, 3usize), (2, 5), (3, 8)] {
            let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
            let mut placed: Vec<Position> = Vec::new();
            for _ in 0..n {
                let p = place_connected_without_overlap(&placed, field, min_sep, max_sep, &mut rng);
                for q in &placed {
                    let d = dist(*q, p);
                    assert!(
                        d >= min_sep - 1e-3,
                        "min sep violated (seed={seed},n={n}): {:?} vs {:?} d={d}",
                        q,
                        p,
                    );
                    assert!(
                        d <= max_sep + 1e-3,
                        "max sep violated (seed={seed},n={n}): {:?} vs {:?} d={d}",
                        q,
                        p,
                    );
                }
                placed.push(p);
            }
        }
    }

    #[test]
    fn place_connected_first_node_central_enough_for_cluster() {
        // With no peers yet, the first node must land far enough from every
        // edge that a full cluster of radius max_sep/2 still fits. Otherwise
        // a corner-seeded first node starves subsequent placements.
        let field = (60.0, 30.0);
        let max_sep = 11.5;
        let r = max_sep * 0.5;
        for seed in 0u64..20 {
            let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
            let p = place_connected_without_overlap(&[], field, 2.5, max_sep, &mut rng);
            assert!(p.x >= r - 1e-3 && p.x <= field.0 - r + 1e-3, "first x={}", p.x);
            assert!(p.y >= r - 1e-3 && p.y <= field.1 - r + 1e-3, "first y={}", p.y);
        }
    }

    #[test]
    fn place_connected_single_node_returns_a_valid_position() {
        // Edge case: swarm of 1. No pairs to check, just has to fit.
        let mut rng = rand::rngs::StdRng::seed_from_u64(99);
        let p = place_connected_without_overlap(&[], (60.0, 30.0), 2.5, 11.5, &mut rng);
        assert!(p.x >= 0.0 && p.x <= 60.0);
        assert!(p.y >= 0.0 && p.y <= 30.0);
    }
}
