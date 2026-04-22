import { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import { Badge } from '@/components/ui/badge'
import type { AgentState, EventLogEntry, NodeInfo } from '../types'
import type { GameConfig, LocalGameSnapshot, Position } from '../game/types'
import {
  COMM_RADIUS_M,
  PX_PER_M,
  fromPxX,
  fromPxY,
  teamColor,
  toPxX,
  toPxY,
} from '../game/presentation'
import { hasLos, inRange } from '../game/geom'
import { useSelection } from '@/state/SelectionContext'
import { useObstacles, type ObstacleRecord } from '@/state/ObstaclesContext'
import { edgeKey } from '@/game/edgeKey'
import { SelectionRing } from '@/components/canvas/SelectionRing'
import { CanvasHudSourceIndicator } from '@/components/canvas/CanvasHudSourceIndicator'
import { EdgeHoverToggle } from '@/components/canvas/EdgeHoverToggle'
import { GameTimer } from '@/components/canvas/huds/GameTimer'
import { Scoreboard } from '@/components/canvas/huds/Scoreboard'
import { FlagHolderBadge } from '@/components/canvas/huds/FlagHolderBadge'
import { CountdownOverlay } from '@/components/canvas/huds/CountdownOverlay'
import { EndedBanner } from '@/components/canvas/huds/EndedBanner'
import { selectHudSourceLabel } from '@/state/selectors'

/** Drag-vs-click threshold in screen pixels. Below this we treat the gesture
 *  as a selection click rather than a move. */
const CLICK_DRAG_THRESHOLD_PX = 3

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
  // Local overrides for obstacles during drag-move / drag-resize. Patch is
  // {x,y} while moving, {r} while resizing (no overlap — each gesture has
  // one obstacle in flight). Committed to ObstaclesContext on drag end.
  const [obstacleOverrides, setObstacleOverrides] = useState<
    Record<string, { x?: number; y?: number; r?: number }>
  >({})
  // Current zoom transform — stored so the drag handlers below can compensate
  // for pan/zoom when converting pointer coordinates back to field metres.
  const transformRef = useRef<{ k: number; x: number; y: number }>({ k: 1, x: 0, y: 0 })
  // Stable drag behaviours built once on mount; re-attached to DOM groups
  // whenever the set of entities / obstacles changes (see below).
  const dragBehaviorRef = useRef<d3.DragBehavior<SVGGElement, unknown, unknown> | null>(null)
  const obstacleDragRef = useRef<d3.DragBehavior<SVGGElement, unknown, unknown> | null>(null)
  const obstacleResizeRef = useRef<d3.DragBehavior<SVGGElement, unknown, unknown> | null>(null)
  // Stable zoom behaviour, also built once on mount. Exposed via ref so the
  // one-shot initial-fit effect (below) can apply a programmatic transform
  // through the same d3-zoom state machine the user drives.
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  // Latches `true` after the first fit-to-entities has been applied. Prevents
  // the initial-fit from yanking the camera around when new nodes spawn.
  const hasFitInitialRef = useRef(false)
  // Always-latest `onMove` callback so the drag-end handler doesn't need the
  // zoom/drag setup to re-run on every prop change.
  const onMoveRef = useRef(onMove)
  useEffect(() => { onMoveRef.current = onMove })

  // Selection wiring: read via ref so the drag-end handler keeps a stable
  // closure even when the selection updates.
  const selectionApi = useSelection()
  const selectionApiRef = useRef(selectionApi)
  useEffect(() => { selectionApiRef.current = selectionApi })

  // `onTogglePartition` stays in the prop surface so callers don't need to
  // rewire when EdgeHoverToggle lands in Phase 5. Reference it via a ref so
  // TypeScript sees it as consumed and so the Phase 5 overlay can pick it up
  // without a re-prop.
  const onTogglePartitionRef = useRef(onTogglePartition)
  useEffect(() => { onTogglePartitionRef.current = onTogglePartition })

  const activeGameId = useMemo<string | null>(() => {
    for (const snap of Object.values(snapshots)) {
      if (snap.active_game_id) return snap.active_game_id
    }
    return null
  }, [snapshots])

  // Obstacles live in ObstaclesContext — the user places / moves / resizes
  // them manually. We keep a ref of the latest list so drag handlers can
  // look up an obstacle's current geometry without reinstalling when the
  // list changes.
  const { obstacles, updateObstacle } = useObstacles()
  const obstaclesRef = useRef<ObstacleRecord[]>(obstacles)
  useEffect(() => {
    obstaclesRef.current = obstacles
  }, [obstacles])
  const updateObstacleRef = useRef(updateObstacle)
  useEffect(() => {
    updateObstacleRef.current = updateObstacle
  })

  // Effective obstacles: merge in any live drag overrides so the canvas
  // (and the LOS edge colouring) tracks the cursor in real time.
  const effectiveObstacles = useMemo<ObstacleRecord[]>(() => {
    if (Object.keys(obstacleOverrides).length === 0) return obstacles
    return obstacles.map(o => {
      const ov = obstacleOverrides[o.id]
      return ov ? { ...o, ...ov } : o
    })
  }, [obstacles, obstacleOverrides])

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

  // Stable key that changes when obstacles are added / removed (the `set`
  // changes), not on every reposition. Used to gate the obstacle-drag
  // re-attachment effect below, mirroring the pattern for entities.
  const obstacleIdsKey = useMemo(
    () => obstacles.map(o => o.id).sort().join(','),
    [obstacles],
  )

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
        const inLosRange = inRange(pa, pb, commRadiusM) && hasLos(pa, pb, effectiveObstacles)
        const partitioned = partitionedSet.has(key)
        edges.push({ a: ea.label, b: eb.label, connected: inLosRange && !partitioned })
      }
    }
    return edges
  }, [entities, effectivePos, commRadiusM, effectiveObstacles, partitionedSet])

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
        // handler, and on a comm edge fall through to its click handler, and
        // on an obstacle (or its resize handle) fall through to their drag
        // handlers. Wheels and background drags still pan/zoom.
        if (event.type === 'wheel') return true
        const target = event.target as Element | null
        if (target?.closest('g.entity-group')) return false
        if (target?.closest('g.comm-edge')) return false
        if (target?.closest('g.obstacle-group')) return false
        if (target?.closest('g.obstacle-handle')) return false
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
    zoomBehaviorRef.current = zoom

    // Convert a d3-drag event's (x, y) into field metres. d3-drag uses
    // d3.pointer with a default container of the dragged element's parent
    // (`g.entities`), and d3.pointer applies `getScreenCTM().inverse()` —
    // which already undoes the zoom-layer's transform. So `event.x`/`event.y`
    // are in the *pre-zoom* pixel coordinate space (the same space `toPxX`
    // outputs), and we just divide by `PX_PER_M` to get metres.
    //
    // (Earlier this also subtracted the zoom transform's translate and divided
    // by its scale — that was double-undoing the zoom and made the dropped
    // node land at an offset from the cursor that grew with the pan offset.)
    //
    // The canvas is infinite, so we do not clamp — entities can be dragged
    // anywhere.
    const toFieldM = (event: { x: number; y: number }) => {
      return { x: fromPxX(event.x), y: fromPxY(event.y) }
    }

    // React owns the entity DOM, so `.call(drag)` can't rely on `__data__`
    // being bound (it isn't — React doesn't set it). Read the label from the
    // `data-label` attribute stamped onto each `g.entity-group` instead.
    //
    // Click vs drag (A5 + B2): track screen-space distance from mousedown;
    // if the gesture moves < CLICK_DRAG_THRESHOLD_PX pixels we emit a
    // selection click instead of committing a move. Threshold is in screen
    // px (NOT field metres) so it's zoom-invariant.
    const dragState = { startX: 0, startY: 0, wasDrag: false }
    const drag = d3
      .drag<SVGGElement, unknown>()
      .filter(function () {
        // Entity is always clickable (even when stopped) so a stopped node's
        // label can still be selected. Drag-move is blocked for stopped
        // nodes inside the handler.
        return true
      })
      .on('start', function (event) {
        dragState.startX = event.sourceEvent.clientX
        dragState.startY = event.sourceEvent.clientY
        dragState.wasDrag = false
        d3.select(this).raise()
      })
      .on('drag', function (event) {
        const el = this as SVGGElement
        if (el.getAttribute('data-running') === 'false') return
        const dx = event.sourceEvent.clientX - dragState.startX
        const dy = event.sourceEvent.clientY - dragState.startY
        if (Math.hypot(dx, dy) >= CLICK_DRAG_THRESHOLD_PX) {
          dragState.wasDrag = true
          d3.select(this).classed('dragging', true)
        }
        if (!dragState.wasDrag) return
        const label = el.getAttribute('data-label')
        if (!label) return
        const p = toFieldM(event)
        setDragOverrides(prev => ({ ...prev, [label]: p }))
      })
      .on('end', function (event) {
        d3.select(this).classed('dragging', false)
        const el = this as SVGGElement
        const label = el.getAttribute('data-label')
        if (!label) return
        if (!dragState.wasDrag) {
          // Treat as click — select the node (A5).
          selectionApiRef.current.selectNode(label)
          return
        }
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

    // --- Obstacle move (click-to-select, drag-to-reposition) ---
    //
    // Mirrors the entity pattern: a screen-pixel threshold distinguishes a
    // click (select) from a drag (move). Offset capture keeps the cursor
    // anchored to the same point on the obstacle throughout the drag.
    const obstacleDragState = {
      startX: 0,
      startY: 0,
      wasDrag: false,
      offsetX: 0,
      offsetY: 0,
    }
    const obstacleDrag = d3
      .drag<SVGGElement, unknown>()
      .on('start', function (event) {
        obstacleDragState.startX = event.sourceEvent.clientX
        obstacleDragState.startY = event.sourceEvent.clientY
        obstacleDragState.wasDrag = false
        const el = this as SVGGElement
        const id = el.getAttribute('data-id')
        const ob = id
          ? obstaclesRef.current.find(o => o.id === id)
          : undefined
        if (ob) {
          const p = toFieldM(event)
          obstacleDragState.offsetX = p.x - ob.x
          obstacleDragState.offsetY = p.y - ob.y
        } else {
          obstacleDragState.offsetX = 0
          obstacleDragState.offsetY = 0
        }
        d3.select(this).raise()
      })
      .on('drag', function (event) {
        const el = this as SVGGElement
        const dx = event.sourceEvent.clientX - obstacleDragState.startX
        const dy = event.sourceEvent.clientY - obstacleDragState.startY
        if (Math.hypot(dx, dy) >= CLICK_DRAG_THRESHOLD_PX) {
          obstacleDragState.wasDrag = true
          d3.select(this).classed('dragging', true)
        }
        if (!obstacleDragState.wasDrag) return
        const id = el.getAttribute('data-id')
        if (!id) return
        const p = toFieldM(event)
        setObstacleOverrides(prev => ({
          ...prev,
          [id]: {
            ...(prev[id] ?? {}),
            x: p.x - obstacleDragState.offsetX,
            y: p.y - obstacleDragState.offsetY,
          },
        }))
      })
      .on('end', function (event) {
        d3.select(this).classed('dragging', false)
        const el = this as SVGGElement
        const id = el.getAttribute('data-id')
        if (!id) return
        if (!obstacleDragState.wasDrag) {
          // Treat as click — select the obstacle so the inspector opens.
          selectionApiRef.current.selectObstacle(id)
          return
        }
        const p = toFieldM(event)
        const finalX = p.x - obstacleDragState.offsetX
        const finalY = p.y - obstacleDragState.offsetY
        setObstacleOverrides(prev => {
          const copy = { ...prev }
          delete copy[id]
          return copy
        })
        updateObstacleRef.current(id, { x: finalX, y: finalY })
        // Keep the obstacle selected after a drag so the user can immediately
        // tweak numeric fields in the inspector or drag the resize handle.
        selectionApiRef.current.selectObstacle(id)
      })
    obstacleDragRef.current = obstacleDrag
    svg.selectAll<SVGGElement, unknown>('g.obstacle-group').call(obstacleDrag)

    // --- Obstacle resize (drag a handle on the circle edge) ---
    //
    // The handle is only rendered when the obstacle is selected; radius
    // equals the cursor's distance from the obstacle centre, floored so a
    // zero-radius circle can't be produced.
    const obstacleResize = d3
      .drag<SVGGElement, unknown>()
      .on('start', function () {
        d3.select(this).classed('dragging', true)
      })
      .on('drag', function (event) {
        const el = this as SVGGElement
        const id = el.getAttribute('data-id')
        if (!id) return
        const ob = obstaclesRef.current.find(o => o.id === id)
        if (!ob) return
        const p = toFieldM(event)
        const dx = p.x - ob.x
        const dy = p.y - ob.y
        const r = Math.max(0.3, Math.sqrt(dx * dx + dy * dy))
        setObstacleOverrides(prev => ({
          ...prev,
          [id]: { ...(prev[id] ?? {}), r },
        }))
      })
      .on('end', function (event) {
        d3.select(this).classed('dragging', false)
        const el = this as SVGGElement
        const id = el.getAttribute('data-id')
        if (!id) return
        const ob = obstaclesRef.current.find(o => o.id === id)
        if (!ob) return
        const p = toFieldM(event)
        const dx = p.x - ob.x
        const dy = p.y - ob.y
        const r = Math.max(0.3, Math.sqrt(dx * dx + dy * dy))
        setObstacleOverrides(prev => {
          const copy = { ...prev }
          delete copy[id]
          return copy
        })
        updateObstacleRef.current(id, { r })
      })
    obstacleResizeRef.current = obstacleResize
    svg.selectAll<SVGGElement, unknown>('g.obstacle-handle').call(obstacleResize)

    return () => {
      svg.on('.zoom', null)
      svg.selectAll<SVGGElement, unknown>('g.entity-group').on('.drag', null)
      svg.selectAll<SVGGElement, unknown>('g.obstacle-group').on('.drag', null)
      svg.selectAll<SVGGElement, unknown>('g.obstacle-handle').on('.drag', null)
      dragBehaviorRef.current = null
      obstacleDragRef.current = null
      obstacleResizeRef.current = null
      zoomBehaviorRef.current = null
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

  // Re-attach the obstacle drag + resize behaviours when an obstacle is
  // added or removed. Both behaviours are stable (built once on mount); we
  // just need to bind them to the freshly-rendered <g>'s on set changes.
  // Position/radius edits keep the same <g> node so drag state survives.
  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    if (obstacleDragRef.current) {
      svg.selectAll<SVGGElement, unknown>('g.obstacle-group')
        .call(obstacleDragRef.current)
    }
    if (obstacleResizeRef.current) {
      svg.selectAll<SVGGElement, unknown>('g.obstacle-handle')
        .call(obstacleResizeRef.current)
    }
  }, [obstacleIdsKey])

  // Ensure the resize handle for the currently-selected obstacle is bound to
  // the resize behaviour as soon as it renders (selection change mounts /
  // unmounts the handle's <g> node).
  const selectedObstacleId =
    selectionApi.selection.kind === 'obstacle'
      ? selectionApi.selection.id
      : null
  useEffect(() => {
    if (!svgRef.current || !obstacleResizeRef.current) return
    d3.select(svgRef.current)
      .selectAll<SVGGElement, unknown>('g.obstacle-handle')
      .call(obstacleResizeRef.current)
  }, [selectedObstacleId])

  // One-shot initial-fit: when entities first appear, center the entity
  // bounding box in the canvas and scale to fit with some padding. Runs
  // exactly once (latched via `hasFitInitialRef`) so subsequent spawns and
  // re-renders don't yank the camera away from wherever the user has panned.
  // Scale is clamped to the same [0.5, 3] range the d3-zoom behaviour uses,
  // and the transform is applied via `zoomBehavior.transform` so the
  // 'zoom' event fires and `transformRef.current` stays in sync.
  useEffect(() => {
    if (hasFitInitialRef.current) return
    if (entities.length === 0) return
    const svgEl = svgRef.current
    const zoomBehavior = zoomBehaviorRef.current
    if (!svgEl || !zoomBehavior) return
    const rect = svgEl.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    const xs = entities.map(e => toPxX(e.pos.x))
    const ys = entities.map(e => toPxY(e.pos.y))
    const PAD_PX = 80
    const minX = Math.min(...xs) - PAD_PX
    const maxX = Math.max(...xs) + PAD_PX
    const minY = Math.min(...ys) - PAD_PX
    const maxY = Math.max(...ys) + PAD_PX
    const w = Math.max(maxX - minX, 1)
    const h = Math.max(maxY - minY, 1)

    const scale = Math.max(
      0.5,
      Math.min(3, Math.min(rect.width / w, rect.height / h)),
    )
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const tx = rect.width / 2 - cx * scale
    const ty = rect.height / 2 - cy * scale

    d3.select(svgEl).call(
      zoomBehavior.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale),
    )
    hasFitInitialRef.current = true
  }, [entities])

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

  // Grid pattern ids — scoped per-mount so multiple GameView instances
  // (hypothetically) don't collide in the SVG defs namespace.
  const gridIdSuffix = useMemo(() => Math.random().toString(36).slice(2, 8), [])
  const gridFineId = `grid-fine-${gridIdSuffix}`
  const gridCoarseId = `grid-coarse-${gridIdSuffix}`

  // Grid extent: a large rect inside the zoom layer makes the canvas feel
  // "infinite" — the user can pan far in any direction before running off
  // the grid. At PX_PER_M=20 this covers ±5000 metres from origin, which
  // is well beyond any realistic navigation range.
  const GRID_EXTENT_PX = 100_000

  // Look up the active game config for game-specific UI (timer, flag holder).
  const activeGame = useMemo<GameConfig | undefined>(() => {
    if (!activeGameId) return undefined
    return games.find(g => g.id === activeGameId)
  }, [games, activeGameId])

  // HUD-source label (A2): selected node → its snapshot, otherwise fall back
  // to the first node. Drives the canvas HUDs and the "HUD: …" pill.
  const hudSourceLabel = selectHudSourceLabel(selectionApi.selection, nodes)
  const hudSourceSnapshot = hudSourceLabel ? snapshots[hudSourceLabel] : undefined

  // Edge hover state (A7). Tracked here so the HTML overlay can position the
  // quick-toggle button at the edge midpoint without crossing the SVG/HTML
  // boundary.
  const [hoveredEdge, setHoveredEdge] = useState<{
    a: string
    b: string
    mid: { x: number; y: number }
  } | null>(null)

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Canvas header strip: title + extracted HUDs. */}
      <div className="shrink-0 border-b px-3 py-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Playing Field</span>
          {activeGameId ? (
            <Badge variant="secondary">{activeGameId}</Badge>
          ) : (
            <Badge variant="outline">no game loaded</Badge>
          )}
          <FlagHolderBadge
            sourceSnapshot={hudSourceSnapshot}
            allSnapshots={snapshots}
          />
        </div>
        <div className="ml-auto flex items-center gap-3">
          <GameTimer
            sourceSnapshot={hudSourceSnapshot}
            allSnapshots={snapshots}
            activeGame={activeGame}
          />
          <Scoreboard
            sourceSnapshot={hudSourceSnapshot}
            allSnapshots={snapshots}
          />
          <div className="text-[10px] text-muted-foreground">
            radius {commRadiusM}m · {entities.length}{' '}
            {entities.length === 1 ? 'entity' : 'entities'}
          </div>
        </div>
      </div>

      {/* Optional ended banner strip under the header. */}
      <div className="shrink-0 px-3 py-1 empty:hidden">
        <EndedBanner
          sourceSnapshot={hudSourceSnapshot}
          allSnapshots={snapshots}
        />
      </div>

      {/* Canvas container: full-bleed SVG + HTML overlays (pill, hover
          button, countdown). The canvas is infinite — the user pans/zooms
          via d3-zoom rather than scrolling a bounded SVG. `overflow-hidden`
          clips the huge grid rect to the container's rounded border. */}
      <div className="flex-1 min-h-0 relative bg-background rounded-md border overflow-hidden">
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          className="block absolute inset-0"
          onClick={e => {
            // Background click → deselect. Entity/comm-edge/obstacle groups
            // either stop propagation or (for obstacles) are handled by the
            // d3-drag end callback that fires before this click — either way
            // reaching here means the user clicked on the grid background.
            const target = e.target as Element
            if (
              target.closest('.entity-group') ||
              target.closest('.comm-edge') ||
              target.closest('.obstacle-group') ||
              target.closest('.obstacle-handle')
            ) {
              return
            }
            selectionApi.deselect()
          }}
        >
          <defs>
            {/* 1 metre × 1 metre grid — thin, low-contrast. Tiled across a
                large rect inside the zoom layer so grid spacing tracks world
                metres under pan/zoom. `vector-effect: non-scaling-stroke`
                keeps stroke width constant on screen regardless of zoom. */}
            <pattern
              id={gridFineId}
              x={0}
              y={0}
              width={PX_PER_M}
              height={PX_PER_M}
              patternUnits="userSpaceOnUse"
            >
              <path
                d={`M ${PX_PER_M} 0 L 0 0 0 ${PX_PER_M}`}
                fill="none"
                stroke="#94a3b8"
                strokeOpacity={0.18}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            </pattern>
            {/* Every 10 metres — slightly thicker / more opaque, drawn on
                top of the fine grid so the 10-m lines visually dominate. */}
            <pattern
              id={gridCoarseId}
              x={0}
              y={0}
              width={PX_PER_M * 10}
              height={PX_PER_M * 10}
              patternUnits="userSpaceOnUse"
            >
              <path
                d={`M ${PX_PER_M * 10} 0 L 0 0 0 ${PX_PER_M * 10}`}
                fill="none"
                stroke="#94a3b8"
                strokeOpacity={0.45}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            </pattern>
          </defs>

          {/* Zoom/pan transform applies to every field layer below. d3-zoom
              writes to `transform` on this group; see the effect above. */}
          <g ref={zoomLayerRef} className="zoom-layer">
          {/* Grid — drawn inside the zoom layer so 1 m spacing is preserved
              in world coordinates (i.e., tiles scale with zoom). Two rects
              layer the fine and coarse grids; the huge extent makes pan feel
              unbounded. */}
          <rect
            x={-GRID_EXTENT_PX}
            y={-GRID_EXTENT_PX}
            width={GRID_EXTENT_PX * 2}
            height={GRID_EXTENT_PX * 2}
            fill={`url(#${gridFineId})`}
          />
          <rect
            x={-GRID_EXTENT_PX}
            y={-GRID_EXTENT_PX}
            width={GRID_EXTENT_PX * 2}
            height={GRID_EXTENT_PX * 2}
            fill={`url(#${gridCoarseId})`}
          />

          {/* Obstacles — rendered from the user-managed ObstaclesContext.
              Each obstacle sits in its own `g.obstacle-group` so the d3-drag
              behaviour (installed in the mount effect) can pick it up by
              `data-id`. Obstacles are clickable (select → inspector) and
              draggable (reposition → updateObstacle). The selected obstacle
              also renders a small square handle on its right edge that the
              user drags to resize. */}
          <g className="obstacles">
            {effectiveObstacles.map(o => {
              const cx = toPxX(o.x)
              const cy = toPxY(o.y)
              const rPx = o.r * PX_PER_M
              const selected = selectedObstacleId === o.id
              const fill = o.blocks_los ? '#5b6470' : '#5b647080'
              const stroke = selected ? 'var(--primary)' : '#2b323c'
              const strokeWidth = selected ? 2.5 : 1.5
              return (
                <g
                  key={o.id}
                  className="obstacle-group"
                  data-id={o.id}
                  style={{ cursor: 'grab' }}
                >
                  <circle
                    cx={cx}
                    cy={cy}
                    r={rPx}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    strokeDasharray={o.blocks_los ? undefined : '4,3'}
                  />
                  {/* Tiny label, shown faintly so obstacles are identifiable
                      at a glance but don't compete with entity labels. */}
                  <text
                    x={cx}
                    y={cy + rPx + 12}
                    textAnchor="middle"
                    fontSize={10}
                    fill={selected ? 'var(--primary)' : '#94a3b8'}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {o.label}
                  </text>
                </g>
              )
            })}
          </g>

          {/* Obstacle resize handle — rendered separately (above obstacles)
              for the selected obstacle only. Sits on its own `g` so the
              resize-drag behaviour can find it by class + data-id. */}
          {selectedObstacleId && (() => {
            const o = effectiveObstacles.find(ob => ob.id === selectedObstacleId)
            if (!o) return null
            const cx = toPxX(o.x)
            const cy = toPxY(o.y)
            const rPx = o.r * PX_PER_M
            return (
              <g
                className="obstacle-handle"
                data-id={o.id}
                style={{ cursor: 'ew-resize' }}
              >
                {/* Thin indicator line from centre to handle so the user
                    can see they're editing the radius. */}
                <line
                  x1={cx}
                  y1={cy}
                  x2={cx + rPx}
                  y2={cy}
                  stroke="var(--primary)"
                  strokeWidth={1}
                  strokeOpacity={0.5}
                  strokeDasharray="3,3"
                  pointerEvents="none"
                />
                <rect
                  x={cx + rPx - 5}
                  y={cy - 5}
                  width={10}
                  height={10}
                  rx={2}
                  fill="var(--primary)"
                  stroke="#0f172a"
                  strokeWidth={1}
                />
              </g>
            )
          })()}

          {/* Comm-radius rings. The selected node's ring renders with a
              much higher opacity so it's obvious which node's range is
              highlighted; the remaining rings stay faint so they don't
              clutter the canvas. */}
          <g className="radius-rings">
            {entities.map(e => {
              const p = effectivePos[e.label]
              if (!p) return null
              const selected =
                selectionApi.selection.kind === 'node' &&
                selectionApi.selection.label === e.label
              return (
                <circle
                  key={e.label}
                  cx={toPxX(p.x)}
                  cy={toPxY(p.y)}
                  r={commRadiusM * PX_PER_M}
                  fill="none"
                  stroke="#64748b"
                  strokeOpacity={selected ? 0.75 : 0.08}
                  strokeWidth={selected ? 1.5 : 1}
                  strokeDasharray="2,4"
                />
              )
            })}
          </g>

          {/* Comm edges — one line per pair. Connected pairs are green; every
              other pair (out of range, obstructed, or user-severed) renders as
              a red dashed line with higher opacity. A wider transparent line
              sits on top so the edge is easy to click. Clicking the line
              selects the edge (A7); the partition toggle itself lives in the
              EdgeInspector (Phase 4/5). The `EdgeHoverToggle` overlay on top
              of this layer surfaces a quick-toggle button on hover. */}
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
              const selected =
                selectionApi.selection.kind === 'edge' &&
                edgeKey(edge.a, edge.b) === edgeKey(
                  selectionApi.selection.a,
                  selectionApi.selection.b,
                )
              const midX = (x1 + x2) / 2
              const midY = (y1 + y2) / 2
              return (
                <g
                  key={`${edge.a}-${edge.b}`}
                  className="comm-edge"
                  style={{ cursor: 'pointer' }}
                  onClick={e => {
                    e.stopPropagation()
                    selectionApi.selectEdge(edge.a, edge.b)
                  }}
                  onMouseEnter={() => {
                    // Convert viewBox coords to container pixels for the
                    // HTML overlay. The zoom layer's transform applies on the
                    // client side; `getScreenCTM` would be the correct way to
                    // project, but for the container-relative midpoint we
                    // combine the current zoom transform with the SVG size
                    // ratio (SVG is rendered at its intrinsic size since the
                    // container scrolls rather than scales).
                    const { k, x, y } = transformRef.current
                    setHoveredEdge({
                      a: edge.a,
                      b: edge.b,
                      mid: { x: midX * k + x, y: midY * k + y },
                    })
                  }}
                  onMouseLeave={() => {
                    // Let EdgeHoverToggle's own hide-delay take over. Setting
                    // null arms its timer; if the cursor moves onto the
                    // button itself it keeps the toggle visible.
                    setHoveredEdge(null)
                  }}
                >
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={stroke}
                    strokeOpacity={selected ? 1 : strokeOpacity}
                    strokeWidth={selected ? strokeWidth + 1.5 : strokeWidth}
                    strokeDasharray="6,4"
                  />
                  {/* Invisible wider hit target — makes thin lines easy to
                      tap without dominating the visual. `pointerEvents="stroke"`
                      guarantees the line catches clicks even though the stroke
                      is transparent. Widened to 20px (A7) so hover/click is
                      easy. */}
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke="transparent"
                    strokeWidth={20}
                    pointerEvents="stroke"
                  />
                </g>
              )
            })}
          </g>

          {/* Effects layer (heartbeat/action/state animations) sits above the
              edges and behind the entities so pulses don't hide the glyphs. */}
          <g ref={effectsLayerRef} className="effects-layer" pointerEvents="none" />

          {/* Selection ring sits above effects, below entity glyphs. Rendered
              inside the zoom layer so the ring pans + zooms with the field. */}
          {selectionApi.selection.kind === 'node' && (() => {
            const p = effectivePos[selectionApi.selection.label]
            if (!p) return null
            return (
              <SelectionRing x={toPxX(p.x)} y={toPxY(p.y)} />
            )
          })()}

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
          {/* Background-click deselect layer. A transparent rect inside the
              zoom layer would hijack drag/zoom, so we put a top-level
              invisible overlay on the SVG root and check that the click
              originated directly on the SVG background (not bubbled from an
              entity or edge group). */}
        </svg>

        {/* HTML overlays pinned to the canvas container. `absolute` +
            `inset-0` stacks on top of the SVG but shares the same sizing. */}
        <div className="pointer-events-none absolute inset-0">
          <CanvasHudSourceIndicator />
          <CountdownOverlay allSnapshots={snapshots} />
          <EdgeHoverToggle
            hovered={hoveredEdge}
            partitioned={
              hoveredEdge
                ? partitions.some(
                    p => edgeKey(p[0], p[1]) === edgeKey(hoveredEdge.a, hoveredEdge.b),
                  )
                : false
            }
            onToggle={(a, b) => onTogglePartitionRef.current(a, b)}
            onHoverEnd={() => setHoveredEdge(null)}
          />
        </div>
      </div>
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
