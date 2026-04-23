// Top chrome bar: the persistent header for the whole app. Houses the app
// title, aggregate state indicators (nodes / entities / game phase), the
// Global Actions popover (B5), Clear Artifacts, Event Log toggle, theme
// toggle, and the connection badge.

import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Terminal, Trash2 } from 'lucide-react'

import { ConnectionBadge } from './ConnectionBadge'
import { ModeToggle } from './ModeToggle'
import { GlobalActionsPanel } from './GlobalActionsPanel'

import type { NodeInfo } from '@/types'
import type { GameConfig, GamePhase, LocalGameSnapshot } from '@/game/types'
import { PHASE_LABELS, PHASE_COLORS } from '@/lib/node-control-helpers'

interface Props {
  nodes: NodeInfo[]
  snapshots: Record<string, LocalGameSnapshot>
  games: GameConfig[]
  connected: boolean
  eventLogOpen: boolean
  onToggleEventLog: () => void
  onClearArtifacts: () => void
  onCreateSwarm: (count: number) => Promise<void>
  onDestroySwarm: () => Promise<void>
  onStart: (label: string) => Promise<void>
  onStop: (label: string) => Promise<void>
  onProposeGame: (label: string, gameId: string) => Promise<void>
  onVoteGame: (label: string, gameId: string) => Promise<void>
  onReadyUp: (label: string) => Promise<void>
}

export function TopChrome({
  nodes,
  snapshots,
  games,
  connected,
  eventLogOpen,
  onToggleEventLog,
  onClearArtifacts,
  onCreateSwarm,
  onDestroySwarm,
  onStart,
  onStop,
  onProposeGame,
  onVoteGame,
  onReadyUp,
}: Props) {
  // Aggregate phase: pick the "most advanced" phase visible across snapshots,
  // mirroring the tally logic in NodeControl so the chrome reports a single
  // state at a glance.
  const aggregatePhase = useMemo<GamePhase>(() => {
    const order: GamePhase[] = [
      'ended',
      'playing',
      'counting_down',
      'ready',
      'placing_entities',
      'loaded',
      'voting',
      'proposing',
      'no_game',
    ]
    const phases = new Set(Object.values(snapshots).map(s => s.phase))
    for (const p of order) {
      if (phases.has(p)) return p
    }
    return 'no_game'
  }, [snapshots])

  const entityCount = useMemo(() => {
    const set = new Set<string>()
    for (const snap of Object.values(snapshots)) {
      for (const e of Object.values(snap.entities)) {
        if (e.entity_type) set.add(e.label)
      }
    }
    return set.size
  }, [snapshots])

  const runningCount = nodes.filter(n => n.status === 'running').length

  return (
    <header className="h-12 shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex items-center gap-3 px-4 z-40">
      {/* Title */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="h-6 w-6 rounded bg-primary/10 border border-primary/30 flex items-center justify-center">
          <span className="text-primary font-bold text-[11px]">T</span>
        </div>
        <h1 className="text-sm font-semibold tracking-tight whitespace-nowrap">
          Tashi Vertex Explorer
        </h1>
      </div>

      {/* Aggregate state chips */}
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground ml-2">
        <span
          className={`px-1.5 py-0.5 rounded font-semibold text-[10px] ${PHASE_COLORS[aggregatePhase]}`}
        >
          {PHASE_LABELS[aggregatePhase]}
        </span>
        <span className="tabular-nums">
          {runningCount}/{nodes.length} nodes
        </span>
        {entityCount > 0 && (
          <span className="tabular-nums">· {entityCount} entities</span>
        )}
      </div>

      {/* Right-side actions */}
      <div className="ml-auto flex items-center gap-2">
        <GlobalActionsPanel
          nodes={nodes}
          snapshots={snapshots}
          games={games}
          onCreateSwarm={onCreateSwarm}
          onDestroySwarm={onDestroySwarm}
          onStart={onStart}
          onStop={onStop}
          onProposeGame={onProposeGame}
          onVoteGame={onVoteGame}
          onReadyUp={onReadyUp}
        />

        <Button size="sm" variant="outline" onClick={onClearArtifacts} className="gap-1">
          <Trash2 className="h-3 w-3" />
          Clear Artifacts
        </Button>

        <Button
          size="sm"
          variant={eventLogOpen ? 'default' : 'outline'}
          onClick={onToggleEventLog}
          className="gap-1"
        >
          <Terminal className="h-3 w-3" />
          Event Log
        </Button>

        <ModeToggle />
        <ConnectionBadge connected={connected} />
      </div>
    </header>
  )
}
