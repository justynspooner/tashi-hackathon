//! Game-selection finite state machine.
//!
//! Drives the `NoGame → Proposing → Voting → Loaded` progression based on
//! consensus events (`GameProposal`, `GameVote`). Lives separately from
//! `rules.rs` because rules are pure-function evaluations; the FSM has its own
//! state (windows, counts) that evolves as events arrive.
//!
//! Majority rule: a specific game is only "locked in" once strictly more than
//! half of the swarm has picked the same game mode. A plurality is not
//! enough. If every peer has weighed in but no single game commands a
//! majority — e.g. seven nodes split 3/2/2 across three modes — the round
//! aborts back to `NoGame` and players have to start a fresh vote.

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

    // Only move on once a *specific* game has crossed the strict majority
    // threshold. Counting distinct proposers would let the FSM commit on a
    // split proposal (e.g. 2/2/2 in a 6-of-7 swarm), which is exactly the
    // behaviour we want to avoid.
    let tally = tally(&window.proposers);
    if let Some(winner) = majority_winner(&tally, swarm_size) {
        state.phase = GamePhase::Voting;
        state.vote_window = Some(VoteWindow {
            started_at_ms: now_ms,
            votes: HashMap::new(),
        });
        state.proposal_window = None;
        effects.push(FsmEffect::AutoVote { game_id: winner });
        return effects;
    }

    // Every peer has proposed but no game commands a majority — a split
    // proposal. Abort immediately rather than waiting out the 30s window.
    if window.proposers.len() >= swarm_size {
        state.proposal_window = None;
        state.phase = GamePhase::NoGame;
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

    let tally = tally(&window.votes);

    // Lock in as soon as a specific game clears the strict majority
    // threshold. No need to wait for stragglers once the outcome is
    // mathematically decided.
    if let Some(winner) = majority_winner(&tally, swarm_size) {
        state.phase = GamePhase::Loaded;
        state.active_game_id = Some(winner.clone());
        effects.push(FsmEffect::LoadGame { game_id: winner });
        return effects;
    }

    // All peers have voted but no game commands a majority — split vote.
    // End the round and drop back to NoGame; the players have to start
    // over.
    if window.votes.len() >= swarm_size {
        state.vote_window = None;
        state.phase = GamePhase::NoGame;
    }

    effects
}

/// Called on 1 Hz tick to detect window timeouts.
pub fn on_tick(state: &mut LocalGameState, now_ms: u64, swarm_size: usize) -> Vec<FsmEffect> {
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
                    if let Some(winner) = majority_winner(&tally, swarm_size) {
                        // A specific game had majority at timeout — lock
                        // it in even though stragglers never weighed in.
                        state.phase = GamePhase::Loaded;
                        state.active_game_id = Some(winner.clone());
                        effects.push(FsmEffect::LoadGame { game_id: winner });
                    } else {
                        // Split vote (or silent window) — drop back so
                        // players can start a fresh round.
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

/// Return the game id that has strictly more than half of the swarm
/// behind it, if any. Plurality is not enough — ties and split votes
/// return `None`. Only one game can ever clear the threshold at a time,
/// so no tie-breaking is required.
fn majority_winner(tally: &HashMap<String, usize>, swarm_size: usize) -> Option<String> {
    let threshold = swarm_size / 2 + 1;
    tally
        .iter()
        .find(|(_, &count)| count >= threshold)
        .map(|(k, _)| k.clone())
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
    fn vote_window_times_out_to_no_game_without_majority() {
        // Five-node swarm. A proposal majority (3/5 for ctf) opens the
        // vote window, but the actual vote splits: two ctf, one koth,
        // and two nodes never weigh in. At timeout there is a plurality
        // but no strict majority (threshold = 3), so the round aborts
        // to NoGame rather than silently loading the plurality winner.
        let mut s = blank();
        let swarm = 5;
        apply_proposal(&mut s, "PK_A".into(), "ctf".into(), 0, swarm);
        apply_proposal(&mut s, "PK_B".into(), "ctf".into(), 0, swarm);
        let vote_opened_at = 100;
        apply_proposal(&mut s, "PK_C".into(), "ctf".into(), vote_opened_at, swarm);
        assert_eq!(s.phase, GamePhase::Voting);

        apply_vote(&mut s, "PK_A".into(), "ctf".into(), 200, swarm);
        apply_vote(&mut s, "PK_B".into(), "ctf".into(), 300, swarm);
        apply_vote(&mut s, "PK_C".into(), "koth".into(), 400, swarm);
        assert_eq!(s.phase, GamePhase::Voting);

        let effects = on_tick(&mut s, vote_opened_at + VOTE_WINDOW_MS, swarm);
        assert!(effects.is_empty());
        assert_eq!(s.phase, GamePhase::NoGame);
        assert!(s.vote_window.is_none());
    }

    #[test]
    fn vote_window_times_out_to_no_game_with_zero_votes() {
        // Edge case: voting phase opened (both nodes agreed on ctf at
        // proposal time) but nobody ever followed through with the
        // actual vote. Window elapses; we drop back to NoGame.
        let mut s = blank();
        apply_proposal(&mut s, "PK_A".into(), "ctf".into(), 0, 2);
        let vote_opened_at = 100;
        apply_proposal(&mut s, "PK_B".into(), "ctf".into(), vote_opened_at, 2);
        assert_eq!(s.phase, GamePhase::Voting);

        // The FSM itself does not record votes in response to proposals;
        // it's the caller's job to feed the resulting GameVote messages
        // back through `apply_vote`. Here we simulate the case where
        // nobody ever does.
        assert!(s.vote_window.as_ref().unwrap().votes.is_empty());

        // Tick after the vote window's start_at_ms elapses — *not* after
        // the raw window duration (the window opened at `vote_opened_at`,
        // not at t=0).
        let effects = on_tick(&mut s, vote_opened_at + VOTE_WINDOW_MS + 1, 2);
        assert!(effects.is_empty());
        assert_eq!(s.phase, GamePhase::NoGame);
        assert!(s.vote_window.is_none());
    }

    #[test]
    fn seven_node_split_proposal_aborts_on_final_proposal() {
        // Seven nodes, three game modes. Six are split evenly (2/2/2);
        // the seventh's proposal tips `ctf` to 3 — a plurality but
        // still short of the strict-majority threshold (4). This is the
        // exact scenario from the spec: the round must abort back to
        // NoGame, not silently commit to the plurality winner.
        let mut s = blank();
        let swarm = 7;
        apply_proposal(&mut s, "PK_A".into(), "ctf".into(), 0, swarm);
        apply_proposal(&mut s, "PK_B".into(), "ctf".into(), 0, swarm);
        apply_proposal(&mut s, "PK_C".into(), "koth".into(), 0, swarm);
        apply_proposal(&mut s, "PK_D".into(), "koth".into(), 0, swarm);
        apply_proposal(&mut s, "PK_E".into(), "territory".into(), 0, swarm);
        apply_proposal(&mut s, "PK_F".into(), "territory".into(), 0, swarm);
        assert_eq!(s.phase, GamePhase::Proposing);

        let effects = apply_proposal(&mut s, "PK_G".into(), "ctf".into(), 100, swarm);
        assert!(effects.is_empty());
        assert_eq!(s.phase, GamePhase::NoGame);
        assert!(s.proposal_window.is_none());
    }

    #[test]
    fn seven_node_proposal_majority_transitions_to_voting() {
        // Four of seven nodes converge on `ctf` — that crosses the
        // strict-majority threshold (4), so the FSM should transition
        // to Voting on the fourth matching proposal even though three
        // nodes disagreed.
        let mut s = blank();
        let swarm = 7;
        apply_proposal(&mut s, "PK_A".into(), "ctf".into(), 0, swarm);
        apply_proposal(&mut s, "PK_B".into(), "koth".into(), 0, swarm);
        apply_proposal(&mut s, "PK_C".into(), "ctf".into(), 0, swarm);
        apply_proposal(&mut s, "PK_D".into(), "territory".into(), 0, swarm);
        apply_proposal(&mut s, "PK_E".into(), "ctf".into(), 0, swarm);
        assert_eq!(s.phase, GamePhase::Proposing);

        let effects = apply_proposal(&mut s, "PK_F".into(), "ctf".into(), 100, swarm);
        assert_eq!(s.phase, GamePhase::Voting);
        assert!(
            matches!(effects.as_slice(), [FsmEffect::AutoVote { game_id }] if game_id == "ctf")
        );
    }

    #[test]
    fn split_vote_aborts_on_final_vote() {
        // Three-node swarm. Proposal phase agrees on ctf (so we're in
        // Voting), but the actual vote ends up split 1/1/1 across three
        // different games. Once the last vote is in and no game has
        // majority, the round aborts immediately — no need to wait for
        // the timeout.
        let mut s = blank();
        let swarm = 3;
        apply_proposal(&mut s, "PK_A".into(), "ctf".into(), 0, swarm);
        apply_proposal(&mut s, "PK_B".into(), "ctf".into(), 0, swarm);
        assert_eq!(s.phase, GamePhase::Voting);

        apply_vote(&mut s, "PK_A".into(), "ctf".into(), 100, swarm);
        apply_vote(&mut s, "PK_B".into(), "koth".into(), 200, swarm);
        assert_eq!(s.phase, GamePhase::Voting);

        let effects = apply_vote(&mut s, "PK_C".into(), "territory".into(), 300, swarm);
        assert!(effects.is_empty());
        assert_eq!(s.phase, GamePhase::NoGame);
        assert!(s.vote_window.is_none());
    }

    #[test]
    fn split_proposal_in_two_node_swarm_aborts_immediately() {
        // Two-node swarm proposing different games. Since each proposal
        // is worth half the swarm, neither game can ever reach strict
        // majority — we detect the split as soon as the second proposal
        // arrives and drop back to NoGame.
        let mut s = blank();
        apply_proposal(&mut s, "PK_A".into(), "ctf".into(), 0, 2);
        assert_eq!(s.phase, GamePhase::Proposing);

        let effects = apply_proposal(&mut s, "PK_B".into(), "koth".into(), 100, 2);
        assert!(effects.is_empty());
        assert_eq!(s.phase, GamePhase::NoGame);
        assert!(s.proposal_window.is_none());
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
