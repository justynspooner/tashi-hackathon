// Peer table for the inspector's "Peers" component. Shows each connected
// peer, the entity they've claimed (glyph + type + team badge), a staleness
// badge if they haven't been seen in >15s, and the relative last-seen time.
//
// Ported from `NodeControl.tsx` NodeCard peer table (L1093–1132) with the
// layout loosened for the vertical inspector panel.
//
// IMPORTANT: peer role badges MUST come from the *selected* node's own
// snapshot (`nodeEntities`), never from a cross-snapshot merge. If a node is
// partitioned it hasn't received consensus events from its peers and its view
// of their roles must stay frozen at what it last saw — otherwise the panel
// leaks state from other nodes and hides the divergence. See
// `selectors.ts#canonicalEntities` for the merged view (intentionally not
// used here).

import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { timeSince } from '@/lib/utils'
import type { AgentState } from '@/types'
import type { EntityRecord } from '@/game/types'
import { teamColor } from '@/game/presentation'
import { entityGlyph, shortId, shortMessageId } from '@/lib/node-control-helpers'

interface Props {
  agentState: AgentState | undefined
  peerIdToLabel: Record<string, string>
  /** The selected node's own `snapshot.entities` — *only* what that node has
   *  learned through consensus. Never a cross-snapshot merge. */
  nodeEntities: Record<string, EntityRecord> | undefined
}

export function PeersComponent({ agentState, peerIdToLabel, nodeEntities }: Props) {
  // Retick every 5s so the "last-seen" times stay fresh.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(id)
  }, [])

  if (!agentState) {
    return (
      <div className="text-[11px] text-muted-foreground italic">
        No agent state yet — the node hasn't reported in.
      </div>
    )
  }

  const peers = Object.entries(agentState.peers ?? {}).sort(
    ([, a], [, b]) =>
      (peerIdToLabel[a.peer_id] ?? a.peer_id).localeCompare(
        peerIdToLabel[b.peer_id] ?? b.peer_id,
      ),
  )

  return (
    <div className="space-y-1 text-[11px]">
      {peers.length === 0 ? (
        <div className="text-muted-foreground italic">No peers yet.</div>
      ) : (
        peers.map(([peerId, peer]) => {
          const isStale = now - peer.last_seen_ms > 15_000
          const peerLabel = peerIdToLabel[peer.peer_id]
          // Only read from the selected node's own snapshot. If this node is
          // partitioned and never received the peer's claim event, the peer
          // should render as `unclaimed` — not as whatever a different node
          // happened to observe.
          const peerEntity = peerLabel ? nodeEntities?.[peerLabel] : undefined
          const entityType = peerEntity?.entity_type ?? null
          const entityTeam = peerEntity?.team ?? null
          return (
            <div key={peerId} className={`flex items-center gap-1.5 ${isStale ? 'opacity-50' : ''}`}>
              <span className="text-muted-foreground w-16 truncate shrink-0">
                {peerLabel ?? shortId(peer.peer_id)}
              </span>
              {entityType ? (
                <Badge variant="outline" className="text-[10px] px-1 py-0 leading-tight gap-0.5">
                  <span>{entityGlyph(entityType)}</span>
                  <span>{entityType}</span>
                  {entityTeam && (
                    <span
                      className="px-0.5 rounded text-[10px] font-semibold"
                      style={{
                        backgroundColor: teamColor(entityTeam) + '30',
                        color: teamColor(entityTeam),
                      }}
                    >
                      {entityTeam}
                    </span>
                  )}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] px-1 py-0 leading-tight text-muted-foreground">
                  unclaimed
                </Badge>
              )}
              {isStale && (
                <Badge variant="destructive" className="text-[9px] px-1 py-0 leading-tight">
                  stale
                </Badge>
              )}
              <span className="text-muted-foreground ml-auto tabular-nums shrink-0">
                {timeSince(peer.last_seen_ms)}
              </span>
            </div>
          )
        })
      )}
      <div className="flex items-center gap-1.5 text-muted-foreground pt-1 border-t mt-1">
        <span className="shrink-0">Last</span>
        <Badge variant="outline" className="text-[10px] px-1 py-0 leading-tight">
          {agentState.last_message_kind}
        </Badge>
        <span className="font-mono truncate">{shortMessageId(agentState.last_message_id)}</span>
      </div>
    </div>
  )
}
