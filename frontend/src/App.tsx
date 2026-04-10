import { useCallback } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { ProofList } from '@/components/ProofList'
import { EventTimeline } from '@/components/EventTimeline'
import { EventLog } from '@/components/EventLog'
import { NetworkGraph } from '@/components/NetworkGraph'
import { NodeControl } from '@/components/NodeControl'
import { FinalityChart } from '@/components/FinalityChart'
import { Button } from '@/components/ui/button'
import { useAgentStates, useProofs, useEventLog, useNodes, useSSE } from '@/hooks/useApi'
import { Wifi, WifiOff, Trash2 } from 'lucide-react'

export default function App() {
  const { states, refetch: refetchStates } = useAgentStates()
  const { proofs, refetch: refetchProofs } = useProofs()
  const { events, appendEvent, clearEvents } = useEventLog()
  const { nodes, startNode, stopNode, setRole, createSwarm, destroySwarm, refetch: refetchNodes } = useNodes()

  const handleUpdate = useCallback(() => {
    refetchStates()
    refetchProofs()
    refetchNodes()
  }, [refetchStates, refetchProofs, refetchNodes])

  async function handleClearArtifacts() {
    await fetch('/api/clear-artifacts', { method: 'POST' })
    clearEvents()
    refetchNodes()
    refetchStates()
    refetchProofs()
  }

  const { connected } = useSSE({
    onEventLog: appendEvent,
    onUpdate: handleUpdate,
    onNodeStatus: refetchNodes,
  })

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-6 py-4">
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

      <main className="w-full p-6">
        {/* Three-column layout: Node Control | Network + Finality | Event Log */}
        <div className="flex gap-6 items-start">
          {/* Left: Node Control stacked vertically */}
          <div className="w-80 shrink-0">
            <NodeControl
              nodes={nodes}
              states={states}
              onStart={startNode}
              onStop={stopNode}
              onSetRole={setRole}
              onCreateSwarm={createSwarm}
              onDestroySwarm={destroySwarm}
            />
          </div>

          {/* Center: Network Topology + Consensus Finality stacked */}
          <div className="flex-1 min-w-0 space-y-6">
            <NetworkGraph states={states} events={events} nodes={nodes} />
            <FinalityChart proofs={proofs} />
          </div>

          {/* Right: Event Log */}
          <div className="w-96 shrink-0">
            <EventLog events={events} onClear={clearEvents} />
          </div>
        </div>

        {/* Proofs / Timeline below */}
        <div className="mt-6">
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
        </div>
      </main>
    </div>
  )
}
