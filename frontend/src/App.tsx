import { useCallback, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { ProofList } from '@/components/ProofList'
import { EventTimeline } from '@/components/EventTimeline'
import { EventLog } from '@/components/EventLog'
import { NodeControl } from '@/components/NodeControl'
import { FinalityChart } from '@/components/FinalityChart'
import { GameView } from '@/components/GameView'
import { ConsensusStalledBanner } from '@/components/ConsensusStalledBanner'
import { Button } from '@/components/ui/button'
import { useAgentStates, useProofs, useEventLog, useNodes, usePartitions, useSSE } from '@/hooks/useApi'
import { useGameActions, useGames, useGameState } from '@/hooks/useGame'
import type { LocalGameSnapshot } from '@/game/types'
import { Wifi, WifiOff, Trash2, Terminal } from 'lucide-react'

export default function App() {
  const { states, refetch: refetchStates } = useAgentStates()
  const { proofs, refetch: refetchProofs } = useProofs()
  const { events, appendEvent, clearEvents } = useEventLog()
  const { nodes, startNode, stopNode, createSwarm, destroySwarm, refetch: refetchNodes } = useNodes()
  const { partitions, togglePartition, refetch: refetchPartitions } = usePartitions()
  const { snapshots, applySnapshotUpdate, clear: clearGameState } = useGameState()
  const { games } = useGames()
  const { moveEntity, proposeGame, voteGame, claimEntity, readyUp } = useGameActions()
  const [eventLogOpen, setEventLogOpen] = useState(false)

  const handleUpdate = useCallback(() => {
    refetchStates()
    refetchProofs()
    refetchNodes()
  }, [refetchStates, refetchProofs, refetchNodes])

  async function handleClearArtifacts() {
    await fetch('/api/clear-artifacts', { method: 'POST' })
    clearEvents()
    clearGameState()
    refetchNodes()
    refetchStates()
    refetchProofs()
  }

  const { connected } = useSSE({
    onEventLog: appendEvent,
    onUpdate: handleUpdate,
    onNodeStatus: refetchNodes,
    onPartitionChanged: refetchPartitions,
    onGameStateChanged: (label, snapshot) =>
      applySnapshotUpdate(label, snapshot as LocalGameSnapshot),
  })

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Tashi Vertex Explorer
            </h1>
            <p className="text-sm text-muted-foreground">
              Live coordination events & proof verification
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              onClick={handleClearArtifacts}
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Clear Artifacts
            </Button>
            <Button
              size="sm"
              variant={eventLogOpen ? 'default' : 'outline'}
              onClick={() => setEventLogOpen(o => !o)}
            >
              <Terminal className="h-3 w-3 mr-1" />
              Event Log
              {events.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-xs">{events.length}</Badge>
              )}
            </Button>
            {connected ? (
              <Badge variant="outline" className="gap-1">
                <Wifi className="h-3 w-3 text-green-500" />
                Live
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1">
                <WifiOff className="h-3 w-3 text-red-500" />
                Disconnected
              </Badge>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <main className="flex-1 min-w-0 p-6 overflow-y-auto space-y-6">
          {/* Node control — full width (network topology is now drawn
              directly on top of the playing field below) */}
          <NodeControl
            nodes={nodes}
            states={states}
            events={events}
            snapshots={snapshots}
            games={games}
            onStart={startNode}
            onStop={stopNode}
            onCreateSwarm={createSwarm}
            onDestroySwarm={destroySwarm}
            onProposeGame={proposeGame}
            onVoteGame={voteGame}
            onClaimEntity={claimEntity}
            onReadyUp={readyUp}
          />

          {/* Playing field — full width. Now also hosts the comm graph: green
              lines between connected peers, red dashed lines for any pair
              without a link (user-severed or out of range). Tap any edge to
              toggle a manual sever. */}
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

          {/* Consensus finality — full width */}
          <ConsensusStalledBanner proofs={proofs} partitions={partitions} />
          <FinalityChart events={events} />

          {/* Proofs / Timeline */}
          <Tabs defaultValue="proofs">
            <TabsList>
              <TabsTrigger value="proofs">
                Proofs
                {proofs.length > 0 && (
                  <Badge variant="secondary" className="ml-2 text-xs">{proofs.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="timeline">
                Event Timeline
              </TabsTrigger>
            </TabsList>

            <TabsContent value="proofs" className="mt-4">
              <ProofList proofs={proofs} />
            </TabsContent>

            <TabsContent value="timeline" className="mt-4">
              <EventTimeline proofs={proofs} />
            </TabsContent>
          </Tabs>
        </main>

        {eventLogOpen && (
          <aside className="w-96 shrink-0 border-l bg-background flex flex-col">
            <EventLog events={events} onClear={clearEvents} />
          </aside>
        )}
      </div>
    </div>
  )
}
