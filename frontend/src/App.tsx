import { useCallback, useMemo, useState } from 'react'
import { ProofList } from '@/components/ProofList'
import { EventTimeline } from '@/components/EventTimeline'
import { EventLog } from '@/components/EventLog'
import { FinalityChart } from '@/components/FinalityChart'
import { GameView } from '@/components/GameView'
import { ConsensusStalledBanner } from '@/components/ConsensusStalledBanner'
import { TopChrome } from '@/components/top-chrome/TopChrome'
import { SelectionProvider } from '@/state/SelectionContext'
import { ActionsProvider } from '@/state/ActionsContext'
import { DataProvider } from '@/state/DataContext'
import { ObstaclesProvider } from '@/state/ObstaclesContext'
import { Toaster } from '@/components/ui/sonner'
import { AppShell } from '@/components/layout/AppShell'
import { BottomDrawer, type DrawerTab } from '@/components/layout/BottomDrawer'
import { SceneTree } from '@/components/scene-tree/SceneTree'
import { InspectorRouter } from '@/components/inspector/InspectorRouter'
import { CanvasArea } from '@/components/canvas/CanvasArea'
import { useAgentStates, useProofs, useEventLog, useNodes, usePartitions, useSSE } from '@/hooks/useApi'
import { useGameActions, useGames, useGameState } from '@/hooks/useGame'
import { runWithToast } from '@/hooks/useErrorToast'
import type { LocalGameSnapshot } from '@/game/types'

export default function App() {
  const { states, refetch: refetchStates } = useAgentStates()
  const { proofs, refetch: refetchProofs } = useProofs()
  const { events, appendEvent, clearEvents } = useEventLog()
  const { nodes, startNode, stopNode, createSwarm, destroySwarm, refetch: refetchNodes } = useNodes()
  const { partitions, togglePartition, refetch: refetchPartitions } = usePartitions()
  const { snapshots, applySnapshotUpdate, clear: clearGameState } = useGameState()
  const { games } = useGames()
  const { moveEntity, proposeGame, voteGame, claimEntity, readyUp } = useGameActions()

  const [drawerTab, setDrawerTab] = useState<DrawerTab>('events')
  const [drawerCollapsed, setDrawerCollapsed] = useState(false)

  const handleUpdate = useCallback(() => {
    refetchStates()
    refetchProofs()
    refetchNodes()
  }, [refetchStates, refetchProofs, refetchNodes])

  const handleClearArtifacts = useCallback(async () => {
    await runWithToast('Clear artifacts', async () => {
      const res = await fetch('/api/clear-artifacts', { method: 'POST' })
      if (!res.ok) throw new Error(`clear-artifacts failed: ${res.status}`)
    })
    clearEvents()
    clearGameState()
    refetchNodes()
    refetchStates()
    refetchProofs()
  }, [clearEvents, clearGameState, refetchNodes, refetchStates, refetchProofs])

  const handleToggleEventLog = useCallback(() => {
    // Top chrome's Event Log button routes to the drawer's Events tab.
    setDrawerTab('events')
    setDrawerCollapsed(false)
  }, [])

  const { connected } = useSSE({
    onEventLog: appendEvent,
    onUpdate: handleUpdate,
    onNodeStatus: refetchNodes,
    onPartitionChanged: refetchPartitions,
    onGameStateChanged: (label, snapshot) =>
      applySnapshotUpdate(label, snapshot as LocalGameSnapshot),
  })

  const dataValue = useMemo(
    () => ({ nodes, states, events, snapshots, games, proofs, partitions }),
    [nodes, states, events, snapshots, games, proofs, partitions],
  )

  const actionsValue = useMemo(
    () => ({
      onStart: startNode,
      onStop: stopNode,
      onProposeGame: proposeGame,
      onVoteGame: voteGame,
      onClaimEntity: claimEntity,
      onReadyUp: readyUp,
      onTogglePartition: togglePartition,
    }),
    [startNode, stopNode, proposeGame, voteGame, claimEntity, readyUp, togglePartition],
  )

  return (
    <ObstaclesProvider>
      <SelectionProvider nodes={nodes}>
        <DataProvider value={dataValue}>
          <ActionsProvider value={actionsValue}>
            <AppShell
              topChrome={
                <TopChrome
                  nodes={nodes}
                  snapshots={snapshots}
                  games={games}
                  connected={connected}
                  eventLogOpen={drawerTab === 'events' && !drawerCollapsed}
                  onToggleEventLog={handleToggleEventLog}
                  onClearArtifacts={handleClearArtifacts}
                  onCreateSwarm={createSwarm}
                  onDestroySwarm={destroySwarm}
                  onStart={startNode}
                  onStop={stopNode}
                  onProposeGame={proposeGame}
                  onVoteGame={voteGame}
                  onReadyUp={readyUp}
                />
              }
              leftPanel={<SceneTree nodes={nodes} snapshots={snapshots} />}
              center={
                <CanvasArea>
                  <GameView
                    nodes={nodes}
                    snapshots={snapshots}
                    onMove={moveEntity}
                    partitions={partitions}
                    events={events}
                    states={states}
                    games={games}
                    onTogglePartition={togglePartition}
                  />
                  {/* Headless watcher: fires toasts when consensus stalls or
                      recovers. No visual surface. */}
                  <ConsensusStalledBanner proofs={proofs} partitions={partitions} />
                </CanvasArea>
              }
              rightPanel={<InspectorRouter />}
              drawer={
                <BottomDrawer
                  tab={drawerTab}
                  onTabChange={setDrawerTab}
                  proofCount={proofs.length}
                  events={<EventLog events={events} onClear={clearEvents} />}
                  timeline={<EventTimeline proofs={proofs} />}
                  proofs={<ProofList proofs={proofs} />}
                  chart={<FinalityChart events={events} />}
                  collapsed={drawerCollapsed}
                  onToggleCollapsed={() => setDrawerCollapsed(c => !c)}
                />
              }
            />

            <Toaster richColors position="top-right" />
          </ActionsProvider>
        </DataProvider>
      </SelectionProvider>
    </ObstaclesProvider>
  )
}
