// Inspector view for a selected edge (node pair). Surfaces current distance,
// LOS state, partition state, and the Toggle Partition action.

import { useState } from 'react'
import { PanelHeader } from '@/components/layout/PanelHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { InspectorSection } from './InspectorSection'
import { Link, Network, Unlink } from 'lucide-react'

import { useData } from '@/state/DataContext'
import { useActions } from '@/state/ActionsContext'
import { useSelection } from '@/state/SelectionContext'
import { useObstacles } from '@/state/ObstaclesContext'
import { edgeKey } from '@/game/edgeKey'
import { runWithToast } from '@/hooks/useErrorToast'
import { COMM_RADIUS_M } from '@/game/presentation'
import { hasLos, inRange, distance } from '@/game/geom'

export function EdgeInspector() {
  const { selection } = useSelection()
  const { nodes, snapshots, partitions } = useData()
  const { onTogglePartition } = useActions()
  const { obstacles } = useObstacles()
  const [busy, setBusy] = useState(false)

  if (selection.kind !== 'edge') return null
  const { a, b } = selection

  const nodeA = nodes.find(n => n.label === a)
  const nodeB = nodes.find(n => n.label === b)

  // Prefer each node's own snapshot position, falling back to peer reports.
  const posA = resolvePos(a, snapshots)
  const posB = resolvePos(b, snapshots)

  const partitioned = partitions.some(p => edgeKey(p[0], p[1]) === edgeKey(a, b))

  // LOS uses the user-placed obstacles from the ObstaclesContext.
  let dist: number | null = null
  let inRangeVal: boolean | null = null
  let losClear: boolean | null = null
  if (posA && posB) {
    dist = distance(posA, posB)
    inRangeVal = inRange(posA, posB, COMM_RADIUS_M)
    losClear = hasLos(posA, posB, obstacles)
  }

  const connected = !partitioned && !!inRangeVal && !!losClear

  async function handleToggle() {
    setBusy(true)
    try {
      await runWithToast(
        partitioned ? `Heal partition ${a} ↔ ${b}` : `Partition ${a} ↔ ${b}`,
        async () => {
          await onTogglePartition(a, b)
        },
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PanelHeader title="Edge" subtitle={`${a} ↔ ${b}`} />
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        <div className="rounded-md border bg-background/50 px-2 py-2">
          <div className="flex items-center gap-2 text-sm">
            {connected ? (
              <>
                <Link className="h-4 w-4 text-green-500" />
                <span className="font-semibold">Connected</span>
              </>
            ) : (
              <>
                <Unlink className="h-4 w-4 text-red-500" />
                <span className="font-semibold">Severed</span>
              </>
            )}
            <Badge
              variant="outline"
              className={`ml-auto text-[10px] ${partitioned ? 'border-red-500/40 text-red-300' : 'border-border'}`}
            >
              {partitioned ? 'partitioned' : 'auto'}
            </Badge>
          </div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {!posA || !posB
              ? 'Position data unavailable.'
              : `${dist?.toFixed(1)}m apart · comm radius ${COMM_RADIUS_M}m`}
          </div>
        </div>

        <InspectorSection
          title="Connectivity"
          icon={<Network className="h-3.5 w-3.5" />}
        >
          <div className="text-[11px] space-y-1.5">
            <Row
              label="In range"
              value={inRangeVal}
              yes="within radius"
              no="out of range"
            />
            <Row
              label="Line of sight"
              value={losClear}
              yes="clear"
              no="blocked by obstacle"
            />
            <Row
              label="Manual partition"
              value={partitioned ? false : true}
              yes="not partitioned"
              no="pfctl partition active"
            />
          </div>
        </InspectorSection>

        <InspectorSection
          title="Actions"
          icon={<Unlink className="h-3.5 w-3.5" />}
          defaultOpen
        >
          <Button
            size="sm"
            className="w-full gap-1 h-7 text-[11px]"
            variant={partitioned ? 'default' : 'destructive'}
            disabled={busy}
            onClick={handleToggle}
          >
            {partitioned ? (
              <>
                <Link className="h-3 w-3" />
                {busy ? 'Healing…' : 'Heal Partition'}
              </>
            ) : (
              <>
                <Unlink className="h-3 w-3" />
                {busy ? 'Partitioning…' : 'Toggle Partition'}
              </>
            )}
          </Button>
          <div className="text-[10px] text-muted-foreground mt-1.5">
            Creates or heals a `pfctl` partition between these two nodes.
          </div>
        </InspectorSection>

        {(nodeA?.status === 'stopped' || nodeB?.status === 'stopped') && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
            One or both endpoints are stopped — partition state may not apply.
          </div>
        )}
      </div>
    </>
  )
}

function Row({
  label,
  value,
  yes,
  no,
}: {
  label: string
  value: boolean | null
  yes: string
  no: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-28 shrink-0">{label}</span>
      {value == null ? (
        <span className="italic text-muted-foreground">—</span>
      ) : (
        <span className={value ? 'text-emerald-300' : 'text-red-300'}>
          {value ? yes : no}
        </span>
      )}
    </div>
  )
}

function resolvePos(
  label: string,
  snapshots: Record<string, import('@/game/types').LocalGameSnapshot>,
) {
  const own = snapshots[label]
  const ownPos = own?.my_position ?? own?.entities[label]?.pos
  if (ownPos) return ownPos
  for (const snap of Object.values(snapshots)) {
    const peerPos = snap.entities[label]?.pos
    if (peerPos) return peerPos
  }
  return null
}

