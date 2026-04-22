// Single row in the scene tree. Per A4/A5 the node+entity are a unified
// element: one row renders the node's status AND its attached entity
// component (when it has one).
//
// Layout:
//   [team-bar 3px][status-dot][label][entity-badge?][phase-badge?]

import { Badge } from '@/components/ui/badge'
import type { NodeInfo } from '@/types'
import type { EntityRecord, GamePhase, LocalGameSnapshot } from '@/game/types'
import { PHASE_COLORS, PHASE_LABELS, entityGlyph } from '@/lib/node-control-helpers'
import { teamColor } from '@/game/presentation'
import { cn } from '@/lib/utils'

interface Props {
  node: NodeInfo
  snapshot: LocalGameSnapshot | undefined
  entity: EntityRecord | undefined
  selected: boolean
  onClick: () => void
}

export function SceneTreeRow({ node, snapshot, entity, selected, onClick }: Props) {
  const phase: GamePhase = snapshot?.phase ?? 'no_game'
  const isRunning = node.status === 'running'
  const team = entity?.team ?? null
  const entityType = entity?.entity_type ?? null
  const showPhase = isRunning && phase !== 'no_game'
  const teamBar = team ? teamColor(team) : 'transparent'

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
