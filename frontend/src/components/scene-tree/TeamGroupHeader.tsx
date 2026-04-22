// Collapsible team group header for the scene tree.

import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { teamColor } from '@/game/presentation'

interface Props {
  team: string | null
  count: number
  collapsed: boolean
  onToggle: () => void
}

export function TeamGroupHeader({ team, count, collapsed, onToggle }: Props) {
  const color = team ? teamColor(team) : undefined
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'w-full flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted/60',
      )}
    >
      {collapsed ? (
        <ChevronRight className="h-3 w-3 shrink-0" />
      ) : (
        <ChevronDown className="h-3 w-3 shrink-0" />
      )}
      {color && (
        <span
          className="h-2 w-2 rounded-full shrink-0"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}
      <span className="uppercase font-semibold tracking-wide truncate">
        {team ?? 'Unassigned'}
      </span>
      <span className="ml-auto tabular-nums text-[10px]">{count}</span>
    </button>
  )
}
