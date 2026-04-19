//! Constants shared between the web server and child nodes.
//!
//! Field dimensions are duplicated (in lockstep) with the frontend's
//! `frontend/src/game/presentation.ts`. Obstacles live entirely in the frontend;
//! backend uses range-only for `pfctl` reconciliation.

/// Pre-game communication radius in metres (used when no game is loaded).
pub const PRE_GAME_COMM_RADIUS_M: f32 = 12.0;

/// Minimum separation between randomly-placed nodes in metres.
pub const MIN_SEP_M: f32 = 2.5;

/// Playing field width in metres (matches `FIELD_WIDTH_M` in the frontend).
pub const FIELD_WIDTH_M: f32 = 60.0;

/// Playing field height in metres (matches `FIELD_HEIGHT_M` in the frontend).
pub const FIELD_HEIGHT_M: f32 = 30.0;

/// Hysteresis applied to the range check when toggling `pfctl` partitions.
/// Don't block until distance > radius + HYSTERESIS, don't unblock until
/// distance < radius - HYSTERESIS.
pub const HYSTERESIS_M: f32 = 0.5;

/// How often the partition reconciler wakes up.
pub const RECONCILER_TICK_MS: u64 = 500;
