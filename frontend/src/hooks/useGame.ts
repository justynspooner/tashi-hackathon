import { useCallback, useEffect, useState } from 'react'
import type { GameConfig, LocalGameSnapshot } from '../game/types'
import { errorToast } from './useErrorToast'

export function useGames() {
  const [games, setGames] = useState<GameConfig[]>([])

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/games')
      const data = await res.json()
      setGames(data || [])
    } catch {
      /* server not ready */
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/games')
      .then(r => r.json())
      .then(d => {
        if (!cancelled) setGames(d || [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return { games, refetch }
}

/**
 * Map of `label -> LocalGameSnapshot`. Populated via GET /api/game-state on
 * mount and updated by SSE `game_state_changed` events (one per node).
 */
export function useGameState() {
  const [snapshots, setSnapshots] = useState<Record<string, LocalGameSnapshot>>({})

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/game-state')
      const data = await res.json()
      setSnapshots(data || {})
    } catch {
      /* server not ready */
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/game-state')
      .then(r => r.json())
      .then(d => {
        if (!cancelled) setSnapshots(d || {})
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const applySnapshotUpdate = useCallback((label: string, snapshot: LocalGameSnapshot) => {
    setSnapshots(prev => ({ ...prev, [label]: snapshot }))
  }, [])

  const clear = useCallback(() => setSnapshots({}), [])

  return { snapshots, refetch, applySnapshotUpdate, clear }
}

export function useGameActions() {
  // User-initiated actions surface failures via a toast (B7). Entity drag
  // calls `moveEntity` too — we rate-limit the "move" toast so a failing
  // backend doesn't drown the user in toasts during a drag.
  const moveEntity = useCallback(async (label: string, x: number, y: number) => {
    try {
      const res = await fetch(`/api/nodes/${label}/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y }),
      })
      if (!res.ok) throw new Error(`move failed: ${res.status}`)
    } catch (err) {
      errorToast(`Move ${label} failed`, err)
    }
  }, [])

  const proposeGame = useCallback(async (label: string, gameId: string) => {
    try {
      const res = await fetch(`/api/nodes/${label}/propose-game/${gameId}`, { method: 'POST' })
      if (!res.ok) throw new Error(`propose failed: ${res.status}`)
    } catch (err) {
      errorToast(`Propose on ${label} failed`, err)
      throw err
    }
  }, [])

  const voteGame = useCallback(async (label: string, gameId: string) => {
    try {
      const res = await fetch(`/api/nodes/${label}/vote-game/${gameId}`, { method: 'POST' })
      if (!res.ok) throw new Error(`vote failed: ${res.status}`)
    } catch (err) {
      errorToast(`Vote on ${label} failed`, err)
      throw err
    }
  }, [])

  const claimEntity = useCallback(
    async (label: string, entityType: string, team: string | null) => {
      try {
        const res = await fetch(`/api/nodes/${label}/entity-type`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity_type: entityType, team }),
        })
        if (!res.ok) throw new Error(`claim failed: ${res.status}`)
      } catch (err) {
        errorToast(`Claim on ${label} failed`, err)
        throw err
      }
    },
    [],
  )

  const readyUp = useCallback(async (label: string) => {
    try {
      const res = await fetch(`/api/nodes/${label}/ready`, { method: 'POST' })
      if (!res.ok) throw new Error(`ready-up failed: ${res.status}`)
    } catch (err) {
      errorToast(`Ready-up on ${label} failed`, err)
      throw err
    }
  }, [])

  return { moveEntity, proposeGame, voteGame, claimEntity, readyUp }
}
