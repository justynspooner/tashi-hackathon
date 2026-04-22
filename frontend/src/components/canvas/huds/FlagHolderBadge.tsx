// CTF-style flag-holder pill. Reads properties.holding_team off the flag
// entity (if any). Source snapshot is preferred for A2 consistency but
// falls back to any snapshot that sees the flag.

import { Badge } from '@/components/ui/badge'
import { teamColor } from '@/game/presentation'
import type { LocalGameSnapshot } from '@/game/types'

interface Props {
  sourceSnapshot: LocalGameSnapshot | undefined
  allSnapshots: Record<string, LocalGameSnapshot>
}

export function FlagHolderBadge({ sourceSnapshot, allSnapshots }: Props) {
  const snap =
    (sourceSnapshot?.active_game_id ? sourceSnapshot : null) ??
    Object.values(allSnapshots).find(s => s.active_game_id) ??
    null
  if (!snap) return null

  const flagEntity = Object.values(snap.entities).find(e => e.entity_type === 'flag')
  if (!flagEntity) return null

  const holdingTeam = (flagEntity.properties?.holding_team as string | undefined) ?? null
  const tracker = snap.proximity_tracker ?? {}
  const flagLabel = flagEntity.label
  const activelyHeld = Object.keys(tracker).some(key => {
    if (!key.startsWith('mark_holding|')) return false
    return key.includes(`|${flagLabel}|`) || key.endsWith(`|${flagLabel}`)
  })

  if (!holdingTeam && !activelyHeld) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] font-mono border-slate-500/40 bg-slate-500/10 text-slate-200"
        title="Flag has not been captured yet"
      >
        🚩 neutral
      </Badge>
    )
  }

  const color = holdingTeam ? teamColor(holdingTeam) : '#94a3b8'
  return (
    <Badge
      variant="outline"
      className="text-[10px] font-mono"
      style={{
        backgroundColor: color + '22',
        color,
        borderColor: color + '55',
      }}
      title={
        activelyHeld
          ? `Flag is at ${holdingTeam ?? 'a'} base`
          : `Flag last captured by ${holdingTeam ?? 'unknown'}; currently in transit`
      }
    >
      🚩 {activelyHeld ? `at ${holdingTeam ?? '?'} base` : `last held by ${holdingTeam ?? '?'}`}
    </Badge>
  )
}
