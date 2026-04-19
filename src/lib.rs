//! Library-crate shim.
//!
//! The binary at `src/main.rs` wires everything together; this `lib.rs`
//! re-exports the pure modules so integration tests in `tests/` can import
//! them. Modules that touch the Vertex FFI (`node`, `pf`, `web`) are *not*
//! re-exported — integration tests stay fast and hermetic.
//!
//! Keeping both a lib and a bin target is the lightest way to expose
//! internals without restructuring the whole crate. If future integration
//! tests need more modules, add them here.

pub mod defaults;
pub mod game_fsm;
pub mod game_state;
pub mod games;
pub mod geom;
pub mod protocol;
pub mod rules;
