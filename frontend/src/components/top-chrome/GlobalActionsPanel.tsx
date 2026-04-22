// Swarm-wide batching popover mounted in the top chrome.
//
// Rationale (B5): a Unity-style global-actions bucket so the user can issue
// the same command across every node at once — Start All, Stop All, Destroy
// Swarm, Ready All, and "Auto-select Game" which pushes a proposal/vote to
// every running node in one shot. Also surfaces per-phase aggregate progress
// (running count, ready count, proposal/vote tally) so the user can see
// convergence without fanning out to every scene-tree row.

import { useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  Gamepad2,
  Plus,
  Power,
  PowerOff,
  Trash2,
} from 'lucide-react'

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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
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
import { Separator } from '@/components/ui/separator'

import type { NodeInfo } from '@/types'
import type { GameConfig, LocalGameSnapshot } from '@/game/types'
import { tallyPicks } from '@/lib/node-control-helpers'
import { runWithToast } from '@/hooks/useErrorToast'

interface Props {
  nodes: NodeInfo[]
  snapshots: Record<string, LocalGameSnapshot>
  games: GameConfig[]
  onCreateSwarm: (count: number) => Promise<void>
  onDestroySwarm: () => Promise<void>
  onStart: (label: string) => Promise<void>
  onStop: (label: string) => Promise<void>
  onProposeGame: (label: string, gameId: string) => Promise<void>
  onVoteGame: (label: string, gameId: string) => Promise<void>
  onReadyUp: (label: string) => Promise<void>
}

export function GlobalActionsPanel({
  nodes,
  snapshots,
  games,
  onCreateSwarm,
  onDestroySwarm,
  onStart,
  onStop,
  onProposeGame,
  onVoteGame,
  onReadyUp,
}: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [swarmSizeInput, setSwarmSizeInput] = useState('7')
  const [swarmDialogOpen, setSwarmDialogOpen] = useState(false)
  const [destroyDialogOpen, setDestroyDialogOpen] = useState(false)
  const [autoGame, setAutoGame] = useState<string>('')

  const runningCount = nodes.filter(n => n.status === 'running').length
  const totalCount = nodes.length
  const allRunning = totalCount > 0 && runningCount === totalCount
  const hasSwarm = totalCount > 0

  // Aggregate ready-peer progress across snapshots. Any snapshot suffices
  // since `ready_peers` converges through consensus.
  const { readyCount, readyTotal } = useMemo(() => {
    const runningLabels = new Set(nodes.filter(n => n.status === 'running').map(n => n.label))
    const readyPeerIds = new Set<string>()
    for (const snap of Object.values(snapshots)) {
      for (const p of snap.ready_peers ?? []) readyPeerIds.add(p)
    }
    let ready = 0
    for (const label of runningLabels) {
      const snap = snapshots[label]
      if (snap?.peer_id && readyPeerIds.has(snap.peer_id)) ready += 1
    }
    return { readyCount: ready, readyTotal: runningLabels.size }
  }, [nodes, snapshots])

  // Show proposal/vote tally while any node is proposing/voting.
  const selectionPhase = useMemo<'none' | 'proposing' | 'voting'>(() => {
    const phases = Object.values(snapshots).map(s => s.phase)
    if (phases.some(p => ['loaded', 'placing_entities', 'ready', 'counting_down', 'playing', 'ended'].includes(p))) {
      return 'none'
    }
    if (phases.some(p => p === 'voting')) return 'voting'
    if (phases.some(p => p === 'proposing')) return 'proposing'
    return 'none'
  }, [snapshots])

  const tally = useMemo(
    () => tallyPicks(
      snapshots,
      selectionPhase === 'voting' ? 'vote_window' : 'proposal_window',
    ),
    [snapshots, selectionPhase],
  )

  // Which nodes are in `placing_entities` / `ready` AND have a valid
  // placement — i.e. eligible to Ready Up.
  const readyableLabels = useMemo(() => {
    const out: string[] = []
    for (const n of nodes) {
      if (n.status !== 'running') continue
      const snap = snapshots[n.label]
      if (!snap) continue
      const phase = snap.phase
      if (phase !== 'placing_entities' && phase !== 'ready') continue
      if (!snap.placement_ok) continue
      if (!snap.entities[n.label]?.entity_type) continue
      if (snap.peer_id && (snap.ready_peers ?? []).includes(snap.peer_id)) continue
      out.push(n.label)
    }
    return out
  }, [nodes, snapshots])

  // Any node in a pre-game / voting state that can accept a proposal or vote.
  const autoSelectEligibleLabels = useMemo(() => {
    const out: Array<{ label: string; action: 'propose' | 'vote' }> = []
    for (const n of nodes) {
      if (n.status !== 'running') continue
      const snap = snapshots[n.label]
      const phase = snap?.phase ?? 'no_game'
      if (phase === 'voting') out.push({ label: n.label, action: 'vote' })
      else if (phase === 'no_game' || phase === 'proposing') {
        out.push({ label: n.label, action: 'propose' })
      }
    }
    return out
  }, [nodes, snapshots])

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(prev => ({ ...prev, [key]: true }))
    try {
      await fn()
    } finally {
      setBusy(prev => ({ ...prev, [key]: false }))
    }
  }

  async function handleCreateSwarm() {
    const count = Math.max(4, Math.min(26, parseInt(swarmSizeInput) || 7))
    setSwarmDialogOpen(false)
    await withBusy('__swarm__', async () => {
      await runWithToast('Deploy swarm', () => onCreateSwarm(count))
    })
  }

  async function handleStartAll() {
    const stopped = nodes.filter(n => n.status !== 'running')
    await withBusy('__start_all__', async () => {
      for (const n of stopped) {
        await runWithToast(`Start ${n.label}`, () => onStart(n.label))
      }
    })
  }

  async function handleStopAll() {
    const running = nodes.filter(n => n.status === 'running')
    await withBusy('__stop_all__', async () => {
      for (const n of running) {
        await runWithToast(`Stop ${n.label}`, () => onStop(n.label))
      }
    })
  }

  async function handleDestroySwarm() {
    setDestroyDialogOpen(false)
    await withBusy('__destroy__', async () => {
      await runWithToast('Destroy swarm', () => onDestroySwarm())
    })
  }

  async function handleReadyAll() {
    if (readyableLabels.length === 0) return
    await withBusy('__ready_all__', async () => {
      for (const label of readyableLabels) {
        await runWithToast(`Ready ${label}`, () => onReadyUp(label))
      }
    })
  }

  async function handleAutoSelect() {
    if (!autoGame) return
    await withBusy('__auto_select__', async () => {
      for (const e of autoSelectEligibleLabels) {
        const action = e.action === 'vote' ? onVoteGame : onProposeGame
        await runWithToast(
          `${e.action === 'vote' ? 'Vote' : 'Propose'} ${e.label}`,
          () => action(e.label, autoGame),
        )
      }
    })
  }

  const busyAny = Object.values(busy).some(Boolean)

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button size="sm" variant="outline" className="gap-1" disabled={busyAny}>
              Swarm Actions
              <ChevronDown className="h-3 w-3" />
            </Button>
          }
        />
        <PopoverContent align="end" className="w-80 p-0">
          {/* Header: aggregate progress subline so the popover is useful at a glance */}
          <div className="px-3 py-2 border-b bg-muted/40">
            <div className="text-xs font-semibold">Swarm</div>
            <div className="text-[11px] text-muted-foreground tabular-nums">
              {totalCount === 0
                ? 'No swarm deployed'
                : `${runningCount}/${totalCount} running · ${readyCount}/${readyTotal} ready`}
            </div>
          </div>

          <div className="p-3 space-y-3">
            {/* Swarm lifecycle */}
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Nodes</div>
              {!hasSwarm ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full justify-start gap-2"
                  disabled={busy['__swarm__']}
                  onClick={() => setSwarmDialogOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {busy['__swarm__'] ? 'Deploying…' : 'Add Swarm'}
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full justify-start gap-2"
                    disabled={busy['__start_all__'] || allRunning}
                    onClick={handleStartAll}
                  >
                    <Power className="h-3.5 w-3.5" />
                    {busy['__start_all__'] ? 'Starting…' : 'Start All'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full justify-start gap-2"
                    disabled={busy['__stop_all__'] || runningCount === 0}
                    onClick={handleStopAll}
                  >
                    <PowerOff className="h-3.5 w-3.5" />
                    {busy['__stop_all__'] ? 'Stopping…' : 'Stop All'}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="w-full justify-start gap-2"
                    disabled={busy['__destroy__']}
                    onClick={() => setDestroyDialogOpen(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {busy['__destroy__'] ? 'Destroying…' : 'Destroy Swarm'}
                  </Button>
                </>
              )}
            </div>

            {hasSwarm && (
              <>
                <Separator />

                {/* Game controls */}
                <div className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Game</div>
                  <Label htmlFor="auto-game" className="text-[11px] text-muted-foreground">
                    Auto-select on all nodes
                  </Label>
                  <div className="flex gap-1.5">
                    <Select value={autoGame} onValueChange={v => setAutoGame(v ?? '')} disabled={games.length === 0 || autoSelectEligibleLabels.length === 0}>
                      <SelectTrigger id="auto-game" size="sm" className="flex-1 h-7 text-[11px]">
                        <SelectValue placeholder="pick a game" />
                      </SelectTrigger>
                      <SelectContent>
                        {games.map(g => (
                          <SelectItem key={g.id} value={g.id}>
                            {g.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      className="h-7 px-2 text-[11px] gap-1"
                      disabled={busy['__auto_select__'] || !autoGame || autoSelectEligibleLabels.length === 0}
                      onClick={handleAutoSelect}
                    >
                      <Gamepad2 className="h-3 w-3" />
                      {busy['__auto_select__'] ? '…' : 'Go'}
                    </Button>
                  </div>
                  {autoSelectEligibleLabels.length > 0 && (
                    <div className="text-[10px] text-muted-foreground">
                      {autoSelectEligibleLabels.length} node{autoSelectEligibleLabels.length === 1 ? '' : 's'} eligible
                      {selectionPhase !== 'none' && (
                        <>
                          {' · '}
                          {selectionPhase === 'voting' ? 'voting' : 'proposing'}
                        </>
                      )}
                    </div>
                  )}

                  {/* Tally strip (proposal/vote counts). */}
                  {selectionPhase !== 'none' && games.length > 0 && (
                    <div className="rounded border border-border bg-muted/30 px-2 py-1.5 space-y-1">
                      {games.map(g => {
                        const count = tally[g.id] ?? 0
                        const pct = totalCount > 0 ? Math.round((count / totalCount) * 100) : 0
                        return (
                          <div key={g.id} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span className="font-mono truncate flex-1">{g.name}</span>
                            <div className="w-14 h-1.5 bg-muted rounded overflow-hidden">
                              <div
                                className="h-full bg-primary transition-all"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="tabular-nums w-10 text-right">{count}/{totalCount}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  <Button
                    size="sm"
                    className="w-full justify-start gap-2 h-7 text-[11px]"
                    disabled={busy['__ready_all__'] || readyableLabels.length === 0}
                    onClick={handleReadyAll}
                    title={
                      readyableLabels.length === 0
                        ? 'No eligible nodes to ready up'
                        : `Broadcast ReadyUp on ${readyableLabels.length} node${readyableLabels.length === 1 ? '' : 's'}`
                    }
                  >
                    <Check className="h-3.5 w-3.5" />
                    {busy['__ready_all__']
                      ? 'Signalling…'
                      : `Ready All${readyableLabels.length > 0 ? ` (${readyableLabels.length})` : ''}`}
                  </Button>
                </div>
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>

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
            <Button onClick={handleCreateSwarm}>Deploy Nodes</Button>
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
    </>
  )
}
