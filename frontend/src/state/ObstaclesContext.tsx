/* eslint-disable react-refresh/only-export-components --
   Provider + hook belong in the same module per React Context convention. */
// Frontend-only obstacle state. Obstacles are a pure rendering concern (the
// Rust backend does not know about them) and are placed manually by the user
// via the scene tree "+ Add Obstacle" control. Once added they can be
// dragged around and resized directly on the canvas, or edited numerically
// in the Inspector. State lives in memory for the session only — no
// persistence, no backend round-trip.
//
// Each obstacle carries:
//   - `id`          stable string ID, used for selection + updates
//   - `label`       human-readable name shown in the scene tree / inspector
//   - `x`, `y`      centre position in metres (field coords)
//   - `r`           radius in metres
//   - `blocks_los`  whether the obstacle blocks comm line-of-sight
//
// The shape is a structural superset of the geom helper's `Obstacle` so the
// same list can be passed to `hasLos` without mapping.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export interface ObstacleRecord {
  id: string
  label: string
  x: number
  y: number
  r: number
  blocks_los: boolean
}

export type ObstaclePatch = Partial<Omit<ObstacleRecord, 'id'>>

interface ObstaclesContextValue {
  obstacles: ObstacleRecord[]
  /** Append a new obstacle. Returns the generated id so callers can select
   *  it immediately after creation. */
  addObstacle: (partial?: ObstaclePatch) => string
  /** Patch any subset of fields on an existing obstacle. No-op if the id
   *  is unknown. */
  updateObstacle: (id: string, patch: ObstaclePatch) => void
  /** Delete an obstacle by id. No-op if the id is unknown. */
  removeObstacle: (id: string) => void
}

const ObstaclesContext = createContext<ObstaclesContextValue | null>(null)

// Monotonic suffix for IDs within a single page session. Prefixed with
// `Date.now()` so IDs across reloads don't collide with earlier snapshots
// (not that anything persists, but it keeps the IDs human-distinct).
let counter = 0
function nextObstacleId(): string {
  counter += 1
  return `obstacle-${Date.now().toString(36)}-${counter}`
}

// Staggered default placement so each successive "Add" lands somewhere the
// user can see, not stacked exactly on top of the last one.
function defaultPosition(existing: number): { x: number; y: number } {
  const GRID = 5
  const col = existing % GRID
  const row = Math.floor(existing / GRID)
  return { x: 20 + col * 4, y: 15 + row * 4 }
}

export function ObstaclesProvider({ children }: { children: ReactNode }) {
  const [obstacles, setObstacles] = useState<ObstacleRecord[]>([])

  const addObstacle = useCallback((partial?: ObstaclePatch) => {
    const id = nextObstacleId()
    setObstacles(prev => {
      const pos = defaultPosition(prev.length)
      const record: ObstacleRecord = {
        id,
        label: partial?.label ?? `Obstacle ${prev.length + 1}`,
        x: partial?.x ?? pos.x,
        y: partial?.y ?? pos.y,
        r: partial?.r ?? 2,
        blocks_los: partial?.blocks_los ?? true,
      }
      return [...prev, record]
    })
    return id
  }, [])

  const updateObstacle = useCallback((id: string, patch: ObstaclePatch) => {
    setObstacles(prev =>
      prev.map(o => (o.id === id ? { ...o, ...patch } : o)),
    )
  }, [])

  const removeObstacle = useCallback((id: string) => {
    setObstacles(prev => prev.filter(o => o.id !== id))
  }, [])

  const value = useMemo<ObstaclesContextValue>(
    () => ({ obstacles, addObstacle, updateObstacle, removeObstacle }),
    [obstacles, addObstacle, updateObstacle, removeObstacle],
  )

  return (
    <ObstaclesContext.Provider value={value}>
      {children}
    </ObstaclesContext.Provider>
  )
}

export function useObstacles(): ObstaclesContextValue {
  const ctx = useContext(ObstaclesContext)
  if (!ctx) {
    throw new Error('useObstacles must be used inside an <ObstaclesProvider>')
  }
  return ctx
}
