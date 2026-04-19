import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { NodeInfo } from '../types'
import type { GameConfig, LocalGameSnapshot, Position } from '../game/types'
import {
  FIELD_HEIGHT_M,
  FIELD_HEIGHT_PX,
  FIELD_WIDTH_M,
  FIELD_WIDTH_PX,
  PRE_GAME_COMM_RADIUS_M,
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
  games: GameConfig[]
  onMove: (label: string, x: number, y: number) => void | Promise<void>
  partitions: [string, string][]
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

export function GameView({ nodes, snapshots, games, onMove, partitions }: GameViewProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const zoomLayerRef = useRef<SVGGElement | null>(null)
  // During drag, we locally override positions; on drop we commit to backend.
  const [dragOverrides, setDragOverrides] = useState<Record<string, Position>>({})
  // Current zoom transform — stored so the drag handlers below can compensate
  // for pan/zoom when converting pointer coordinates back to field metres.
  const transformRef = useRef<{ k: number; x: number; y: number }>({ k: 1, x: 0, y: 0 })

  const activeGameId = useMemo<string | null>(() => {
    for (const snap of Object.values(snapshots)) {
      if (snap.active_game_id) return snap.active_game_id
    }
    return null
  }, [snapshots])

  const presentation = useMemo(() => presentationFor(activeGameId), [activeGameId])

  // Comm radius: pre-game default until a game is loaded, then the active
  // game's `comm_radius_m` — in lockstep with the backend `partition_reconciler`.
  const commRadiusM = useMemo(() => {
    if (!activeGameId) return PRE_GAME_COMM_RADIUS_M
    const cfg = games.find(g => g.id === activeGameId)
    return cfg?.comm_radius_m ?? PRE_GAME_COMM_RADIUS_M
  }, [activeGameId, games])

  const entities = useMemo(
    () => buildEntityViews(nodes, snapshots),
    [nodes, snapshots],
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

  // Compute comm edges (pairs that are in range + LOS).
  const commEdges = useMemo(() => {
    const edges: { a: string; b: string; partitioned: boolean }[] = []
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const ea = entities[i]
        const eb = entities[j]
        const pa = effectivePos[ea.label]
        const pb = effectivePos[eb.label]
        if (!pa || !pb) continue
        if (!inRange(pa, pb, commRadiusM)) continue
        if (!hasLos(pa, pb, presentation.obstacles)) continue
        const key = ea.label < eb.label ? `${ea.label}|${eb.label}` : `${eb.label}|${ea.label}`
        edges.push({ a: ea.label, b: eb.label, partitioned: partitionedSet.has(key) })
      }
    }
    return edges
  }, [entities, effectivePos, commRadiusM, presentation.obstacles, partitionedSet])

  // Set up D3 drag + zoom behaviour.
  //
  // Zoom is applied as a transform on an inner `<g class="zoom-layer">` so
  // the SVG background and size don't change. Drag events use the current
  // zoom transform to compute field-metre coords from pointer-pixel coords,
  // so dragging an entity while zoomed in tracks the cursor correctly.
  //
  // A filter on the zoom prevents it from grabbing pointer events that start
  // on an entity group — otherwise the zoom and drag race for the gesture.
  useEffect(() => {
    if (!svgRef.current || !zoomLayerRef.current) return
    const svg = d3.select(svgRef.current)
    const layer = d3.select(zoomLayerRef.current)

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 3])
      .filter(event => {
        // Let mousedown/touchstart on an entity fall through to the drag
        // handler. Wheels and background drags still pan/zoom.
        if (event.type === 'wheel') return true
        const target = event.target as Element | null
        if (target?.closest('g.entity-group')) return false
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
        void onMove(label, p.x, p.y)
      })

    svg.selectAll<SVGGElement, unknown>('g.entity-group').call(drag)

    return () => {
      svg.on('.zoom', null)
    }
  }, [onMove, entities])

  const gradientId = `game-field-gradient-${activeGameId ?? 'none'}`

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
          </CardTitle>
          <div className="flex items-center gap-3">
            <Scoreboard snapshots={snapshots} />
            <div className="text-xs text-muted-foreground">
              {FIELD_WIDTH_M}m × {FIELD_HEIGHT_M}m · radius {commRadiusM}m · {entities.length}{' '}
              {entities.length === 1 ? 'entity' : 'entities'}
            </div>
          </div>
        </div>
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

          {/* Comm edges */}
          <g className="comm-edges">
            {commEdges.map(edge => {
              const pa = effectivePos[edge.a]
              const pb = effectivePos[edge.b]
              if (!pa || !pb) return null
              return (
                <line
                  key={`${edge.a}-${edge.b}`}
                  x1={toPxX(pa.x)}
                  y1={toPxY(pa.y)}
                  x2={toPxX(pb.x)}
                  y2={toPxY(pb.y)}
                  stroke={edge.partitioned ? '#ef4444' : '#22c55e'}
                  strokeOpacity={edge.partitioned ? 0.9 : 0.6}
                  strokeWidth={edge.partitioned ? 2 : 1.2}
                  strokeDasharray="6,4"
                />
              )
            })}
          </g>

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
          style={{
            backgroundColor: teamColor(team) + '22',
            color: teamColor(team),
            border: `1px solid ${teamColor(team)}55`,
          }}
        >
          {team}: {merged[team]}
        </span>
      ))}
    </div>
  )
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
