// MM:SS game clock — countdown if duration_s is set on the active game,
// otherwise an elapsed-since-start timer. Drives off the source snapshot
// so the HUD reflects the currently-selected node per A2.
//
// If the source has no `countdown_zero_ns` yet, fall back to the first
// snapshot that does — the backend pins this to consensus time so reading
// from any node yields the same absolute startMs.

import { useEffect, useState } from 'react'
import type { GameConfig, LocalGameSnapshot } from '@/game/types'
import { formatMmSs } from '@/lib/node-control-helpers'

interface Props {
  sourceSnapshot: LocalGameSnapshot | undefined
  allSnapshots: Record<string, LocalGameSnapshot>
  activeGame: GameConfig | undefined
}

export function GameTimer({ sourceSnapshot, allSnapshots, activeGame }: Props) {
  const [now, setNow] = useState(() => Date.now())

  const sourcePhase = sourceSnapshot?.phase
  const anyPlaying = Object.values(allSnapshots).some(s => s.phase === 'playing')
  const anyEnded = Object.values(allSnapshots).some(s => s.phase === 'ended')
  const live = anyPlaying || anyEnded

  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [live])

  // Prefer the source snapshot's `countdown_zero_ns`; fall back to any
  // snapshot that has it (they converge through consensus).
  let startMs: number | null = null
  if (sourceSnapshot?.countdown_zero_ns != null) {
    startMs = Math.floor(sourceSnapshot.countdown_zero_ns / 1_000_000) + 3_000
  } else {
    for (const snap of Object.values(allSnapshots)) {
      if (snap.countdown_zero_ns != null) {
        startMs = Math.floor(snap.countdown_zero_ns / 1_000_000) + 3_000
        break
      }
    }
  }

  if (!live || startMs == null) return null

  const elapsedMs = Math.max(0, now - startMs)
  const durationS = activeGame?.duration_s
  const endedBySource = sourcePhase === 'ended'

  if (durationS != null) {
    const remainingMs = Math.max(0, durationS * 1000 - elapsedMs)
    const critical = remainingMs <= 30_000
    const color = (anyEnded || endedBySource)
      ? 'text-purple-300 border-purple-400/40 bg-purple-500/10'
      : critical
        ? 'text-amber-300 border-amber-400/50 bg-amber-500/10'
        : 'text-emerald-300 border-emerald-400/40 bg-emerald-500/10'
    return (
      <span
        className={`font-mono text-xs font-semibold px-2 py-0.5 rounded border ${color} ${
          critical && !anyEnded ? 'animate-pulse' : ''
        }`}
        title={anyEnded ? 'Game ended' : 'Time remaining'}
      >
        ⏱ {formatMmSs(Math.ceil(remainingMs / 1000))}
      </span>
    )
  }

  return (
    <span
      className="font-mono text-xs font-semibold px-2 py-0.5 rounded border border-slate-500/40 bg-slate-500/10 text-slate-200"
      title="Elapsed play time"
    >
      ⏱ {formatMmSs(Math.floor(elapsedMs / 1000))}
    </span>
  )
}
