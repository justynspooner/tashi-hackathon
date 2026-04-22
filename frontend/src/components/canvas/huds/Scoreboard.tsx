// Scoreboard HUD. Reads from the source snapshot (the HUD-source node per
// A2), falling back to merged-max across all snapshots so the board isn't
// empty when the source hasn't caught up yet.

import { useMemo } from 'react'
import type { LocalGameSnapshot } from '@/game/types'
import { teamColor } from '@/game/presentation'
import { formatMmSs } from '@/lib/node-control-helpers'

interface Props {
  sourceSnapshot: LocalGameSnapshot | undefined
  allSnapshots: Record<string, LocalGameSnapshot>
}

export function Scoreboard({ sourceSnapshot, allSnapshots }: Props) {
  const scores = useMemo(() => {
    // Prefer the source snapshot's scores — that's what A2 pins the HUD to.
    if (sourceSnapshot?.scores) {
      const out: Record<string, number> = {}
      for (const [team, score] of Object.entries(sourceSnapshot.scores)) {
        if (team.startsWith('__')) continue
        out[team] = typeof score === 'number' ? score : 0
      }
      if (Object.keys(out).length > 0) return out
    }

    // Fallback: merged max across snapshots.
    const out: Record<string, number> = {}
    for (const snap of Object.values(allSnapshots)) {
      for (const [team, score] of Object.entries(snap.scores ?? {})) {
        if (team.startsWith('__')) continue
        const n = typeof score === 'number' ? score : 0
        if (n > (out[team] ?? -Infinity)) out[team] = n
      }
    }
    return out
  }, [sourceSnapshot, allSnapshots])

  const teams = Object.keys(scores).sort()
  if (teams.length === 0) return null

  return (
    <div className="flex items-center gap-1.5">
      {teams.map(team => (
        <span
          key={team}
          className="font-mono text-xs font-semibold px-1.5 py-0.5 rounded"
          title={`${team} hold time: ${formatMmSs(scores[team])}`}
          style={{
            backgroundColor: teamColor(team) + '22',
            color: teamColor(team),
            border: `1px solid ${teamColor(team)}55`,
          }}
        >
          {team}: {formatMmSs(scores[team])}
        </span>
      ))}
    </div>
  )
}
