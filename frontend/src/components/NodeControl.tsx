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
import { Power, PowerOff, Server, Plus, Trash2, Check, Flag } from 'lucide-react'
import { timeSince } from '@/lib/utils'
import type { AgentState, EventLogEntry, NodeInfo } from '@/types'
import type {
  EntityRecord,
  GameConfig,
  GamePhase,
  LocalGameSnapshot,
} from '@/game/types'
import { teamColor } from '@/game/presentation'

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

// --- Phase + entity helpers ---

const PHASE_LABELS: Record<GamePhase, string> = {
  no_game: 'no game',
  proposing: 'proposing',
  voting: 'voting',
  loaded: 'loaded',
  placing_entities: 'placing',
  ready: 'ready',
  counting_down: 'countdown',
  playing: 'playing',
  ended: 'ended',
}

const PHASE_COLORS: Record<GamePhase, string> = {
  no_game: 'bg-slate-500/20 text-slate-300',
  proposing: 'bg-amber-500/20 text-amber-300',
  voting: 'bg-amber-500/20 text-amber-300',
  loaded: 'bg-cyan-500/20 text-cyan-300',
  placing_entities: 'bg-cyan-500/20 text-cyan-300',
  ready: 'bg-emerald-500/20 text-emerald-300',
  counting_down: 'bg-emerald-500/20 text-emerald-300',
  playing: 'bg-emerald-500/20 text-emerald-300',
  ended: 'bg-purple-500/20 text-purple-300',
}

function entityGlyph(entityType: string | null | undefined): string {
  switch (entityType) {
    case 'flag': return '🚩'
    case 'base': return '🏰'
    case 'player': return '🟢'
    case 'hill': return '⛰️'
    case 'zone': return '⬛'
    default: return '●'
  }
}

/// Count existing claims for an (entity_type, team) tuple, excluding a
/// specific peer_id (so re-claims by the same node don't count against
/// themselves — mirrors rules.rs::count_claims).
function countClaims(
  entities: Record<string, EntityRecord>,
  entityType: string,
  team: string | null,
  excludePeerId?: string,
): number {
  let n = 0
  for (const e of Object.values(entities)) {
    if (excludePeerId && e.peer_id === excludePeerId) continue
    if (e.entity_type !== entityType) continue
    const eTeam = e.team ?? null
    if (eTeam !== team) continue
    n += 1
  }
  return n
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

// --- Game controls section (entity claim + ready-up) ---

interface NodeGameControlsProps {
  node: NodeInfo
  snapshot?: LocalGameSnapshot
  activeGame?: GameConfig
  canonicalEntities: Record<string, EntityRecord>
  onClaimEntity: (label: string, entityType: string, team: string | null) => Promise<void>
  onReadyUp: (label: string) => Promise<void>
}

function NodeGameControls({
  node,
  snapshot,
  activeGame,
  canonicalEntities,
  onClaimEntity,
  onReadyUp,
}: NodeGameControlsProps) {
  const [claiming, setClaiming] = useState(false)
  const [readying, setReadying] = useState(false)
  const [selectedType, setSelectedType] = useState<string>('')
  const [selectedTeam, setSelectedTeam] = useState<string>('')

  const phase = snapshot?.phase ?? 'no_game'
  const myPeerId = snapshot?.peer_id
  const myEntity = snapshot ? snapshot.entities[node.label] : undefined
  const hasClaimed = !!myEntity?.entity_type
  const isReady = !!myPeerId && (snapshot?.ready_peers ?? []).includes(myPeerId)
  const placementOk = !!snapshot?.placement_ok

  // Nothing to show before a game is loaded, or once in the proposal/vote
  // phases (GameSelectOverlay owns those).
  if (!activeGame || phase === 'no_game' || phase === 'proposing' || phase === 'voting') {
    return null
  }

  // Teams the currently-selected entity type supports.
  const selectedTypeDef = activeGame.entity_types.find(t => t.id === selectedType)
  const needsTeam = selectedTypeDef?.team === 'per_team'
  const teamOptions: Array<string | null> = needsTeam ? activeGame.teams : [null]

  // An entity_type option is disabled when *every* valid team slot for it is
  // already filled. For teamless types there's one slot; for `per_team` types,
  // each team is a slot.
  function isTypeExhausted(typeId: string): boolean {
    const td = activeGame!.entity_types.find(t => t.id === typeId)
    if (!td) return true
    const teams: Array<string | null> = td.team === 'per_team' ? activeGame!.teams : [null]
    return teams.every(t => countClaims(canonicalEntities, typeId, t, myPeerId) >= td.max)
  }

  function isTeamExhausted(typeId: string, team: string | null): boolean {
    const td = activeGame!.entity_types.find(t => t.id === typeId)
    if (!td) return true
    return countClaims(canonicalEntities, typeId, team, myPeerId) >= td.max
  }

  async function handleClaim() {
    if (!selectedType) return
    if (needsTeam && !selectedTeam) return
    setClaiming(true)
    try {
      await onClaimEntity(
        node.label,
        selectedType,
        needsTeam ? selectedTeam : null,
      )
    } finally {
      setClaiming(false)
    }
  }

  async function handleReady() {
    setReadying(true)
    try {
      await onReadyUp(node.label)
    } finally {
      setReadying(false)
    }
  }

  // After-claim display: show the node's entity + ready-up button.
  if (hasClaimed) {
    const teamStr = myEntity?.team ?? null
    return (
      <div className="border-t pt-1 space-y-1">
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-muted-foreground">Entity:</span>
          <span>{entityGlyph(myEntity?.entity_type)}</span>
          <span className="font-medium">{myEntity?.entity_type}</span>
          {teamStr && (
            <span
              className="px-1 rounded text-[9px] font-semibold"
              style={{ backgroundColor: teamColor(teamStr) + '30', color: teamColor(teamStr) }}
            >
              {teamStr}
            </span>
          )}
        </div>
        {phase === 'placing_entities' && (
          isReady ? (
            <Badge variant="outline" className="h-5 text-[10px] bg-emerald-500/20 text-emerald-300 border-emerald-500/40">
              <Check className="h-2.5 w-2.5 mr-0.5" />
              Ready
            </Badge>
          ) : (
            <Button
              size="sm"
              className="h-5 text-[10px] px-2 w-full"
              disabled={readying || !placementOk}
              onClick={handleReady}
              title={placementOk ? 'Signal readiness' : 'Move entity into a valid placement first'}
            >
              {readying ? 'Signalling…' : placementOk ? 'Ready Up' : 'Placement invalid'}
            </Button>
          )
        )}
        {phase === 'ready' && (
          <Badge variant="outline" className="h-5 text-[10px] bg-emerald-500/20 text-emerald-300 border-emerald-500/40">
            <Check className="h-2.5 w-2.5 mr-0.5" />
            Ready
          </Badge>
        )}
      </div>
    )
  }

  // Claim form: only during loaded/placing_entities with no prior claim.
  if (phase !== 'loaded' && phase !== 'placing_entities') {
    return null
  }

  return (
    <div className="border-t pt-1 space-y-1">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Flag className="h-2.5 w-2.5" />
        <span>Claim entity</span>
      </div>
      <div className="flex gap-1">
        <Select
          value={selectedType}
          onValueChange={value => {
            setSelectedType(value ?? '')
            setSelectedTeam('')
          }}
        >
          <SelectTrigger className="h-5 text-[10px] flex-1 px-1.5">
            <SelectValue placeholder="type" />
          </SelectTrigger>
          <SelectContent>
            {activeGame.entity_types.map(et => {
              const exhausted = isTypeExhausted(et.id)
              return (
                <SelectItem key={et.id} value={et.id} disabled={exhausted}>
                  <span className="flex items-center gap-1">
                    <span>{entityGlyph(et.id)}</span>
                    <span>{et.id}</span>
                    {exhausted && <span className="text-[9px] text-muted-foreground">(full)</span>}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        {needsTeam && (
          <Select
            value={selectedTeam}
            onValueChange={value => setSelectedTeam(value ?? '')}
          >
            <SelectTrigger className="h-5 text-[10px] flex-1 px-1.5">
              <SelectValue placeholder="team" />
            </SelectTrigger>
            <SelectContent>
              {teamOptions.filter((t): t is string => !!t).map(team => {
                const exhausted = isTeamExhausted(selectedType, team)
                return (
                  <SelectItem key={team} value={team} disabled={exhausted}>
                    <span
                      className="px-1 rounded text-[9px] font-semibold"
                      style={{ backgroundColor: teamColor(team) + '30', color: teamColor(team) }}
                    >
                      {team}{exhausted ? ' (full)' : ''}
                    </span>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        )}
      </div>
      <Button
        size="sm"
        className="h-5 text-[10px] px-2 w-full"
        disabled={claiming || !selectedType || (needsTeam && !selectedTeam)}
        onClick={handleClaim}
      >
        {claiming ? 'Claiming…' : 'Claim'}
      </Button>
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
  snapshot,
  activeGame,
  canonicalEntities,
  onStart,
  onStop,
  onClaimEntity,
  onReadyUp,
}: {
  node: NodeInfo
  agentState?: AgentState
  events: EventLogEntry[]
  loading: boolean
  peerIdToLabel: Record<string, string>
  now: number
  snapshot?: LocalGameSnapshot
  activeGame?: GameConfig
  canonicalEntities: Record<string, EntityRecord>
  onStart: (label: string) => void
  onStop: (label: string) => void
  onClaimEntity: (label: string, entityType: string, team: string | null) => Promise<void>
  onReadyUp: (label: string) => Promise<void>
}) {
  const phase: GamePhase = snapshot?.phase ?? 'no_game'
  return (
    <Card className="w-56 shrink-0 flex flex-col">
      <CardHeader className="py-2 px-3">
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full shrink-0 ${node.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
          <span className="font-medium text-sm">{node.label}</span>
          <span className="text-[10px] text-muted-foreground">{node.bind}</span>
          {node.status === 'running' && phase !== 'no_game' && (
            <span className={`text-[9px] font-semibold px-1 rounded ${PHASE_COLORS[phase]}`}>
              {PHASE_LABELS[phase]}
            </span>
          )}
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
        {agentState && (
          <div className="text-[10px] space-y-0.5">
            {agentState.peers && Object.entries(agentState.peers).sort(([, a], [, b]) => (peerIdToLabel[a.peer_id] ?? a.peer_id).localeCompare(peerIdToLabel[b.peer_id] ?? b.peer_id)).map(([peerId, peer]) => {
              const isStale = now - peer.last_seen_ms > 15_000
              const peerLabel = peerIdToLabel[peer.peer_id]
              const peerEntity = peerLabel ? canonicalEntities[peerLabel] : undefined
              const entityType = peerEntity?.entity_type ?? null
              const entityTeam = peerEntity?.team ?? null
              return (
                <div key={peerId} className={`flex items-center gap-1 ${isStale ? 'opacity-50' : ''}`}>
                  <span className="text-muted-foreground w-12 shrink-0 truncate">{peerLabel ?? shortId(peer.peer_id)}</span>
                  {entityType ? (
                    <Badge variant="outline" className="text-[9px] px-0.5 py-0 leading-tight gap-0.5">
                      <span>{entityGlyph(entityType)}</span>
                      <span>{entityType}</span>
                      {entityTeam && (
                        <span
                          className="px-0.5 rounded text-[9px] font-semibold"
                          style={{ backgroundColor: teamColor(entityTeam) + '30', color: teamColor(entityTeam) }}
                        >
                          {entityTeam}
                        </span>
                      )}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] px-0.5 py-0 leading-tight text-muted-foreground">
                      unclaimed
                    </Badge>
                  )}
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

        <NodeGameControls
          node={node}
          snapshot={snapshot}
          activeGame={activeGame}
          canonicalEntities={canonicalEntities}
          onClaimEntity={onClaimEntity}
          onReadyUp={onReadyUp}
        />

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
  snapshots: Record<string, LocalGameSnapshot>
  games: GameConfig[]
  onStart: (label: string) => Promise<void>
  onStop: (label: string) => Promise<void>
  onCreateSwarm: (count: number) => Promise<void>
  onDestroySwarm: () => Promise<void>
  onClaimEntity: (label: string, entityType: string, team: string | null) => Promise<void>
  onReadyUp: (label: string) => Promise<void>
}

export const NodeControl = memo(function NodeControl({
  nodes,
  states,
  events,
  snapshots,
  games,
  onStart,
  onStop,
  onCreateSwarm,
  onDestroySwarm,
  onClaimEntity,
  onReadyUp,
}: Props) {
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

  // Resolve the currently-active game from snapshots. Nodes converge via
  // consensus, so any non-empty `active_game_id` across snapshots is
  // authoritative; ties shouldn't happen in practice.
  const activeGame = useMemo<GameConfig | undefined>(() => {
    for (const snap of Object.values(snapshots)) {
      if (snap.active_game_id) {
        return games.find(g => g.id === snap.active_game_id)
      }
    }
    return undefined
  }, [snapshots, games])

  // Canonical view of all entity claims across snapshots. Each node's
  // snapshot should converge to the same set; we merge by label, preferring
  // the richest (i.e. `entity_type`-set) record.
  const canonicalEntities = useMemo<Record<string, EntityRecord>>(() => {
    const out: Record<string, EntityRecord> = {}
    for (const snap of Object.values(snapshots)) {
      for (const [label, rec] of Object.entries(snap.entities)) {
        const existing = out[label]
        if (!existing || (!existing.entity_type && rec.entity_type)) {
          out[label] = rec
        }
      }
    }
    return out
  }, [snapshots])

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
              snapshot={snapshots[node.label]}
              activeGame={activeGame}
              canonicalEntities={canonicalEntities}
              onStart={handleStart}
              onStop={handleStop}
              onClaimEntity={onClaimEntity}
              onReadyUp={onReadyUp}
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
