// Scene-tree section listing user-placed obstacles. Users add obstacles here
// via the inline "+ Add" button — obstacles are never auto-generated from a
// game config. Each row is selectable (routes to ObstacleInspector) and
// carries a delete affordance that appears on hover / when selected.

import { useState } from 'react'
import { ChevronDown, ChevronRight, Circle, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useObstacles } from '@/state/ObstaclesContext'
import { useSelection } from '@/state/SelectionContext'

export function ObstaclesSection() {
  const { obstacles, addObstacle, removeObstacle } = useObstacles()
  const { selection, selectObstacle, deselect } = useSelection()
  const [collapsed, setCollapsed] = useState(false)

  const selectedId =
    selection.kind === 'obstacle' ? selection.id : null

  function handleAdd(e: React.MouseEvent) {
    e.stopPropagation()
    const id = addObstacle()
    // Auto-select the new obstacle so the inspector opens immediately and the
    // user can tweak position / radius without an extra click.
    selectObstacle(id)
    // If the section was collapsed, expand it so the user sees the new row.
    setCollapsed(false)
  }

  function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation()
    removeObstacle(id)
    // If we just deleted the selected obstacle, drop selection so the
    // inspector collapses back to empty state.
    if (selectedId === id) deselect()
  }

  return (
    <div>
      <div
        className={cn(
          'w-full flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted/60',
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed(c => !c)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" />
          )}
          <span className="uppercase font-semibold tracking-wide truncate">
            Obstacles
          </span>
          <span className="tabular-nums text-[10px]">{obstacles.length}</span>
        </button>
        <button
          type="button"
          onClick={handleAdd}
          className="shrink-0 h-4 w-4 rounded-sm flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground"
          title="Add obstacle"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>

      {!collapsed && (
        <div className="ml-2 mt-0.5 space-y-0.5 border-l border-border pl-1">
          {obstacles.length === 0 ? (
            <div className="px-2 py-1 text-[10px] italic text-muted-foreground">
              No obstacles — click + to add one.
            </div>
          ) : (
            obstacles.map(ob => {
              const selected = selectedId === ob.id
              return (
                <button
                  key={ob.id}
                  type="button"
                  onClick={() => selectObstacle(ob.id)}
                  className={cn(
                    'w-full text-left flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[12px] transition-colors group',
                    selected
                      ? 'bg-primary/15 text-foreground ring-1 ring-primary/40'
                      : 'hover:bg-muted/60 text-foreground/90',
                  )}
                >
                  <Circle className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{ob.label}</span>
                  <span className="ml-auto text-[9px] tabular-nums text-muted-foreground shrink-0">
                    r{ob.r.toFixed(1)}
                  </span>
                  <button
                    type="button"
                    onClick={e => handleDelete(e, ob.id)}
                    className={cn(
                      'shrink-0 h-4 w-4 rounded-sm flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10',
                      selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                    )}
                    title="Delete obstacle"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
