// Unity-style "Entity" component attached to a node. Two modes:
//
//   - Pre-claim (phase=loaded|placing_entities, no entity claim yet):
//     renders NodeGameControls — type dropdown, team dropdown (when the
//     entity_type declares `team === 'per_team'`), claim button phase-gated
//     by `snapshot.placement_ok`.
//
//   - Post-claim (entity has an entity_type) or during playing/ended:
//     renders NodeGameRuntime — score pills with flash-on-increment,
//     property rows (e.g. flag.holding_team), proximity progress bars
//     deduped by (peerEntityType, max_m, min_s), 4Hz (250ms) ticker so
//     bars tick between snapshot arrivals.
//
// Also includes the "Ready Up" button (individual, per-node) when the game
// is in the ready-up stage.
//
// Ported from `frontend/src/components/NodeControl.tsx` L480-998 with a
// single-node slice; the batch "Ready All" lives in GlobalActionsPanel now.

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Check, Flag } from 'lucide-react'

import type { NodeInfo } from '@/types'
import type { EntityRecord, GameConfig, LocalGameSnapshot } from '@/game/types'
import { teamColor } from '@/game/presentation'
import {
  HIDDEN_PROPERTY_KEYS,
  claimTeamFor,
  closestEntityOfType,
  countClaims,
  decayRemainingMs,
  entityGlyph,
  extractDecayRules,
  extractProximityRules,
  formatMmSs,
  hasScoreEffects,
  proximityKey,
  teamsForCardinality,
  visibleScoreTeams,
} from '@/lib/node-control-helpers'

interface Props {
  node: NodeInfo
  snapshot: LocalGameSnapshot | undefined
  activeGame: GameConfig | undefined
  canonicalEntities: Record<string, EntityRecord>
  onClaimEntity: (label: string, entityType: string, team: string | null) => Promise<void>
  onReadyUp: (label: string) => Promise<void>
}

export function EntityComponent({
  node,
  snapshot,
  activeGame,
  canonicalEntities,
  onClaimEntity,
  onReadyUp,
}: Props) {
  const phase = snapshot?.phase ?? 'no_game'
  const myEntity = snapshot?.entities[node.label]
  const hasClaimed = !!myEntity?.entity_type

  // Before a game is loaded (or during proposal/vote), there's nothing for
  // this component to render. The post-game `GameEndedActions` panel lives
  // alongside this in `NodeInspector` — it has its own visibility logic that
  // spans `ended → proposing → voting`, which is why we don't fold it in
  // here anymore (the runtime body / claim form / ready-up UI all want to
  // stay hidden during a vote, but the post-game picker doesn't).
  if (!activeGame || phase === 'no_game' || phase === 'proposing' || phase === 'voting') {
    return null
  }

  return (
    <div className="space-y-3">
      {hasClaimed ? (
        <ClaimedView
          node={node}
          snapshot={snapshot!}
          myEntity={myEntity!}
          onReadyUp={onReadyUp}
        />
      ) : (
        <ClaimForm
          node={node}
          snapshot={snapshot}
          activeGame={activeGame}
          canonicalEntities={canonicalEntities}
          onClaimEntity={onClaimEntity}
        />
      )}

      <NodeGameRuntimeBody
        node={node}
        snapshot={snapshot}
        activeGame={activeGame}
      />
    </div>
  )
}

// -------- Pre-claim form --------

function ClaimForm({
  node,
  snapshot,
  activeGame,
  canonicalEntities,
  onClaimEntity,
}: {
  node: NodeInfo
  snapshot: LocalGameSnapshot | undefined
  activeGame: GameConfig
  canonicalEntities: Record<string, EntityRecord>
  onClaimEntity: (label: string, entityType: string, team: string | null) => Promise<void>
}) {
  const [selectedType, setSelectedType] = useState<string>('')
  const [selectedTeam, setSelectedTeam] = useState<string>('')
  const [claiming, setClaiming] = useState(false)
  const phase = snapshot?.phase ?? 'no_game'
  const myPeerId = snapshot?.peer_id

  if (phase !== 'loaded' && phase !== 'placing_entities') {
    return (
      <div className="text-[11px] text-muted-foreground italic">
        Waiting for entity placement phase.
      </div>
    )
  }

  const selectedTypeDef = activeGame.entity_types.find(t => t.id === selectedType)
  // Only `per_team` surfaces a team picker in the UI. Teamless entities send
  // `null`; fixed-team entities (e.g. freeze_tag's `freezer` → `'freezers'`)
  // don't need a picker but *do* need their fixed team in the claim payload —
  // see `claimTeamFor` and the backend's `reject_for_cardinality`.
  const needsTeamPicker = selectedTypeDef?.team === 'per_team'
  const fixedTeam =
    selectedTypeDef && selectedTypeDef.team && selectedTypeDef.team !== 'per_team'
      ? selectedTypeDef.team
      : null
  const teamOptions: Array<string | null> = needsTeamPicker ? activeGame.teams : [null]

  const isTypeExhausted = (typeId: string): boolean => {
    const td = activeGame.entity_types.find(t => t.id === typeId)
    if (!td) return true
    // Count against every slot this type occupies — `[null]` for teamless,
    // every team for `per_team`, or the one fixed team for fixed-team types.
    // Using a bare `[null]` here used to hide full-capacity for fixed-team
    // entities because claims are stored with their fixed team string, not
    // null.
    const teams = teamsForCardinality(td.team, activeGame.teams)
    return teams.every(t => countClaims(canonicalEntities, typeId, t, myPeerId) >= td.max)
  }

  const isTeamExhausted = (typeId: string, team: string | null): boolean => {
    const td = activeGame.entity_types.find(t => t.id === typeId)
    if (!td) return true
    return countClaims(canonicalEntities, typeId, team, myPeerId) >= td.max
  }

  async function handleClaim() {
    if (!selectedType || !selectedTypeDef) return
    if (needsTeamPicker && !selectedTeam) return
    setClaiming(true)
    try {
      await onClaimEntity(
        node.label,
        selectedType,
        claimTeamFor(selectedTypeDef.team, selectedTeam),
      )
    } finally {
      setClaiming(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Flag className="h-3 w-3" />
        <span>Claim entity</span>
      </div>
      <div className="flex gap-1.5">
        <Select
          value={selectedType}
          onValueChange={v => {
            setSelectedType(v ?? '')
            setSelectedTeam('')
          }}
        >
          <SelectTrigger size="sm" className="h-7 text-[11px] flex-1 px-2">
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
                    {exhausted && <span className="text-[10px] text-muted-foreground">(full)</span>}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        {needsTeamPicker && (
          <Select value={selectedTeam} onValueChange={v => setSelectedTeam(v ?? '')}>
            <SelectTrigger size="sm" className="h-7 text-[11px] flex-1 px-2">
              <SelectValue placeholder="team" />
            </SelectTrigger>
            <SelectContent>
              {teamOptions.filter((t): t is string => !!t).map(team => {
                const exhausted = isTeamExhausted(selectedType, team)
                return (
                  <SelectItem key={team} value={team} disabled={exhausted}>
                    <span
                      className="px-1 rounded text-[10px] font-semibold"
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
        {fixedTeam && (
          // Fixed-team entities (e.g. freeze_tag `freezer`) have a pre-assigned
          // team — show it so the user knows what they're claiming.
          <div className="flex-1 flex items-center justify-center h-7">
            <span
              className="px-1.5 rounded text-[10px] font-semibold"
              style={{ backgroundColor: teamColor(fixedTeam) + '30', color: teamColor(fixedTeam) }}
            >
              {fixedTeam}
            </span>
          </div>
        )}
      </div>
      <Button
        size="sm"
        className="h-7 text-[11px] w-full"
        disabled={claiming || !selectedType || (needsTeamPicker && !selectedTeam)}
        onClick={handleClaim}
      >
        {claiming ? 'Claiming…' : 'Claim'}
      </Button>
    </div>
  )
}

// -------- Post-claim view --------

function ClaimedView({
  node,
  snapshot,
  myEntity,
  onReadyUp,
}: {
  node: NodeInfo
  snapshot: LocalGameSnapshot
  myEntity: EntityRecord
  onReadyUp: (label: string) => Promise<void>
}) {
  const [readying, setReadying] = useState(false)
  const phase = snapshot.phase
  const myPeerId = snapshot.peer_id
  const isReady = !!myPeerId && (snapshot.ready_peers ?? []).includes(myPeerId)
  const placementOk = !!snapshot.placement_ok
  const inReadyStage = phase === 'placing_entities' || phase === 'ready'
  const team = myEntity.team ?? null

  async function handleReady() {
    setReadying(true)
    try {
      await onReadyUp(node.label)
    } finally {
      setReadying(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground">Entity</span>
        <span>{entityGlyph(myEntity.entity_type)}</span>
        <span className="font-medium text-foreground">{myEntity.entity_type}</span>
        {team && (
          <span
            className="px-1 rounded text-[10px] font-semibold"
            style={{ backgroundColor: teamColor(team) + '30', color: teamColor(team) }}
          >
            {team}
          </span>
        )}
      </div>

      {inReadyStage && (
        isReady ? (
          <Badge
            variant="outline"
            className="h-6 text-[11px] bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
          >
            <Check className="h-3 w-3 mr-1" />
            Ready
          </Badge>
        ) : (
          <Button
            size="sm"
            className="h-7 text-[11px] w-full"
            disabled={readying || !placementOk}
            onClick={handleReady}
            title={
              placementOk
                ? 'Broadcast ReadyUp to start countdown'
                : 'Move entity into a valid placement first'
            }
          >
            {readying ? 'Signalling…' : placementOk ? 'Ready Up' : 'Placement invalid'}
          </Button>
        )
      )}
    </div>
  )
}

// -------- Runtime (scores, properties, proximity) --------

function NodeGameRuntimeBody({
  node,
  snapshot,
  activeGame,
}: {
  node: NodeInfo
  snapshot: LocalGameSnapshot | undefined
  activeGame: GameConfig
}) {
  // Re-render at ~4Hz while playing so proximity bars tick smoothly between
  // snapshot arrivals. Snapshot scores change less often; their flash-on-
  // increment animation also relies on the 4Hz tick to fire reliably.
  const [, setTick] = useState(0)
  const phase = snapshot?.phase ?? 'no_game'
  const isLive = phase === 'playing' || phase === 'ended'
  useEffect(() => {
    if (!isLive) return
    const id = window.setInterval(() => setTick(t => t + 1), 250)
    return () => window.clearInterval(id)
  }, [isLive])

  // Score-change flash: when any team's score on THIS node goes up, flash
  // the matching pill amber for ~1.2s.
  //
  // `snapshot?.scores` is the effect's real dependency — wrapping in `?? {}`
  // during render would allocate a fresh object on every tick and re-fire the
  // effect, so we key on the snapshot ref itself and defer the `?? {}` fallback
  // to inside the effect body.
  const prevScoresRef = useRef<Record<string, number>>({})
  const flashAtRef = useRef<Record<string, number>>({})
  const scoresForRender = snapshot?.scores
  useEffect(() => {
    const scores = scoresForRender ?? {}
    const prev = prevScoresRef.current
    const now = Date.now()
    for (const [team, value] of Object.entries(scores)) {
      if (team.startsWith('__')) continue
      const before = prev[team] ?? 0
      if (value > before) flashAtRef.current[team] = now
    }
    prevScoresRef.current = { ...scores }
  }, [scoresForRender])

  if (!isLive || !snapshot) return null

  const myEntity = snapshot.entities[node.label]
  const myType = myEntity?.entity_type ?? null
  const myPos = myEntity?.pos ?? null

  const countdownZeroNs = snapshot.countdown_zero_ns ?? null
  const startMs = countdownZeroNs != null
    ? Math.floor(countdownZeroNs / 1_000_000) + 3_000
    : null
  // 4Hz setInterval above re-renders this component; reading Date.now()
  // during render is how the progress bars tick smoothly between snapshot
  // arrivals.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now()
  const elapsedS = startMs != null ? Math.max(0, Math.floor((nowMs - startMs) / 1000)) : null
  const remainingS = activeGame.duration_s != null && elapsedS != null
    ? Math.max(0, activeGame.duration_s - elapsedS)
    : null

  // Property rows: if this node's entity is the target of any set_property
  // rule, surface the current value (e.g. flag.holding_team).
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
    if (seenPropertyKeys.has(key)) continue
    seenPropertyKeys.add(key)
    const raw = myEntity?.properties?.[key]
    const value = raw == null ? null : String(raw)
    propertyRows.push({ key, value, highlightTeam: key.endsWith('team') })
  }

  // eslint-disable-next-line react-hooks/purity -- 4Hz tick pattern (see comment above nowMs)
  const now = Date.now()

  // Decay timers (e.g. freeze_tag's 30-second `frozen_since_ms` window). When
  // the rule that produces the timer is currently "blocked" by its own guard,
  // we suppress the matching proximity bar — once a runner is frozen, the
  // freezer's 2-second proximity progress is moot until the 30s window
  // expires. Surfaced as countdown chips in the runtime body.
  const decayRules = extractDecayRules(activeGame).filter(d => d.targetEntityType === myType)
  const decayRows = decayRules
    .map(d => {
      const remainingMs = decayRemainingMs(myEntity, d, now)
      if (remainingMs == null) return null
      return {
        rule: d,
        remainingMs,
        pct: Math.min(100, Math.max(0, (remainingMs / d.durationMs) * 100)),
      }
    })
    .filter((r): r is NonNullable<typeof r> => r != null)
  const suppressedProximityRuleIds = new Set(decayRows.map(r => r.rule.ruleId))

  // Proximity progress: one bar per unique (peerEntityType, maxM, minS, teamFilter),
  // deduped so e.g. CTF's mark_holding / hold_pulse only render once. Skip any
  // rule whose decay timer is currently active for this entity — re-firing is
  // blocked by the rule's own `not property_age_ms` guard, so showing the bar
  // would just be noise (and would visibly "tick over" past the 2s threshold
  // as the proximity_tracker keeps incrementing while the freezer stays
  // adjacent).
  const proximityRules = extractProximityRules(activeGame).filter(
    r => r.selfEntityType === myType && !suppressedProximityRuleIds.has(r.ruleId),
  )
  const seenProximityKeys = new Set<string>()
  const dedupedProximityRules = proximityRules.filter(r => {
    const key = `${r.peerEntityType}|${r.maxM}|${r.minS}|${r.sameTeam ?? ''}|${r.differentTeam ?? ''}`
    if (seenProximityKeys.has(key)) return false
    seenProximityKeys.add(key)
    return true
  })
  const proximityRows = dedupedProximityRules.map(r => {
    const closest = closestEntityOfType(snapshot.entities, myPos, r.peerEntityType)
    let startFromMs: number | undefined
    if (closest) {
      for (const candidate of proximityRules) {
        if (
          candidate.peerEntityType !== r.peerEntityType ||
          candidate.maxM !== r.maxM ||
          candidate.minS !== r.minS
        ) continue
        const trackerKey = proximityKey(candidate.ruleId, node.label, closest.entity.label)
        const t = snapshot.proximity_tracker?.[trackerKey]
        if (t != null) { startFromMs = t; break }
      }
    }
    const thresholdMs = r.minS * 1000
    // Cap the displayed elapsed time at the threshold — the proximity_tracker
    // keeps counting past `min_s` while the entities stay adjacent, but the
    // bar represents progress toward the rule firing, which already happened.
    // Showing "3.4/2.0s" would mislead users into thinking the rule hasn't
    // fired yet.
    const rawElapsedMs = startFromMs != null ? Math.max(0, now - startFromMs) : 0
    const elapsedMs = Math.min(rawElapsedMs, thresholdMs)
    const pct = thresholdMs > 0 ? Math.min(100, (elapsedMs / thresholdMs) * 100) : 0
    return {
      rule: r,
      closest,
      active: startFromMs != null,
      pct,
      elapsedS: elapsedMs / 1000,
    }
  })

  // Untargeted entity (flag/hill/zone): surface closest player so user can
  // see who's threatening the objective.
  const entityTypeDef = activeGame.entity_types.find(t => t.id === myType)
  const watchNearest = entityTypeDef && entityTypeDef.team === null
  const nearestPlayer = watchNearest
    ? closestEntityOfType(snapshot.entities, myPos, 'player')
    : null

  const scoreTeams = visibleScoreTeams(snapshot.scores)
  const displayTeams = Array.from(new Set([...scoreTeams, ...activeGame.teams])).sort()
  const FLASH_MS = 1200
  const scoreIsDuration = activeGame.duration_s != null
  const formatScore = (v: number): string => (scoreIsDuration ? formatMmSs(v) : String(v))
  // Games without any `increment_score` rules (e.g. freeze_tag, where the win
  // condition is "all runners frozen at once" rather than a numeric tally)
  // never produce non-zero scores. Showing a "Hold 00:00 / 00:00" pill row
  // every tick is just visual noise — hide the whole section in that case.
  const showScoreRow = displayTeams.length > 0 && hasScoreEffects(activeGame)

  const anyRow =
    propertyRows.length > 0 ||
    proximityRows.length > 0 ||
    decayRows.length > 0 ||
    nearestPlayer ||
    showScoreRow

  return (
    <div className="border-t pt-2 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span>Runtime</span>
        {remainingS != null && (
          <span
            className={`tabular-nums font-mono text-[10px] font-semibold px-1 rounded ${
              phase === 'ended'
                ? 'bg-purple-500/20 text-purple-200'
                : remainingS <= 30
                  ? 'bg-amber-500/20 text-amber-300 animate-pulse'
                  : 'bg-emerald-500/20 text-emerald-300'
            }`}
          >
            ⏱ {formatMmSs(remainingS)}
          </span>
        )}
        {remainingS == null && elapsedS != null && (
          <span className="tabular-nums font-mono text-[10px] font-semibold px-1 rounded bg-slate-500/20 text-slate-200">
            ⏱ {formatMmSs(elapsedS)}
          </span>
        )}
        {phase === 'playing' && (
          <span className="ml-auto flex items-center gap-1 text-[10px] font-semibold text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
        )}
        {phase === 'ended' && (
          <span className="ml-auto text-[10px] font-semibold text-purple-300">ENDED</span>
        )}
      </div>

      {phase === 'ended' && snapshot.ended_reason && (
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground">Winner</span>
          {snapshot.ended_winner_team ? (
            <span
              className="px-1 rounded text-[10px] font-semibold"
              style={{
                backgroundColor: teamColor(snapshot.ended_winner_team) + '30',
                color: teamColor(snapshot.ended_winner_team),
              }}
            >
              {snapshot.ended_winner_team}
            </span>
          ) : (
            <span className="px-1 rounded text-[10px] font-semibold bg-slate-500/20 text-slate-200">
              draw
            </span>
          )}
          <span className="text-[10px] text-muted-foreground italic truncate">
            {snapshot.ended_reason}
          </span>
        </div>
      )}

      {showScoreRow && (
        <div className="flex items-center gap-1 text-[11px] flex-wrap">
          <span className="text-muted-foreground mr-0.5">
            {scoreIsDuration ? 'Hold' : 'Scores'}
          </span>
          {displayTeams.map(team => {
            const value = snapshot.scores?.[team] ?? 0
            const flashAt = flashAtRef.current[team] ?? 0
            // eslint-disable-next-line react-hooks/purity -- 4Hz tick drives re-render
            const flashing = Date.now() - flashAt < FLASH_MS
            return (
              <span
                key={team}
                className={`px-1 rounded text-[10px] font-semibold tabular-nums transition-shadow duration-300 ${
                  flashing ? 'ring-2 ring-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.7)]' : ''
                }`}
                style={{
                  backgroundColor: teamColor(team) + '30',
                  color: teamColor(team),
                }}
              >
                {team} {formatScore(value)}
              </span>
            )
          })}
        </div>
      )}

      {!anyRow && (
        <div className="text-[11px] text-muted-foreground italic">
          No gameplay signals yet.
        </div>
      )}

      {propertyRows.map(row => (
        <div key={row.key} className="flex items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground">{row.key}</span>
          {row.value == null ? (
            <span className="text-muted-foreground italic">unset</span>
          ) : row.highlightTeam ? (
            <span
              className="px-1 rounded text-[10px] font-semibold"
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
        <div key={row.rule.ruleId} className="space-y-1">
          <div className="flex items-center gap-1 text-[11px]">
            <span>{entityGlyph(row.rule.peerEntityType)}</span>
            <span className="text-muted-foreground truncate">
              {row.rule.peerEntityType}
              {row.closest ? ` · ${row.closest.distance.toFixed(1)}m` : ' · —'}
            </span>
            <span className="ml-auto tabular-nums text-muted-foreground text-[10px]">
              {row.elapsedS.toFixed(1)}/{row.rule.minS}s
            </span>
          </div>
          <div className="h-1.5 bg-muted rounded overflow-hidden">
            <div
              className={`h-full transition-all ${
                row.active ? 'bg-emerald-400' : 'bg-muted-foreground/20'
              }`}
              style={{ width: `${row.pct}%` }}
            />
          </div>
        </div>
      ))}

      {/* Decay countdowns — e.g. freeze_tag's 30s frozen window. The bar
          drains from full to empty over `durationMs`; once it hits zero the
          property age has expired and the row disappears (the rule that
          gates on `not property_age_ms` can fire again). */}
      {decayRows.map(row => {
        const remainingS = row.remainingMs / 1000
        const totalS = row.rule.durationMs / 1000
        return (
          <div key={`decay:${row.rule.ruleId}`} className="space-y-1">
            <div className="flex items-center gap-1 text-[11px]">
              <span>🥶</span>
              <span className="font-semibold text-cyan-300 uppercase tracking-wide text-[10px]">
                {row.rule.label}
              </span>
              <span className="ml-auto tabular-nums text-cyan-300 text-[10px] font-mono">
                {remainingS.toFixed(1)}s
              </span>
            </div>
            <div className="h-1.5 bg-muted rounded overflow-hidden">
              <div
                className="h-full bg-cyan-400 transition-all"
                style={{ width: `${row.pct}%` }}
                title={`${remainingS.toFixed(1)}s of ${totalS.toFixed(0)}s remaining`}
              />
            </div>
          </div>
        )
      })}

      {!propertyRows.length && nearestPlayer && (
        <div className="flex items-center gap-1.5 text-[11px]">
          <span>{entityGlyph('player')}</span>
          <span className="text-muted-foreground truncate">
            closest {nearestPlayer.entity.label}
            {nearestPlayer.entity.team ? ` (${nearestPlayer.entity.team})` : ''}
          </span>
          <span className="ml-auto tabular-nums text-muted-foreground text-[10px]">
            {nearestPlayer.distance.toFixed(1)}m
          </span>
        </div>
      )}
    </div>
  )
}
