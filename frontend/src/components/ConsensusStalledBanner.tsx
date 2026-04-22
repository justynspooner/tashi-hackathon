// Fires a `toast.warning` once per stall episode (B6). A "stall" is 10s
// without a new proof while partitions are live — the heuristic matches the
// original inline-banner version. Reconciles on recovery with a success
// toast so the user sees both sides of the transition.
//
// Rendered as a headless component (returns null): it exists purely for the
// toast side effect. Keep it mounted alongside the canvas so it has access
// to proofs + partitions.

import { useEffect, useRef } from 'react'
import type { ProofOfCoordination } from '@/types'
import { warningToast, successToast } from '@/hooks/useErrorToast'

const STALL_MS = 10_000
const TICK_MS = 500

interface Props {
  proofs: ProofOfCoordination[]
  partitions: [string, string][]
}

export function ConsensusStalledBanner({ proofs, partitions }: Props) {
  // Hold the latest inputs in refs so the interval effect can read them
  // without re-installing on every render.
  const proofsRef = useRef(proofs)
  const partitionsRef = useRef(partitions)
  useEffect(() => { proofsRef.current = proofs })
  useEffect(() => { partitionsRef.current = partitions })

  useEffect(() => {
    const stalledRef = { current: false }
    const id = window.setInterval(() => {
      const now = Date.now()
      let max = 0
      for (const p of proofsRef.current) {
        const ms = Math.floor(p.consensus_at / 1_000_000)
        if (ms > max) max = ms
      }
      const partCount = partitionsRef.current.length
      const stalled = partCount > 0 && (max === 0 || now - max > STALL_MS)
      if (stalled && !stalledRef.current) {
        warningToast(
          'Consensus stalled — no quorum',
          `No new proofs for ${
            max === 0 ? 'a while' : `${Math.floor((now - max) / 1000)}s`
          } while ${partCount} partition${partCount === 1 ? ' is' : 's are'} live. Heal partitions to restore quorum.`,
        )
        stalledRef.current = true
      } else if (!stalled && stalledRef.current) {
        successToast('Consensus recovered', 'Finality proofs are landing again.')
        stalledRef.current = false
      }
    }, TICK_MS)
    return () => window.clearInterval(id)
  }, [])

  return null
}
