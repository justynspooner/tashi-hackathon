/* eslint-disable react-refresh/only-export-components --
   Provider + hook belong in the same module per React Context convention. */
// Selection state shared by the scene tree, canvas, and inspector.
//
// Rules (A2 / A5):
//   - kind='node' means the user has picked a node (and implicitly its entity
//     component when one exists). Canvas highlights + inspector renders from
//     this label. Selection auto-clears if the label disappears from `nodes`
//     (e.g. destroy-swarm).
//   - kind='edge' means the user has selected a connection between two nodes.
//     Partition controls render in the inspector. `a` / `b` are always
//     canonical-ordered (a <= b) so `{a:x, b:y}` and `{a:y, b:x}` collapse.
//   - kind='obstacle' means the user has picked a user-placed obstacle on the
//     canvas (or via the Obstacles group in the scene tree). Canvas shows
//     drag + resize affordances; inspector renders editable x/y/r/los form.
//     Selection auto-clears when the id disappears from `ObstaclesContext`.
//   - kind='none' is the resting/empty state.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { NodeInfo } from '@/types'
import { canonicalPair } from '@/game/edgeKey'
import { useObstacles } from '@/state/ObstaclesContext'

export type Selection =
  | { kind: 'none' }
  | { kind: 'node'; label: string }
  | { kind: 'edge'; a: string; b: string }
  | { kind: 'obstacle'; id: string }

interface SelectionContextValue {
  selection: Selection
  selectNode: (label: string) => void
  selectEdge: (a: string, b: string) => void
  selectObstacle: (id: string) => void
  deselect: () => void
}

const SelectionContext = createContext<SelectionContextValue | null>(null)

interface ProviderProps {
  nodes: NodeInfo[]
  children: ReactNode
}

/**
 * Provide selection state + clear it when the underlying node list changes in
 * a way that makes the current selection stale.
 *
 * Rather than setState-in-effect, we derive the "effective" selection on every
 * render: if the raw selection points to a label that's no longer in `nodes`,
 * consumers see `{ kind: 'none' }`. The raw state persists underneath so that
 * if the node reappears (e.g. restart), the original selection would only
 * restore if explicitly re-chosen — this is the desired UX.
 */
export function SelectionProvider({ nodes, children }: ProviderProps) {
  const { obstacles } = useObstacles()
  const [rawSelection, setSelection] = useState<Selection>({ kind: 'none' })

  const selection = useMemo<Selection>(() => {
    if (rawSelection.kind === 'node') {
      return nodes.some(n => n.label === rawSelection.label)
        ? rawSelection
        : { kind: 'none' }
    }
    if (rawSelection.kind === 'edge') {
      const hasA = nodes.some(n => n.label === rawSelection.a)
      const hasB = nodes.some(n => n.label === rawSelection.b)
      return hasA && hasB ? rawSelection : { kind: 'none' }
    }
    if (rawSelection.kind === 'obstacle') {
      return obstacles.some(o => o.id === rawSelection.id)
        ? rawSelection
        : { kind: 'none' }
    }
    return rawSelection
  }, [rawSelection, nodes, obstacles])

  const selectNode = useCallback((label: string) => {
    setSelection({ kind: 'node', label })
  }, [])

  const selectEdge = useCallback((a: string, b: string) => {
    const [lo, hi] = canonicalPair(a, b)
    setSelection({ kind: 'edge', a: lo, b: hi })
  }, [])

  const selectObstacle = useCallback((id: string) => {
    setSelection({ kind: 'obstacle', id })
  }, [])

  const deselect = useCallback(() => {
    setSelection({ kind: 'none' })
  }, [])

  // Keyboard: Escape clears the current selection. Ignored while the user is
  // typing in an input/textarea/contenteditable element so form fields work
  // normally (Escape often closes popovers in those cases).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      setSelection({ kind: 'none' })
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const value = useMemo<SelectionContextValue>(
    () => ({ selection, selectNode, selectEdge, selectObstacle, deselect }),
    [selection, selectNode, selectEdge, selectObstacle, deselect],
  )

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  )
}

export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext)
  if (!ctx) {
    throw new Error('useSelection must be used inside a <SelectionProvider>')
  }
  return ctx
}
