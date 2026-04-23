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

  const proposeGame = useCallback(
    async (label: string, gameId: string, opts?: { keepRoles?: boolean }) => {
      const keepRoles = opts?.keepRoles ?? false
      // The legacy path is keep_roles=false; use it unchanged so anything
      // hitting the old endpoint (tests, curl, old frontend bundles) keeps
      // working. Only the post-game Replay button actually sets keepRoles.
      const url = keepRoles
        ? `/api/nodes/${label}/propose-replay`
        : `/api/nodes/${label}/propose-game/${gameId}`
      try {
        const res = await fetch(url, {
          method: 'POST',
          ...(keepRoles
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ game_id: gameId, keep_roles: true }),
              }
            : {}),
        })
        if (!res.ok) throw new Error(`propose failed: ${res.status}`)
      } catch (err) {
        errorToast(`Propose on ${label} failed`, err)
        throw err
      }
    },
    [],
  )

  const voteGame = useCallback(
    async (label: string, gameId: string, opts?: { keepRoles?: boolean }) => {
      const keepRoles = opts?.keepRoles ?? false
      // Mirror `proposeGame`'s split: the path-based legacy route hard-codes
      // keep_roles=false, so post-game replay/change-roles votes have to go
      // through the body-based `vote-replay` endpoint to carry the intent
      // intact. Without this, a node voting "Replay" lands a `(game_id,
      // keep_roles=false)` choice that doesn't coalesce with the proposer's
      // `(game_id, keep_roles=true)` and the swarm can't reach consensus.
      const url = keepRoles
        ? `/api/nodes/${label}/vote-replay`
        : `/api/nodes/${label}/vote-game/${gameId}`
      try {
        const res = await fetch(url, {
          method: 'POST',
          ...(keepRoles
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ game_id: gameId, keep_roles: true }),
              }
            : {}),
        })
        if (!res.ok) throw new Error(`vote failed: ${res.status}`)
      } catch (err) {
        errorToast(`Vote on ${label} failed`, err)
        throw err
      }
    },
    [],
  )

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
