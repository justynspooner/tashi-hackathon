import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Power, PowerOff, Server, Plus, Trash2 } from 'lucide-react'
import { timeSince, roleColor } from '@/lib/utils'
import type { AgentState, NodeInfo } from '@/types'

const AVAILABLE_ROLES = ['carrier', 'scout', 'observer', 'relay']

function shortId(id: string): string {
  return id.slice(-4)
}

function shortMessageId(id: string | null | undefined): string {
  if (!id) return '—'
  const dashIdx = id.indexOf('-')
  return dashIdx >= 0 ? id.slice(dashIdx + 1) : id
}

interface Props {
  nodes: NodeInfo[]
  states: AgentState[]
  onStart: (label: string) => Promise<void>
  onStop: (label: string) => Promise<void>
  onSetRole: (label: string, role: string) => Promise<void>
  onCreateSwarm: (count: number) => Promise<void>
  onDestroySwarm: () => Promise<void>
}

export function NodeControl({ nodes, states, onStart, onStop, onSetRole, onCreateSwarm, onDestroySwarm }: Props) {
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [swarmSizeInput, setSwarmSizeInput] = useState('7')
  const [swarmDialogOpen, setSwarmDialogOpen] = useState(false)
  const [destroyDialogOpen, setDestroyDialogOpen] = useState(false)

  async function handleStart(label: string) {
    setLoading(prev => ({ ...prev, [label]: true }))
    try { await onStart(label) }
    finally { setTimeout(() => setLoading(prev => ({ ...prev, [label]: false })), 1000) }
  }

  async function handleStop(label: string) {
    setLoading(prev => ({ ...prev, [label]: true }))
    try { await onStop(label) }
    finally { setTimeout(() => setLoading(prev => ({ ...prev, [label]: false })), 1000) }
  }

  async function handleCreateSwarm() {
    setLoading(prev => ({ ...prev, '__swarm__': true }))
    const count = Math.max(4, Math.min(26, parseInt(swarmSizeInput) || 7))
    setSwarmDialogOpen(false)
    try { await onCreateSwarm(count) }
    finally { setLoading(prev => ({ ...prev, '__swarm__': false })) }
  }

  async function handleDestroySwarm() {
    setLoading(prev => ({ ...prev, '__destroy__': true }))
    setDestroyDialogOpen(false)
    try { await onDestroySwarm() }
    finally { setLoading(prev => ({ ...prev, '__destroy__': false })) }
  }

  const hasSwarm = nodes.length > 0

  return (
    <Card>
      <CardHeader className="py-2 px-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4" />
          Node Control
          <div className="ml-auto flex items-center gap-1">
            {!hasSwarm ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs gap-1"
                disabled={loading['__swarm__']}
                onClick={() => setSwarmDialogOpen(true)}
              >
                <Plus className="h-3 w-3" />
                {loading['__swarm__'] ? 'Deploying...' : 'Add Swarm'}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                className="h-6 px-2 text-xs gap-1"
                disabled={loading['__destroy__']}
                onClick={() => setDestroyDialogOpen(true)}
              >
                <Trash2 className="h-3 w-3" />
                {loading['__destroy__'] ? 'Destroying...' : 'Destroy Swarm'}
              </Button>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0">
        {!hasSwarm ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No swarm deployed. Click "Add Swarm" to get started.
          </p>
        ) : (
          <div className="space-y-3">
            {nodes.map(node => {
              const agentState = states.find(s => s.label === node.label)
              return (
                <div key={node.label} className="border rounded-lg p-2.5 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${node.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
                    <span className="font-medium text-sm">{node.label}</span>
                    <span className="text-[10px] text-muted-foreground">{node.bind}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <Select
                        value={node.role ?? ''}
                        onValueChange={(value) => value && onSetRole(node.label, value)}
                      >
                        <SelectTrigger className={`h-6 text-[11px] w-[80px] px-2 ${node.role ? roleColor(node.role) : ''}`}>
                          <SelectValue placeholder="role" />
                        </SelectTrigger>
                        <SelectContent>
                          {AVAILABLE_ROLES.map(role => (
                            <SelectItem key={role} value={role}>
                              <span className={`px-1 rounded ${roleColor(role)}`}>{role}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {node.status === 'running' ? (
                        <Button size="sm" variant="destructive" className="h-6 w-6 p-0" disabled={loading[node.label]} onClick={() => handleStop(node.label)}>
                          <PowerOff className="h-3 w-3" />
                        </Button>
                      ) : (
                        <Button size="sm" className="h-6 w-6 p-0" disabled={loading[node.label]} onClick={() => handleStart(node.label)}>
                          <Power className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {agentState && (
                    <div className="text-[11px] border-t pt-1.5 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground w-8 shrink-0">Local</span>
                        <Badge variant="outline" className={`text-[10px] px-1 py-0 leading-tight ${roleColor(agentState.local.role)}`}>{agentState.local.role}</Badge>
                        <span className="text-muted-foreground">{timeSince(agentState.local.last_seen_ms)}</span>
                        <span className="font-mono text-muted-foreground ml-auto">...{shortId(agentState.local.peer_id)}</span>
                      </div>
                      {agentState.peers && Object.keys(agentState.peers).length > 0 ? (
                        Object.entries(agentState.peers).sort(([a], [b]) => a.localeCompare(b)).map(([peerId, peer]) => (
                          <div key={peerId} className="flex items-center gap-1.5">
                            <span className="text-muted-foreground w-8 shrink-0">Peer</span>
                            <Badge variant="outline" className={`text-[10px] px-1 py-0 leading-tight ${roleColor(peer.role)}`}>{peer.role}</Badge>
                            <span className="text-muted-foreground">{timeSince(peer.last_seen_ms)}</span>
                            <span className="font-mono text-muted-foreground ml-auto">...{shortId(peer.peer_id)}</span>
                          </div>
                        ))
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted-foreground w-8 shrink-0">Peer</span>
                          <span className="text-muted-foreground italic">waiting...</span>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 text-muted-foreground pt-0.5">
                        <span className="shrink-0">Last</span>
                        <Badge variant="outline" className="text-[10px] px-1 py-0 leading-tight">{agentState.last_message_kind}</Badge>
                        <span className="font-mono truncate">{shortMessageId(agentState.last_message_id)}</span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>

      {/* Deploy Swarm Dialog */}
      <Dialog open={swarmDialogOpen} onOpenChange={setSwarmDialogOpen}>
        <DialogContent className="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle>Deploy Swarm</DialogTitle>
            <DialogDescription>
              Choose the number of nodes for your Vertex consensus network. Each node gets a unique Ed25519 keypair.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="swarm-size">Number of nodes</Label>
            <Input
              id="swarm-size"
              type="number"
              min={4}
              max={26}
              value={swarmSizeInput}
              onChange={(e) => setSwarmSizeInput(e.target.value)}
              className="mt-2"
            />
            <p className="text-xs text-muted-foreground mt-2">
              Minimum 4 nodes required for fault tolerance (f&ge;1). This allows nodes to be stopped and restarted while the swarm continues.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={handleCreateSwarm}>
              Deploy Nodes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Destroy Swarm Confirmation */}
      <AlertDialog open={destroyDialogOpen} onOpenChange={setDestroyDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Destroy Swarm?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop all {nodes.length} nodes and remove the swarm configuration.
              Artifact files (proofs, logs) will be kept on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDestroySwarm}>Destroy</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
