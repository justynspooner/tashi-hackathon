/* eslint-disable react-refresh/only-export-components --
   Provider + hook belong in the same module per React Context convention. */
// Read-only data context: nodes, agent states, events, snapshots, games,
// proofs, partitions. The inspector / scene tree / canvas HUDs all need some
// mix of these; exposing them via a context avoids passing the same 6 props
// through every container.

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { AgentState, EventLogEntry, NodeInfo, ProofOfCoordination } from '@/types'
import type { GameConfig, LocalGameSnapshot } from '@/game/types'
import { canonicalEntities } from '@/state/selectors'

export interface AppData {
  nodes: NodeInfo[]
  states: AgentState[]
  events: EventLogEntry[]
  snapshots: Record<string, LocalGameSnapshot>
  games: GameConfig[]
  proofs: ProofOfCoordination[]
  partitions: [string, string][]
}

export interface AppDerived {
  /** Union of entity claims across all snapshots, keyed by label. */
  canonicalEntities: Record<string, import('@/game/types').EntityRecord>
  /** peer_id → node label lookup, derived from agent states. */
  peerIdToLabel: Record<string, string>
  /** The active game config (first snapshot with `active_game_id` wins). */
  activeGame: GameConfig | undefined
}

const DataContext = createContext<(AppData & AppDerived) | null>(null)

export function DataProvider({
  value,
  children,
}: {
  value: AppData
  children: ReactNode
}) {
  const derived = useMemo<AppDerived>(() => {
    const peerIdToLabel: Record<string, string> = {}
    for (const s of value.states) peerIdToLabel[s.local.peer_id] = s.label

    let activeGame: GameConfig | undefined
    for (const snap of Object.values(value.snapshots)) {
      if (snap.active_game_id) {
        activeGame = value.games.find(g => g.id === snap.active_game_id)
        if (activeGame) break
      }
    }

    return {
      canonicalEntities: canonicalEntities(value.snapshots),
      peerIdToLabel,
      activeGame,
    }
  }, [value.states, value.snapshots, value.games])

  const merged = useMemo(() => ({ ...value, ...derived }), [value, derived])

  return <DataContext.Provider value={merged}>{children}</DataContext.Provider>
}

export function useData(): AppData & AppDerived {
  const ctx = useContext(DataContext)
  if (!ctx) {
    throw new Error('useData must be used inside a <DataProvider>')
  }
  return ctx
}
