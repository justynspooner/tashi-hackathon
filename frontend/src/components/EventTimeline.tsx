import { memo, useRef, useEffect, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Radio } from 'lucide-react'
import { kindClass, kindIcon, roleColor } from '@/lib/utils'
import type { ProofOfCoordination } from '@/types'

interface TimelineEvent {
  kind: string
  message_id: string
  sent_at_ms: number
  agent: string
  role: string
  status: string
  note?: string
}

export const EventTimeline = memo(function EventTimeline({ proofs }: { proofs: ProofOfCoordination[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const events = useMemo(() => {
    const result: TimelineEvent[] = proofs.flatMap(proof =>
      proof.transactions.map(tx => ({
        kind: tx.kind,
        message_id: tx.message_id,
        sent_at_ms: tx.sent_at_ms,
        agent: proof.agent,
        role: tx.state.role,
        status: tx.state.status,
        note: tx.note ?? undefined,
      }))
    )
    result.sort((a, b) => b.sent_at_ms - a.sent_at_ms)
    return result
  }, [proofs])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [events.length])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="h-5 w-5" />
          Event Timeline
          <Badge variant="secondary">{events.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No consensus events yet.
          </p>
        ) : (
          <div ref={scrollRef} className="h-[400px] overflow-y-auto">
            <div className="relative pl-6 space-y-0">
              <div className="absolute left-[11px] top-0 bottom-0 w-px bg-border" />

              {events.map((event, i) => (
                <div key={`${event.message_id}-${i}`} className="relative flex gap-3 pb-4">
                  <div
                    className={`absolute left-[-17px] top-1 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white ${kindClass(event.kind)}`}
                  >
                    {kindIcon(event.kind)}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs">{event.agent}</Badge>
                      <Badge variant="secondary" className="text-xs">{event.kind}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(event.sent_at_ms).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 flex gap-3">
                      <span className="flex items-center gap-1">Role: <span className={`px-1 rounded text-[10px] font-medium border ${roleColor(event.role)}`}>{event.role}</span></span>
                      <span>Status: <strong>{event.status}</strong></span>
                    </div>
                    {event.note && (
                      <div className="text-xs italic text-muted-foreground mt-1">
                        {event.note}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
})
