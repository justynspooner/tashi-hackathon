import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { NodeInfo } from '../types'
import type { GameConfig, LocalGameSnapshot } from '../game/types'

interface Props {
  nodes: NodeInfo[]
  snapshots: Record<string, LocalGameSnapshot>
  games: GameConfig[]
  onPropose: (label: string, gameId: string) => void | Promise<void>
  onVote: (label: string, gameId: string) => void | Promise<void>
}

type Phase = 'no_game' | 'proposing' | 'voting' | 'loaded' | 'other'

function aggregatedPhase(snapshots: Record<string, LocalGameSnapshot>): Phase {
  // If any snapshot says "loaded/placing/ready/playing" that trumps proposing/voting.
  const phases = Object.values(snapshots).map(s => s.phase)
  if (phases.some(p => ['playing', 'counting_down', 'ready', 'placing_entities', 'loaded'].includes(p))) {
    return 'loaded'
  }
  if (phases.some(p => p === 'voting')) return 'voting'
  if (phases.some(p => p === 'proposing')) return 'proposing'
  if (phases.every(p => p === 'no_game' || !p)) return 'no_game'
  return 'other'
}

function tallyProposals(snapshots: Record<string, LocalGameSnapshot>): Record<string, number> {
  const tally: Record<string, number> = {}
  for (const snap of Object.values(snapshots)) {
    const proposers: Record<string, string> | undefined = (snap.proposal_window as { proposers?: Record<string, string> } | undefined)?.proposers
    if (!proposers) continue
    for (const gid of Object.values(proposers)) {
      tally[gid] = (tally[gid] || 0) + 1
    }
    // Only count one snapshot's view — they should all converge via consensus.
    break
  }
  return tally
}

function tallyVotes(snapshots: Record<string, LocalGameSnapshot>): Record<string, number> {
  const tally: Record<string, number> = {}
  for (const snap of Object.values(snapshots)) {
    const votes: Record<string, string> | undefined = (snap.vote_window as { votes?: Record<string, string> } | undefined)?.votes
    if (!votes) continue
    for (const gid of Object.values(votes)) {
      tally[gid] = (tally[gid] || 0) + 1
    }
    break
  }
  return tally
}

/** When did the current window start? (Any snapshot's view will do.) */
function windowStartedAt(snapshots: Record<string, LocalGameSnapshot>, which: 'proposal_window' | 'vote_window'): number | null {
  for (const snap of Object.values(snapshots)) {
    const win = snap[which] as { started_at_ms?: number } | null | undefined
    if (win?.started_at_ms) return win.started_at_ms
  }
  return null
}

export function GameSelectOverlay({ nodes, snapshots, games, onPropose, onVote }: Props) {
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null)

  const runningNodes = useMemo(() => nodes.filter(n => n.status === 'running'), [nodes])
  const defaultLabel = runningNodes[0]?.label ?? nodes[0]?.label ?? null
  const activeLabel = selectedLabel ?? defaultLabel

  const phase = aggregatedPhase(snapshots)

  const proposalTally = useMemo(() => tallyProposals(snapshots), [snapshots])
  const voteTally = useMemo(() => tallyVotes(snapshots), [snapshots])

  const proposalStart = useMemo(() => windowStartedAt(snapshots, 'proposal_window'), [snapshots])
  const voteStart = useMemo(() => windowStartedAt(snapshots, 'vote_window'), [snapshots])

  // Live countdown via a simple 1s re-render using Date.now().
  const [tick, setTick] = useState(0)
  useMemoTickEffect(setTick)

  const proposalRemaining = useCountdown(proposalStart, 30000, tick)
  const voteRemaining = useCountdown(voteStart, 30000, tick)

  // If a game has been loaded, hide overlay contents (GameView shows entity visuals).
  if (phase === 'loaded') return null
  if (nodes.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            Game Selection
            <Badge variant="outline">{labelPhase(phase)}</Badge>
          </CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>As:</span>
            <Select
              value={activeLabel ?? undefined}
              onValueChange={v => setSelectedLabel(v)}
            >
              <SelectTrigger className="h-7 w-32 text-xs">
                <SelectValue placeholder="node…" />
              </SelectTrigger>
              <SelectContent>
                {nodes.map(n => (
                  <SelectItem key={n.label} value={n.label} disabled={n.status !== 'running'}>
                    {n.label}
                    {n.status !== 'running' ? ' (stopped)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {phase === 'no_game' && (
          <div>
            <p className="text-sm text-muted-foreground mb-2">
              Propose a game to load on all nodes. When a majority propose, voting opens.
            </p>
            <div className="flex flex-wrap gap-2">
              {games.length === 0 && (
                <div className="text-sm text-muted-foreground">No games available.</div>
              )}
              {games.map(g => (
                <Button
                  key={g.id}
                  size="sm"
                  disabled={!activeLabel}
                  onClick={() => activeLabel && onPropose(activeLabel, g.id)}
                >
                  Propose: {g.name}
                </Button>
              ))}
            </div>
          </div>
        )}

        {phase === 'proposing' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Proposal window — {proposalRemaining == null ? 'timed' : `${Math.ceil(proposalRemaining / 1000)}s`} left
              </p>
            </div>
            <TallyBars tally={proposalTally} games={games} total={nodes.length} />
            <div className="flex flex-wrap gap-2 pt-1">
              {games.map(g => (
                <Button
                  key={g.id}
                  size="sm"
                  variant="outline"
                  disabled={!activeLabel}
                  onClick={() => activeLabel && onPropose(activeLabel, g.id)}
                >
                  Propose: {g.name}
                </Button>
              ))}
            </div>
          </div>
        )}

        {phase === 'voting' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Voting — {voteRemaining == null ? 'timed' : `${Math.ceil(voteRemaining / 1000)}s`} left
              </p>
            </div>
            <TallyBars tally={voteTally} games={games} total={nodes.length} />
            <div className="flex flex-wrap gap-2 pt-1">
              {games.map(g => (
                <Button
                  key={g.id}
                  size="sm"
                  variant="secondary"
                  disabled={!activeLabel}
                  onClick={() => activeLabel && onVote(activeLabel, g.id)}
                >
                  Vote: {g.name}
                </Button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function labelPhase(phase: Phase): string {
  switch (phase) {
    case 'no_game':
      return 'no game'
    case 'proposing':
      return 'proposing (30s)'
    case 'voting':
      return 'voting (30s)'
    case 'loaded':
      return 'game loaded'
    default:
      return 'ready'
  }
}

function TallyBars({
  tally,
  games,
  total,
}: {
  tally: Record<string, number>
  games: GameConfig[]
  total: number
}) {
  const max = Math.max(1, total)
  return (
    <div className="space-y-1.5">
      {games.map(g => {
        const count = tally[g.id] ?? 0
        const pct = Math.round((count / max) * 100)
        return (
          <div key={g.id} className="flex items-center gap-3 text-sm">
            <div className="w-32 truncate">{g.name}</div>
            <div className="flex-1 h-2 bg-muted rounded overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="w-10 text-right text-xs text-muted-foreground">{count}/{total}</div>
          </div>
        )
      })}
    </div>
  )
}

// Tiny helpers (inline to avoid a whole hook file for one-liners).

import { useEffect } from 'react'

function useMemoTickEffect(setTick: (n: (x: number) => number) => void) {
  useEffect(() => {
    const id = setInterval(() => setTick(x => x + 1), 1000)
    return () => clearInterval(id)
  }, [setTick])
}

function useCountdown(startedAtMs: number | null, windowMs: number, _tick: number): number | null {
  if (!startedAtMs) return null
  const elapsed = Date.now() - startedAtMs
  return Math.max(0, windowMs - elapsed)
}
