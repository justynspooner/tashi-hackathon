import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { ProofOfCoordination } from '@/types'

/**
 * Surfaces the consensus-quorum-lost signal during the demo.
 *
 * Heuristic per the plan: "no new proofs in the last 10s while partitions are
 * live". A partition alone doesn't necessarily stall consensus (the majority
 * side keeps going); the banner only appears when the partition coincides
 * with a drop-off in finalised proofs, which is what the demo's Phase-B
 * "drag nodes apart until quorum fails" payoff is meant to show.
 */
const STALL_MS = 10_000
const TICK_MS = 500

export function ConsensusStalledBanner({
  proofs,
  partitions,
}: {
  proofs: ProofOfCoordination[]
  partitions: [string, string][]
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [])

  const latestProofAt = useMemo(() => {
    // Proofs carry `consensus_at` in nanoseconds since Unix epoch (per the
    // Rust `Event::consensus_at()` units). Convert to ms for comparison with
    // Date.now(). We only care about the most recent one.
    let max = 0
    for (const p of proofs) {
      const ms = Math.floor(p.consensus_at / 1_000_000)
      if (ms > max) max = ms
    }
    return max
  }, [proofs])

  const stalled = partitions.length > 0 && (latestProofAt === 0 || now - latestProofAt > STALL_MS)

  if (!stalled) return null

  const idleFor =
    latestProofAt === 0 ? 'since boot' : `${Math.floor((now - latestProofAt) / 1000)}s`

  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-md border border-red-500/50 bg-red-950/40 px-4 py-2 text-sm"
    >
      <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
      <div className="flex-1">
        <div className="font-medium text-red-200">
          consensus stalled — no quorum
        </div>
        <div className="text-xs text-red-300/80">
          No new proofs {idleFor} while {partitions.length}{' '}
          {partitions.length === 1 ? 'partition is' : 'partitions are'} live.
          BFT requires a super-majority — reconnect nodes to heal.
        </div>
      </div>
    </div>
  )
}
