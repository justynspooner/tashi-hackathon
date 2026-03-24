import { useState, useEffect, useCallback, useRef } from 'react'
import type { AgentState, EventLogEntry, NodeInfo, ProofOfCoordination } from '../types'

const MAX_LOG_ENTRIES = 500

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
  const [events, setEvents] = useState<EventLogEntry[]>([])

  // Fetch tail once on mount
  useEffect(() => {
    async function fetchTail() {
      try {
        const res = await fetch('/api/event-log?tail=200')
        const data: EventLogEntry[] = await res.json()
        setEvents(data.slice(-MAX_LOG_ENTRIES))
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
      return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next
    })
  }, [])

  const clearEvents = useCallback(() => setEvents([]), [])

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

  return { nodes, startNode, stopNode, setRole, refetch: fetchNodes }
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
      } else if (data.type === 'node_status' && callbacksRef.current?.onNodeStatus) {
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
