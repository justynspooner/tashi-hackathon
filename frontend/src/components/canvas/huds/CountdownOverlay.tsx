// 3-2-1-GO overlay.
//
// Timing is derived from the consensus-canonical `countdown_zero_ns` on any
// snapshot (all nodes converge on the same value), so we don't need to pin
// local wall-clock timestamps — which previously required refs that the React
// compiler's lint rules (`react-hooks/refs`, `react-hooks/set-state-in-effect`)
// don't like. We only tick state for the render clock while the overlay is
// active.

import { useEffect, useMemo, useState } from 'react'
import type { LocalGameSnapshot } from '@/game/types'

interface Props {
  allSnapshots: Record<string, LocalGameSnapshot>
}

/** Window (ms) to hold the "GO!" flash after the counter hits zero. */
const GO_FLASH_MS = 1200

export function CountdownOverlay({ allSnapshots }: Props) {
  const [now, setNow] = useState(() => Date.now())

  // Earliest countdown_zero_ns from any snapshot. All nodes converge on the
  // same value through consensus, so `find` is fine here.
  const zeroMs = useMemo<number | null>(() => {
    for (const snap of Object.values(allSnapshots)) {
      const ns = snap.countdown_zero_ns
      if (ns != null) return Math.floor(ns / 1_000_000)
    }
    return null
  }, [allSnapshots])

  const phases = useMemo(() => Object.values(allSnapshots).map(s => s.phase), [allSnapshots])
  const anyCountingDown = phases.some(p => p === 'counting_down')
  const anyPlaying = phases.some(p => p === 'playing')
  const active = anyCountingDown || anyPlaying

  // Tick the render clock only while the overlay might be visible.
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), 60)
    return () => window.clearInterval(id)
  }, [active])

  let content: { text: string; accent: string } | null = null
  if (zeroMs != null) {
    const msToZero = zeroMs - now
    if (anyCountingDown && msToZero > 0) {
      const secsLeft = Math.ceil(msToZero / 1000)
      if (secsLeft >= 1 && secsLeft <= 3) {
        content = { text: String(secsLeft), accent: 'text-amber-300' }
      }
    } else if (anyPlaying && msToZero <= 0 && -msToZero < GO_FLASH_MS) {
      content = { text: 'GO!', accent: 'text-emerald-300' }
    }
  }

  if (!content) return null

  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center z-10"
      aria-live="polite"
    >
      <div
        className={`font-black ${content.accent} drop-shadow-[0_6px_24px_rgba(0,0,0,0.8)]`}
        style={{
          fontSize: '180px',
          letterSpacing: '-0.05em',
          textShadow: '0 0 32px currentColor, 0 2px 8px rgba(0,0,0,0.6)',
          animation: 'countdown-pulse 0.9s ease-out',
        }}
      >
        {content.text}
      </div>
      <style>{`
        @keyframes countdown-pulse {
          0% { transform: scale(1.6); opacity: 0; }
          40% { transform: scale(1); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  )
}
