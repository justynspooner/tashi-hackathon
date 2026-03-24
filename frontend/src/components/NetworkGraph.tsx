import { useEffect, useRef, useMemo } from 'react'
import * as d3 from 'd3'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Network } from 'lucide-react'
import { roleHex } from '@/lib/utils'
import type { AgentState, EventLogEntry, NodeInfo } from '@/types'

const STALE_THRESHOLD_MS = 10_000

interface Props {
  states: AgentState[]
  events: EventLogEntry[]
  nodes: NodeInfo[]
}

type Liveness = 'online' | 'stale' | 'offline'

function determineLiveness(label: string, states: AgentState[], nodes: NodeInfo[]): Liveness {
  const nodeInfo = nodes.find(n => n.label === label)
  if (nodeInfo && nodeInfo.status === 'stopped') return 'offline'
  const agentState = states.find(s => s.label === label)
  if (!agentState) return 'offline'
  if (Date.now() - agentState.local.last_seen_ms > STALE_THRESHOLD_MS) return 'stale'
  return 'online'
}

function livenessColor(liveness: string): string {
  switch (liveness) { case 'online': return '#22c55e'; case 'stale': return '#ef4444'; default: return '#6b7280' }
}

function roleIcon(role: string): string {
  switch (role) { case 'carrier': return '\u{1F4E6}'; case 'scout': return '\u{1F50D}'; case 'observer': return '\u{1F441}'; case 'relay': return '\u{1F4E1}'; default: return '\u{2B55}' }
}

// Topology key — only changes when nodes are added/removed
function topoKey(nodes: NodeInfo[], states: AgentState[]): string {
  const labels = nodes.length > 0 ? nodes.map(n => n.label) : states.map(s => s.label)
  return labels.sort().join(',') || 'agent-a,agent-b'
}

export function NetworkGraph({ states, events, nodes }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const lastEventCount = useRef(0)
  const layoutRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const prevTopoKey = useRef('')

  const currentTopo = useMemo(() => topoKey(nodes, states), [nodes, states])

  // 1) Layout — only recompute positions when topology changes (nodes added/removed)
  useEffect(() => {
    if (currentTopo === prevTopoKey.current) return
    prevTopoKey.current = currentTopo

    const svgEl = svgRef.current
    if (!svgEl) return

    const svg = d3.select(svgEl)
    svg.selectAll('*').interrupt()
    svg.selectAll('*').remove()

    // Use a fixed virtual coordinate space; the viewBox handles responsive scaling
    const vw = 800
    const vh = 100
    svg.attr('viewBox', `0 0 ${vw} ${vh}`).attr('preserveAspectRatio', 'xMidYMid meet')

    const cx = vw / 2
    const cy = vh / 2

    const labels = currentTopo.split(',')
    const positions = new Map<string, { x: number; y: number }>()
    const padding = 100
    const usableWidth = vw - padding * 2
    labels.forEach((label, i) => {
      const x = labels.length === 1 ? cx : padding + (i / (labels.length - 1)) * usableWidth
      positions.set(label, { x, y: cy })
    })
    layoutRef.current = positions

    // Create persistent SVG groups
    svg.append('g').attr('class', 'edges-layer')
    svg.append('g').attr('class', 'effects-layer')
    svg.append('g').attr('class', 'nodes-layer')

    // Create edge lines between all pairs
    const edgesLayer = svg.select('.edges-layer')
    if (labels.length >= 2) {
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const a = positions.get(labels[i])!
          const b = positions.get(labels[j])!
          const edgeId = [labels[i], labels[j]].sort().join('--')
          edgesLayer.append('line')
            .attr('class', `edge-${edgeId}`)
            .attr('x1', a.x).attr('y1', a.y)
            .attr('x2', b.x).attr('y2', b.y)
            .attr('stroke', 'currentColor')
            .attr('stroke-opacity', 0.1)
            .attr('stroke-width', 2)
            .attr('stroke-dasharray', '6,4')
        }
      }
    }

    // Create node groups
    const nodesLayer = svg.select('.nodes-layer')
    for (const label of labels) {
      const pos = positions.get(label)!
      const g = nodesLayer.append('g')
        .attr('class', `node-group-${label}`)
        .attr('transform', `translate(${pos.x},${pos.y})`)

      // Pulse ring
      g.append('circle').attr('class', 'pulse-ring')
        .attr('r', 32).attr('fill', 'none').attr('stroke', '#6b7280')
        .attr('stroke-width', 2).attr('opacity', 0)

      // State change ring (larger, different color)
      g.append('circle').attr('class', 'state-ring')
        .attr('r', 32).attr('fill', 'none').attr('stroke', '#f59e0b')
        .attr('stroke-width', 3).attr('opacity', 0)

      // Outer ring
      g.append('circle').attr('class', 'outer-ring')
        .attr('r', 30).attr('fill', 'none').attr('stroke', '#6b7280')
        .attr('stroke-width', 2.5).attr('stroke-dasharray', '2,6')

      // Inner fill
      g.append('circle').attr('class', 'inner-fill')
        .attr('r', 24).attr('fill', '#6b7280').attr('fill-opacity', 0.05)

      // Role icon
      g.append('text').attr('class', 'role-icon')
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
        .attr('font-size', '18').attr('opacity', 0.3)
        .text('\u{2B55}')

      // Label
      g.append('text').attr('class', 'node-label')
        .attr('text-anchor', 'middle').attr('y', 48)
        .attr('font-size', '13').attr('font-weight', '600')
        .attr('fill', 'currentColor').attr('opacity', 0.4)
        .text(label)

      // Role + liveness text
      g.append('text').attr('class', 'role-liveness')
        .attr('text-anchor', 'middle').attr('y', 65)
        .attr('font-size', '11').attr('fill', '#6b7280').attr('opacity', 0.8)
        .text('offline')

      // Status dot
      g.append('circle').attr('class', 'status-dot')
        .attr('cx', 20).attr('cy', -20).attr('r', 5)
        .attr('fill', '#6b7280')
        .attr('stroke', 'var(--background)').attr('stroke-width', 2)
    }
  }, [currentTopo])

  // 2) Update visual properties with smooth transitions when state changes
  useEffect(() => {
    const svg = d3.select(svgRef.current)
    if (!svgRef.current) return

    const labels = currentTopo.split(',')
    const positions = layoutRef.current

    for (const label of labels) {
      const liveness = determineLiveness(label, states, nodes)
      const agentState = states.find(s => s.label === label)
      const role = agentState?.local.role ?? 'unknown'
      const color = livenessColor(liveness)
      const rColor = roleHex(role)
      const g = svg.select(`.node-group-${label}`)

      // Smooth transition for colors and opacity
      g.select('.outer-ring')
        .transition().duration(600)
        .attr('stroke', liveness === 'online' ? rColor : color)
        .attr('stroke-dasharray', liveness === 'stale' ? '4,4' : liveness === 'offline' ? '2,6' : 'none')

      g.select('.inner-fill')
        .transition().duration(600)
        .attr('fill', liveness === 'online' ? rColor : color)
        .attr('fill-opacity', liveness === 'offline' ? 0.05 : 0.15)

      g.select('.role-icon')
        .transition().duration(400)
        .attr('opacity', liveness === 'offline' ? 0.3 : 1)
        .on('end', function() { d3.select(this).text(roleIcon(role)) })

      g.select('.node-label')
        .transition().duration(400)
        .attr('opacity', liveness === 'offline' ? 0.4 : 1)

      g.select('.role-liveness')
        .transition().duration(400)
        .attr('fill', color)
        .on('end', function() { d3.select(this).text(`${role} \u00b7 ${liveness}`) })

      g.select('.status-dot')
        .transition().duration(400)
        .attr('fill', color)

      g.select('.pulse-ring')
        .attr('stroke', color)
    }

    // Update edges
    if (labels.length >= 2) {
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const livenessA = determineLiveness(labels[i], states, nodes)
          const livenessB = determineLiveness(labels[j], states, nodes)
          const bothOnline = livenessA === 'online' && livenessB === 'online'
          const edgeId = [labels[i], labels[j]].sort().join('--')

          svg.select(`.edge-${edgeId}`)
            .transition().duration(600)
            .attr('stroke', bothOnline ? '#22c55e' : 'currentColor')
            .attr('stroke-opacity', bothOnline ? 0.3 : 0.1)
            .attr('stroke-dasharray', bothOnline ? 'none' : '6,4')
        }
      }
    }

    return undefined
  }, [states, nodes, currentTopo])

  // 3) Event-driven effects — pulses, state change visuals, message arrows
  useEffect(() => {
    if (events.length <= lastEventCount.current) {
      lastEventCount.current = events.length
      return
    }
    const newEvents = events.slice(lastEventCount.current)
    lastEventCount.current = events.length

    const svg = d3.select(svgRef.current)
    const effectsLayer = svg.select('.effects-layer')
    const positions = layoutRef.current

    for (const ev of newEvents) {
      const g = svg.select(`.node-group-${ev.label}`)

      if (ev.tag === 'HEARTBEAT' || ev.tag === 'HANDSHAKE' || ev.tag === 'DISCOVERY') {
        // Small green pulse
        g.select('.pulse-ring')
          .interrupt()
          .attr('opacity', 0.6).attr('r', 32)
          .transition().duration(500)
          .attr('r', 46).attr('opacity', 0)

        g.select('.inner-fill')
          .interrupt()
          .transition().duration(80).attr('fill-opacity', 0.45)
          .transition().duration(400).attr('fill-opacity', 0.15)
      }

      if (ev.tag === 'ACTION') {
        const color = '#f97316' // orange — transmit

        // Outward pulse ring from sender
        g.select('.state-ring')
          .interrupt()
          .attr('stroke', color)
          .attr('opacity', 1).attr('r', 30).attr('stroke-width', 4)
          .transition().duration(800).ease(d3.easeExpOut)
          .attr('r', 65).attr('opacity', 0).attr('stroke-width', 1)

        // Flash the fill
        g.select('.inner-fill')
          .interrupt()
          .attr('fill', color)
          .transition().duration(150).attr('fill-opacity', 0.6)
          .transition().duration(600).attr('fill-opacity', 0.15)
          .transition().duration(300)
          .attr('fill', livenessColor(determineLiveness(ev.label, states, nodes)))

        // Fire a bolt along the edge to the peer
        const otherLabel = [...positions.keys()].find(l => l !== ev.label)
        if (otherLabel) {
          const from = positions.get(ev.label)
          const to = positions.get(otherLabel)
          if (from && to) {
            const bolt = effectsLayer.append('circle')
              .attr('r', 6).attr('fill', color).attr('opacity', 0.9)
              .attr('cx', from.x).attr('cy', from.y)

            const trail = effectsLayer.append('line')
              .attr('x1', from.x).attr('y1', from.y)
              .attr('x2', from.x).attr('y2', from.y)
              .attr('stroke', color).attr('stroke-width', 2).attr('opacity', 0.6)

            bolt.transition().duration(500).ease(d3.easeCubicIn)
              .attr('cx', to.x).attr('cy', to.y).attr('r', 4)
              .on('end', () => {
                bolt.transition().duration(300).attr('opacity', 0).remove()
              })

            trail.transition().duration(500).ease(d3.easeCubicIn)
              .attr('x2', to.x).attr('y2', to.y)
              .transition().duration(400).attr('opacity', 0).remove()
          }
        }
      }

      if (ev.tag === 'STATE') {
        const color = '#f59e0b' // amber — receive

        // Inward contracting ring on receiver
        g.select('.state-ring')
          .interrupt()
          .attr('stroke', color)
          .attr('opacity', 0.8).attr('r', 55).attr('stroke-width', 3)
          .transition().duration(500).ease(d3.easeCubicOut)
          .attr('r', 30).attr('opacity', 0)

        // Flash the fill amber
        g.select('.inner-fill')
          .interrupt()
          .attr('fill', color)
          .transition().duration(100).attr('fill-opacity', 0.5)
          .transition().duration(500).attr('fill-opacity', 0.15)
          .transition().duration(300)
          .attr('fill', livenessColor(determineLiveness(ev.label, states, nodes)))
      }

      if (ev.tag === 'ACK') {
        // Purple pulse for acknowledgements
        g.select('.state-ring')
          .interrupt()
          .attr('stroke', '#a855f7')
          .attr('opacity', 0.8).attr('r', 30).attr('stroke-width', 3)
          .transition().duration(500).ease(d3.easeExpOut)
          .attr('r', 50).attr('opacity', 0)

        g.select('.inner-fill')
          .interrupt()
          .transition().duration(100).attr('fill-opacity', 0.4)
          .transition().duration(400).attr('fill-opacity', 0.15)
      }

      if (ev.tag === 'STALE') {
        // Red warning flash
        g.select('.outer-ring')
          .interrupt()
          .attr('stroke', '#ef4444').attr('stroke-width', 4)
          .transition().duration(200).attr('stroke-width', 2.5)
          .transition().duration(200).attr('stroke-width', 4)
          .transition().duration(200).attr('stroke-width', 2.5)

        g.select('.inner-fill')
          .interrupt()
          .attr('fill', '#ef4444')
          .transition().duration(100).attr('fill-opacity', 0.4)
          .transition().duration(500).attr('fill-opacity', 0.15)
      }

      if (ev.tag === 'RECOVERY') {
        // Green expanding rings
        const pos = positions.get(ev.label)
        if (pos) {
          for (let r = 0; r < 3; r++) {
            effectsLayer.append('circle')
              .attr('cx', pos.x).attr('cy', pos.y)
              .attr('r', 30).attr('fill', 'none')
              .attr('stroke', '#22c55e').attr('stroke-width', 2).attr('opacity', 0.7)
              .transition().delay(r * 150).duration(800).ease(d3.easeExpOut)
              .attr('r', 60 + r * 10).attr('opacity', 0)
              .remove()
          }
        }
      }
    }
  }, [events, states, nodes])


  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Network className="h-5 w-5" />
          Network Topology
        </CardTitle>
      </CardHeader>
      <CardContent>
        <svg ref={svgRef} className="w-full" />
      </CardContent>
    </Card>
  )
}
