// Routes the right panel based on selection state.
//   - kind='none'     → EmptyInspector
//   - kind='node'     → NodeInspector (Unity-style: header + stacked components)
//   - kind='edge'     → EdgeInspector (partition + LOS + distance)
//   - kind='obstacle' → ObstacleInspector (label + position + radius + LOS flag)

import { useSelection } from '@/state/SelectionContext'
import { useData } from '@/state/DataContext'
import { useObstacles } from '@/state/ObstaclesContext'
import { EmptyInspector } from './EmptyInspector'
import { NodeInspector } from './NodeInspector'
import { EdgeInspector } from './EdgeInspector'
import { ObstacleInspector } from './ObstacleInspector'

export function InspectorRouter() {
  const { selection } = useSelection()
  const { nodes } = useData()
  const { obstacles } = useObstacles()

  if (selection.kind === 'none') return <EmptyInspector />
  if (selection.kind === 'edge') return <EdgeInspector />
  if (selection.kind === 'obstacle') {
    const obstacle = obstacles.find(o => o.id === selection.id)
    if (!obstacle) return <EmptyInspector />
    return <ObstacleInspector obstacle={obstacle} />
  }

  const node = nodes.find(n => n.label === selection.label)
  if (!node) return <EmptyInspector />
  return <NodeInspector node={node} />
}
