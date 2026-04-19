// In-browser geometry helpers used for comm-edge rendering.
//
// LOS (line-of-sight) lives only in the frontend since obstacles are a
// rendering concern. Range-only checks also exist here so the GameView can
// draw dashed comm lines without round-tripping through the backend — the
// backend's `partition_reconciler` does the authoritative range check for
// `pfctl` partitions (and ignores obstacles).

import type { Position } from './types'
import type { Obstacle } from './presentation'

export function inRange(a: Position, b: Position, radiusM: number): boolean {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy <= radiusM * radiusM
}

/** Segment-vs-circle intersection. Returns true if the line segment (a, b)
 *  passes through any of the obstacles that block LOS. */
export function hasLos(
  a: Position,
  b: Position,
  obstacles: Obstacle[],
): boolean {
  for (const o of obstacles) {
    if (o.blocks_los === false) continue
    if (segmentIntersectsCircle(a, b, o)) return false
  }
  return true
}

function segmentIntersectsCircle(a: Position, b: Position, o: Obstacle): boolean {
  // Closest-point-on-segment to circle centre, clamp parameter to [0,1].
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) {
    const ex = a.x - o.x
    const ey = a.y - o.y
    return ex * ex + ey * ey <= o.r * o.r
  }
  let t = ((o.x - a.x) * dx + (o.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  const ex = cx - o.x
  const ey = cy - o.y
  return ex * ex + ey * ey <= o.r * o.r
}

export function distance(a: Position, b: Position): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}
