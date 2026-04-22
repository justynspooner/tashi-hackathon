// Shared helpers extracted from NodeControl.tsx + GameView.tsx during the
// canvas-centric UI refactor. Keep this module free of React hooks so it can
// be imported from tree rendering, inspector panels, canvas HUDs, and
// headless tests alike.

import type {
  EntityRecord,
  GameConfig,
  GamePhase,
  LocalGameSnapshot,
  Position,
} from '@/game/types'

// ---------- Event-log tag + phase palette ----------

export const TAG_COLORS: Record<string, string> = {
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

export const PHASE_LABELS: Record<GamePhase, string> = {
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

export const PHASE_COLORS: Record<GamePhase, string> = {
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

// ---------- Short-id / message-id / timestamp helpers ----------

export function shortId(id: string): string {
  return id.slice(-4)
}

export function shortMessageId(id: string | null | undefined): string {
  if (!id) return '—'
  const dashIdx = id.indexOf('-')
  return dashIdx >= 0 ? id.slice(dashIdx + 1) : id
}

export function formatTs(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

/** Format non-negative seconds as `MM:SS`. */
export function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const mm = Math.floor(s / 60).toString().padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

// ---------- Entity glyph + claim helpers ----------

export function entityGlyph(entityType: string | null | undefined): string {
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
export function countClaims(
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

// ---------- Proximity helpers ----------

/** Mirrors `src/rules.rs::proximity_key`. */
export function proximityKey(ruleId: string, labelA: string, labelB: string): string {
  const [lo, hi] = labelA <= labelB ? [labelA, labelB] : [labelB, labelA]
  return `${ruleId}|${lo}|${hi}`
}

export function distanceM(a: Position | null | undefined, b: Position | null | undefined): number | null {
  if (!a || !b) return null
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** Find the closest entity of the given type to `from`, ignoring entities
 *  without a position. Returns null if none exist. */
export function closestEntityOfType(
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

export interface ProximityRuleInfo {
  ruleId: string
  selfEntityType: string
  peerEntityType: string
  maxM: number
  minS: number
  /** Optional key/label surfaced when describing the rule's effect to the UI. */
  effectLabel: string
  /** When true, only same-team peers qualify for this proximity rule. */
  sameTeam?: boolean
  /** When true, only different-team peers qualify for this proximity rule. */
  differentTeam?: boolean
}

export function extractProximityRules(game: GameConfig | undefined): ProximityRuleInfo[] {
  if (!game) return []
  const out: ProximityRuleInfo[] = []
  for (const rule of game.rules) {
    const when = rule.when as Record<string, unknown>
    const clauses = Array.isArray((when as { of?: unknown }).of)
      ? ((when as { of: unknown[] }).of)
      : [when]
    let selfEntityType: string | undefined
    let proximity: { peer: string; maxM: number; minS: number; sameTeam: boolean; differentTeam: boolean } | undefined
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
        proximity = {
          peer: c.peer_entity_type,
          maxM: c.max_m,
          minS: c.min_s,
          sameTeam: c.same_team === true,
          differentTeam: c.different_team === true,
        }
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
      sameTeam: proximity.sameTeam || undefined,
      differentTeam: proximity.differentTeam || undefined,
    })
  }
  return out
}

// ---------- Proposal/vote tallying ----------

export interface ProposalWindow {
  started_at_ms?: number
  proposers?: Record<string, string>
}

export interface VoteWindow {
  started_at_ms?: number
  votes?: Record<string, string>
}

export function readProposalWindow(snap: LocalGameSnapshot | undefined): ProposalWindow | undefined {
  return snap?.proposal_window as ProposalWindow | undefined
}

export function readVoteWindow(snap: LocalGameSnapshot | undefined): VoteWindow | undefined {
  return snap?.vote_window as VoteWindow | undefined
}

export function tallyPicks(
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

export function windowStartedAt(
  snapshots: Record<string, LocalGameSnapshot>,
  which: 'proposal_window' | 'vote_window',
): number | null {
  for (const snap of Object.values(snapshots)) {
    const win = which === 'proposal_window' ? readProposalWindow(snap) : readVoteWindow(snap)
    if (win?.started_at_ms) return win.started_at_ms
  }
  return null
}

// ---------- Score helpers ----------

/** Filter out internal bookkeeping keys (prefixed `__`) and return a stable
 *  sort order so each card's score pills line up left-to-right consistently. */
export function visibleScoreTeams(scores: Record<string, number> | undefined): string[] {
  if (!scores) return []
  return Object.keys(scores)
    .filter(t => !t.startsWith('__'))
    .sort()
}

// ---------- Constants ----------

/** Keys whose raw numeric values are internal bookkeeping for the rules
 *  engine (e.g. CTF's `hold_pulse_ms` — a per-tick now_ms delta beacon) and
 *  should never be rendered verbatim in the UI. */
export const HIDDEN_PROPERTY_KEYS: ReadonlySet<string> = new Set(['hold_pulse_ms'])

/** Maximum per-node event-log buffer size. Rendered without virtualization,
 *  so this keeps the DOM bounded on long sessions. */
export const PER_NODE_EVENT_CAP = 100
