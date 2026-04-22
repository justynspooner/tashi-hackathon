// Inspector for a user-placed obstacle. Displays + edits the obstacle's
// label, field-metre x/y position, radius, and LOS-blocking flag. Also
// exposes a delete action.

import { PanelHeader } from '@/components/layout/PanelHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { InspectorSection } from './InspectorSection'
import { Circle, Move, Ruler, Trash2 } from 'lucide-react'
import { useObstacles, type ObstacleRecord } from '@/state/ObstaclesContext'
import { useSelection } from '@/state/SelectionContext'

interface Props {
  obstacle: ObstacleRecord
}

export function ObstacleInspector({ obstacle }: Props) {
  const { updateObstacle, removeObstacle } = useObstacles()
  const { deselect } = useSelection()

  // `commitNumber` parses the input's current value; if empty / NaN it keeps
  // the field's previous value so users can clear-and-retype without the
  // canvas jumping on every keystroke.
  function commitNumber(
    field: 'x' | 'y' | 'r',
    raw: string,
    fallback: number,
  ) {
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    // Radius must stay strictly positive so the circle remains visible + the
    // LOS check doesn't divide through zero.
    const v = field === 'r' ? Math.max(0.3, n) : n
    if (v === fallback) return
    updateObstacle(obstacle.id, { [field]: v })
  }

  function handleDelete() {
    removeObstacle(obstacle.id)
    deselect()
  }

  return (
    <>
      <PanelHeader title="Obstacle" subtitle={obstacle.label}>
        <Button
          size="sm"
          variant="destructive"
          className="h-6 w-6 p-0"
          onClick={handleDelete}
          title="Delete obstacle"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </PanelHeader>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        <div className="rounded-md border bg-background/50 px-2 py-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-sm">
            <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="font-semibold truncate">{obstacle.label}</span>
            <Badge
              variant="outline"
              className="ml-auto text-[10px]"
              title={obstacle.blocks_los ? 'Blocks line-of-sight' : 'Cosmetic only'}
            >
              {obstacle.blocks_los ? 'blocks LOS' : 'cosmetic'}
            </Badge>
          </div>
          <div className="text-[10px] text-muted-foreground">
            Drag on the canvas to move · drag the handle to resize
          </div>
        </div>

        <InspectorSection title="Label" icon={<Circle className="h-3.5 w-3.5" />}>
          <Input
            value={obstacle.label}
            onChange={e => updateObstacle(obstacle.id, { label: e.target.value })}
            className="h-7 text-[12px]"
          />
        </InspectorSection>

        <InspectorSection title="Position" icon={<Move className="h-3.5 w-3.5" />}>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">X (m)</Label>
              <Input
                type="number"
                step={0.1}
                defaultValue={obstacle.x}
                key={`x-${obstacle.x}`}
                onBlur={e => commitNumber('x', e.target.value, obstacle.x)}
                className="h-7 text-[12px] tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Y (m)</Label>
              <Input
                type="number"
                step={0.1}
                defaultValue={obstacle.y}
                key={`y-${obstacle.y}`}
                onBlur={e => commitNumber('y', e.target.value, obstacle.y)}
                className="h-7 text-[12px] tabular-nums"
              />
            </div>
          </div>
        </InspectorSection>

        <InspectorSection title="Size" icon={<Ruler className="h-3.5 w-3.5" />}>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Radius (m)</Label>
            <Input
              type="number"
              step={0.1}
              min={0.3}
              defaultValue={obstacle.r}
              key={`r-${obstacle.r}`}
              onBlur={e => commitNumber('r', e.target.value, obstacle.r)}
              className="h-7 text-[12px] tabular-nums"
            />
          </div>
        </InspectorSection>

        <InspectorSection title="Behaviour" icon={<Circle className="h-3.5 w-3.5" />}>
          <label className="flex items-center gap-2 text-[11px] cursor-pointer">
            <input
              type="checkbox"
              checked={obstacle.blocks_los}
              onChange={e =>
                updateObstacle(obstacle.id, { blocks_los: e.target.checked })
              }
              className="h-3.5 w-3.5"
            />
            <span>Blocks line-of-sight</span>
          </label>
          <div className="text-[10px] text-muted-foreground mt-1.5">
            When enabled, comm edges that cross this obstacle render as severed.
          </div>
        </InspectorSection>
      </div>
    </>
  )
}
