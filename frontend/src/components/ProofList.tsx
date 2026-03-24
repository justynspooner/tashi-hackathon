import { useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Shield, ShieldCheck, ShieldX, ChevronDown, ChevronRight } from 'lucide-react'
import type { ProofOfCoordination, VerifyResult } from '@/types'
import { verifyProof } from '@/hooks/useApi'
import { ProofDetail } from './ProofDetail'

function formatTimestamp(ns: number): string {
  // consensus_at is in nanoseconds
  const ms = ns / 1_000_000
  return new Date(ms).toLocaleTimeString()
}

function truncateHash(hash: string): string {
  if (hash.length <= 16) return hash
  return hash.slice(0, 8) + '...' + hash.slice(-8)
}

export function ProofList({ proofs }: { proofs: ProofOfCoordination[] }) {
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({})
  const [verifying, setVerifying] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<string | null>(null)

  async function handleVerify(proof: ProofOfCoordination) {
    const key = proof.file
    const fileName = key.split('/').pop()!
    setVerifying(prev => ({ ...prev, [key]: true }))
    try {
      const result = await verifyProof(proof.agent, fileName)
      setVerifyResults(prev => ({ ...prev, [key]: result }))
    } catch {
      setVerifyResults(prev => ({
        ...prev,
        [key]: { valid: false, proof, error: 'Failed to verify' },
      }))
    }
    setVerifying(prev => ({ ...prev, [key]: false }))
  }

  async function handleVerifyAll() {
    for (const proof of proofs) {
      await handleVerify(proof)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Proofs of Coordination
            <Badge variant="secondary">{proofs.length}</Badge>
          </CardTitle>
          {proofs.length > 0 && (
            <Button size="sm" variant="outline" onClick={handleVerifyAll}>
              Verify All
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {proofs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No proofs generated yet. Run the agents with --proof-dir to generate proofs.
          </p>
        ) : (
          <ScrollArea className="h-[500px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Event Hash</TableHead>
                  <TableHead>Consensus</TableHead>
                  <TableHead>Finality</TableHead>
                  <TableHead>Txns</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {proofs.map(proof => {
                  const key = proof.file
                  const isExpanded = expanded === key
                  const result = verifyResults[key]
                  return (
                    <>
                      <TableRow
                        key={key}
                        className="cursor-pointer"
                        onClick={() => setExpanded(isExpanded ? null : key)}
                      >
                        <TableCell>
                          {isExpanded
                            ? <ChevronDown className="h-4 w-4" />
                            : <ChevronRight className="h-4 w-4" />}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{proof.agent}</Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {truncateHash(proof.event_hash)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatTimestamp(proof.consensus_at)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{proof.finality_ms}ms</Badge>
                        </TableCell>
                        <TableCell>{proof.transactions.length}</TableCell>
                        <TableCell>
                          {result ? (
                            result.valid ? (
                              <ShieldCheck className="h-4 w-4 text-green-500" />
                            ) : (
                              <ShieldX className="h-4 w-4 text-red-500" />
                            )
                          ) : (
                            <span className="text-muted-foreground text-xs">--</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={verifying[key]}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleVerify(proof)
                            }}
                          >
                            {verifying[key] ? 'Verifying...' : 'Verify'}
                          </Button>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow key={`${key}-detail`}>
                          <TableCell colSpan={8} className="p-0">
                            <ProofDetail proof={proof} verifyResult={result} />
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  )
                })}
              </TableBody>
            </Table>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
