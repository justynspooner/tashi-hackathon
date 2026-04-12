import { useState, useEffect, useCallback, useRef } from 'react'
import type { AgentState, EventLogEntry, NodeInfo, ProofOfCoordination } from '../types'

const MAX_LOG_ENTRIES = 5000
const EVENT_LOG_STORAGE_KEY = 'vertex-event-log'
const STORAGE_FLUSH_MS = 2000

function loadCachedEvents(): EventLogEntry[] {
  try {
    const raw = sessionStorage.getItem(EVENT_LOG_STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return []
}

let storageFlushTimer: ReturnType<typeof setTimeout> | null = null
let pendingEvents: EventLogEntry[] | null = null

function saveCachedEvents(events: EventLogEntry[]) {
  pendingEvents = events
  if (storageFlushTimer) return
  storageFlushTimer = setTimeout(() => {
    storageFlushTimer = null
    if (pendingEvents) {
      try {
        sessionStorage.setItem(EVENT_LOG_STORAGE_KEY, JSON.stringify(pendingEvents))
      } catch { /* storage full — silently drop */ }
      pendingEvents = null
    }
  }, STORAGE_FLUSH_MS)
}

function useThrottledCallback<T extends (...args: unknown[]) => void>(fn: T, delayMs: number): T {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const throttled = useCallback((...args: unknown[]) => {
    if (timerRef.current) return
    fnRef.current(...args)
    timerRef.current = setTimeout(() => { timerRef.current = null }, delayMs)
  }, [delayMs]) as T

  return throttled
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

const EVENT_BATCH_MS = 100

export function useEventLog() {
  const [events, setEvents] = useState<EventLogEntry[]>(loadCachedEvents)
  const pendingBatch = useRef<EventLogEntry[]>([])
  const batchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Merge server tail with cached events on mount
  useEffect(() => {
    async function fetchTail() {
      try {
        const res = await fetch('/api/event-log?tail=200')
        const serverEvents: EventLogEntry[] = await res.json()
        setEvents(prev => {
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

  const flushBatch = useCallback(() => {
    batchTimer.current = null
    const batch = pendingBatch.current
    if (batch.length === 0) return
    pendingBatch.current = []
    setEvents(prev => {
      let next = prev
      for (const entry of batch) {
        const last = next[next.length - 1]
        if (last && last.ts === entry.ts && last.label === entry.label && last.tag === entry.tag) {
          continue
        }
        next = next === prev ? [...prev, entry] : (next.push(entry), next)
      }
      if (next === prev) return prev
      const trimmed = next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next
      saveCachedEvents(trimmed)
      return trimmed
    })
  }, [])

  const appendEvent = useCallback((entry: EventLogEntry) => {
    pendingBatch.current.push(entry)
    if (!batchTimer.current) {
      batchTimer.current = setTimeout(flushBatch, EVENT_BATCH_MS)
    }
  }, [flushBatch])

  const clearEvents = useCallback(() => {
    pendingBatch.current = []
    if (batchTimer.current) { clearTimeout(batchTimer.current); batchTimer.current = null }
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

export function usePartitions() {
  const [partitions, setPartitions] = useState<[string, string][]>([])

  const fetchPartitions = useCallback(async () => {
    try {
      const res = await fetch('/api/partitions')
      const data = await res.json()
      setPartitions(data.partitions ?? [])
    } catch { /* server not ready */ }
  }, [])

  useEffect(() => { fetchPartitions() }, [fetchPartitions])

  const togglePartition = useCallback(async (nodeA: string, nodeB: string) => {
    const sorted = [nodeA, nodeB].sort()
    const exists = partitions.some(p =>
      [p[0], p[1]].sort().join() === sorted.join()
    )
    const endpoint = exists ? '/api/partitions/heal' : '/api/partitions/create'
    console.log('[partition] toggle', sorted, 'exists=', exists, 'endpoint=', endpoint)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_a: sorted[0], node_b: sorted[1] }),
      })
      const data = await res.json()
      console.log('[partition] response', res.status, data)
    } catch (err) {
      console.error('[partition] fetch error', err)
    }
    await fetchPartitions()
  }, [partitions, fetchPartitions])

  return { partitions, togglePartition, refetch: fetchPartitions }
}

export function useSSE(callbacks?: {
  onEventLog?: (entry: EventLogEntry) => void
  onUpdate?: () => void
  onNodeStatus?: () => void
  onPartitionChanged?: () => void
}) {
  const [connected, setConnected] = useState(false)
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  // Throttle bulk-refetch callbacks so rapid SSE bursts don't cascade
  const throttledUpdate = useThrottledCallback(() => {
    callbacksRef.current?.onUpdate?.()
  }, 500)
  const throttledNodeStatus = useThrottledCallback(() => {
    callbacksRef.current?.onNodeStatus?.()
  }, 500)
  const throttledPartition = useThrottledCallback(() => {
    callbacksRef.current?.onPartitionChanged?.()
  }, 500)

  useEffect(() => {
    const source = new EventSource('/api/events')

    source.onmessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.type === 'connected') {
        setConnected(true)
      } else if (data.type === 'event_log' && callbacksRef.current?.onEventLog) {
        callbacksRef.current.onEventLog(data.entry)
      } else if (data.type === 'update') {
        throttledUpdate()
      } else if (data.type === 'node_status' || data.type === 'node_added' || data.type === 'swarm_created' || data.type === 'swarm_destroyed') {
        throttledNodeStatus()
      } else if (data.type === 'partition_changed') {
        throttledPartition()
      }
    }

    source.onerror = () => setConnected(false)

    return () => source.close()
  }, [throttledUpdate, throttledNodeStatus, throttledPartition])

  return { connected }
}

export async function verifyProof(agent: string, file: string) {
  const res = await fetch(`/api/proofs/${agent}/${file}/verify`)
  return res.json()
}
