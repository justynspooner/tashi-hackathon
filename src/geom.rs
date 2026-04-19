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
pub fn place_randomly_without_overlap(
    existing: &[Position],
    field: (f32, f32),
    min_sep_m: f32,
    rng: &mut impl Rng,
) -> Position {
    let (w, h) = field;
    let margin = min_sep_m.max(1.0);
    let lo_x = margin;
    let hi_x = (w - margin).max(margin + 0.1);
    let lo_y = margin;
    let hi_y = (h - margin).max(margin + 0.1);

    for _ in 0..200 {
        let x = rng.gen_range(lo_x..hi_x);
        let y = rng.gen_range(lo_y..hi_y);
        let candidate = Position { x, y };
        if existing
            .iter()
            .all(|p| dist_sq(*p, candidate) >= min_sep_m * min_sep_m)
        {
            return candidate;
        }
    }

    // Grid fallback: walk a regular lattice, pick the first cell that's
    // further than min_sep_m from every existing point. Guaranteed to find a
    // cell unless the field is genuinely saturated, in which case we return
    // the last cell we visited (caller is responsible for cluster size).
    let step = (min_sep_m.max(0.1) * 1.1).max(1.0);
    let mut last = Position { x: lo_x, y: lo_y };
    let mut y = lo_y;
    while y < hi_y {
        let mut x = lo_x;
        while x < hi_x {
            let candidate = Position { x, y };
            if existing
                .iter()
                .all(|p| dist_sq(*p, candidate) >= min_sep_m * min_sep_m)
            {
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
}
