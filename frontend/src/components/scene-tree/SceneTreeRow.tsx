// Single row in the scene tree. Per A4/A5 the node+entity are a unified
// element: one row renders the node's status AND its attached entity
// component (when it has one).
//
// Layout:
//   [team-bar 3px][status-dot][label][entity-badge?][decay-badge?][phase-badge?]

import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import type { NodeInfo } from '@/types'
import type { EntityRecord, GameConfig, GamePhase, LocalGameSnapshot } from '@/game/types'
import {
  PHASE_COLORS,
  PHASE_LABELS,
  decayRemainingMs,
  entityGlyph,
  extractDecayRules,
} from '@/lib/node-control-helpers'
import { teamColor } from '@/game/presentation'
import { cn } from '@/lib/utils'

interface Props {
  node: NodeInfo
  snapshot: LocalGameSnapshot | undefined
  entity: EntityRecord | undefined
  selected: boolean
  onClick: () => void
  /** Active game config — needed to discover decay rules (e.g. freeze_tag's
   *  30s `frozen_since_ms` window) so the row can render a per-entity
   *  countdown chip without hard-coding game-specific property keys. */
  activeGame?: GameConfig
}

export function SceneTreeRow({ node, snapshot, entity, selected, onClick, activeGame }: Props) {
  const phase: GamePhase = snapshot?.phase ?? 'no_game'
  const isRunning = node.status === 'running'
  const team = entity?.team ?? null
  const entityType = entity?.entity_type ?? null
  const showPhase = isRunning && phase !== 'no_game'
  const teamBar = team ? teamColor(team) : 'transparent'

  // Re-render at ~4Hz while a decay timer *might* be active so the countdown
  // chip ticks down smoothly between snapshot arrivals (snapshots only land
  // every ~1s — without this, the chip would freeze and only update on the
  // next tick, making the timer feel laggy). The "might be active" check is
  // a pure property-presence test so it's safe to read during render; the
  // actual remaining-ms calculation against Date.now() happens below with
  // the standard 4Hz-tick disable comment.
  const decayRules = extractDecayRules(activeGame).filter(d => d.targetEntityType === entityType)
  const hasAnyDecayProperty = decayRules.some(
    d => entity?.properties?.[d.propertyKey] != null,
  )
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!hasAnyDecayProperty) return
    const id = window.setInterval(() => setTick(t => t + 1), 250)
    return () => window.clearInterval(id)
  }, [hasAnyDecayProperty])

  // eslint-disable-next-line react-hooks/purity -- 4Hz tick drives re-render (see comment above)
  const now = Date.now()
  const decayChip = (() => {
    for (const d of decayRules) {
      const remainingMs = decayRemainingMs(entity, d, now)
      if (remainingMs == null) continue
      return { label: d.label, remainingS: remainingMs / 1000 }
    }
    return null
  })()

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[12px] transition-colors',
        selected
          ? 'bg-primary/15 text-foreground ring-1 ring-primary/40'
          : 'hover:bg-muted/60 text-foreground/90',
      )}
    >
      {/* Team colour bar (left edge) */}
      <span
        className="h-4 w-[3px] rounded-sm shrink-0"
        style={{ backgroundColor: teamBar }}
        aria-hidden
      />

      {/* Running/stopped status dot */}
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full shrink-0',
          isRunning ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/40',
        )}
        aria-hidden
      />

      {/* Node label — primary identifier */}
      <span className="truncate font-medium">{node.label}</span>

      {/* Entity badge (only when claimed) */}
      {entityType && (
        <Badge
          variant="outline"
          className="h-4 px-1 text-[9px] leading-none gap-0.5 shrink-0"
          title={`Entity: ${entityType}${team ? ` · ${team}` : ''}`}
        >
          <span>{entityGlyph(entityType)}</span>
          <span>{entityType}</span>
        </Badge>
      )}

      {/* Decay countdown chip — e.g. freeze_tag's 30s frozen window. Cyan +
          pulse to draw the eye when a runner is locked out. */}
      {decayChip && (
        <span
          className="h-4 px-1 rounded text-[9px] font-semibold leading-none flex items-center gap-0.5 shrink-0 bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 animate-pulse tabular-nums"
          title={`${decayChip.label} — ${decayChip.remainingS.toFixed(1)}s remaining`}
        >
          <span>🥶</span>
          <span className="uppercase tracking-wide">{decayChip.label}</span>
          <span>{decayChip.remainingS.toFixed(0)}s</span>
        </span>
      )}

      {/* Phase badge — shown only when the node is running and a game is active */}
      {showPhase && (
        <span
          className={cn(
            'ml-auto text-[9px] font-semibold px-1 rounded shrink-0',
            PHASE_COLORS[phase],
          )}
        >
          {PHASE_LABELS[phase]}
        </span>
      )}
    </button>
  )
}
