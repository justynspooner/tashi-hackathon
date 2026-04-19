// Uses Bun's built-in test runner (`bun test`). No extra deps.
import { describe, expect, test } from 'bun:test'
import { inRange, hasLos, distance } from './geom'
import type { Obstacle } from './presentation'

describe('inRange', () => {
  test('returns true when distance equals radius (boundary inclusive)', () => {
    expect(inRange({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toBe(true)
  })

  test('returns false when distance exceeds radius', () => {
    expect(inRange({ x: 0, y: 0 }, { x: 3, y: 4 }, 4.9)).toBe(false)
  })

  test('returns true for coincident points', () => {
    expect(inRange({ x: 10, y: 10 }, { x: 10, y: 10 }, 0)).toBe(true)
  })

  test('matches Rust backend semantics at 5m with 3-4-5 triangle', () => {
    // Mirrors the Rust geom::in_range test case — critical for keeping the
    // rendered edges consistent with the pfctl-partitioned set.
    expect(inRange({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toBe(true)
    expect(inRange({ x: 0, y: 0 }, { x: 3, y: 4 }, 4)).toBe(false)
  })
})

describe('distance', () => {
  test('computes Euclidean distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })

  test('is zero for the same point', () => {
    expect(distance({ x: 7, y: 7 }, { x: 7, y: 7 })).toBe(0)
  })
})

describe('hasLos', () => {
  const rock: Obstacle = { x: 5, y: 0, r: 1, blocks_los: true }

  test('returns true when no obstacles', () => {
    expect(hasLos({ x: 0, y: 0 }, { x: 10, y: 0 }, [])).toBe(true)
  })

  test('returns false when segment passes through an obstacle', () => {
    expect(hasLos({ x: 0, y: 0 }, { x: 10, y: 0 }, [rock])).toBe(false)
  })

  test('returns true when segment misses the obstacle', () => {
    // Segment shifted upward past rock's radius.
    expect(hasLos({ x: 0, y: 5 }, { x: 10, y: 5 }, [rock])).toBe(true)
  })

  test('ignores obstacles with blocks_los=false', () => {
    const cosmetic: Obstacle = { x: 5, y: 0, r: 1, blocks_los: false }
    expect(hasLos({ x: 0, y: 0 }, { x: 10, y: 0 }, [cosmetic])).toBe(true)
  })

  test('handles zero-length segment (endpoints coincide) inside obstacle', () => {
    expect(hasLos({ x: 5, y: 0 }, { x: 5, y: 0 }, [rock])).toBe(false)
  })

  test('handles zero-length segment outside obstacle', () => {
    expect(hasLos({ x: 20, y: 20 }, { x: 20, y: 20 }, [rock])).toBe(true)
  })

  test('short-circuits on first blocking obstacle', () => {
    const r1: Obstacle = { x: 3, y: 0, r: 0.5, blocks_los: true }
    const r2: Obstacle = { x: 6, y: 0, r: 0.5, blocks_los: true }
    expect(hasLos({ x: 0, y: 0 }, { x: 10, y: 0 }, [r1, r2])).toBe(false)
  })
})
