// Small "HUD: <label>" pill overlaid at the top-left of the canvas so the
// user always knows which node's state is powering the canvas HUDs (per A2).
//
// When the user has explicitly selected a node, the pill renders in solid
// style. When the HUD is falling back to the first node (selection is none
// or an edge), the pill is rendered in italic/muted style with a "fallback"
// annotation so it's obvious the label isn't a user choice.
//
// Clicking the pill opens a small dropdown listing all nodes so the user can
// pick a different HUD source without hunting for the entity on the canvas.

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'

import { useSelection } from '@/state/SelectionContext'
import { useData } from '@/state/DataContext'
import { isHudSourceFallback, selectHudSourceLabel } from '@/state/selectors'
import { cn } from '@/lib/utils'

export function CanvasHudSourceIndicator() {
  const { selection, selectNode, deselect } = useSelection()
  const { nodes } = useData()
  const [open, setOpen] = useState(false)

  const label = selectHudSourceLabel(selection, nodes)
  const fallback = isHudSourceFallback(selection)
  if (!label) return null

  return (
    <div className="absolute top-3 left-3 z-20 pointer-events-auto">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className={cn(
                'group inline-flex items-center gap-1 rounded-md border bg-background/80 backdrop-blur px-2 py-1 text-[11px] font-mono hover:bg-background shadow-sm transition-colors',
                fallback
                  ? 'text-muted-foreground italic border-dashed'
                  : 'text-foreground border-border',
              )}
              title={
                fallback
                  ? 'HUD is showing data from the first node (nothing selected)'
                  : `HUD source: ${label}`
              }
            >
              <span className="uppercase tracking-wide text-[9px] text-muted-foreground group-hover:text-foreground transition-colors">
                HUD
              </span>
              <span className="truncate max-w-[140px]">{label}</span>
              {fallback && (
                <Badge variant="outline" className="text-[8px] px-1 py-0 leading-none uppercase tracking-wide">
                  fallback
                </Badge>
              )}
              <ChevronDown className="h-3 w-3 text-muted-foreground group-hover:text-foreground transition-colors" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-[180px]">
          <DropdownMenuLabel>HUD source</DropdownMenuLabel>
          {nodes.length === 0 ? (
            <DropdownMenuItem disabled>No nodes</DropdownMenuItem>
          ) : (
            nodes.map(n => (
              <DropdownMenuItem
                key={n.label}
                onClick={() => selectNode(n.label)}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    n.status === 'running' ? 'bg-green-500' : 'bg-muted-foreground/50',
                  )}
                />
                <span className="font-mono text-[11px]">{n.label}</span>
                {label === n.label && (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {fallback ? 'fallback' : 'selected'}
                  </span>
                )}
              </DropdownMenuItem>
            ))
          )}
          {!fallback && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={deselect}>
                <span className="text-[11px] text-muted-foreground">
                  Clear selection (use first node)
                </span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
