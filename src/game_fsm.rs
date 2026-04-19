//! Game-selection finite state machine.
//!
//! Drives the `NoGame → Proposing → Voting → Loaded` progression based on
//! consensus events (`GameProposal`, `GameVote`). Lives separately from
//! `rules.rs` because rules are pure-function evaluations; the FSM has its own
//! state (windows, counts) that evolves as events arrive.

use std::collections::HashMap;

use crate::game_state::{GamePhase, LocalGameState, ProposalWindow, VoteWindow};

/// Window durations (milliseconds).
pub const PROPOSAL_WINDOW_MS: u64 = 30_000;
pub const VOTE_WINDOW_MS: u64 = 30_000;

/// Effect the FSM wants the caller to apply.
#[derive(Debug, Clone)]
pub enum FsmEffect {
    /// The local node should auto-broadcast its own vote for `game_id`.
    AutoVote { game_id: String },
    /// Game is loaded — caller should set active_game_id and transition to
    /// PlacingEntities.
    LoadGame { game_id: String },
}

/// Apply a new `GameProposal` from `proposer_peer_id`.
pub fn apply_proposal(
    state: &mut LocalGameState,
    proposer_peer_id: String,
    game_id: String,
    now_ms: u64,
    swarm_size: usize,
) -> Vec<FsmEffect> {
    let mut effects = Vec::new();
    if matches!(state.phase, GamePhase::Loaded | GamePhase::PlacingEntities | GamePhase::Ready | GamePhase::CountingDown | GamePhase::Playing | GamePhase::Ended) {
        return effects;
    }
    if state.phase == GamePhase::NoGame {
        state.phase = GamePhase::Proposing;
    }
    let window = state
        .proposal_window
        .get_or_insert(ProposalWindow { started_at_ms: now_ms, proposers: HashMap::new() });
    window.proposers.insert(proposer_peer_id, game_id);

    let majority = swarm_size / 2 + 1;
    if window.proposers.len() >= majority {
        // Tally preferred game_id (lex tie-break).
        let tally = tally(&window.proposers);
        let preferred = pick_winner(&tally);
        state.phase = GamePhase::Voting;
        state.vote_window = Some(VoteWindow {
            started_at_ms: now_ms,
            votes: HashMap::new(),
        });
        state.proposal_window = None;
        if let Some(g) = preferred {
            effects.push(FsmEffect::AutoVote { game_id: g });
        }
    }

    effects
}

pub fn apply_vote(
    state: &mut LocalGameState,
    voter_peer_id: String,
    game_id: String,
    _now_ms: u64,
    swarm_size: usize,
) -> Vec<FsmEffect> {
    let mut effects = Vec::new();
    if state.phase != GamePhase::Voting {
        return effects;
    }
    let window = state.vote_window.get_or_insert_with(Default::default);
    window.votes.insert(voter_peer_id, game_id);

    // Load if every live node has voted.
    if window.votes.len() >= swarm_size {
        let tally = tally(&window.votes);
        if let Some(winner) = pick_winner(&tally) {
            state.phase = GamePhase::Loaded;
            state.active_game_id = Some(winner.clone());
            effects.push(FsmEffect::LoadGame { game_id: winner });
        }
    }

    effects
}

/// Called on 1 Hz tick to detect window timeouts.
pub fn on_tick(state: &mut LocalGameState, now_ms: u64, _swarm_size: usize) -> Vec<FsmEffect> {
    let mut effects = Vec::new();
    match state.phase {
        GamePhase::Proposing => {
            if let Some(win) = &state.proposal_window {
                if now_ms.saturating_sub(win.started_at_ms) >= PROPOSAL_WINDOW_MS {
                    // Drop back — no majority proposed in time.
                    state.proposal_window = None;
                    state.phase = GamePhase::NoGame;
                }
            }
        }
        GamePhase::Voting => {
            if let Some(win) = state.vote_window.clone() {
                if now_ms.saturating_sub(win.started_at_ms) >= VOTE_WINDOW_MS {
                    let tally = tally(&win.votes);
                    if let Some(winner) = pick_winner(&tally) {
                        state.phase = GamePhase::Loaded;
                        state.active_game_id = Some(winner.clone());
                        effects.push(FsmEffect::LoadGame { game_id: winner });
                    } else {
                        // No votes — drop back.
                        state.vote_window = None;
                        state.phase = GamePhase::NoGame;
                    }
                }
            }
        }
        _ => {}
    }
    effects
}

fn tally(map: &HashMap<String, String>) -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for v in map.values() {
        *counts.entry(v.clone()).or_insert(0) += 1;
    }
    counts
}

fn pick_winner(tally: &HashMap<String, usize>) -> Option<String> {
    let mut best: Option<(&String, usize)> = None;
    for (k, &v) in tally.iter() {
        best = match best {
            None => Some((k, v)),
            Some((bk, bv)) => {
                if v > bv || (v == bv && k < bk) {
                    Some((k, v))
                } else {
                    Some((bk, bv))
                }
            }
        };
    }
    best.map(|(k, _)| k.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> LocalGameState {
        LocalGameState::new("a".into(), "PK_A".into(), None)
    }

    #[test]
    fn proposing_to_voting_on_majority() {
        let mut s = blank();
        // Swarm of 3. Majority = 2 distinct proposers.
        let e1 = apply_proposal(&mut s, "PK_A".into(), "ctf".into(), 100, 3);
        assert!(e1.is_empty());
        assert_eq!(s.phase, GamePhase::Proposing);
        let e2 = apply_proposal(&mut s, "PK_B".into(), "ctf".into(), 200, 3);
        assert_eq!(s.phase, GamePhase::Voting);
        assert!(matches!(e2.as_slice(), [FsmEffect::AutoVote { game_id }] if game_id == "ctf"));
    }

    #[test]
    fn voting_to_loaded_when_all_vote() {
        let mut s = blank();
        apply_proposal(&mut s, "PK_A".into(), "ctf".into(), 0, 2);
        apply_proposal(&mut s, "PK_B".into(), "ctf".into(), 0, 2);
        assert_eq!(s.phase, GamePhase::Voting);
        let _ = apply_vote(&mut s, "PK_A".into(), "ctf".into(), 1, 2);
        let e = apply_vote(&mut s, "PK_B".into(), "ctf".into(), 2, 2);
        assert_eq!(s.phase, GamePhase::Loaded);
        assert!(matches!(e.as_slice(), [FsmEffect::LoadGame { game_id }] if game_id == "ctf"));
    }

    #[test]
    fn proposal_window_times_out_after_30s_with_no_majority() {
        // Single proposer in a 5-node swarm — majority threshold is 3, so
        // the FSM should stay in Proposing until the window elapses, then
        // fall back to NoGame.
        let mut s = blank();
        let effects = apply_proposal(&mut s, "PK_A".into(), "ctf".into(), 100, 5);
        assert!(effects.is_empty());
        assert_eq!(s.phase, GamePhase::Proposing);

        // Just before the timeout — phase unchanged.
        let _ = on_tick(&mut s, 100 + PROPOSAL_WINDOW_MS - 1, 5);
        assert_eq!(s.phase, GamePhase::Proposing);

        // At exactly the timeout — we drop back to NoGame and clear the
        // window so a fresh proposal can open a new one.
        let effects = on_tick(&mut s, 100 + PROPOSAL_WINDOW_MS, 5);
        assert!(effects.is_empty(), "timeout should not synthesise effects");
        assert_eq!(s.phase, GamePhase::NoGame);
        assert!(s.proposal_window.is_none());
    }

    #[test]
    fn vote_window_times_out_and_loads_majority_winner() {
        // Two-of-three voted; the third never will. At timeout we should
        // still load because a clear majority exists.
        let mut s = blank();
        apply_proposal(&mut s, "PK_A".into(), "ctf".into(), 0, 3);
        apply_proposal(&mut s, "PK_B".into(), "ctf".into(), 100, 3);
        assert_eq!(s.phase, GamePhase::Voting);

        apply_vote(&mut s, "PK_A".into(), "ctf".into(), 200, 3);
        apply_vote(&mut s, "PK_B".into(), "ctf".into(), 300, 3);

        // Phase is still Voting — 2/3 have voted but swarm_size=3 requires 3.
        assert_eq!(s.phase, GamePhase::Voting);

        // Wait out the vote window; majority winner loads regardless.
        let effects = on_tick(&mut s, 300 + VOTE_WINDOW_MS, 3);
        assert_eq!(s.phase, GamePhase::Loaded);
        assert!(
            matches!(effects.as_slice(), [FsmEffect::LoadGame { game_id }] if game_id == "ctf")
        );
    }

    #[test]
    fn vote_window_times_out_to_no_game_with_zero_votes() {
        // Edge case: voting phase opened but nobody actually voted. Window
        // elapses; we drop back to NoGame (not Loaded).
        let mut s = blank();
        apply_proposal(&mut s, "PK_A".into(), "ctf".into(), 0, 2);
        let vote_opened_at = 100;
        apply_proposal(&mut s, "PK_B".into(), "koth".into(), vote_opened_at, 2);
        assert_eq!(s.phase, GamePhase::Voting);

        // Clear votes so the timeout has nothing to tally.
        s.vote_window.as_mut().unwrap().votes.clear();

        // Tick after the vote window's start_at_ms elapses — *not* after
        // the raw window duration (the window opened at `vote_opened_at`,
        // not at t=0).
        let effects = on_tick(&mut s, vote_opened_at + VOTE_WINDOW_MS + 1, 2);
        assert!(effects.is_empty());
        assert_eq!(s.phase, GamePhase::NoGame);
        assert!(s.vote_window.is_none());
    }

    #[test]
    fn on_tick_noop_outside_voting_and_proposing_phases() {
        // Sanity check: FSM tick must not mutate anything once the game is
        // loaded / playing — those phases are driven by other handlers.
        let mut s = blank();
        s.phase = GamePhase::Playing;
        let effects = on_tick(&mut s, 1_000_000, 3);
        assert!(effects.is_empty());
        assert_eq!(s.phase, GamePhase::Playing);
    }
}
