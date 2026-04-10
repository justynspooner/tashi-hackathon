import { useState, useEffect, useCallback, useRef } from 'react'
import type { AgentState, EventLogEntry, NodeInfo, ProofOfCoordination } from '../types'

const MAX_LOG_ENTRIES = 5000
const EVENT_LOG_STORAGE_KEY = 'vertex-event-log'

function loadCachedEvents(): EventLogEntry[] {
  try {
    const raw = sessionStorage.getItem(EVENT_LOG_STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return []
}

function saveCachedEvents(events: EventLogEntry[]) {
  try {
    sessionStorage.setItem(EVENT_LOG_STORAGE_KEY, JSON.stringify(events))
  } catch { /* storage full — silently drop */ }
}

export function useAgentStates() {
  const [states, setStates] = useState<AgentState[]>([])

  const fetchStates = useCallback(async () => {
    try {
      const res = await fetch('/api/state')
      setStates(await res.json())
    } catch { /* server not ready */ }
  }, [])

  // Fetch once on mount; SSE drives updates after that
  useEffect(() => { fetchStates() }, [fetchStates])

  return { states, refetch: fetchStates }
}

export function useProofs() {
  const [proofs, setProofs] = useState<ProofOfCoordination[]>([])

  const fetchProofs = useCallback(async () => {
    try {
      const res = await fetch('/api/proofs')
      setProofs(await res.json())
    } catch { /* server not ready */ }
  }, [])

  // Fetch once on mount; SSE drives updates after that
  useEffect(() => { fetchProofs() }, [fetchProofs])

  return { proofs, refetch: fetchProofs }
}

export function useEventLog() {
  const [events, setEvents] = useState<EventLogEntry[]>(loadCachedEvents)

  // Merge server tail with cached events on mount
  useEffect(() => {
    async function fetchTail() {
      try {
        const res = await fetch('/api/event-log?tail=200')
        const serverEvents: EventLogEntry[] = await res.json()
        setEvents(prev => {
          // Merge: use cached events as base, append any server events newer than our latest
          const lastTs = prev.length > 0 ? prev[prev.length - 1].ts : 0
          const newer = serverEvents.filter(e => e.ts > lastTs)
          const merged = [...prev, ...newer]
          const trimmed = merged.length > MAX_LOG_ENTRIES ? merged.slice(-MAX_LOG_ENTRIES) : merged
          saveCachedEvents(trimmed)
          return trimmed
        })
      } catch { /* server not ready */ }
    }
    fetchTail()
  }, [])

  const appendEvent = useCallback((entry: EventLogEntry) => {
    setEvents(prev => {
      const last = prev[prev.length - 1]
      if (last && last.ts === entry.ts && last.label === entry.label && last.tag === entry.tag) {
        return prev
      }
      const next = [...prev, entry]
      const trimmed = next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next
      saveCachedEvents(trimmed)
      return trimmed
    })
  }, [])

  const clearEvents = useCallback(() => {
    setEvents([])
    saveCachedEvents([])
  }, [])

  return { events, appendEvent, clearEvents }
}

export function useNodes() {
  const [nodes, setNodes] = useState<NodeInfo[]>([])

  const fetchNodes = useCallback(async () => {
    try {
      const res = await fetch('/api/nodes')
      setNodes(await res.json())
    } catch { /* server not ready */ }
  }, [])

  // Fetch once on mount; SSE drives updates after that
  useEffect(() => { fetchNodes() }, [fetchNodes])

  const startNode = useCallback(async (label: string) => {
    await fetch(`/api/nodes/${label}/start`, { method: 'POST' })
    await fetchNodes()
  }, [fetchNodes])

  const stopNode = useCallback(async (label: string) => {
    await fetch(`/api/nodes/${label}/stop`, { method: 'POST' })
    await fetchNodes()
  }, [fetchNodes])

  const setRole = useCallback(async (label: string, role: string) => {
    await fetch(`/api/nodes/${label}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    await fetchNodes()
  }, [fetchNodes])

  const createSwarm = useCallback(async (count: number) => {
    await fetch('/api/swarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count }),
    })
    await fetchNodes()
  }, [fetchNodes])

  const destroySwarm = useCallback(async () => {
    await fetch('/api/swarm', { method: 'DELETE' })
    await fetchNodes()
  }, [fetchNodes])

  return { nodes, startNode, stopNode, setRole, createSwarm, destroySwarm, refetch: fetchNodes }
}

export function useSSE(callbacks?: {
  onEventLog?: (entry: EventLogEntry) => void
  onUpdate?: () => void
  onNodeStatus?: () => void
}) {
  const [connected, setConnected] = useState(false)
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  useEffect(() => {
    const source = new EventSource('/api/events')

    source.onmessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.type === 'connected') {
        setConnected(true)
      } else if (data.type === 'event_log' && callbacksRef.current?.onEventLog) {
        callbacksRef.current.onEventLog(data.entry)
      } else if (data.type === 'update' && callbacksRef.current?.onUpdate) {
        callbacksRef.current.onUpdate()
      } else if ((data.type === 'node_status' || data.type === 'node_added' || data.type === 'swarm_created' || data.type === 'swarm_destroyed') && callbacksRef.current?.onNodeStatus) {
        callbacksRef.current.onNodeStatus()
      }
    }

    source.onerror = () => setConnected(false)

    return () => source.close()
  }, [])

  return { connected }
}

export async function verifyProof(agent: string, file: string) {
  const res = await fetch(`/api/proofs/${agent}/${file}/verify`)
  return res.json()
}
