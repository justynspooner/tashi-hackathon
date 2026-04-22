/* eslint-disable react-refresh/only-export-components --
   Provider + hook belong in the same module per React Context convention. */
// Bundle of action callbacks the inspector / scene tree / canvas need. A
// lightweight context avoids prop-drilling these ~10 functions through every
// component tree layer.

import { createContext, useContext, type ReactNode } from 'react'

export interface AppActions {
  onStart: (label: string) => Promise<void>
  onStop: (label: string) => Promise<void>
  onProposeGame: (label: string, gameId: string) => Promise<void>
  onVoteGame: (label: string, gameId: string) => Promise<void>
  onClaimEntity: (
    label: string,
    entityType: string,
    team: string | null,
  ) => Promise<void>
  onReadyUp: (label: string) => Promise<void>
  onTogglePartition: (a: string, b: string) => Promise<void> | void
}

const ActionsContext = createContext<AppActions | null>(null)

export function ActionsProvider({
  value,
  children,
}: {
  value: AppActions
  children: ReactNode
}) {
  return <ActionsContext.Provider value={value}>{children}</ActionsContext.Provider>
}

export function useActions(): AppActions {
  const ctx = useContext(ActionsContext)
  if (!ctx) {
    throw new Error('useActions must be used inside an <ActionsProvider>')
  }
  return ctx
}
