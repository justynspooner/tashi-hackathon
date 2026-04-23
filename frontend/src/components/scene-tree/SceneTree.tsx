// Scene tree (A4/A5): unified node+entity rows. Pre-game it's a flat list;
// once snapshots arrive and entities claim teams, rows group under team
// headers. Nodes without a claimed entity sit under "Unassigned".

import { useMemo, useState } from 'react'
import { PanelHeader } from '@/components/layout/PanelHeader'
import { SceneTreeRow } from './SceneTreeRow'
import { TeamGroupHeader } from './TeamGroupHeader'
import { ObstaclesSection } from './ObstaclesSection'
import { useSelection } from '@/state/SelectionContext'
import { useData } from '@/state/DataContext'
import type { NodeInfo } from '@/types'
import type { EntityRecord, LocalGameSnapshot } from '@/game/types'

interface Props {
  nodes: NodeInfo[]
  snapshots: Record<string, LocalGameSnapshot>
}

/**
 * Resolve the entity associated with a node label, preferring the node's own
 * snapshot but falling back to peer snapshots (a claim may be visible
 * elsewhere before it lands in the owner's snapshot).
 */
function resolveEntity(
  label: string,
  snapshots: Record<string, LocalGameSnapshot>,
): EntityRecord | undefined {
  const own = snapshots[label]?.entities?.[label]
  if (own) return own
  for (const snap of Object.values(snapshots)) {
    const hit = snap.entities?.[label]
    if (hit) return hit
  }
  return undefined
}

export function SceneTree({ nodes, snapshots }: Props) {
  const { selection, selectNode } = useSelection()
  // Pulled in for game-aware row decoration (decay countdowns like
  // freeze_tag's frozen window). The row component looks up its own decay
  // rules from the config rather than receiving them per-node.
  const { activeGame } = useData()
  const hasSnapshots = Object.keys(snapshots).length > 0

  // Group nodes by team (A4): "Unassigned" for nodes without a claimed entity.
  const grouped = useMemo(() => {
    const buckets = new Map<string, Array<{ node: NodeInfo; entity: EntityRecord | undefined }>>()
    for (const node of nodes) {
      const entity = resolveEntity(node.label, snapshots)
      const key = entity?.team ?? '__unassigned__'
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key)!.push({ node, entity })
    }
    // Stable ordering: real team names (sorted) first, Unassigned last.
    const orderedKeys = [...buckets.keys()].sort((a, b) => {
      if (a === '__unassigned__') return 1
      if (b === '__unassigned__') return -1
      return a.localeCompare(b)
    })
    return orderedKeys.map(k => ({
      team: k === '__unassigned__' ? null : k,
      items: buckets.get(k)!.sort((x, y) => x.node.label.localeCompare(y.node.label)),
    }))
  }, [nodes, snapshots])

  // Collapse state per group key. Default to expanded; remember per-team
  // across state changes within a session.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const toggleCollapsed = (key: string) =>
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))

  const selectedLabel = selection.kind === 'node' ? selection.label : null

  // When there are no snapshots (pre-game), skip team headers and render as a
  // flat list — matches A4 "display nodes pre-game".
  const renderFlat = !hasSnapshots

  return (
    <>
      <PanelHeader
        title="Scene"
        subtitle={
          nodes.length === 0
            ? 'no swarm deployed'
            : `${nodes.length} node${nodes.length === 1 ? '' : 's'}${hasSnapshots ? ' · in game' : ''}`
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-2">
        {nodes.length === 0 ? (
          <div className="p-3 text-[11px] text-muted-foreground italic text-center">
            Deploy a swarm from the <span className="font-semibold">Swarm Actions</span> menu above to populate the scene.
          </div>
        ) : renderFlat ? (
          // Pre-game flat list.
          <div className="space-y-0.5">
            {nodes.map(node => (
              <SceneTreeRow
                key={node.label}
                node={node}
                snapshot={undefined}
                entity={undefined}
                selected={selectedLabel === node.label}
                onClick={() => selectNode(node.label)}
                activeGame={activeGame}
              />
            ))}
          </div>
        ) : (
          // In-game: team-grouped.
          <div className="space-y-1">
            {grouped.map(group => {
              const key = group.team ?? '__unassigned__'
              const isCollapsed = collapsed[key]
              return (
                <div key={key}>
                  <TeamGroupHeader
                    team={group.team}
                    count={group.items.length}
                    collapsed={!!isCollapsed}
                    onToggle={() => toggleCollapsed(key)}
                  />
                  {!isCollapsed && (
                    <div className="ml-2 mt-0.5 space-y-0.5 border-l border-border pl-1">
                      {group.items.map(({ node, entity }) => (
                        <SceneTreeRow
                          key={node.label}
                          node={node}
                          snapshot={snapshots[node.label]}
                          entity={entity}
                          selected={selectedLabel === node.label}
                          onClick={() => selectNode(node.label)}
                          activeGame={activeGame}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Obstacles section — always shown so users can place obstacles
            pre-game or post-deploy. Independent of node state. */}
        <ObstaclesSection />
      </div>
    </>
  )
}
