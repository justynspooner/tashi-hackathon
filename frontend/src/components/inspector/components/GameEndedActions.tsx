// Post-game action menu. Visible whenever the swarm is between rounds — the
// just-ended game's `active_game_id` is still set on every snapshot, so we
// keep the menu up through the entire `Ended → Proposing → Voting` arc until
// consensus actually loads the next game (which clears the ended-* metadata
// via `reset_for_new_game` / `reset_for_new_round_keeping_roles`).
//
// Three ways for the swarm to move on from the finished round:
//
//   1. **Replay** — same game, `keep_roles: true`. Each node's claimed
//      `entity_type`/`team` from the prior round carries over; scores /
//      properties / countdown are wiped (see
//      `LocalGameState::reset_for_new_round_keeping_roles` in the Rust side).
//   2. **Change roles** — same game, `keep_roles: false`. Equivalent to a
//      regular new-game proposal on the current game_id — claims are cleared
//      so players re-pick in `placing_entities`.
//   3. **New game** — propose a *different* game via the inline dropdown.
//      `keep_roles: false` (claims wouldn't make sense across game modes
//      anyway).
//
// The consensus tally treats `(game_id, keep_roles)` as the key, so Replay
// and Change-Roles votes do **not** silently merge: if the swarm is split
// 1/1/1 across these three options, the vote aborts to NoGame and players
// start a fresh pick. That's exactly why every node needs to see this menu
// during `Proposing`/`Voting` — without it, only the proposer can express
// `keep_roles: true` and every other node's `vote-game/{id}` defaults to
// `keep_roles: false`, splitting the tally and preventing the swarm from
// converging on Replay.
//
// Phase routing: in `ended` / `proposing` we call `onProposeGame` (registers
// against the proposal window). In `voting` we call `onVoteGame` (registers
// against the vote window — once the FSM has crossed the proposal-majority
// threshold it ignores further proposals).

import { useState } from 'react'
import { RotateCcw, Users, Gamepad2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import type { NodeInfo } from '@/types'
import type { GameConfig, LocalGameSnapshot } from '@/game/types'
import { readProposalWindow, readVoteWindow, type GameChoice } from '@/lib/node-control-helpers'

interface Props {
  node: NodeInfo
  snapshot: LocalGameSnapshot | undefined
  /** The just-ended game's config — resolved from the snapshot's
   *  `active_game_id` (which the FSM intentionally leaves set through
   *  `Ended → Proposing → Voting`). Without it we can't render the
   *  Replay/Change-Roles buttons because they need the game id. */
  activeGame: GameConfig | undefined
  games: GameConfig[]
  onProposeGame: (
    label: string,
    gameId: string,
    opts?: { keepRoles?: boolean },
  ) => Promise<void>
  onVoteGame: (
    label: string,
    gameId: string,
    opts?: { keepRoles?: boolean },
  ) => Promise<void>
}

type PendingAction = 'replay' | 'change' | 'new' | null

export function GameEndedActions({
  node,
  snapshot,
  activeGame,
  games,
  onProposeGame,
  onVoteGame,
}: Props) {
  const [pending, setPending] = useState<PendingAction>(null)
  const [newGameId, setNewGameId] = useState<string>('')

  const phase = snapshot?.phase ?? 'no_game'
  // Visible across the whole post-game arc. Once the FSM transitions back to
  // `Loaded`/`PlacingEntities`/etc, the next round is locked in and this
  // panel disappears (the regular `EntityComponent` runtime view takes over).
  const isPostGamePhase = phase === 'ended' || phase === 'proposing' || phase === 'voting'
  if (!isPostGamePhase) return null
  if (!activeGame) return null

  const isVoting = phase === 'voting'
  const myPeerId = snapshot?.peer_id

  // What this node has already committed to — surfaced as a "you picked X"
  // pill so users can see their own vote landed (and don't reflexively click
  // the same button twice). The proposer's choice during `proposing` lives
  // in `proposal_window.proposers`; once the FSM moves on to `voting`, the
  // proposer's auto-vote and any subsequent votes live in
  // `vote_window.votes`.
  const proposers = readProposalWindow(snapshot)?.proposers ?? {}
  const votes = readVoteWindow(snapshot)?.votes ?? {}
  const committed = isVoting
    ? (myPeerId ? votes[myPeerId] : undefined)
    : (phase === 'proposing' && myPeerId ? proposers[myPeerId] : undefined)

  function describeChoice(choice: GameChoice | undefined): string | null {
    if (!choice) return null
    const game = games.find(g => g.id === choice.game_id)
    const name = game?.name ?? choice.game_id
    if (choice.game_id === activeGame!.id) {
      return choice.keep_roles ? 'Replay' : 'Change roles'
    }
    return name
  }

  const committedLabel = describeChoice(committed)

  const disabled = node.status !== 'running' || pending !== null
  const currentGameName = activeGame.name

  async function run(action: PendingAction, gameId: string, keepRoles: boolean) {
    setPending(action)
    try {
      // Phase-aware dispatch: `apply_proposal` is a no-op once the FSM has
      // moved into `Voting` (and vice-versa for `apply_vote`), so we have to
      // pick the right RPC. Both routes thread `keepRoles` through to the
      // wire payload; without that, the Replay/Change-Roles intent gets
      // dropped and the consensus tally treats the message as a vanilla
      // "new game" pick — splitting the swarm and aborting the round.
      if (isVoting) {
        await onVoteGame(node.label, gameId, { keepRoles })
      } else {
        await onProposeGame(node.label, gameId, { keepRoles })
      }
    } finally {
      setPending(null)
    }
  }

  // New-game options exclude the just-ended game (the Change-Roles button
  // already covers "same game, clear claims" — no point duplicating it in
  // the picker). If the only config on the server happens to be the active
  // one, the picker collapses to an empty list and gets disabled.
  const newGameOptions = games.filter(g => g.id !== activeGame.id)
  const canProposeNewGame = !!newGameId && !disabled

  // Header text reflects where the swarm is in the pick → vote → load arc so
  // a node that joins mid-flight (or one whose proposal already landed)
  // doesn't see a stale "Round over" message during the voting phase.
  const headerText =
    phase === 'ended'
      ? "Round over — pick what's next:"
      : phase === 'proposing'
        ? 'Proposal in flight — pick what you want next:'
        : 'Voting in flight — cast your vote:'
  const actionVerb = isVoting ? 'Vote' : 'Propose'

  return (
    <div className="space-y-2 rounded border border-border/60 p-2">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span>{headerText}</span>
        {committedLabel && (
          <Badge variant="outline" className="ml-auto h-4 px-1 text-[9px] leading-none">
            you: {committedLabel}
          </Badge>
        )}
      </div>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          className="h-7 text-[11px] flex-1 gap-1"
          disabled={disabled}
          onClick={() => run('replay', activeGame.id, true)}
        >
          <RotateCcw className="h-3 w-3" />
          {pending === 'replay' ? '…' : 'Replay'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-7 text-[11px] flex-1 gap-1"
          disabled={disabled}
          onClick={() => run('change', activeGame.id, false)}
          title={`Same game (${currentGameName}), re-pick roles`}
        >
          <Users className="h-3 w-3" />
          {pending === 'change' ? '…' : 'Change roles'}
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Gamepad2 className="h-3 w-3 text-muted-foreground shrink-0" />
        <Select
          value={newGameId}
          onValueChange={v => setNewGameId(v ?? '')}
          disabled={disabled || newGameOptions.length === 0}
        >
          <SelectTrigger size="sm" className="h-7 text-[11px] flex-1 px-2">
            <SelectValue placeholder="new game" />
          </SelectTrigger>
          <SelectContent>
            {newGameOptions.map(g => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          className="h-7 text-[11px] px-2.5"
          disabled={!canProposeNewGame}
          onClick={() => run('new', newGameId, false)}
        >
          {pending === 'new' ? '…' : actionVerb}
        </Button>
      </div>
    </div>
  )
}
