import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { AgentState, EventLogEntry, NodeInfo } from '../types'
import type { GameConfig, LocalGameSnapshot, Position } from '../game/types'
import {
  COMM_RADIUS_M,
  FIELD_HEIGHT_M,
  FIELD_HEIGHT_PX,
  FIELD_WIDTH_M,
  FIELD_WIDTH_PX,
  PX_PER_M,
  clampToField,
  fromPxX,
  fromPxY,
  presentationFor,
  teamColor,
  toPxX,
  toPxY,
} from '../game/presentation'
import { hasLos, inRange } from '../game/geom'

interface GameViewProps {
  nodes: NodeInfo[]
  snapshots: Record<string, LocalGameSnapshot>
  onMove: (label: string, x: number, y: number) => void | Promise<void>
  partitions: [string, string][]
  /** Event log stream — used to drive heartbeat/action/state animations. */
  events: EventLogEntry[]
  /** Agent states — used to detect liveness (pulse colour vs stopped). */
  states: AgentState[]
  /** All loaded game configs — used to look up `duration_s` for the active
   *  game so the header can render an MM:SS countdown. */
  games: GameConfig[]
  /** Toggle a manual partition between two nodes. */
  onTogglePartition: (a: string, b: string) => void | Promise<void>
}

interface EntityView {
  label: string
  peer_id: string
  pos: Position
  entity_type: string | null
  team: string | null
  running: boolean
}

function snapshotEntityType(snap: LocalGameSnapshot | undefined, label: string): string | null {
  if (!snap) return null
  const entity = snap.entities?.[label]
  return entity?.entity_type ?? null
}

function snapshotTeam(snap: LocalGameSnapshot | undefined, label: string): string | null {
  if (!snap) return null
  const entity = snap.entities?.[label]
  return entity?.team ?? null
}

/** Combine per-node snapshots plus node-info (for running status) into a single
 *  authoritative list. Position priority: own snapshot.my_position → any
 *  snapshot.entities[label].pos → node.initial_x/y. */
function buildEntityViews(
  nodes: NodeInfo[],
  snapshots: Record<string, LocalGameSnapshot>,
): EntityView[] {
  return nodes
    .map<EntityView | null>(n => {
      const ownSnap = snapshots[n.label]
      const posFromOwn = ownSnap?.my_position ?? ownSnap?.entities?.[n.label]?.pos ?? null
      // Fallback: some other node's snapshot may have seen us first.
      const posFromPeer =
        posFromOwn ??
        Object.values(snapshots)
          .map(s => s.entities?.[n.label]?.pos ?? null)
          .find(p => p != null) ??
        null
      const initialPos: Position | null =
        posFromPeer ??
        (n.initial_x != null && n.initial_y != null ? { x: n.initial_x, y: n.initial_y } : null)
      if (!initialPos) return null
      return {
        label: n.label,
        peer_id: ownSnap?.peer_id ?? '',
        pos: initialPos,
        entity_type:
          snapshotEntityType(ownSnap, n.label) ??
          // Some peer may have seen our claim before we did.
          Object.values(snapshots)
            .map(s => snapshotEntityType(s, n.label))
            .find(t => t) ??
          null,
        team:
          snapshotTeam(ownSnap, n.label) ??
          Object.values(snapshots)
            .map(s => snapshotTeam(s, n.label))
            .find(t => t) ??
          null,
        running: n.status === 'running',
      }
    })
    .filter((e): e is EntityView => e != null)
}

export function GameView({
  nodes,
  snapshots,
  onMove,
  partitions,
  events,
  states,
  games,
  onTogglePartition,
}: GameViewProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const zoomLayerRef = useRef<SVGGElement | null>(null)
  const effectsLayerRef = useRef<SVGGElement | null>(null)
  // During drag, we locally override positions; on drop we commit to backend.
  const [dragOverrides, setDragOverrides] = useState<Record<string, Position>>({})
  // Current zoom transform — stored so the drag handlers below can compensate
  // for pan/zoom when converting pointer coordinates back to field metres.
  const transformRef = useRef<{ k: number; x: number; y: number }>({ k: 1, x: 0, y: 0 })
  // Stable drag behaviour built once on mount; re-attached to entity groups
  // only when the set of entities changes (see below).
  const dragBehaviorRef = useRef<d3.DragBehavior<SVGGElement, unknown, unknown> | null>(null)
  // Always-latest `onMove` callback so the drag-end handler doesn't need the
  // zoom/drag setup to re-run on every prop change.
  const onMoveRef = useRef(onMove)
  useEffect(() => { onMoveRef.current = onMove })

  const activeGameId = useMemo<string | null>(() => {
    for (const snap of Object.values(snapshots)) {
      if (snap.active_game_id) return snap.active_game_id
    }
    return null
  }, [snapshots])

  const presentation = useMemo(() => presentationFor(activeGameId), [activeGameId])

  // Comm radius is a global playing-field constant — in lockstep with the
  // backend `partition_reconciler`.
  const commRadiusM = COMM_RADIUS_M

  const entities = useMemo(
    () => buildEntityViews(nodes, snapshots),
    [nodes, snapshots],
  )

  // Stable key that only changes when the *set* of entities (by label) changes,
  // not when their positions / running state / claims change. Used to gate the
  // drag-reattach effect below so we don't reinstall d3 behaviours on every
  // snapshot tick.
  const entityLabelsKey = useMemo(
    () => entities.map(e => e.label).sort().join(','),
    [entities],
  )

  // Effective positions: drag overrides take precedence.
  const effectivePos = useMemo(() => {
    const map: Record<string, Position> = {}
    for (const e of entities) {
      map[e.label] = dragOverrides[e.label] ?? e.pos
    }
    return map
  }, [entities, dragOverrides])

  // Which pairs have a real pfctl partition applied?
  const partitionedSet = useMemo(() => {
    const s = new Set<string>()
    for (const [a, b] of partitions) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      s.add(key)
    }
    return s
  }, [partitions])

  // Compute edges for every pair of entities. Pairs that are out of range,
  // blocked by an obstacle, or marked partitioned by the backend are shown as
  // red dashed "severed" lines; in-range LOS-clear pairs that aren't in the
  // partition set are shown as green comm links. All edges are clickable to
  // toggle a manual sever.
  const commEdges = useMemo(() => {
    const edges: { a: string; b: string; connected: boolean }[] = []
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const ea = entities[i]
        const eb = entities[j]
        const pa = effectivePos[ea.label]
        const pb = effectivePos[eb.label]
        if (!pa || !pb) continue
        const key = ea.label < eb.label ? `${ea.label}|${eb.label}` : `${eb.label}|${ea.label}`
        const inLosRange = inRange(pa, pb, commRadiusM) && hasLos(pa, pb, presentation.obstacles)
        const partitioned = partitionedSet.has(key)
        edges.push({ a: ea.label, b: eb.label, connected: inLosRange && !partitioned })
      }
    }
    return edges
  }, [entities, effectivePos, commRadiusM, presentation.obstacles, partitionedSet])

  // Set up D3 drag + zoom behaviour ONCE on mount.
  //
  // Zoom is applied as a transform on an inner `<g class="zoom-layer">` so
  // the SVG background and size don't change. Drag events use the current
  // zoom transform to compute field-metre coords from pointer-pixel coords,
  // so dragging an entity while zoomed in tracks the cursor correctly.
  //
  // A filter on the zoom prevents it from grabbing pointer events that start
  // on an entity group — otherwise the zoom and drag race for the gesture.
  //
  // IMPORTANT: this effect used to depend on `[onMove, entities]`, which made
  // it re-run on every SSE snapshot tick (entities is derived from snapshots).
  // Each re-run allocated fresh d3 behaviours and rewrote listener state on the
  // SVG and every entity <g>, which thrashed the GC and eventually tripped the
  // renderer's memory limit ("Aw, Snap!" / error code 5). We now read `onMove`
  // through a ref and reattach drag lazily when the entity *set* changes.
  useEffect(() => {
    if (!svgRef.current || !zoomLayerRef.current) return
    const svg = d3.select(svgRef.current)
    const layer = d3.select(zoomLayerRef.current)

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 3])
      .filter(event => {
        // Let mousedown/touchstart on an entity fall through to the drag
        // handler, and on a comm edge fall through to its click handler.
        // Wheels and background drags still pan/zoom.
        if (event.type === 'wheel') return true
        const target = event.target as Element | null
        if (target?.closest('g.entity-group')) return false
        if (target?.closest('g.comm-edge')) return false
        return !event.ctrlKey && !event.button
      })
      .on('zoom', event => {
        transformRef.current = {
          k: event.transform.k,
          x: event.transform.x,
          y: event.transform.y,
        }
        layer.attr('transform', event.transform.toString())
      })

    svg.call(zoom)

    // Convert a pointer event's client-space (x,y) into field metres,
    // compensating for the current zoom/pan transform.
    const toFieldM = (event: { x: number; y: number }) => {
      const { k, x, y } = transformRef.current
      const xPx = (event.x - x) / k
      const yPx = (event.y - y) / k
      return clampToField({ x: fromPxX(xPx), y: fromPxY(yPx) })
    }

    // React owns the entity DOM, so `.call(drag)` can't rely on `__data__`
    // being bound (it isn't — React doesn't set it). Read the label from the
    // `data-label` attribute stamped onto each `g.entity-group` instead.
    // Stopped nodes have `data-running="false"` — filter those out at the
    // d3.drag level so we don't start an interaction that can't be applied.
    const drag = d3
      .drag<SVGGElement, unknown>()
      .filter(function () {
        const el = this as SVGGElement
        return el.getAttribute('data-running') !== 'false'
      })
      .on('start', function () {
        d3.select(this).raise().classed('dragging', true)
      })
      .on('drag', function (event) {
        const label = (this as SVGGElement).getAttribute('data-label')
        if (!label) return
        const p = toFieldM(event)
        setDragOverrides(prev => ({ ...prev, [label]: p }))
      })
      .on('end', function (event) {
        d3.select(this).classed('dragging', false)
        const label = (this as SVGGElement).getAttribute('data-label')
        if (!label) return
        const p = toFieldM(event)
        setDragOverrides(prev => {
          const copy = { ...prev }
          delete copy[label]
          return copy
        })
        // Via ref so we always call the latest onMove without reinstalling.
        void onMoveRef.current(label, p.x, p.y)
      })

    dragBehaviorRef.current = drag
    svg.selectAll<SVGGElement, unknown>('g.entity-group').call(drag)

    return () => {
      svg.on('.zoom', null)
      svg.selectAll<SVGGElement, unknown>('g.entity-group').on('.drag', null)
      dragBehaviorRef.current = null
    }
  }, [])

  // Re-attach the drag behaviour whenever the entity *set* changes (new node
  // added / removed). Position updates and claim updates don't invalidate this
  // — React keeps the same <g> DOM node when the React key is stable, and d3's
  // `.call(drag)` is idempotent on the same element.
  useEffect(() => {
    if (!svgRef.current || !dragBehaviorRef.current) return
    d3.select(svgRef.current)
      .selectAll<SVGGElement, unknown>('g.entity-group')
      .call(dragBehaviorRef.current)
  }, [entityLabelsKey])

  // --- Event-driven animations (moved from NetworkGraph) ---
  //
  // Each heartbeat/action/state log line in `events` fires a transient d3
  // animation anchored at the triggering entity's pixel position. The effects
  // live in their own <g> layer underneath the entities so they never block
  // drag/click interactions. We track `lastEventCount` so re-renders don't
  // replay old animations — only genuinely new entries animate.

  // Stable map label → current pixel position, read via ref so the event
  // effect doesn't need to re-run on every position tick.
  const entityPxPos = useMemo(() => {
    const map: Record<string, { x: number; y: number }> = {}
    for (const e of entities) {
      const p = effectivePos[e.label]
      if (p) map[e.label] = { x: toPxX(p.x), y: toPxY(p.y) }
    }
    return map
  }, [entities, effectivePos])
  const entityPxPosRef = useRef(entityPxPos)
  useEffect(() => {
    entityPxPosRef.current = entityPxPos
  }, [entityPxPos])

  // Liveness lookup used to tint pulses green for running nodes and grey for
  // stopped ones — read via ref for the same reason.
  const livenessByLabel = useMemo(() => {
    const map: Record<string, 'online' | 'offline'> = {}
    for (const n of nodes) {
      if (n.status === 'stopped') { map[n.label] = 'offline'; continue }
      const hasAgent = states.some(s => s.label === n.label)
      map[n.label] = hasAgent ? 'online' : 'offline'
    }
    return map
  }, [nodes, states])
  const livenessRef = useRef(livenessByLabel)
  useEffect(() => {
    livenessRef.current = livenessByLabel
  }, [livenessByLabel])

  const lastEventCount = useRef(0)
  useEffect(() => {
    if (events.length <= lastEventCount.current) {
      lastEventCount.current = events.length
      return
    }
    const newEvents = events.slice(lastEventCount.current)
    lastEventCount.current = events.length

    const layer = effectsLayerRef.current
    if (!layer) return
    const layerSel = d3.select(layer)
    const positions = entityPxPosRef.current
    const liveness = livenessRef.current

    for (const ev of newEvents) {
      const from = positions[ev.label]
      if (!from) continue

      if (ev.tag === 'HEARTBEAT' || ev.tag === 'HANDSHAKE' || ev.tag === 'DISCOVERY') {
        const color = liveness[ev.label] === 'online' ? '#22c55e' : '#6b7280'
        layerSel
          .append('circle')
          .attr('cx', from.x)
          .attr('cy', from.y)
          .attr('r', 14)
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', 2)
          .attr('opacity', 0.7)
          .transition()
          .duration(600)
          .ease(d3.easeQuadOut)
          .attr('r', 32)
          .attr('opacity', 0)
          .remove()
      }

      if (ev.tag === 'ACTION') {
        const color = '#f97316'

        // Flash ring at the source entity.
        layerSel
          .append('circle')
          .attr('cx', from.x)
          .attr('cy', from.y)
          .attr('r', 18)
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', 4)
          .attr('opacity', 1)
          .transition()
          .duration(800)
          .ease(d3.easeExpOut)
          .attr('r', 52)
          .attr('stroke-width', 1)
          .attr('opacity', 0)
          .remove()

        // Bolts + trails flying to every other entity.
        for (const [otherLabel, to] of Object.entries(positions)) {
          if (otherLabel === ev.label) continue
          const bolt = layerSel
            .append('circle')
            .attr('r', 4)
            .attr('fill', color)
            .attr('opacity', 0.9)
            .attr('cx', from.x)
            .attr('cy', from.y)
          const trail = layerSel
            .append('line')
            .attr('x1', from.x)
            .attr('y1', from.y)
            .attr('x2', from.x)
            .attr('y2', from.y)
            .attr('stroke', color)
            .attr('stroke-width', 2)
            .attr('opacity', 0.6)

          bolt
            .transition()
            .duration(500)
            .ease(d3.easeCubicIn)
            .attr('cx', to.x)
            .attr('cy', to.y)
            .attr('r', 3)
            .on('end', function () {
              d3.select(this).transition().duration(300).attr('opacity', 0).remove()
            })

          trail
            .transition()
            .duration(500)
            .ease(d3.easeCubicIn)
            .attr('x2', to.x)
            .attr('y2', to.y)
            .transition()
            .duration(400)
            .attr('opacity', 0)
            .remove()
        }
      }

      if (ev.tag === 'STATE') {
        const color = '#f59e0b'
        layerSel
          .append('circle')
          .attr('cx', from.x)
          .attr('cy', from.y)
          .attr('r', 42)
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', 3)
          .attr('opacity', 0.8)
          .transition()
          .duration(500)
          .ease(d3.easeCubicOut)
          .attr('r', 18)
          .attr('opacity', 0)
          .remove()
      }
    }
  }, [events])

  const gradientId = `game-field-gradient-${activeGameId ?? 'none'}`

  // Look up the active game config for game-specific UI (timer, flag holder).
  const activeGame = useMemo<GameConfig | undefined>(() => {
    if (!activeGameId) return undefined
    return games.find(g => g.id === activeGameId)
  }, [games, activeGameId])

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            Playing Field
            {activeGameId ? (
              <Badge variant="secondary">{activeGameId}</Badge>
            ) : (
              <Badge variant="outline">no game loaded</Badge>
            )}
            {/* CTF-style flag-holder pill — also works for any game whose
                rules stamp `flag.holding_team`. */}
            <FlagHolderBadge snapshots={snapshots} />
          </CardTitle>
          <div className="flex items-center gap-3">
            <GameTimer snapshots={snapshots} durationS={activeGame?.duration_s} />
            <Scoreboard snapshots={snapshots} />
            <div className="text-xs text-muted-foreground">
              {FIELD_WIDTH_M}m × {FIELD_HEIGHT_M}m · radius {commRadiusM}m · {entities.length}{' '}
              {entities.length === 1 ? 'entity' : 'entities'}
            </div>
          </div>
        </div>
        <EndedBanner snapshots={snapshots} />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <div className="relative inline-block" style={{ maxWidth: '100%' }}>
        <svg
          ref={svgRef}
          width={FIELD_WIDTH_PX}
          height={FIELD_HEIGHT_PX}
          viewBox={`0 0 ${FIELD_WIDTH_PX} ${FIELD_HEIGHT_PX}`}
          className="bg-background rounded-md border"
          style={{ maxWidth: '100%', height: 'auto' }}
        >
          <defs>
            <linearGradient
              id={gradientId}
              x1="0%"
              y1="0%"
              x2={presentation.gradient.angle === 0 ? '100%' : '0%'}
              y2={presentation.gradient.angle === 0 ? '0%' : '100%'}
            >
              <stop offset="0%" stopColor={presentation.gradient.from} />
              <stop offset="100%" stopColor={presentation.gradient.to} />
            </linearGradient>
          </defs>

          {/* Zoom/pan transform applies to every field layer below. d3-zoom
              writes to `transform` on this group; see the effect above. */}
          <g ref={zoomLayerRef} className="zoom-layer">
          {/* Field background */}
          <rect
            x={0}
            y={0}
            width={FIELD_WIDTH_PX}
            height={FIELD_HEIGHT_PX}
            fill={`url(#${gradientId})`}
          />

          {/* Obstacles */}
          <g className="obstacles">
            {presentation.obstacles.map((o, i) => (
              <circle
                key={i}
                cx={toPxX(o.x)}
                cy={toPxY(o.y)}
                r={o.r * PX_PER_M}
                fill="#5b6470"
                stroke="#2b323c"
                strokeWidth={1.5}
              />
            ))}
          </g>

          {/* Comm-radius rings */}
          <g className="radius-rings">
            {entities.map(e => {
              const p = effectivePos[e.label]
              if (!p) return null
              return (
                <circle
                  key={e.label}
                  cx={toPxX(p.x)}
                  cy={toPxY(p.y)}
                  r={commRadiusM * PX_PER_M}
                  fill="none"
                  stroke="#64748b"
                  strokeOpacity={0.12}
                  strokeDasharray="2,4"
                />
              )
            })}
          </g>

          {/* Comm edges — one line per pair. Connected pairs are green; every
              other pair (out of range, obstructed, or user-severed) renders as
              a red dashed line with higher opacity. A wider transparent line
              sits on top so the edge is easy to click. */}
          <g className="comm-edges">
            {commEdges.map(edge => {
              const pa = effectivePos[edge.a]
              const pb = effectivePos[edge.b]
              if (!pa || !pb) return null
              const x1 = toPxX(pa.x)
              const y1 = toPxY(pa.y)
              const x2 = toPxX(pb.x)
              const y2 = toPxY(pb.y)
              const stroke = edge.connected ? '#22c55e' : '#ef4444'
              const strokeOpacity = edge.connected ? 0.55 : 0.85
              const strokeWidth = edge.connected ? 1.4 : 2
              return (
                <g
                  key={`${edge.a}-${edge.b}`}
                  className="comm-edge"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onTogglePartition(edge.a, edge.b)}
                >
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={stroke}
                    strokeOpacity={strokeOpacity}
                    strokeWidth={strokeWidth}
                    strokeDasharray="6,4"
                  />
                  {/* Invisible wider hit target — makes thin lines easy to
                      tap without dominating the visual. `pointerEvents="stroke"`
                      guarantees the line catches clicks even though the stroke
                      is transparent. */}
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke="transparent"
                    strokeWidth={14}
                    pointerEvents="stroke"
                  />
                </g>
              )
            })}
          </g>

          {/* Effects layer (heartbeat/action/state animations) sits above the
              edges and behind the entities so pulses don't hide the glyphs. */}
          <g ref={effectsLayerRef} className="effects-layer" pointerEvents="none" />

          {/* Entities */}
          <g className="entities">
            {entities.map(e => {
              const p = effectivePos[e.label]
              if (!p) return null
              return (
                <EntityGlyph
                  key={e.label}
                  entity={e}
                  datum={e}
                  x={toPxX(p.x)}
                  y={toPxY(p.y)}
                />
              )
            })}
          </g>
          </g>
        </svg>
        <CountdownOverlay snapshots={snapshots} />
        </div>
      </CardContent>
    </Card>
  )
}

// --- Scoreboard (visible once any node has scores) ---
//
// Each node maintains its own `scores: Record<team, number>` in its snapshot.
// Because every node applies IncrementScore on the same consensus-ordered
// delta, values converge; we merge across snapshots by taking the max per
// team to tolerate transient lag while nodes are catching up.
function Scoreboard({
  snapshots,
}: {
  snapshots: Record<string, LocalGameSnapshot>
}) {
  const merged = useMemo(() => {
    const out: Record<string, number> = {}
    for (const snap of Object.values(snapshots)) {
      for (const [team, score] of Object.entries(snap.scores ?? {})) {
        // Skip internal bookkeeping keys (like __countdown_start_ms).
        if (team.startsWith('__')) continue
        const n = typeof score === 'number' ? score : 0
        if (n > (out[team] ?? -Infinity)) out[team] = n
      }
    }
    return out
  }, [snapshots])

  const teams = Object.keys(merged).sort()
  if (teams.length === 0) return null

  return (
    <div className="flex items-center gap-1.5">
      {teams.map(team => (
        <span
          key={team}
          className="font-mono text-xs font-semibold px-1.5 py-0.5 rounded"
          title={`${team} hold time: ${formatMmSs(merged[team])}`}
          style={{
            backgroundColor: teamColor(team) + '22',
            color: teamColor(team),
            border: `1px solid ${teamColor(team)}55`,
          }}
        >
          {team}: {formatMmSs(merged[team])}
        </span>
      ))}
    </div>
  )
}

// --- Game timer (MM:SS) ---
//
// The backend pins `countdown_zero_ns` to the consensus timestamp of the final
// `ReadyUp`, then `CountingDown → Playing` flips 3s later. Gameplay therefore
// starts at `countdown_zero_ns + 3s` on every node, so we can derive an
// MM:SS countdown purely from the snapshot stream. When `duration_s` is unset
// we render an elapsed-since-start timer instead so every game still surfaces
// a running clock.
function GameTimer({
  snapshots,
  durationS,
}: {
  snapshots: Record<string, LocalGameSnapshot>
  durationS?: number
}) {
  const [now, setNow] = useState(() => Date.now())

  const phases = useMemo(() => Object.values(snapshots).map(s => s.phase), [snapshots])
  const anyPlaying = phases.some(p => p === 'playing')
  const anyEnded = phases.some(p => p === 'ended')
  const live = anyPlaying || anyEnded
  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [live])

  // countdown_zero_ns is nanoseconds since UNIX epoch. Play starts 3s later.
  const startMs = useMemo(() => {
    for (const snap of Object.values(snapshots)) {
      if (snap.countdown_zero_ns != null) {
        const zeroMs = Math.floor(snap.countdown_zero_ns / 1_000_000)
        return zeroMs + 3_000
      }
    }
    return null
  }, [snapshots])

  if (!live || startMs == null) return null

  const elapsedMs = Math.max(0, now - startMs)
  if (durationS != null) {
    const remainingMs = Math.max(0, durationS * 1000 - elapsedMs)
    const critical = remainingMs <= 30_000
    const color = anyEnded
      ? 'text-purple-300 border-purple-400/40 bg-purple-500/10'
      : critical
        ? 'text-amber-300 border-amber-400/50 bg-amber-500/10'
        : 'text-emerald-300 border-emerald-400/40 bg-emerald-500/10'
    return (
      <span
        className={`font-mono text-xs font-semibold px-2 py-0.5 rounded border ${color} ${critical && !anyEnded ? 'animate-pulse' : ''}`}
        title={
          anyEnded
            ? 'Game ended'
            : `Time remaining · game ends at ${new Date(startMs + durationS * 1000).toLocaleTimeString()}`
        }
      >
        ⏱ {formatMmSs(Math.ceil(remainingMs / 1000))}
      </span>
    )
  }

  // No duration configured — show elapsed as a neutral pill.
  return (
    <span
      className="font-mono text-xs font-semibold px-2 py-0.5 rounded border border-slate-500/40 bg-slate-500/10 text-slate-200"
      title="Elapsed play time"
    >
      ⏱ {formatMmSs(Math.floor(elapsedMs / 1000))}
    </span>
  )
}

// --- Flag-holder pill ---
//
// Reads `entities.<flag>.properties.holding_team` from any converged snapshot.
// The CTF `mark_holding` rule stamps it once the flag has sat at a base for
// 1s; it persists as "last holder" until another base takes possession. We
// also cross-check the proximity_tracker to label "currently at base" vs
// "last held by" so the UI tells the truth when the flag is in transit.
function FlagHolderBadge({
  snapshots,
}: {
  snapshots: Record<string, LocalGameSnapshot>
}) {
  const snap = Object.values(snapshots).find(s => s.active_game_id) ?? null
  if (!snap) return null

  // Find the flag entity (game-agnostic — any entity whose type is 'flag').
  const flagEntity = Object.values(snap.entities).find(e => e.entity_type === 'flag')
  if (!flagEntity) return null

  const holdingTeam = (flagEntity.properties?.holding_team as string | undefined) ?? null

  // Is the flag currently within 1m of *a* base? We can tell from the
  // proximity_tracker — `mark_holding`'s rule-scoped key is `mark_holding|<flag>|<base>`
  // and is present iff the pair is currently within range.
  const tracker = snap.proximity_tracker ?? {}
  const flagLabel = flagEntity.label
  const activelyHeld = Object.keys(tracker).some(key => {
    if (!key.startsWith('mark_holding|')) return false
    return key.includes(`|${flagLabel}|`) || key.endsWith(`|${flagLabel}`)
  })

  if (!holdingTeam && !activelyHeld) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] font-mono border-slate-500/40 bg-slate-500/10 text-slate-200"
        title="Flag has not been captured yet"
      >
        🚩 neutral
      </Badge>
    )
  }

  const color = holdingTeam ? teamColor(holdingTeam) : '#94a3b8'
  return (
    <Badge
      variant="outline"
      className="text-[10px] font-mono"
      style={{
        backgroundColor: color + '22',
        color,
        borderColor: color + '55',
      }}
      title={
        activelyHeld
          ? `Flag is at ${holdingTeam ?? 'a'} base`
          : `Flag last captured by ${holdingTeam ?? 'unknown'}; currently in transit`
      }
    >
      🚩 {activelyHeld ? `at ${holdingTeam ?? '?'} base` : `last held by ${holdingTeam ?? '?'}`}
    </Badge>
  )
}

// --- Ended banner (winner + reason) ---
//
// When any node's phase flips to `ended`, surface the winner_team and reason
// captured from the GameEnd payload. Renders below the header row so the
// playing field stays unobstructed.
function EndedBanner({
  snapshots,
}: {
  snapshots: Record<string, LocalGameSnapshot>
}) {
  const ended = useMemo(() => {
    for (const snap of Object.values(snapshots)) {
      if (snap.phase !== 'ended') continue
      return {
        winner: snap.ended_winner_team ?? null,
        reason: snap.ended_reason ?? null,
      }
    }
    return null
  }, [snapshots])

  if (!ended) return null

  return (
    <div className="mt-2 flex items-center gap-2 text-xs rounded border border-purple-500/40 bg-purple-500/10 text-purple-200 px-2 py-1">
      <span className="font-semibold uppercase tracking-wide">Game ended</span>
      {ended.winner ? (
        <span
          className="px-1.5 py-0.5 rounded font-mono font-semibold"
          style={{
            backgroundColor: teamColor(ended.winner) + '22',
            color: teamColor(ended.winner),
            border: `1px solid ${teamColor(ended.winner)}55`,
          }}
        >
          winner: {ended.winner}
        </span>
      ) : (
        <span className="px-1.5 py-0.5 rounded font-mono font-semibold bg-slate-500/20 text-slate-200 border border-slate-500/40">
          draw
        </span>
      )}
      {ended.reason && <span className="text-[11px] italic truncate">{ended.reason}</span>}
    </div>
  )
}

/** Format a non-negative number of seconds as `MM:SS`. */
function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

// --- Synchronised 3-2-1-GO countdown overlay ---
//
// Backend sets `countdown_zero_ns` to the Vertex consensus timestamp of the
// final ReadyUp on every node simultaneously, then transitions each local
// phase through CountingDown → Playing after 3s of wall-clock. The overlay
// here reads the collective phase state: if *any* snapshot reports
// counting_down, start showing the countdown using a locally-captured t0;
// when phases flip to playing, briefly show "GO!" then fade out.
function CountdownOverlay({
  snapshots,
}: {
  snapshots: Record<string, LocalGameSnapshot>
}) {
  const [now, setNow] = useState(() => Date.now())
  const t0Ref = useRef<number | null>(null)
  const playingAtRef = useRef<number | null>(null)

  const phases = useMemo(() => Object.values(snapshots).map(s => s.phase), [snapshots])
  const anyCountingDown = phases.some(p => p === 'counting_down')
  const anyPlaying = phases.some(p => p === 'playing')

  // Capture t0 on the first tick we observe counting_down.
  useEffect(() => {
    if (anyCountingDown && t0Ref.current == null) {
      t0Ref.current = Date.now()
    }
  }, [anyCountingDown])

  // Capture transition to playing to drive the "GO!" flash.
  useEffect(() => {
    if (anyPlaying && playingAtRef.current == null) {
      playingAtRef.current = Date.now()
    }
  }, [anyPlaying])

  // Reset when nobody is counting down or playing anymore.
  useEffect(() => {
    if (!anyCountingDown && !anyPlaying) {
      t0Ref.current = null
      playingAtRef.current = null
    }
  }, [anyCountingDown, anyPlaying])

  // Tick at ~60Hz while the overlay is live so the count re-renders.
  useEffect(() => {
    if (!anyCountingDown && !anyPlaying) return
    const id = window.setInterval(() => setNow(Date.now()), 60)
    return () => window.clearInterval(id)
  }, [anyCountingDown, anyPlaying])

  const t0 = t0Ref.current
  const playingAt = playingAtRef.current

  let content: { text: string; accent: string } | null = null
  if (t0 != null) {
    const elapsedMs = now - t0
    const secsLeft = Math.ceil((3000 - elapsedMs) / 1000)
    if (secsLeft > 0 && secsLeft <= 3) {
      content = { text: String(secsLeft), accent: 'text-amber-300' }
    }
  }
  // "GO!" takes priority once any node transitions to playing, for ~1s.
  if (playingAt != null && now - playingAt < 1200) {
    content = { text: 'GO!', accent: 'text-emerald-300' }
  }

  if (!content) return null

  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
      aria-live="polite"
    >
      <div
        className={`font-black ${content.accent} drop-shadow-[0_6px_24px_rgba(0,0,0,0.8)]`}
        style={{
          fontSize: '180px',
          letterSpacing: '-0.05em',
          textShadow: '0 0 32px currentColor, 0 2px 8px rgba(0,0,0,0.6)',
          animation: 'countdown-pulse 0.9s ease-out',
        }}
      >
        {content.text}
      </div>
      <style>{`
        @keyframes countdown-pulse {
          0% { transform: scale(1.6); opacity: 0; }
          40% { transform: scale(1); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  )
}

function EntityGlyph({
  entity,
  datum,
  x,
  y,
}: {
  entity: EntityView
  datum: EntityView
  x: number
  y: number
}) {
  const color = teamColor(entity.team)
  const opacity = entity.running ? 1 : 0.45
  const strokeColor = entity.running ? '#0f172a' : '#4b5563'

  // Visual per entity_type — Phase A default is a generic grey circle.
  const type = entity.entity_type
  let body: React.ReactNode
  if (type === 'flag') {
    body = (
      <>
        <circle r={14} fill={color} stroke={strokeColor} strokeWidth={1.5} />
        <text textAnchor="middle" dominantBaseline="central" fontSize={16}>
          🚩
        </text>
      </>
    )
  } else if (type === 'base') {
    body = (
      <>
        <rect x={-16} y={-12} width={32} height={24} fill={color} stroke={strokeColor} strokeWidth={1.5} rx={2} />
        <text textAnchor="middle" dominantBaseline="central" fontSize={14}>
          🏠
        </text>
      </>
    )
  } else if (type === 'player') {
    body = (
      <>
        <polygon
          points="0,-12 10,10 -10,10"
          fill={color}
          stroke={strokeColor}
          strokeWidth={1.5}
        />
      </>
    )
  } else {
    body = (
      <circle
        r={10}
        fill="#6b7280"
        stroke={strokeColor}
        strokeWidth={1.5}
        fillOpacity={entity.running ? 0.9 : 0.5}
      />
    )
  }

  return (
    <g
      className="entity-group"
      data-label={datum.label}
      data-running={entity.running ? 'true' : 'false'}
      transform={`translate(${x}, ${y})`}
      style={{ cursor: entity.running ? 'grab' : 'not-allowed', opacity }}
    >
      {body}
      <text
        y={24}
        textAnchor="middle"
        fontSize={10}
        fill="#e5e7eb"
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {entity.label}
      </text>
    </g>
  )
}
