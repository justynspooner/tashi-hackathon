// Unity-style Game Object inspector for a selected node.
//
// Header: node summary (label, bind, running/stopped, start/stop).
// Body: stacked collapsible "components":
//   - Game Select (propose/vote) — shown during no_game/proposing/voting only
//   - Peers (peer table + last-message pill)
//   - Entity (claim form / runtime / ready-up) — only when a game is loaded
//   - Events (per-node event log, capped at PER_NODE_EVENT_CAP)

import { useState } from 'react'
import { PanelHeader } from '@/components/layout/PanelHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Power, PowerOff, Activity, Flag, ListChecks, Terminal, Gamepad2 } from 'lucide-react'

import { InspectorSection } from './InspectorSection'
import { PeersComponent } from './components/PeersComponent'
import { EntityComponent } from './components/EntityComponent'
import { EventsComponent } from './components/EventsComponent'
import { GameSelectComponent } from './components/GameSelectComponent'

import { useData } from '@/state/DataContext'
import { useActions } from '@/state/ActionsContext'
import { PHASE_COLORS, PHASE_LABELS } from '@/lib/node-control-helpers'
import type { NodeInfo } from '@/types'

interface Props {
  node: NodeInfo
}

export function NodeInspector({ node }: Props) {
  const { states, events, snapshots, games, peerIdToLabel, canonicalEntities, activeGame } =
    useData()
  const { onStart, onStop, onProposeGame, onVoteGame, onClaimEntity, onReadyUp } = useActions()

  const [loading, setLoading] = useState(false)
  const snapshot = snapshots[node.label]
  const agentState = states.find(s => s.label === node.label)
  const phase = snapshot?.phase ?? 'no_game'
  const hasEntityComponent = phase !== 'no_game' && phase !== 'proposing' && phase !== 'voting'
  const bindPort = node.bind.split(':').pop() ?? node.bind
  const isRunning = node.status === 'running'
  const showGameSelect =
    phase === 'no_game' || phase === 'proposing' || phase === 'voting'

  async function handleToggleRunning() {
    setLoading(true)
    try {
      if (isRunning) {
        await onStop(node.label)
      } else {
        await onStart(node.label)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <PanelHeader title="Node" subtitle={`:${bindPort}`}>
        <Button
          size="sm"
          variant={isRunning ? 'destructive' : 'default'}
          className="h-6 w-6 p-0"
          disabled={loading}
          onClick={handleToggleRunning}
          title={isRunning ? 'Stop node' : 'Start node'}
        >
          {isRunning ? <PowerOff className="h-3 w-3" /> : <Power className="h-3 w-3" />}
        </Button>
      </PanelHeader>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {/* Top summary row */}
        <div className="rounded-md border bg-background/50 px-2 py-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-sm">
            <span
              className={`h-2 w-2 rounded-full shrink-0 ${
                isRunning ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/40'
              }`}
              aria-hidden
            />
            <span className="font-semibold truncate">{node.label}</span>
            {phase !== 'no_game' && isRunning && (
              <span
                className={`ml-auto text-[10px] font-semibold px-1 rounded shrink-0 ${
                  PHASE_COLORS[phase]
                } ${phase === 'playing' ? 'animate-pulse' : ''}`}
              >
                {PHASE_LABELS[phase]}
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground font-mono truncate" title={node.bind}>
            {node.bind}
          </div>
          {!isRunning && (
            <Badge variant="outline" className="text-[10px]">stopped</Badge>
          )}
        </div>

        {showGameSelect && (
          <InspectorSection title="Game Select" icon={<Gamepad2 className="h-3.5 w-3.5" />}>
            <GameSelectComponent
              node={node}
              snapshot={snapshot}
              games={games}
              onProposeGame={onProposeGame}
              onVoteGame={onVoteGame}
            />
          </InspectorSection>
        )}

        <InspectorSection
          title="Peers"
          icon={<Activity className="h-3.5 w-3.5" />}
          accessory={
            agentState && (
              <Badge variant="secondary" className="text-[10px]">
                {Object.keys(agentState.peers ?? {}).length}
              </Badge>
            )
          }
        >
          <PeersComponent
            agentState={agentState}
            peerIdToLabel={peerIdToLabel}
            // Scope peer roles to this node's own snapshot — never use the
            // cross-snapshot `canonicalEntities` merge here, or a partitioned
            // node will render peer roles it never saw through consensus.
            nodeEntities={snapshot?.entities}
          />
        </InspectorSection>

        {hasEntityComponent && (
          <InspectorSection
            title="Entity"
            icon={<Flag className="h-3.5 w-3.5" />}
            accessory={
              snapshot?.entities?.[node.label]?.entity_type && (
                <Badge variant="secondary" className="text-[10px]">
                  {snapshot.entities[node.label].entity_type}
                </Badge>
              )
            }
          >
            <EntityComponent
              node={node}
              snapshot={snapshot}
              activeGame={activeGame}
              canonicalEntities={canonicalEntities}
              onClaimEntity={onClaimEntity}
              onReadyUp={onReadyUp}
            />
          </InspectorSection>
        )}

        <InspectorSection
          title="Events"
          icon={<Terminal className="h-3.5 w-3.5" />}
          defaultOpen={false}
          accessory={
            <Badge variant="secondary" className="text-[10px]">
              per-node log
            </Badge>
          }
        >
          <EventsComponent label={node.label} events={events} />
        </InspectorSection>

        {/* Placement-validity hint (when applicable) */}
        {snapshot && phase === 'placing_entities' && snapshot.placement_ok === false && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300 flex items-center gap-1.5">
            <ListChecks className="h-3 w-3" />
            Placement is invalid — move the entity into an allowed area.
          </div>
        )}
      </div>
    </>
  )
}
