// Per-node propose / vote control for the inspector. Renders only during the
// no_game / proposing / voting phases (NodeGameControls takes over once a
// game is loaded). Once this node has committed a pick it displays the
// committed game as a pill with a "change" affordance.
//
// Ported from `NodeControl.tsx` NodeGameSelect (L246–344).

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Gamepad2 } from 'lucide-react'

import type { NodeInfo } from '@/types'
import type { GameConfig, LocalGameSnapshot } from '@/game/types'
import { readProposalWindow, readVoteWindow } from '@/lib/node-control-helpers'

interface Props {
  node: NodeInfo
  snapshot: LocalGameSnapshot | undefined
  games: GameConfig[]
  onProposeGame: (label: string, gameId: string) => Promise<void>
  onVoteGame: (label: string, gameId: string) => Promise<void>
}

export function GameSelectComponent({
  node,
  snapshot,
  games,
  onProposeGame,
  onVoteGame,
}: Props) {
  const [selectedGame, setSelectedGame] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [changing, setChanging] = useState(false)

  const phase = snapshot?.phase ?? 'no_game'
  const myPeerId = snapshot?.peer_id
  const isVoting = phase === 'voting'
  const actionVerb = isVoting ? 'Vote' : 'Propose'

  // Only visible during no_game / proposing / voting.
  if (!['no_game', 'proposing', 'voting'].includes(phase)) return null

  const proposers = readProposalWindow(snapshot)?.proposers ?? {}
  const votes = readVoteWindow(snapshot)?.votes ?? {}
  const committedGameId = isVoting
    ? (myPeerId ? votes[myPeerId] : undefined)
    : (phase === 'proposing' && myPeerId ? proposers[myPeerId] : undefined)
  const committed = games.find(g => g.id === committedGameId)

  const disabled = node.status !== 'running' || games.length === 0

  async function handleSubmit() {
    if (!selectedGame) return
    setSubmitting(true)
    try {
      if (isVoting) {
        await onVoteGame(node.label, selectedGame)
      } else {
        await onProposeGame(node.label, selectedGame)
      }
      setChanging(false)
    } finally {
      setSubmitting(false)
    }
  }

  if (committed && !changing) {
    return (
      <div className="flex items-center gap-1.5 text-[11px]">
        <Gamepad2 className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground">{actionVerb}d</span>
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] leading-tight">
          {committed.name}
        </Badge>
        <button
          type="button"
          className="ml-auto text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          onClick={() => setChanging(true)}
        >
          change
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <Gamepad2 className="h-3 w-3 text-muted-foreground shrink-0" />
      <Select
        value={selectedGame}
        onValueChange={v => setSelectedGame(v ?? '')}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="h-7 text-[11px] flex-1 px-2">
          <SelectValue placeholder="game" />
        </SelectTrigger>
        <SelectContent>
          {games.map(g => (
            <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        className="h-7 text-[11px] px-2.5"
        disabled={disabled || !selectedGame || submitting}
        onClick={handleSubmit}
      >
        {submitting ? '…' : actionVerb}
      </Button>
    </div>
  )
}
