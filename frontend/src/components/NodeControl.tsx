import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Power, PowerOff, Server } from 'lucide-react'
import { timeSince, truncateId, roleColor } from '@/lib/utils'
import type { AgentState, NodeInfo } from '@/types'

const AVAILABLE_ROLES = ['carrier', 'scout', 'observer', 'relay']

interface Props {
  nodes: NodeInfo[]
  states: AgentState[]
  onStart: (label: string) => Promise<void>
  onStop: (label: string) => Promise<void>
  onSetRole: (label: string, role: string) => Promise<void>
}

export function NodeControl({ nodes, states, onStart, onStop, onSetRole }: Props) {
  const [loading, setLoading] = useState<Record<string, boolean>>({})

  async function handleStart(label: string) {
    setLoading(prev => ({ ...prev, [label]: true }))
    try {
      await onStart(label)
    } finally {
      setTimeout(() => setLoading(prev => ({ ...prev, [label]: false })), 1000)
    }
  }

  async function handleStop(label: string) {
    setLoading(prev => ({ ...prev, [label]: true }))
    try {
      await onStop(label)
    } finally {
      setTimeout(() => setLoading(prev => ({ ...prev, [label]: false })), 1000)
    }
  }

  return (
    <Card>
      <CardHeader className="py-2 px-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4" />
          Node Control
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0">
        <div className="flex gap-3 flex-wrap">
          {nodes.map(node => {
            const agentState = states.find(s => s.label === node.label)

            return (
              <div
                key={node.label}
                className="flex-1 min-w-[300px] border rounded-lg p-3 space-y-2"
              >
                {/* Header row: name, bind, status, start/stop */}
                <div className="flex items-center gap-2">
                  <div
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      node.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
                    }`}
                  />
                  <span className="font-medium text-sm">{node.label}</span>
                  <span className="text-xs text-muted-foreground">{node.bind}</span>
                  <div className="ml-auto flex items-center gap-2">
                    <Select
                      value={node.role ?? undefined}
                      onValueChange={(value) => value && onSetRole(node.label, value)}
                    >
                      <SelectTrigger className="h-7 text-xs w-[100px]">
                        <SelectValue placeholder="role" />
                      </SelectTrigger>
                      <SelectContent>
                        {AVAILABLE_ROLES.map(role => (
                          <SelectItem key={role} value={role}>{role}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {node.status === 'running' ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 px-2 text-xs"
                        disabled={loading[node.label]}
                        onClick={() => handleStop(node.label)}
                      >
                        <PowerOff className="h-3 w-3 mr-1" />
                        {loading[node.label] ? 'Stopping...' : 'Stop'}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={loading[node.label]}
                        onClick={() => handleStart(node.label)}
                      >
                        <Power className="h-3 w-3 mr-1" />
                        {loading[node.label] ? 'Starting...' : 'Start'}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Agent state — compact two-column layout */}
                {agentState && (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs border-t pt-2">
                    {/* Local */}
                    <div className="space-y-0.5">
                      <div className="text-muted-foreground font-medium">Local</div>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline" className={`text-[10px] px-1 py-0 ${roleColor(agentState.local.role)}`}>
                          {agentState.local.role}
                        </Badge>
                        <span className="text-muted-foreground">{timeSince(agentState.local.last_seen_ms)}</span>
                      </div>
                      <div className="font-mono text-muted-foreground truncate">
                        {truncateId(agentState.local.peer_id)}
                      </div>
                    </div>
                    {/* Peer */}
                    <div className="space-y-0.5">
                      <div className="text-muted-foreground font-medium">Peer</div>
                      {agentState.peer ? (
                        <>
                          <div className="flex items-center gap-1">
                            <Badge variant="outline" className={`text-[10px] px-1 py-0 ${roleColor(agentState.peer.role)}`}>
                              {agentState.peer.role}
                            </Badge>
                            <span className="text-muted-foreground">{timeSince(agentState.peer.last_seen_ms)}</span>
                          </div>
                          <div className="font-mono text-muted-foreground truncate">
                            {truncateId(agentState.peer.peer_id)}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground italic">waiting...</span>
                      )}
                    </div>
                    {/* Footer row spanning both columns */}
                    <div className="col-span-2 flex items-center gap-2 text-muted-foreground pt-1">
                      <span>Last:</span>
                      <Badge variant="outline" className="text-[10px] px-1 py-0">{agentState.last_message_kind}</Badge>
                      <span className="font-mono truncate">{agentState.last_message_id}</span>
                      {agentState.pending_role_change && (
                        <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-auto">
                          pending → {agentState.pending_role_change.role}
                        </Badge>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
