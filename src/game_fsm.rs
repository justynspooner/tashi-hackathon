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

use crate::game_state::{GameChoice, GamePhase, LocalGameState, ProposalWindow, VoteWindow};

/// Window durations (milliseconds).
pub const PROPOSAL_WINDOW_MS: u64 = 30_000;
pub const VOTE_WINDOW_MS: u64 = 30_000;

/// Effect the FSM wants the caller to apply.
#[derive(Debug, Clone)]
pub enum FsmEffect {
    /// The local node should auto-broadcast its own vote for `choice`.
    AutoVote { choice: GameChoice },
    /// Game is loaded — caller should set active_game_id and transition to
    /// PlacingEntities. `keep_roles` tells the caller whether the lineup from
    /// the prior round was preserved (true → skip the claim step in the UI)
    /// or wiped (false → normal placing_entities flow).
    LoadGame { choice: GameChoice },
}

/// Apply a new `GameProposal` from `proposer_peer_id`.
pub fn apply_proposal(
    state: &mut LocalGameState,
    proposer_peer_id: String,
    choice: GameChoice,
    now_ms: u64,
    swarm_size: usize,
) -> Vec<FsmEffect> {
    let mut effects = Vec::new();
    // A round in-flight — loaded / placing / playing — swallows new proposals.
    // `Ended`, by contrast, is terminal for the *previous* round: allow a new
    // proposal to open a fresh round from there, same as from `NoGame`. The
    // stale game-instance state is wiped when the FSM eventually transitions
    // into `Loaded` (see `reset_for_new_game`).
    if matches!(state.phase, GamePhase::Loaded | GamePhase::PlacingEntities | GamePhase::Ready | GamePhase::CountingDown | GamePhase::Playing) {
        return effects;
    }
    if matches!(state.phase, GamePhase::NoGame | GamePhase::Ended) {
        state.phase = GamePhase::Proposing;
    }
    let window = state
        .proposal_window
        .get_or_insert(ProposalWindow { started_at_ms: now_ms, proposers: HashMap::new() });
    window.proposers.insert(proposer_peer_id, choice);

    // Only move on once a *specific* choice has crossed the strict majority
    // threshold. Counting distinct proposers would let the FSM commit on a
    // split proposal (e.g. 2/2/2 in a 6-of-7 swarm), which is exactly the
    // behaviour we want to avoid. `(game_id, keep_roles)` is the consensus
    // key so "Replay freeze_tag" and "Change roles in freeze_tag" tally
    // independently — a 2/2 split between those two intents aborts rather
    // than silently picking one.
    let tally = tally(&window.proposers);
    if let Some(winner) = majority_winner(&tally, swarm_size) {
        state.phase = GamePhase::Voting;
        state.vote_window = Some(VoteWindow {
            started_at_ms: now_ms,
            votes: HashMap::new(),
        });
        state.proposal_window = None;
        effects.push(FsmEffect::AutoVote { choice: winner });
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
    choice: GameChoice,
    _now_ms: u64,
    swarm_size: usize,
) -> Vec<FsmEffect> {
    let mut effects = Vec::new();
    if state.phase != GamePhase::Voting {
        return effects;
    }
    let window = state.vote_window.get_or_insert_with(Default::default);
    window.votes.insert(voter_peer_id, choice);

    let tally = tally(&window.votes);

    // Lock in as soon as a specific choice clears the strict majority
    // threshold. No need to wait for stragglers once the outcome is
    // mathematically decided.
    if let Some(winner) = majority_winner(&tally, swarm_size) {
        lock_in(state, winner.clone());
        effects.push(FsmEffect::LoadGame { choice: winner });
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
                        // A specific choice had majority at timeout — lock
                        // it in even though stragglers never weighed in.
                        lock_in(state, winner.clone());
                        effects.push(FsmEffect::LoadGame { choice: winner });
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

/// Commit the winning `choice`: run the right state-reset variant (keep-roles
/// or full wipe) and advance the FSM to `Loaded` with the new game_id.
fn lock_in(state: &mut LocalGameState, choice: GameChoice) {
    if choice.keep_roles {
        state.reset_for_new_round_keeping_roles();
    } else {
        state.reset_for_new_game();
    }
    state.phase = GamePhase::Loaded;
    state.active_game_id = Some(choice.game_id);
}

fn tally(map: &HashMap<String, GameChoice>) -> HashMap<GameChoice, usize> {
    let mut counts: HashMap<GameChoice, usize> = HashMap::new();
    for v in map.values() {
        *counts.entry(v.clone()).or_insert(0) += 1;
    }
    counts
}

/// Return the choice that has strictly more than half of the swarm behind
/// it, if any. Plurality is not enough — ties and split votes return `None`.
/// Only one choice can ever clear the threshold at a time, so no
/// tie-breaking is required.
fn majority_winner(tally: &HashMap<GameChoice, usize>, swarm_size: usize) -> Option<GameChoice> {
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

    /// Test shorthand — the overwhelming majority of FSM tests just care
    /// about the game_id and want the "clear claims" reset path, so
    /// wrapping `GameChoice::new_game` keeps the existing assertions
    /// readable.
    fn ng(game_id: &str) -> GameChoice {
        GameChoice::new_game(game_id)
    }

    #[test]
    fn proposing_to_voting_on_majority() {
        let mut s = blank();
        // Swarm of 3. Majority = 2 distinct proposers.
        let e1 = apply_proposal(&mut s, "PK_A".into(), ng("ctf"), 100, 3);
        assert!(e1.is_empty());
        assert_eq!(s.phase, GamePhase::Proposing);
        let e2 = apply_proposal(&mut s, "PK_B".into(), ng("ctf"), 200, 3);
        assert_eq!(s.phase, GamePhase::Voting);
        assert!(
            matches!(e2.as_slice(), [FsmEffect::AutoVote { choice }] if choice.game_id == "ctf")
        );
    }

    #[test]
    fn voting_to_loaded_when_all_vote() {
        let mut s = blank();
        apply_proposal(&mut s, "PK_A".into(), ng("ctf"), 0, 2);
        apply_proposal(&mut s, "PK_B".into(), ng("ctf"), 0, 2);
        assert_eq!(s.phase, GamePhase::Voting);
        let _ = apply_vote(&mut s, "PK_A".into(), ng("ctf"), 1, 2);
        let e = apply_vote(&mut s, "PK_B".into(), ng("ctf"), 2, 2);
        assert_eq!(s.phase, GamePhase::Loaded);
        assert!(
            matches!(e.as_slice(), [FsmEffect::LoadGame { choice }] if choice.game_id == "ctf" && !choice.keep_roles)
        );
    }

    #[test]
    fn proposal_window_times_out_after_30s_with_no_majority() {
        // Single proposer in a 5-node swarm — majority threshold is 3, so
        // the FSM should stay in Proposing until the window elapses, then
        // fall back to NoGame.
        let mut s = blank();
        let effects = apply_proposal(&mut s, "PK_A".into(), ng("ctf"), 100, 5);
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
        apply_proposal(&mut s, "PK_A".into(), ng("ctf"), 0, swarm);
        apply_proposal(&mut s, "PK_B".into(), ng("ctf"), 0, swarm);
        let vote_opened_at = 100;
        apply_proposal(&mut s, "PK_C".into(), ng("ctf"), vote_opened_at, swarm);
        assert_eq!(s.phase, GamePhase::Voting);

        apply_vote(&mut s, "PK_A".into(), ng("ctf"), 200, swarm);
        apply_vote(&mut s, "PK_B".into(), ng("ctf"), 300, swarm);
        apply_vote(&mut s, "PK_C".into(), ng("koth"), 400, swarm);
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
        apply_proposal(&mut s, "PK_A".into(), ng("ctf"), 0, 2);
        let vote_opened_at = 100;
        apply_proposal(&mut s, "PK_B".into(), ng("ctf"), vote_opened_at, 2);
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
        apply_proposal(&mut s, "PK_A".into(), ng("ctf"), 0, swarm);
        apply_proposal(&mut s, "PK_B".into(), ng("ctf"), 0, swarm);
        apply_proposal(&mut s, "PK_C".into(), ng("koth"), 0, swarm);
        apply_proposal(&mut s, "PK_D".into(), ng("koth"), 0, swarm);
        apply_proposal(&mut s, "PK_E".into(), ng("territory"), 0, swarm);
        apply_proposal(&mut s, "PK_F".into(), ng("territory"), 0, swarm);
        assert_eq!(s.phase, GamePhase::Proposing);

        let effects = apply_proposal(&mut s, "PK_G".into(), ng("ctf"), 100, swarm);
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
        apply_proposal(&mut s, "PK_A".into(), ng("ctf"), 0, swarm);
        apply_proposal(&mut s, "PK_B".into(), ng("koth"), 0, swarm);
        apply_proposal(&mut s, "PK_C".into(), ng("ctf"), 0, swarm);
        apply_proposal(&mut s, "PK_D".into(), ng("territory"), 0, swarm);
        apply_proposal(&mut s, "PK_E".into(), ng("ctf"), 0, swarm);
        assert_eq!(s.phase, GamePhase::Proposing);

        let effects = apply_proposal(&mut s, "PK_F".into(), ng("ctf"), 100, swarm);
        assert_eq!(s.phase, GamePhase::Voting);
        assert!(
            matches!(effects.as_slice(), [FsmEffect::AutoVote { choice }] if choice.game_id == "ctf")
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
        apply_proposal(&mut s, "PK_A".into(), ng("ctf"), 0, swarm);
        apply_proposal(&mut s, "PK_B".into(), ng("ctf"), 0, swarm);
        assert_eq!(s.phase, GamePhase::Voting);

        apply_vote(&mut s, "PK_A".into(), ng("ctf"), 100, swarm);
        apply_vote(&mut s, "PK_B".into(), ng("koth"), 200, swarm);
        assert_eq!(s.phase, GamePhase::Voting);

        let effects = apply_vote(&mut s, "PK_C".into(), ng("territory"), 300, swarm);
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
        apply_proposal(&mut s, "PK_A".into(), ng("ctf"), 0, 2);
        assert_eq!(s.phase, GamePhase::Proposing);

        let effects = apply_proposal(&mut s, "PK_B".into(), ng("koth"), 100, 2);
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

    #[test]
    fn load_game_wipes_prior_rounds_instance_state() {
        // After a round ends, the next LoadGame must clear the stale
        // countdown anchor, ready set, scores, and ended-game metadata.
        // Otherwise `game_time_elapsed_s` fires on the new round as soon
        // as rules tick, because `countdown_zero_ns + 600s` is in the past.
        let mut s = blank();
        s.phase = GamePhase::Ended;
        s.countdown_zero_ns = Some(1_000_000_000);
        s.ready_peers = vec!["PK_A".into(), "PK_B".into()];
        s.scores.insert("red".into(), 42);
        s.ended_winner_team = Some("red".into());
        s.ended_reason = Some("10-minute time limit reached".into());
        s.placement_ok = true;
        if let Some(e) = s.entities.get_mut("a") {
            e.entity_type = Some("flag".into());
            e.team = Some("red".into());
            e.properties.insert("holding_team".into(), serde_json::json!("red"));
        }

        // A proposal from Ended should open a fresh round...
        apply_proposal(&mut s, "PK_A".into(), ng("ctf"), 0, 2);
        apply_proposal(&mut s, "PK_B".into(), ng("ctf"), 0, 2);
        assert_eq!(s.phase, GamePhase::Voting);

        // ...and the vote that locks it in must wipe prior state.
        apply_vote(&mut s, "PK_A".into(), ng("ctf"), 100, 2);
        let effects = apply_vote(&mut s, "PK_B".into(), ng("ctf"), 200, 2);
        assert_eq!(s.phase, GamePhase::Loaded);
        assert!(
            matches!(effects.as_slice(), [FsmEffect::LoadGame { choice }] if choice.game_id == "ctf" && !choice.keep_roles)
        );
        assert_eq!(s.countdown_zero_ns, None);
        assert!(s.ready_peers.is_empty());
        assert!(s.scores.is_empty());
        assert_eq!(s.ended_winner_team, None);
        assert_eq!(s.ended_reason, None);
        assert!(!s.placement_ok);
        let e = s.entities.get("a").unwrap();
        assert_eq!(e.entity_type, None);
        assert_eq!(e.team, None);
        assert!(e.properties.is_empty());
    }

    #[test]
    fn proposal_from_ended_phase_starts_a_new_round() {
        // Previously, `apply_proposal` bailed out of Ended, which left the
        // swarm stuck on the prior game's banner until the processes were
        // restarted. Proposals from Ended now start a fresh Proposing window.
        let mut s = blank();
        s.phase = GamePhase::Ended;
        s.ended_reason = Some("10-minute time limit reached".into());
        let effects = apply_proposal(&mut s, "PK_A".into(), ng("ctf"), 0, 3);
        assert!(effects.is_empty());
        assert_eq!(s.phase, GamePhase::Proposing);
    }

    // --- Replay (keep-roles) flow ----------------------------------------

    fn replay(game_id: &str) -> GameChoice {
        GameChoice { game_id: game_id.into(), keep_roles: true }
    }

    #[test]
    fn replay_vote_preserves_entity_claims_but_clears_round_state() {
        // Two-node swarm finishes a freeze_tag round. Both nodes pick
        // "Replay with existing roles". Post-vote, the roles must still
        // be claimed (no re-pick required), but scores / properties /
        // countdown / ready-ups must be wiped so the next round starts
        // clean.
        let mut s = blank();
        s.phase = GamePhase::Ended;
        s.active_game_id = Some("freeze_tag".into());
        s.countdown_zero_ns = Some(1_000_000_000);
        s.ready_peers = vec!["PK_A".into(), "PK_B".into()];
        s.scores.insert("freezers".into(), 3);
        s.ended_winner_team = Some("freezers".into());
        s.ended_reason = Some("All runners frozen simultaneously".into());
        s.placement_ok = true;
        if let Some(e) = s.entities.get_mut("a") {
            e.entity_type = Some("freezer".into());
            e.team = Some("freezers".into());
            e.properties
                .insert("frozen_since_ms".into(), serde_json::json!(1234u64));
        }

        apply_proposal(&mut s, "PK_A".into(), replay("freeze_tag"), 0, 2);
        apply_proposal(&mut s, "PK_B".into(), replay("freeze_tag"), 0, 2);
        assert_eq!(s.phase, GamePhase::Voting);
        apply_vote(&mut s, "PK_A".into(), replay("freeze_tag"), 100, 2);
        let effects = apply_vote(&mut s, "PK_B".into(), replay("freeze_tag"), 200, 2);

        assert_eq!(s.phase, GamePhase::Loaded);
        assert!(
            matches!(effects.as_slice(), [FsmEffect::LoadGame { choice }] if choice.keep_roles)
        );
        // Round state wiped.
        assert_eq!(s.countdown_zero_ns, None);
        assert!(s.ready_peers.is_empty());
        assert!(s.scores.is_empty());
        assert_eq!(s.ended_winner_team, None);
        assert_eq!(s.ended_reason, None);
        assert!(!s.placement_ok);
        // Claims preserved — the whole point of keep_roles.
        let e = s.entities.get("a").unwrap();
        assert_eq!(e.entity_type.as_deref(), Some("freezer"));
        assert_eq!(e.team.as_deref(), Some("freezers"));
        // But the per-entity properties are gone (they're round-local state,
        // not identity — e.g. freeze_tag's frozen_since_ms timestamp).
        assert!(e.properties.is_empty(), "properties should be cleared: {:?}", e.properties);
    }

    #[test]
    fn split_replay_vs_change_roles_aborts_on_final_vote() {
        // Three-node swarm with each node picking a different post-game
        // option: Replay (keep_roles=true), Change-Roles (keep_roles=false,
        // same game_id), and New-Game (different game_id). Since (game_id,
        // keep_roles) is the consensus key, the three votes tally as three
        // separate choices, none hits the 2-vote majority, and the round
        // aborts to NoGame — this is exactly what was promised in the UI
        // design: Replay and Change-Roles don't silently merge.
        let mut s = blank();
        let swarm = 3;
        apply_proposal(&mut s, "PK_A".into(), replay("freeze_tag"), 0, swarm);
        apply_proposal(&mut s, "PK_B".into(), replay("freeze_tag"), 0, swarm);
        assert_eq!(s.phase, GamePhase::Voting);

        apply_vote(&mut s, "PK_A".into(), replay("freeze_tag"), 10, swarm);
        apply_vote(&mut s, "PK_B".into(), ng("freeze_tag"), 20, swarm);
        let effects = apply_vote(&mut s, "PK_C".into(), ng("ctf"), 30, swarm);
        assert!(effects.is_empty());
        assert_eq!(s.phase, GamePhase::NoGame);
        assert!(s.vote_window.is_none());
    }
}
