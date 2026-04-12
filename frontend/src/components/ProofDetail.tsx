import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ShieldCheck, ShieldX } from 'lucide-react'
import { kindBadgeVariant, roleColor } from '@/lib/utils'
import type { ProofOfCoordination, VerifyResult } from '@/types'

export function ProofDetail({
  proof,
  verifyResult,
}: {
  proof: ProofOfCoordination
  verifyResult?: VerifyResult
}) {
  return (
    <div className="p-4 bg-muted/50 space-y-4">
      {/* Verification banner */}
      {verifyResult && (
        <div
          className={`flex items-center gap-2 p-3 rounded-md text-sm ${
            verifyResult.valid
              ? 'bg-green-500/10 text-green-700 dark:text-green-400'
              : 'bg-red-500/10 text-red-700 dark:text-red-400'
          }`}
        >
          {verifyResult.valid ? (
            <>
              <ShieldCheck className="h-4 w-4" />
              Proof is VALID - Content hash matches
            </>
          ) : (
            <>
              <ShieldX className="h-4 w-4" />
              Proof is INVALID - {verifyResult.error || 'Content hash mismatch'}
            </>
          )}
        </div>
      )}

      {/* Proof metadata */}
      <div className="space-y-3 text-sm">
        <div>
          <span className="text-muted-foreground">Creator:</span>
          <p className="font-mono text-xs break-all mt-1">{proof.creator}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Event Hash:</span>
          <p className="font-mono text-xs break-all mt-1">{proof.event_hash}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Whitened Signature:</span>
          {proof.whitened_signature ? (
            <p className="font-mono text-xs break-all mt-1">{proof.whitened_signature}</p>
          ) : (
            <p className="text-xs text-muted-foreground mt-1">
              Unavailable — the Vertex SDK's whitened_signature() FFI call aborts for these events. Awaiting a safe accessor in a future SDK release.
            </p>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">Content Hash:</span>
          <p className="font-mono text-xs break-all mt-1">{proof.content_hash}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Finality:</span>
          <span className="ml-2">{proof.finality_ms}ms</span>
        </div>
      </div>

      <Separator />

      {/* Transactions */}
      <div>
        <h4 className="text-sm font-medium mb-2">
          Transactions ({proof.transactions.length})
        </h4>
        <div className="space-y-2">
          {proof.transactions.map((tx, i) => (
            <div key={i} className="text-xs p-3 rounded-md bg-background border space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant={kindBadgeVariant(tx.kind)} className="text-xs">
                  {tx.kind}
                </Badge>
                <span className="font-mono text-muted-foreground">{tx.message_id}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-2">
                <div>
                  <span className="text-muted-foreground">Peer:</span>{' '}
                  {tx.state.peer_id.slice(0, 12)}...
                </div>
                <div>
                  <span className="text-muted-foreground">Role:</span>{' '}
                  <Badge variant="outline" className={`text-xs ${roleColor(tx.state.role)}`}>{tx.state.role}</Badge>
                </div>
                <div>
                  <span className="text-muted-foreground">Status:</span>{' '}
                  {tx.state.status}
                </div>
              </div>
              {tx.note && (
                <div className="text-muted-foreground italic mt-1">{tx.note}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
