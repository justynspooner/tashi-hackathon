// Game-end banner: winner + reason. Prefers the source snapshot (A2); any
// snapshot reporting `ended` is a valid fallback since the values converge
// via consensus on `GameEnd`.

import type { LocalGameSnapshot } from '@/game/types'
import { teamColor } from '@/game/presentation'

interface Props {
  sourceSnapshot: LocalGameSnapshot | undefined
  allSnapshots: Record<string, LocalGameSnapshot>
}

// Prefer the source snapshot (A2); any snapshot reporting `ended` is a valid
// fallback since the values converge via consensus on `GameEnd`. Left as a
// plain helper (no manual `useMemo`) so React Compiler can auto-memoize;
// hand-rolled `useMemo` here was tripping `react-hooks/preserve-manual-memoization`.
function pickEnded(
  sourceSnapshot: LocalGameSnapshot | undefined,
  allSnapshots: Record<string, LocalGameSnapshot>,
): { winner: string | null; reason: string | null } | null {
  if (sourceSnapshot?.phase === 'ended') {
    return {
      winner: sourceSnapshot.ended_winner_team ?? null,
      reason: sourceSnapshot.ended_reason ?? null,
    }
  }
  for (const snap of Object.values(allSnapshots)) {
    if (snap.phase === 'ended') {
      return {
        winner: snap.ended_winner_team ?? null,
        reason: snap.ended_reason ?? null,
      }
    }
  }
  return null
}

export function EndedBanner({ sourceSnapshot, allSnapshots }: Props) {
  const ended = pickEnded(sourceSnapshot, allSnapshots)

  if (!ended) return null

  return (
    <div className="flex items-center gap-2 text-xs rounded border border-purple-500/40 bg-purple-500/10 text-purple-200 px-2 py-1">
      <span className="font-semibold uppercase tracking-wide">Game ended</span>
      {ended.winner ? (
        <span
          className="px-1.5 py-0.5 rounded font-mono font-semibold"
          style={{
            backgroundColor: teamColor(ended.winner) + '22',
            color: teamColor(ended.winner),
            border: `1px solid ${teamColor(ended.winner)}55`,
          }}
        >
          winner: {ended.winner}
        </span>
      ) : (
        <span className="px-1.5 py-0.5 rounded font-mono font-semibold bg-slate-500/20 text-slate-200 border border-slate-500/40">
          draw
        </span>
      )}
      {ended.reason && <span className="text-[11px] italic truncate">{ended.reason}</span>}
    </div>
  )
}
