import { useEffect, useRef, useState, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Terminal, ArrowDown, ChevronsUpDown } from 'lucide-react'
import type { EventLogEntry } from '@/types'

const ROW_HEIGHT = 22
const COLLAPSED_ROWS = 5
const EXPANDED_ROWS = 25
const VISIBLE_BUFFER = 20 // extra rows above/below viewport

const TAG_COLORS: Record<string, string> = {
  BOOT: 'bg-slate-500',
  DISCOVERY: 'bg-cyan-500',
  HANDSHAKE: 'bg-blue-500',
  HEARTBEAT: 'bg-green-500',
  STATE: 'bg-amber-500',
  ACTION: 'bg-orange-500',
  ACK: 'bg-purple-500',
  STALE: 'bg-red-500',
  RECOVERY: 'bg-emerald-500',
  PROOF: 'bg-indigo-500',
  EXIT: 'bg-gray-500',
  CMD: 'bg-pink-500',
}

function labelColor(label: string): string {
  if (label.includes('agent-a')) return 'text-blue-400'
  if (label.includes('agent-b')) return 'text-amber-400'
  return 'text-muted-foreground'
}

// Pre-format timestamp to avoid Date allocations per render
function formatTs(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${h}:${m}:${s}.${ms}`
}

export function EventLog({ events: rawEvents }: { events: EventLogEntry[] }) {
  const events = useMemo(() => rawEvents.filter(e => e.tag !== 'HEARTBEAT'), [rawEvents])
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(COLLAPSED_ROWS * ROW_HEIGHT)

  // Auto-scroll on new events
  useEffect(() => {
    if (!autoScroll || !containerRef.current) return
    containerRef.current.scrollTop = containerRef.current.scrollHeight
  }, [events.length, autoScroll])

  // Track container size
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    setContainerHeight(el.clientHeight)
    const observer = new ResizeObserver(entries => {
      setContainerHeight(entries[0].contentRect.height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    setAutoScroll(atBottom)
  }

  function scrollToBottom() {
    if (!containerRef.current) return
    containerRef.current.scrollTop = containerRef.current.scrollHeight
    setAutoScroll(true)
  }

  // Virtual window: only render visible rows + buffer
  const { startIdx, endIdx, totalHeight } = useMemo(() => {
    const total = events.length
    const totalH = total * ROW_HEIGHT
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VISIBLE_BUFFER)
    const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT) + VISIBLE_BUFFER * 2
    const end = Math.min(total, start + visibleCount)
    return { startIdx: start, endIdx: end, totalHeight: totalH }
  }, [events.length, scrollTop, containerHeight])

  const visibleEvents = events.slice(startIdx, endIdx)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Terminal className="h-5 w-5" />
          Live Event Log
          <Badge variant="secondary">{events.length}</Badge>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6 px-2"
            onClick={() => setExpanded(e => !e)}
          >
            <ChevronsUpDown className="h-3 w-3 mr-1" />
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No events yet. Start the nodes to stream events here.
          </p>
        ) : (
          <div className="relative">
            <div
              ref={containerRef}
              onScroll={handleScroll}
              className="overflow-y-auto rounded-md border bg-muted/30 p-0 transition-[height] duration-200"
              style={{ height: (expanded ? EXPANDED_ROWS : COLLAPSED_ROWS) * ROW_HEIGHT }}
            >
              <div style={{ height: totalHeight, position: 'relative' }}>
                <div
                  className="font-mono text-xs"
                  style={{
                    position: 'absolute',
                    top: startIdx * ROW_HEIGHT,
                    left: 0,
                    right: 0,
                  }}
                >
                  {visibleEvents.map((event, i) => (
                    <div
                      key={startIdx + i}
                      className="flex items-center gap-2 px-2 hover:bg-muted/50"
                      style={{ height: ROW_HEIGHT }}
                    >
                      <span className="text-muted-foreground shrink-0 w-[82px]">
                        {formatTs(event.ts)}
                      </span>
                      <span
                        className={`shrink-0 inline-flex items-center justify-center rounded px-1 text-[10px] font-bold text-white w-[72px] text-center ${TAG_COLORS[event.tag] ?? 'bg-gray-400'}`}
                      >
                        {event.tag}
                      </span>
                      <span className={`shrink-0 w-[60px] ${labelColor(event.label)}`}>
                        {event.label}
                      </span>
                      <span className="text-foreground truncate">
                        {event.message}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {!autoScroll && (
              <Button
                size="sm"
                variant="secondary"
                className="absolute bottom-4 right-4 shadow-md"
                onClick={scrollToBottom}
              >
                <ArrowDown className="h-3 w-3 mr-1" />
                Latest
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
