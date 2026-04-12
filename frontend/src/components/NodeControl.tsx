import { memo, useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Power, PowerOff, Server, Plus, Trash2 } from 'lucide-react'
import { timeSince, roleColor } from '@/lib/utils'
import type { AgentState, EventLogEntry, NodeInfo } from '@/types'

const AVAILABLE_ROLES = ['carrier', 'scout', 'observer', 'relay']

const TAG_COLORS: Record<string, string> = {
  BOOT: 'text-slate-400',
  DISCOVERY: 'text-cyan-400',
  HANDSHAKE: 'text-blue-400',
  HEARTBEAT: 'text-green-400',
  STATE: 'text-amber-400',
  ACTION: 'text-orange-400',
  PROOF: 'text-indigo-400',
  EXIT: 'text-gray-400',
  CRASH: 'text-red-500',
  SYNC: 'text-purple-400',
  ENGINE: 'text-teal-400',
  EVENT: 'text-sky-400',
  CMD: 'text-pink-400',
}

function shortId(id: string): string {
  return id.slice(-4)
}

function shortMessageId(id: string | null | undefined): string {
  if (!id) return '—'
  const dashIdx = id.indexOf('-')
  return dashIdx >= 0 ? id.slice(dashIdx + 1) : id
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

// --- Per-node event log ---

function NodeEventLog({ events }: { events: EventLogEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (!autoScroll || !containerRef.current) return
    containerRef.current.scrollTop = containerRef.current.scrollHeight
  }, [events.length, autoScroll])

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    setAutoScroll(atBottom)
  }

  if (events.length === 0) {
    return (
      <div className="text-[10px] text-muted-foreground text-center py-2 italic">
        No events yet
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="overflow-y-auto max-h-[160px] font-mono text-[10px] leading-[16px] bg-muted/30 rounded border"
    >
      {events.map((ev, i) => (
        <div key={i} className="flex gap-1.5 px-1.5 hover:bg-muted/50">
          <span className="text-muted-foreground shrink-0">{formatTs(ev.ts)}</span>
          <span className={`shrink-0 font-semibold ${TAG_COLORS[ev.tag] ?? 'text-gray-400'}`}>{ev.tag}</span>
          <span className="truncate text-foreground/70">{ev.message}</span>
        </div>
      ))}
    </div>
  )
}

// --- Single node card ---

const NodeCard = memo(function NodeCard({
  node,
  agentState,
  events,
  loading,
  peerIdToLabel,
  now,
  onStart,
  onStop,
  onSetRole,
}: {
  node: NodeInfo
  agentState?: AgentState
  events: EventLogEntry[]
  loading: boolean
  peerIdToLabel: Record<string, string>
  now: number
  onStart: (label: string) => void
  onStop: (label: string) => void
  onSetRole: (label: string, role: string) => void
}) {
  return (
    <Card className="w-56 shrink-0 flex flex-col">
      <CardHeader className="py-2 px-3">
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full shrink-0 ${node.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
          <span className="font-medium text-sm">{node.label}</span>
          <span className="text-[10px] text-muted-foreground">{node.bind}</span>
          <div className="ml-auto flex items-center gap-1">
            {node.status === 'running' ? (
              <Button size="sm" variant="destructive" className="h-5 w-5 p-0" disabled={loading} onClick={() => onStop(node.label)}>
                <PowerOff className="h-3 w-3" />
              </Button>
            ) : (
              <Button size="sm" className="h-5 w-5 p-0" disabled={loading} onClick={() => onStart(node.label)}>
                <Power className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-3 pb-2 pt-0 flex-1 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Select
            value={node.role ?? ''}
            onValueChange={(value) => value && onSetRole(node.label, value)}
          >
            <SelectTrigger className={`h-5 text-[10px] flex-1 px-1.5 ${node.role ? roleColor(node.role) : ''}`}>
              <SelectValue placeholder="role" />
            </SelectTrigger>
            <SelectContent>
              {AVAILABLE_ROLES.map(role => (
                <SelectItem key={role} value={role}>
                  <span className={`px-1 rounded ${roleColor(role)}`}>{role}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {agentState && (
          <div className="text-[10px] border-t pt-1 space-y-0.5">
            {agentState.peers && Object.entries(agentState.peers).sort(([, a], [, b]) => (peerIdToLabel[a.peer_id] ?? a.peer_id).localeCompare(peerIdToLabel[b.peer_id] ?? b.peer_id)).map(([peerId, peer]) => {
              const isStale = now - peer.last_seen_ms > 15_000
              return (
                <div key={peerId} className={`flex items-center gap-1 ${isStale ? 'opacity-50' : ''}`}>
                  <span className="text-muted-foreground w-12 shrink-0 truncate">{peerIdToLabel[peer.peer_id] ?? shortId(peer.peer_id)}</span>
                  <Badge variant="outline" className={`text-[9px] px-0.5 py-0 leading-tight ${roleColor(peer.role)}`}>{peer.role}</Badge>
                  {isStale && <Badge variant="destructive" className="text-[8px] px-0.5 py-0 leading-tight">stale</Badge>}
                  <span className="text-muted-foreground ml-auto">{timeSince(peer.last_seen_ms)}</span>
                </div>
              )
            })}
            <div className="flex items-center gap-1 text-muted-foreground pt-0.5">
              <span className="shrink-0">Last</span>
              <Badge variant="outline" className="text-[9px] px-0.5 py-0 leading-tight">{agentState.last_message_kind}</Badge>
              <span className="font-mono truncate">{shortMessageId(agentState.last_message_id)}</span>
            </div>
          </div>
        )}

        <div className="border-t pt-1 mt-auto">
          <NodeEventLog events={events} />
        </div>
      </CardContent>
    </Card>
  )
})

// --- Main export ---

interface Props {
  nodes: NodeInfo[]
  states: AgentState[]
  events: EventLogEntry[]
  onStart: (label: string) => Promise<void>
  onStop: (label: string) => Promise<void>
  onSetRole: (label: string, role: string) => Promise<void>
  onCreateSwarm: (count: number) => Promise<void>
  onDestroySwarm: () => Promise<void>
}

export const NodeControl = memo(function NodeControl({ nodes, states, events, onStart, onStop, onSetRole, onCreateSwarm, onDestroySwarm }: Props) {
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [swarmSizeInput, setSwarmSizeInput] = useState('7')
  const [swarmDialogOpen, setSwarmDialogOpen] = useState(false)
  const [destroyDialogOpen, setDestroyDialogOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  // Filter events per node (exclude noisy tags)
  const eventsByNode = useMemo(() => {
    const map: Record<string, EventLogEntry[]> = {}
    for (const node of nodes) {
      map[node.label] = []
    }
    for (const ev of events) {
      if (ev.tag === 'VERTEX_RX' || ev.tag === 'VERTEX_TX' || ev.tag === 'FINALITY') continue
      if (map[ev.label]) {
        map[ev.label].push(ev)
      }
    }
    return map
  }, [events, nodes])

  // Map peer_id (public key) -> label
  const peerIdToLabel = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of states) {
      map[s.local.peer_id] = s.label
    }
    return map
  }, [states])

  const allRunning = nodes.length > 0 && nodes.every(n => n.status === 'running')

  async function handleStartAll() {
    setLoading(prev => ({ ...prev, '__start_all__': true }))
    try {
      const stopped = nodes.filter(n => n.status !== 'running')
      for (const node of stopped) {
        await onStart(node.label)
      }
    } finally { setLoading(prev => ({ ...prev, '__start_all__': false })) }
  }

  async function handleStopAll() {
    setLoading(prev => ({ ...prev, '__stop_all__': true }))
    try {
      const running = nodes.filter(n => n.status === 'running')
      for (const node of running) {
        await onStop(node.label)
      }
    } finally { setLoading(prev => ({ ...prev, '__stop_all__': false })) }
  }

  const handleStart = useCallback(async (label: string) => {
    setLoading(prev => ({ ...prev, [label]: true }))
    try { await onStart(label) }
    finally { setTimeout(() => setLoading(prev => ({ ...prev, [label]: false })), 1000) }
  }, [onStart])

  const handleStop = useCallback(async (label: string) => {
    setLoading(prev => ({ ...prev, [label]: true }))
    try { await onStop(label) }
    finally { setTimeout(() => setLoading(prev => ({ ...prev, [label]: false })), 1000) }
  }, [onStop])

  async function handleCreateSwarm() {
    setLoading(prev => ({ ...prev, '__swarm__': true }))
    const count = Math.max(4, Math.min(26, parseInt(swarmSizeInput) || 7))
    setSwarmDialogOpen(false)
    try { await onCreateSwarm(count) }
    finally { setLoading(prev => ({ ...prev, '__swarm__': false })) }
  }

  async function handleDestroySwarm() {
    setLoading(prev => ({ ...prev, '__destroy__': true }))
    setDestroyDialogOpen(false)
    try { await onDestroySwarm() }
    finally { setLoading(prev => ({ ...prev, '__destroy__': false })) }
  }

  const hasSwarm = nodes.length > 0

  return (
    <div className="space-y-3">
      {/* Swarm header controls */}
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4" />
        <span className="font-semibold text-sm">Node Control</span>
        <div className="ml-auto flex items-center gap-1">
          {!hasSwarm ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs gap-1"
              disabled={loading['__swarm__']}
              onClick={() => setSwarmDialogOpen(true)}
            >
              <Plus className="h-3 w-3" />
              {loading['__swarm__'] ? 'Deploying...' : 'Add Swarm'}
            </Button>
          ) : (
            <>
              {allRunning ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs gap-1"
                  disabled={loading['__stop_all__']}
                  onClick={handleStopAll}
                >
                  <PowerOff className="h-3 w-3" />
                  {loading['__stop_all__'] ? 'Stopping...' : 'Stop All'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-6 px-2 text-xs gap-1"
                  disabled={loading['__start_all__']}
                  onClick={handleStartAll}
                >
                  <Power className="h-3 w-3" />
                  {loading['__start_all__'] ? 'Starting...' : 'Start All'}
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                className="h-6 px-2 text-xs gap-1"
                disabled={loading['__destroy__']}
                onClick={() => setDestroyDialogOpen(true)}
              >
                <Trash2 className="h-3 w-3" />
                {loading['__destroy__'] ? 'Destroying...' : 'Destroy Swarm'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Node cards horizontal */}
      {!hasSwarm ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          No swarm deployed. Click "Add Swarm" to get started.
        </p>
      ) : (
        <div className="flex gap-3 flex-wrap py-1">
          {nodes.map(node => (
            <NodeCard
              key={node.label}
              node={node}
              agentState={states.find(s => s.label === node.label)}
              events={eventsByNode[node.label] ?? []}
              loading={!!loading[node.label]}
              peerIdToLabel={peerIdToLabel}
              now={now}
              onStart={handleStart}
              onStop={handleStop}
              onSetRole={onSetRole}
            />
          ))}
        </div>
      )}

      {/* Deploy Swarm Dialog */}
      <Dialog open={swarmDialogOpen} onOpenChange={setSwarmDialogOpen}>
        <DialogContent className="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle>Deploy Swarm</DialogTitle>
            <DialogDescription>
              Choose the number of nodes for your Vertex consensus network. Each node gets a unique Ed25519 keypair.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="swarm-size">Number of nodes</Label>
            <Input
              id="swarm-size"
              type="number"
              min={4}
              max={26}
              value={swarmSizeInput}
              onChange={(e) => setSwarmSizeInput(e.target.value)}
              className="mt-2"
            />
            <p className="text-xs text-muted-foreground mt-2">
              Minimum 4 nodes required for fault tolerance (f&ge;1). This allows nodes to be stopped and restarted while the swarm continues.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={handleCreateSwarm}>
              Deploy Nodes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Destroy Swarm Confirmation */}
      <AlertDialog open={destroyDialogOpen} onOpenChange={setDestroyDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Destroy Swarm?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop all {nodes.length} nodes and remove the swarm configuration.
              Artifact files (proofs, logs) will be kept on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDestroySwarm}>Destroy</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
