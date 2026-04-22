// Per-node event log rendered in the inspector. Reads the shared event
// buffer, filters to this node's label (excluding high-volume tags), and
// caps the bucket at PER_NODE_EVENT_CAP so the DOM stays bounded on long
// sessions.
//
// Ported from `NodeControl.tsx` NodeEventLog (L137–176).

import { useEffect, useMemo, useRef, useState } from 'react'
import type { EventLogEntry } from '@/types'
import { PER_NODE_EVENT_CAP, TAG_COLORS, formatTs } from '@/lib/node-control-helpers'

interface Props {
  label: string
  events: EventLogEntry[]
}

export function EventsComponent({ label, events: rawEvents }: Props) {
  // Bucket the global event stream down to this node, dropping noisy tags.
  // Walk newest→oldest so we keep only the most recent PER_NODE_EVENT_CAP
  // entries.
  const events = useMemo(() => {
    const bucket: EventLogEntry[] = []
    for (let i = rawEvents.length - 1; i >= 0; i--) {
      const ev = rawEvents[i]
      if (ev.label !== label) continue
      if (ev.tag === 'VERTEX_RX' || ev.tag === 'VERTEX_TX' || ev.tag === 'FINALITY') continue
      bucket.push(ev)
      if (bucket.length >= PER_NODE_EVENT_CAP) break
    }
    bucket.reverse()
    return bucket
  }, [rawEvents, label])

  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (!autoScroll || !containerRef.current) return
    containerRef.current.scrollTop = containerRef.current.scrollHeight
  }, [events.length, autoScroll])

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    setAutoScroll(atBottom)
  }

  if (events.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground italic py-2 text-center">
        No events yet.
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="overflow-y-auto max-h-[200px] font-mono text-[10px] leading-[16px] bg-muted/30 rounded border"
    >
      {events.map((ev, i) => (
        <div key={i} className="flex gap-1.5 px-1.5 hover:bg-muted/50">
          <span className="text-muted-foreground shrink-0">{formatTs(ev.ts)}</span>
          <span className={`shrink-0 font-semibold ${TAG_COLORS[ev.tag] ?? 'text-gray-400'}`}>
            {ev.tag}
          </span>
          <span className="truncate text-foreground/70">{ev.message}</span>
        </div>
      ))}
    </div>
  )
}
