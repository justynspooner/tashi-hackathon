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
import { Power, PowerOff, Server, Plus, Trash2, Check, Flag, Gamepad2, Activity } from 'lucide-react'
import { timeSince } from '@/lib/utils'
import type { AgentState, EventLogEntry, NodeInfo } from '@/types'
import type {
  EntityRecord,
  GameConfig,
  GamePhase,
  LocalGameSnapshot,
  Position,
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

// --- Proposal/vote window helpers ---
//
// The `proposal_window.proposers` / `vote_window.votes` maps are keyed by
// peer_id → game_id. Each snapshot converges to the same view via consensus,
// so reading any one snapshot is authoritative.

interface ProposalWindow {
  started_at_ms?: number
  proposers?: Record<string, string>
}

interface VoteWindow {
  started_at_ms?: number
  votes?: Record<string, string>
}

function readProposalWindow(snap: LocalGameSnapshot | undefined): ProposalWindow | undefined {
  return snap?.proposal_window as ProposalWindow | undefined
}

function readVoteWindow(snap: LocalGameSnapshot | undefined): VoteWindow | undefined {
  return snap?.vote_window as VoteWindow | undefined
}

function tallyPicks(
  snapshots: Record<string, LocalGameSnapshot>,
  which: 'proposal_window' | 'vote_window',
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const snap of Object.values(snapshots)) {
    const picks = which === 'proposal_window'
      ? readProposalWindow(snap)?.proposers
      : readVoteWindow(snap)?.votes
    if (!picks) continue
    for (const gid of Object.values(picks)) {
      out[gid] = (out[gid] ?? 0) + 1
    }
    // Snapshots converge — reading one is enough.
    break
  }
  return out
}

function windowStartedAt(
  snapshots: Record<string, LocalGameSnapshot>,
  which: 'proposal_window' | 'vote_window',
): number | null {
  for (const snap of Object.values(snapshots)) {
    const win = which === 'proposal_window' ? readProposalWindow(snap) : readVoteWindow(snap)
    if (win?.started_at_ms) return win.started_at_ms
  }
  return null
}

/** Poll Date.now() every second; returns seconds-remaining or null. */
function useSecondsRemaining(startedAtMs: number | null, windowMs: number): number | null {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])
  void tick
  if (!startedAtMs) return null
  const elapsed = Date.now() - startedAtMs
  return Math.max(0, Math.ceil((windowMs - elapsed) / 1000))
}

// --- Per-node compact game-select control (propose/vote) ---

interface NodeGameSelectProps {
  node: NodeInfo
  snapshot?: LocalGameSnapshot
  games: GameConfig[]
  onProposeGame: (label: string, gameId: string) => Promise<void>
  onVoteGame: (label: string, gameId: string) => Promise<void>
}

function NodeGameSelect({
  node,
  snapshot,
  games,
  onProposeGame,
  onVoteGame,
}: NodeGameSelectProps) {
  const [selectedGame, setSelectedGame] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [changing, setChanging] = useState(false)

  const phase = snapshot?.phase ?? 'no_game'
  const myPeerId = snapshot?.peer_id
  const isVoting = phase === 'voting'
  const actionVerb = isVoting ? 'Vote' : 'Propose'

  // Only visible during no_game / proposing / voting; once a game is loaded,
  // NodeGameControls takes over.
  if (!['no_game', 'proposing', 'voting'].includes(phase)) return null

  // What has this node already committed in the current window?
  const proposers = readProposalWindow(snapshot)?.proposers ?? {}
  const votes = readVoteWindow(snapshot)?.votes ?? {}
  const committedGameId = isVoting
    ? (myPeerId ? votes[myPeerId] : undefined)
    : (phase === 'proposing' && myPeerId ? proposers[myPeerId] : undefined)
  const committed = games.find(g => g.id === committedGameId)

  // Hide the form entirely on stopped nodes — they can't broadcast.
  const disabled = node.status !== 'running' || games.length === 0

  async function handleSubmit() {
    if (!selectedGame) return
    setSubmitting(true)
    try {
      if (isVoting) {
        await onVoteGame(node.label, selectedGame)
      } else {
        await onProposeGame(node.label, selectedGame)
      }
      setChanging(false)
    } finally {
      setSubmitting(false)
    }
  }

  // If committed and not actively changing, show the committed pill.
  if (committed && !changing) {
    return (
      <div className="flex items-center gap-1 text-[10px] border-t pt-1">
        <Gamepad2 className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground">{actionVerb}d:</span>
        <Badge variant="outline" className="h-4 px-1 text-[10px] leading-tight">
          {committed.name}
        </Badge>
        <button
          type="button"
          className="ml-auto text-[9px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          onClick={() => setChanging(true)}
        >
          change
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1 text-[10px] border-t pt-1">
      <Gamepad2 className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
      <Select value={selectedGame} onValueChange={v => setSelectedGame(v ?? '')} disabled={disabled}>
        <SelectTrigger className="h-5 text-[10px] flex-1 px-1.5">
          <SelectValue placeholder="game" />
        </SelectTrigger>
        <SelectContent>
          {games.map(g => (
            <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        className="h-5 text-[10px] px-2"
        disabled={disabled || !selectedGame || submitting}
        onClick={handleSubmit}
      >
        {submitting ? '…' : actionVerb}
      </Button>
    </div>
  )
}

// --- Game runtime section (per-node gameplay state during `playing`) ---
//
// During the playing phase the entity positions converge through consensus on
// SensorReadings, and rules mutate `entity.properties` (e.g. `owner_team`) or
// track proximity durations in `snapshot.proximity_tracker`. Surfacing these
// per node gives immediate visual feedback when dragging entities around.

/** Mirrors `src/rules.rs::proximity_key`. */
function proximityKey(ruleId: string, labelA: string, labelB: string): string {
  const [lo, hi] = labelA <= labelB ? [labelA, labelB] : [labelB, labelA]
  return `${ruleId}|${lo}|${hi}`
}

function distanceM(a: Position | null | undefined, b: Position | null | undefined): number | null {
  if (!a || !b) return null
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** Find the closest entity of the given type to `from`, ignoring entities
 *  without a position. Returns null if none exist. */
function closestEntityOfType(
  entities: Record<string, EntityRecord>,
  from: Position | null | undefined,
  entityType: string,
): { entity: EntityRecord; distance: number } | null {
  if (!from) return null
  let best: { entity: EntityRecord; distance: number } | null = null
  for (const e of Object.values(entities)) {
    if (e.entity_type !== entityType) continue
    const d = distanceM(from, e.pos)
    if (d == null) continue
    if (!best || d < best.distance) best = { entity: e, distance: d }
  }
  return best
}

/**
 * Pull the set of per-rule proximity-duration specs from a game config, keyed
 * by the rule-firing entity's type. Used to render progress bars toward the
 * rule's `min_s` threshold for the matching node.
 *
 * The config schema types `when`/`effect` as `unknown` on the frontend, so we
 * read them defensively with a recursive walker.
 */
interface ProximityRuleInfo {
  ruleId: string
  selfEntityType: string
  peerEntityType: string
  maxM: number
  minS: number
  /** Optional key/label surfaced when describing the rule's effect to the UI. */
  effectLabel: string
}

function extractProximityRules(game: GameConfig | undefined): ProximityRuleInfo[] {
  if (!game) return []
  const out: ProximityRuleInfo[] = []
  for (const rule of game.rules) {
    const when = rule.when as Record<string, unknown>
    const clauses = Array.isArray((when as { of?: unknown }).of)
      ? ((when as { of: unknown[] }).of)
      : [when]
    // First clause defines self entity type via `entity_is`; later clauses
    // might carry the proximity_duration_s spec.
    let selfEntityType: string | undefined
    let proximity: { peer: string; maxM: number; minS: number } | undefined
    for (const raw of clauses) {
      const c = raw as Record<string, unknown>
      if (c.kind === 'entity_is' && typeof c.entity_type === 'string') {
        selfEntityType = c.entity_type
      }
      if (
        c.kind === 'proximity_duration_s' &&
        typeof c.peer_entity_type === 'string' &&
        typeof c.max_m === 'number' &&
        typeof c.min_s === 'number'
      ) {
        proximity = { peer: c.peer_entity_type, maxM: c.max_m, minS: c.min_s }
      }
    }
    if (!selfEntityType || !proximity) continue

    const effect = rule.effect as Record<string, unknown>
    const effectLabel =
      effect.kind === 'set_property' && typeof effect.key === 'string'
        ? `set ${effect.key}`
        : effect.kind === 'increment_score'
          ? 'score +1'
          : typeof effect.kind === 'string'
            ? effect.kind
            : 'effect'

    out.push({
      ruleId: rule.id,
      selfEntityType,
      peerEntityType: proximity.peer,
      maxM: proximity.maxM,
      minS: proximity.minS,
      effectLabel,
    })
  }
  return out
}

interface NodeGameRuntimeProps {
  node: NodeInfo
  snapshot?: LocalGameSnapshot
  activeGame?: GameConfig
}

/** Filter out internal bookkeeping keys (prefixed `__`) and return a stable
 *  sort order so each card's score pills line up left-to-right consistently. */
function visibleScoreTeams(scores: Record<string, number> | undefined): string[] {
  if (!scores) return []
  return Object.keys(scores)
    .filter(t => !t.startsWith('__'))
    .sort()
}

/** Format non-negative seconds as `MM:SS`. Mirrors the helper in GameView. */
function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const mm = Math.floor(s / 60).toString().padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

/** Keys whose raw numeric values are internal bookkeeping for the rules
 *  engine (e.g. CTF's `hold_pulse_ms` — a per-tick now_ms delta beacon) and
 *  should never be rendered verbatim in the UI. */
const HIDDEN_PROPERTY_KEYS: ReadonlySet<string> = new Set(['hold_pulse_ms'])

function NodeGameRuntime({ node, snapshot, activeGame }: NodeGameRuntimeProps) {
  // Re-render at ~4Hz while playing so proximity progress bars tick smoothly
  // between snapshot arrivals (SensorReadings land every ~2s).
  const [, setTick] = useState(0)
  const phase = snapshot?.phase ?? 'no_game'
  const isLive = phase === 'playing' || phase === 'ended'
  useEffect(() => {
    if (!isLive) return
    const id = window.setInterval(() => setTick(t => t + 1), 250)
    return () => window.clearInterval(id)
  }, [isLive])

  // Score-change flash: when any team's score on THIS node goes up, flash the
  // matching pill amber for ~1.2s so the user sees the increment hit this
  // specific node via consensus. Per-team flash timestamps are kept in a ref
  // so mutating them doesn't force re-renders.
  const prevScoresRef = useRef<Record<string, number>>({})
  const flashAtRef = useRef<Record<string, number>>({})
  const scoresNow = snapshot?.scores ?? {}
  useEffect(() => {
    const prev = prevScoresRef.current
    const now = Date.now()
    for (const [team, value] of Object.entries(scoresNow)) {
      if (team.startsWith('__')) continue
      const before = prev[team] ?? 0
      if (value > before) flashAtRef.current[team] = now
    }
    prevScoresRef.current = { ...scoresNow }
    // Intentional: we key on the serialized snapshot.scores identity so this
    // runs whenever the backend persists a new score map.
  }, [scoresNow])

  if (!isLive || !activeGame || !snapshot) return null

  const myEntity = snapshot.entities[node.label]
  const myType = myEntity?.entity_type ?? null
  const myPos = myEntity?.pos ?? null

  // Derive the timed-game deadline from `countdown_zero_ns + 3s + duration_s`
  // so every node ticks down against the same consensus-pinned clock. If the
  // game is untimed (duration_s unset), elapsedS is still useful to surface.
  const countdownZeroNs = snapshot.countdown_zero_ns ?? null
  const startMs = countdownZeroNs != null
    ? Math.floor(countdownZeroNs / 1_000_000) + 3_000
    : null
  const nowMs = Date.now()
  const elapsedS = startMs != null ? Math.max(0, Math.floor((nowMs - startMs) / 1000)) : null
  const remainingS = activeGame.duration_s != null && elapsedS != null
    ? Math.max(0, activeGame.duration_s - elapsedS)
    : null

  // 1) Property row: if this node's entity is the target of any set_property
  // rule, surface the current value (e.g. flag.holding_team, flag.captured_by).
  const setPropertyRules = activeGame.rules.filter(r => {
    const eff = r.effect as Record<string, unknown>
    return eff.kind === 'set_property' && typeof eff.target_entity_type === 'string'
  })
  const propertyRows: Array<{ key: string; value: string | null; highlightTeam: boolean }> = []
  const seenPropertyKeys = new Set<string>()
  for (const r of setPropertyRules) {
    const eff = r.effect as Record<string, unknown>
    if (eff.target_entity_type !== myType) continue
    const key = typeof eff.key === 'string' ? eff.key : null
    if (!key) continue
    if (HIDDEN_PROPERTY_KEYS.has(key)) continue
    // A game can reference the same key in multiple rules (CTF's hold_pulse /
    // mark_holding both write through flag) — only surface each key once.
    if (seenPropertyKeys.has(key)) continue
    seenPropertyKeys.add(key)
    const raw = myEntity?.properties?.[key]
    const value = raw == null ? null : String(raw)
    propertyRows.push({ key, value, highlightTeam: key.endsWith('team') })
  }

  // 2) Proximity progress rows: for each rule whose `self` type matches this
  // node's entity, find the nearest peer-type entity and render a progress
  // bar driven by the proximity_tracker entry (if any). Multiple rules can
  // share a `(self, peer, max_m, min_s)` spec (CTF's `mark_holding` /
  // `hold_pulse` / etc.) — dedupe so the node renders one bar per unique
  // proximity gate, not one per rule.
  const proximityRules = extractProximityRules(activeGame).filter(
    r => r.selfEntityType === myType,
  )
  const seenProximityKeys = new Set<string>()
  const dedupedProximityRules = proximityRules.filter(r => {
    const key = `${r.peerEntityType}|${r.maxM}|${r.minS}`
    if (seenProximityKeys.has(key)) return false
    seenProximityKeys.add(key)
    return true
  })
  const now = Date.now()
  const proximityRows = dedupedProximityRules.map(r => {
    const closest = closestEntityOfType(snapshot.entities, myPos, r.peerEntityType)
    // Any rule sharing this proximity spec populates the tracker under its
    // own rule_id; prefer the one whose key is actually populated so dedup
    // doesn't silently lose a live progress bar.
    let startMs: number | undefined
    if (closest) {
      for (const candidate of proximityRules) {
        if (
          candidate.peerEntityType !== r.peerEntityType ||
          candidate.maxM !== r.maxM ||
          candidate.minS !== r.minS
        ) {
          continue
        }
        const trackerKey = proximityKey(candidate.ruleId, node.label, closest.entity.label)
        const t = snapshot.proximity_tracker?.[trackerKey]
        if (t != null) {
          startMs = t
          break
        }
      }
    }
    const elapsedMs = startMs != null ? Math.max(0, now - startMs) : 0
    const thresholdMs = r.minS * 1000
    const pct = thresholdMs > 0 ? Math.min(100, (elapsedMs / thresholdMs) * 100) : 0
    const elapsedS = elapsedMs / 1000
    return {
      rule: r,
      closest,
      active: startMs != null,
      pct,
      elapsedS,
    }
  })

  // 3) "Seen by" row for untargeted entities (flag, hill, zone) — show whose
  // is closest so the user knows who's threatening the objective.
  const entityTypeDef = activeGame.entity_types.find(t => t.id === myType)
  const watchNearest = entityTypeDef && entityTypeDef.team === null
  const nearestPlayer = watchNearest ? closestEntityOfType(snapshot.entities, myPos, 'player') : null

  // Per-node score view — derived from THIS node's `scores` map. Because
  // tick/delta rules run independently on every node, the values can briefly
  // diverge mid-propagation, which is exactly what we want to surface: you
  // can see each node applying its own IncrementScore.
  const scoreTeams = visibleScoreTeams(snapshot.scores)
  // Include every team declared in the active game so a 0 pill is visible
  // before anyone has scored — otherwise you only see a team once it ticks.
  const displayTeams = Array.from(new Set([...scoreTeams, ...activeGame.teams])).sort()
  const FLASH_MS = 1200

  const anyRow = propertyRows.length > 0 || proximityRows.length > 0 || nearestPlayer || displayTeams.length > 0
  // When the game declares a duration (CTF: 600s), score pills represent
  // accumulated hold seconds — render them as MM:SS so they're legible at a
  // glance. For untimed games (KotH, Territory) the raw integer tick count
  // is still the most meaningful number.
  const scoreIsDuration = activeGame.duration_s != null
  const formatScore = (v: number): string => (scoreIsDuration ? formatMmSs(v) : String(v))

  return (
    <div className="border-t pt-1 space-y-1">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Activity className="h-2.5 w-2.5 text-emerald-400" />
        <span>Runtime</span>
        {remainingS != null && (
          <span
            className={`tabular-nums font-mono text-[9px] font-semibold px-1 rounded ${
              phase === 'ended'
                ? 'bg-purple-500/20 text-purple-200'
                : remainingS <= 30
                  ? 'bg-amber-500/20 text-amber-300 animate-pulse'
                  : 'bg-emerald-500/20 text-emerald-300'
            }`}
            title={
              phase === 'ended'
                ? 'Game ended'
                : `Time remaining · ${activeGame.duration_s}s total`
            }
          >
            ⏱ {formatMmSs(remainingS)}
          </span>
        )}
        {remainingS == null && elapsedS != null && (
          <span
            className="tabular-nums font-mono text-[9px] font-semibold px-1 rounded bg-slate-500/20 text-slate-200"
            title="Elapsed play time"
          >
            ⏱ {formatMmSs(elapsedS)}
          </span>
        )}
        {phase === 'playing' && (
          <span className="ml-auto flex items-center gap-0.5 text-[9px] font-semibold text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
        )}
        {phase === 'ended' && (
          <span className="ml-auto text-[9px] font-semibold text-purple-300">ENDED</span>
        )}
      </div>

      {phase === 'ended' && snapshot.ended_reason && (
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-muted-foreground">Winner:</span>
          {snapshot.ended_winner_team ? (
            <span
              className="px-1 rounded text-[9px] font-semibold"
              style={{
                backgroundColor: teamColor(snapshot.ended_winner_team) + '30',
                color: teamColor(snapshot.ended_winner_team),
              }}
            >
              {snapshot.ended_winner_team}
            </span>
          ) : (
            <span className="px-1 rounded text-[9px] font-semibold bg-slate-500/20 text-slate-200">
              draw
            </span>
          )}
          <span className="text-[9px] text-muted-foreground italic truncate">
            {snapshot.ended_reason}
          </span>
        </div>
      )}

      {displayTeams.length > 0 && (
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-muted-foreground">
            {scoreIsDuration ? 'Hold:' : 'Scores:'}
          </span>
          <div className="flex items-center gap-0.5 flex-wrap">
            {displayTeams.map(team => {
              const value = snapshot.scores?.[team] ?? 0
              const flashAt = flashAtRef.current[team] ?? 0
              const flashing = Date.now() - flashAt < FLASH_MS
              return (
                <span
                  key={team}
                  className={`px-1 rounded text-[9px] font-semibold tabular-nums transition-shadow duration-300 ${
                    flashing ? 'ring-2 ring-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.7)]' : ''
                  }`}
                  style={{
                    backgroundColor: teamColor(team) + '30',
                    color: teamColor(team),
                  }}
                  title={
                    scoreIsDuration
                      ? `This node's local hold time for ${team}: ${value}s`
                      : `This node's local scores[${team}] = ${value}`
                  }
                >
                  {team} {formatScore(value)}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {!anyRow && (
        <div className="text-[10px] text-muted-foreground italic">
          No gameplay signals yet.
        </div>
      )}

      {propertyRows.map(row => (
        <div key={row.key} className="flex items-center gap-1 text-[10px]">
          <span className="text-muted-foreground">{row.key}:</span>
          {row.value == null ? (
            <span className="text-muted-foreground italic">unset</span>
          ) : row.highlightTeam ? (
            <span
              className="px-1 rounded text-[9px] font-semibold"
              style={{
                backgroundColor: teamColor(row.value) + '30',
                color: teamColor(row.value),
              }}
            >
              {row.value}
            </span>
          ) : (
            <span className="font-semibold">{row.value}</span>
          )}
        </div>
      ))}

      {proximityRows.map(row => (
        <div key={row.rule.ruleId} className="space-y-0.5">
          <div className="flex items-center gap-1 text-[10px]">
            <span>{entityGlyph(row.rule.peerEntityType)}</span>
            <span className="text-muted-foreground truncate">
              {row.rule.peerEntityType}
              {row.closest ? ` · ${row.closest.distance.toFixed(1)}m` : ' · —'}
            </span>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {row.elapsedS.toFixed(1)}/{row.rule.minS}s
            </span>
          </div>
          <div className="h-1 bg-muted rounded overflow-hidden">
            <div
              className={`h-full transition-all ${
                row.active ? 'bg-emerald-400' : 'bg-muted-foreground/20'
              }`}
              style={{ width: `${row.pct}%` }}
            />
          </div>
        </div>
      ))}

      {!propertyRows.length && nearestPlayer && (
        <div className="flex items-center gap-1 text-[10px]">
          <span>{entityGlyph('player')}</span>
          <span className="text-muted-foreground truncate">
            closest {nearestPlayer.entity.label}
            {nearestPlayer.entity.team ? ` (${nearestPlayer.entity.team})` : ''}
          </span>
          <span className="ml-auto tabular-nums text-muted-foreground">
            {nearestPlayer.distance.toFixed(1)}m
          </span>
        </div>
      )}
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

  // Nothing to show before a game is loaded, or during proposal/vote phases
  // (NodeGameSelect owns those).
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
    // The "Ready" phase is just a per-node gate indicating that this node's
    // placement passes validation — it does NOT mean the user has broadcast
    // their ReadyUp. We must keep the Ready Up button visible until the
    // user's peer_id actually appears in `ready_peers`, otherwise there is
    // no way to progress the game past `ready` → `counting_down`.
    const inReadyStage = phase === 'placing_entities' || phase === 'ready'
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
        {inReadyStage && (
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
              title={placementOk ? 'Broadcast ReadyUp to start countdown' : 'Move entity into a valid placement first'}
            >
              {readying ? 'Signalling…' : placementOk ? 'Ready Up' : 'Placement invalid'}
            </Button>
          )
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
  games,
  canonicalEntities,
  onStart,
  onStop,
  onProposeGame,
  onVoteGame,
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
  games: GameConfig[]
  canonicalEntities: Record<string, EntityRecord>
  onStart: (label: string) => void
  onStop: (label: string) => void
  onProposeGame: (label: string, gameId: string) => Promise<void>
  onVoteGame: (label: string, gameId: string) => Promise<void>
  onClaimEntity: (label: string, entityType: string, team: string | null) => Promise<void>
  onReadyUp: (label: string) => Promise<void>
}) {
  const phase: GamePhase = snapshot?.phase ?? 'no_game'
  // All nodes listen on 127.0.0.1, so showing the full `bind` here wastes
  // horizontal space. Display just the port — the IP is implicit.
  const bindPort = node.bind.split(':').pop() ?? node.bind

  // Kickoff cue: pulse the card's ring for ~1.5s when the phase first flips
  // into `playing`. We track the previous phase via a ref so the animation
  // fires exactly once per transition, not on every re-render.
  const [kickoffActive, setKickoffActive] = useState(false)
  const prevPhaseRef = useRef<GamePhase>(phase)
  useEffect(() => {
    if (prevPhaseRef.current !== 'playing' && phase === 'playing') {
      setKickoffActive(true)
      const t = window.setTimeout(() => setKickoffActive(false), 1500)
      return () => window.clearTimeout(t)
    }
    prevPhaseRef.current = phase
  }, [phase])
  useEffect(() => {
    prevPhaseRef.current = phase
  }, [phase])

  return (
    <Card
      className={`w-48 shrink-0 flex flex-col transition-shadow duration-500 ${
        kickoffActive ? 'ring-2 ring-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.55)]' : ''
      }`}
    >
      <CardHeader className="py-2 px-3">
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full shrink-0 ${node.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
          <span className="font-medium text-sm">{node.label}</span>
          <span className="text-[10px] text-muted-foreground" title={node.bind}>:{bindPort}</span>
          {node.status === 'running' && phase !== 'no_game' && (
            <span
              className={`text-[9px] font-semibold px-1 rounded ${PHASE_COLORS[phase]} ${
                phase === 'playing' ? 'animate-pulse' : ''
              }`}
            >
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

        <NodeGameSelect
          node={node}
          snapshot={snapshot}
          games={games}
          onProposeGame={onProposeGame}
          onVoteGame={onVoteGame}
        />

        <NodeGameControls
          node={node}
          snapshot={snapshot}
          activeGame={activeGame}
          canonicalEntities={canonicalEntities}
          onClaimEntity={onClaimEntity}
          onReadyUp={onReadyUp}
        />

        <NodeGameRuntime
          node={node}
          snapshot={snapshot}
          activeGame={activeGame}
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
  onProposeGame: (label: string, gameId: string) => Promise<void>
  onVoteGame: (label: string, gameId: string) => Promise<void>
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
  onProposeGame,
  onVoteGame,
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

  // Filter events per node (exclude noisy tags). Each bucket is capped to the
  // most recent PER_NODE_EVENT_CAP entries — the per-node `NodeEventLog` is
  // rendered without virtualisation, so an uncapped bucket (combined with a
  // large swarm) can balloon the DOM to tens of thousands of rows and trip
  // the renderer's memory limit over long sessions.
  const eventsByNode = useMemo(() => {
    const PER_NODE_EVENT_CAP = 100
    const map: Record<string, EventLogEntry[]> = {}
    const remaining: Record<string, number> = {}
    for (const node of nodes) {
      map[node.label] = []
      remaining[node.label] = PER_NODE_EVENT_CAP
    }
    // Walk newest→oldest so we keep only the most recent `PER_NODE_EVENT_CAP`
    // events per label, independent of how large the full buffer has grown.
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.tag === 'VERTEX_RX' || ev.tag === 'VERTEX_TX' || ev.tag === 'FINALITY') continue
      const left = remaining[ev.label]
      if (left === undefined || left <= 0) continue
      map[ev.label].push(ev)
      remaining[ev.label] = left - 1
    }
    // Restore chronological order for rendering.
    for (const label of Object.keys(map)) {
      map[label].reverse()
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

  // Aggregate game-selection phase across all snapshots — proposing/voting are
  // the only phases where the per-node selectors are interactive. Once any
  // snapshot reports a loaded game, hide the tally.
  const selectionPhase = useMemo<'none' | 'proposing' | 'voting'>(() => {
    const phases = Object.values(snapshots).map(s => s.phase)
    if (phases.some(p => ['loaded', 'placing_entities', 'ready', 'counting_down', 'playing', 'ended'].includes(p))) {
      return 'none'
    }
    if (phases.some(p => p === 'voting')) return 'voting'
    if (phases.some(p => p === 'proposing')) return 'proposing'
    return 'none'
  }, [snapshots])

  const tally = useMemo(
    () =>
      tallyPicks(
        snapshots,
        selectionPhase === 'voting' ? 'vote_window' : 'proposal_window',
      ),
    [snapshots, selectionPhase],
  )
  const windowStart = useMemo(
    () =>
      windowStartedAt(
        snapshots,
        selectionPhase === 'voting' ? 'vote_window' : 'proposal_window',
      ),
    [snapshots, selectionPhase],
  )
  const secondsLeft = useSecondsRemaining(
    selectionPhase === 'none' ? null : windowStart,
    30_000,
  )

  // Ready-up stage helpers: during `placing_entities` / `ready`, show a
  // consolidated progress strip and a "Ready All" helper button so the user
  // doesn't have to click through every card individually. The swarm-wide
  // transition to `counting_down` needs *every* running node to broadcast a
  // ReadyUp; this aggregates that state.
  const readyStage = useMemo<'none' | 'ready_up'>(() => {
    const phases = Object.values(snapshots).map(s => s.phase)
    if (phases.some(p => ['counting_down', 'playing', 'ended'].includes(p))) {
      return 'none'
    }
    if (phases.some(p => p === 'placing_entities' || p === 'ready')) {
      return 'ready_up'
    }
    return 'none'
  }, [snapshots])

  const readyProgress = useMemo(() => {
    const runningLabels = new Set(nodes.filter(n => n.status === 'running').map(n => n.label))
    // Pull the canonical ready-peer list: any snapshot suffices since the set
    // converges through consensus.
    const readyPeerIds = new Set<string>()
    for (const snap of Object.values(snapshots)) {
      for (const p of snap.ready_peers ?? []) readyPeerIds.add(p)
    }
    let ready = 0
    const remainingLabels: string[] = []
    for (const label of runningLabels) {
      const snap = snapshots[label]
      const myPeerId = snap?.peer_id
      if (myPeerId && readyPeerIds.has(myPeerId)) ready += 1
      else remainingLabels.push(label)
    }
    return { ready, total: runningLabels.size, remaining: remainingLabels }
  }, [nodes, snapshots])

  async function handleReadyAll() {
    setLoading(prev => ({ ...prev, '__ready_all__': true }))
    try {
      for (const label of readyProgress.remaining) {
        const snap = snapshots[label]
        // Only signal for nodes whose placement is valid — otherwise the
        // backend would ignore the ReadyUp anyway.
        if (snap?.placement_ok && snap.entities[label]?.entity_type) {
          await onReadyUp(label)
        }
      }
    } finally {
      setLoading(prev => ({ ...prev, '__ready_all__': false }))
    }
  }

  // Number of nodes that *can* ready-up right now (entity claimed + valid
  // placement). Used to enable/disable the Ready All button.
  const readyableCount = useMemo(() => {
    let n = 0
    for (const label of readyProgress.remaining) {
      const snap = snapshots[label]
      if (snap?.placement_ok && snap.entities[label]?.entity_type) n += 1
    }
    return n
  }, [readyProgress.remaining, snapshots])

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

      {/* Inline game-selection tally: one-line summary during proposing/voting
          so users can see convergence without opening every card. */}
      {hasSwarm && selectionPhase !== 'none' && (
        <div className="flex items-center gap-3 text-xs flex-wrap bg-muted/40 border rounded px-2 py-1">
          <span className="font-medium">
            {selectionPhase === 'voting' ? 'Voting' : 'Proposing'}
            {secondsLeft !== null ? ` · ${secondsLeft}s` : ''}
          </span>
          {games.map(g => {
            const count = tally[g.id] ?? 0
            const total = nodes.length
            const pct = total > 0 ? Math.round((count / total) * 100) : 0
            return (
              <div key={g.id} className="flex items-center gap-1.5 text-muted-foreground">
                <span className="font-mono">{g.name}</span>
                <div className="w-14 h-1.5 bg-muted rounded overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="tabular-nums text-[10px]">{count}/{total}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Ready-up progress strip: during placing_entities / ready, shows how
          many nodes have broadcast ReadyUp and offers a one-click helper to
          fire it on every remaining eligible node. Once everyone's ready the
          backend pins `countdown_zero_ns` and flips to `counting_down`. */}
      {hasSwarm && readyStage === 'ready_up' && (
        <div className="flex items-center gap-3 text-xs bg-muted/40 border rounded px-2 py-1">
          <span className="font-medium">Ready check</span>
          <div className="flex items-center gap-1.5 text-muted-foreground flex-1 min-w-0">
            <div className="w-24 h-1.5 bg-muted rounded overflow-hidden shrink-0">
              <div
                className="h-full bg-emerald-400 transition-all"
                style={{
                  width: `${readyProgress.total > 0 ? Math.round((readyProgress.ready / readyProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
            <span className="tabular-nums text-[10px] shrink-0">
              {readyProgress.ready}/{readyProgress.total} signalled
            </span>
            {readyProgress.ready < readyProgress.total && (
              <span className="text-[10px] truncate">
                · awaiting {readyProgress.remaining.length}{readyableCount < readyProgress.remaining.length ? ` (${readyableCount} ready to sign)` : ''}
              </span>
            )}
          </div>
          <Button
            size="sm"
            className="h-6 px-2 text-xs gap-1"
            disabled={loading['__ready_all__'] || readyableCount === 0}
            onClick={handleReadyAll}
            title={
              readyableCount === 0
                ? 'All eligible nodes have already signalled — the remaining nodes still have invalid placement'
                : `Broadcast ReadyUp on ${readyableCount} node${readyableCount === 1 ? '' : 's'}`
            }
          >
            <Check className="h-3 w-3" />
            {loading['__ready_all__'] ? 'Signalling…' : 'Ready All'}
          </Button>
        </div>
      )}

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
              games={games}
              canonicalEntities={canonicalEntities}
              onStart={handleStart}
              onStop={handleStop}
              onProposeGame={onProposeGame}
              onVoteGame={onVoteGame}
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
