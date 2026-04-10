import { useEffect, useRef, useMemo } from 'react'
import * as d3 from 'd3'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Network } from 'lucide-react'
import { roleHex, roleColor } from '@/lib/utils'
import type { AgentState, EventLogEntry, NodeInfo } from '@/types'

const VW = 800
const VH = 500

interface Props {
  states: AgentState[]
  events: EventLogEntry[]
  nodes: NodeInfo[]
}

type Liveness = 'online' | 'offline'

interface SimNode extends d3.SimulationNodeDatum {
  id: string
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  id: string
}

function determineLiveness(label: string, states: AgentState[], nodes: NodeInfo[]): Liveness {
  const nodeInfo = nodes.find(n => n.label === label)
  if (nodeInfo && nodeInfo.status === 'stopped') return 'offline'
  const agentState = states.find(s => s.label === label)
  if (!agentState) return 'offline'
  return 'online'
}

function livenessColor(liveness: string): string {
  switch (liveness) { case 'online': return '#22c55e'; default: return '#6b7280' }
}

function roleIcon(role: string): string {
  switch (role) { case 'carrier': return '\u{1F4E6}'; case 'scout': return '\u{1F50D}'; case 'observer': return '\u{1F441}'; case 'relay': return '\u{1F4E1}'; default: return '\u{2B55}' }
}

function topoKey(nodes: NodeInfo[], states: AgentState[]): string {
  const labels = nodes.length > 0 ? nodes.map(n => n.label) : states.map(s => s.label)
  return labels.sort().join(',') || ''
}

export function NetworkGraph({ states, events, nodes }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const lastEventCount = useRef(0)
  const layoutRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null)
  const prevTopoKey = useRef('')

  const currentTopo = useMemo(() => topoKey(nodes, states), [nodes, states])

  // Stable refs for state/nodes so the tick callback doesn't cause stale closures
  const statesRef = useRef(states)
  const nodesRef = useRef(nodes)
  statesRef.current = states
  nodesRef.current = nodes

  // 1) Force layout — rebuild when topology changes
  useEffect(() => {
    if (currentTopo === prevTopoKey.current || !currentTopo) return
    prevTopoKey.current = currentTopo

    const svgEl = svgRef.current
    if (!svgEl) return

    // Stop previous simulation
    simulationRef.current?.stop()

    const svg = d3.select(svgEl)
    svg.selectAll('*').interrupt()
    svg.selectAll('*').remove()
    svg.attr('viewBox', `0 0 ${VW} ${VH}`).attr('preserveAspectRatio', 'xMidYMid meet')

    const labels = currentTopo.split(',')
    const oldPositions = layoutRef.current

    // Build simulation nodes, preserving old positions
    const simNodes: SimNode[] = labels.map((id, i) => {
      const old = oldPositions.get(id)
      if (old) return { id, x: old.x, y: old.y }
      // New node: start near center with slight offset
      const angle = (2 * Math.PI * i) / labels.length
      return { id, x: VW / 2 + Math.cos(angle) * 50, y: VH / 2 + Math.sin(angle) * 50 }
    })

    // Build links for all pairs
    const simLinks: SimLink[] = []
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        simLinks.push({
          source: labels[i],
          target: labels[j],
          id: [labels[i], labels[j]].sort().join('--'),
        })
      }
    }

    // Create SVG layers
    svg.append('g').attr('class', 'edges-layer')
    svg.append('g').attr('class', 'effects-layer')
    svg.append('g').attr('class', 'nodes-layer')

    // Create edge lines
    const edgesLayer = svg.select('.edges-layer')
    for (const link of simLinks) {
      edgesLayer.append('line')
        .attr('class', `edge-${link.id}`)
        .attr('stroke', 'currentColor')
        .attr('stroke-opacity', 0.1)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '6,4')
    }

    // Create node groups
    const nodesLayer = svg.select('.nodes-layer')
    for (const node of simNodes) {
      const g = nodesLayer.append('g')
        .attr('class', `node-group-${node.id}`)
        .attr('transform', `translate(${node.x},${node.y})`)

      g.append('circle').attr('class', 'pulse-ring')
        .attr('r', 32).attr('fill', 'none').attr('stroke', '#6b7280')
        .attr('stroke-width', 2).attr('opacity', 0)

      g.append('circle').attr('class', 'state-ring')
        .attr('r', 32).attr('fill', 'none').attr('stroke', '#f59e0b')
        .attr('stroke-width', 3).attr('opacity', 0)

      g.append('circle').attr('class', 'outer-ring')
        .attr('r', 30).attr('fill', 'none').attr('stroke', '#6b7280')
        .attr('stroke-width', 2.5).attr('stroke-dasharray', '2,6')

      g.append('circle').attr('class', 'inner-fill')
        .attr('r', 24).attr('fill', '#6b7280').attr('fill-opacity', 0.05)

      g.append('text').attr('class', 'role-icon')
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
        .attr('font-size', '18').attr('opacity', 0.3)
        .text('\u{2B55}')

      g.append('text').attr('class', 'node-label')
        .attr('text-anchor', 'middle').attr('y', 48)
        .attr('font-size', '13').attr('font-weight', '600')
        .attr('fill', 'currentColor').attr('opacity', 0.4)
        .text(node.id)

      const foWidth = 120
      const foHeight = 36
      g.append('foreignObject')
        .attr('class', 'role-liveness-fo')
        .attr('x', -foWidth / 2).attr('y', 55)
        .attr('width', foWidth).attr('height', foHeight)
        .append('xhtml:div')
        .attr('class', 'role-liveness')
        .attr('style', 'display:flex;align-items:center;justify-content:center;gap:4px;width:100%;height:100%;')

      g.append('circle').attr('class', 'status-dot')
        .attr('cx', 20).attr('cy', -20).attr('r', 5)
        .attr('fill', '#6b7280')
        .attr('stroke', 'var(--background)').attr('stroke-width', 2)
    }

    // Create force simulation
    const linkDistance = Math.max(120, Math.min(200, 600 / labels.length))
    const simulation = d3.forceSimulation<SimNode>(simNodes)
      .force('link', d3.forceLink<SimNode, SimLink>(simLinks).id(d => d.id).distance(linkDistance))
      .force('charge', d3.forceManyBody().strength(-500))
      .force('center', d3.forceCenter(VW / 2, VH / 2))
      .force('collision', d3.forceCollide(60))
      .force('x', d3.forceX(VW / 2).strength(0.05))
      .force('y', d3.forceY(VH / 2).strength(0.05))
      .alpha(0.8)
      .alphaDecay(0.02)

    simulation.on('tick', () => {
      const positions = layoutRef.current

      // Update node positions
      for (const node of simNodes) {
        const x = Math.max(60, Math.min(VW - 60, node.x!))
        const y = Math.max(60, Math.min(VH - 80, node.y!))
        node.x = x
        node.y = y
        positions.set(node.id, { x, y })
        svg.select(`.node-group-${node.id}`)
          .attr('transform', `translate(${x},${y})`)
      }

      // Update edge positions
      for (const link of simLinks) {
        const s = link.source as SimNode
        const t = link.target as SimNode
        svg.select(`.edge-${link.id}`)
          .attr('x1', s.x!).attr('y1', s.y!)
          .attr('x2', t.x!).attr('y2', t.y!)
      }
    })

    simulationRef.current = simulation

    return () => { simulation.stop() }
  }, [currentTopo])

  // 2) Update visual properties when state changes
  useEffect(() => {
    const svg = d3.select(svgRef.current)
    if (!svgRef.current || !currentTopo) return

    const labels = currentTopo.split(',')

    for (const label of labels) {
      const liveness = determineLiveness(label, states, nodes)
      const agentState = states.find(s => s.label === label)
      const role = agentState?.local.role ?? 'unknown'
      const color = livenessColor(liveness)
      const rColor = roleHex(role)
      const g = svg.select(`.node-group-${label}`)

      g.select('.outer-ring')
        .transition().duration(600)
        .attr('stroke', liveness === 'online' ? rColor : color)
        .attr('stroke-dasharray', liveness === 'offline' ? '2,6' : 'none')

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

      const roleBadgeClasses = roleColor(role)
      g.select('.role-liveness')
        .html(
          `<span class="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${roleBadgeClasses}">${role}</span>` +
          `<span style="color:${color};font-size:10px;">${liveness}</span>`
        )

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
  }, [states, nodes, currentTopo])

  // 3) Event-driven effects
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
        const color = '#f97316'

        g.select('.state-ring')
          .interrupt()
          .attr('stroke', color)
          .attr('opacity', 1).attr('r', 30).attr('stroke-width', 4)
          .transition().duration(800).ease(d3.easeExpOut)
          .attr('r', 65).attr('opacity', 0).attr('stroke-width', 1)

        g.select('.inner-fill')
          .interrupt()
          .attr('fill', color)
          .transition().duration(150).attr('fill-opacity', 0.6)
          .transition().duration(600).attr('fill-opacity', 0.15)
          .transition().duration(300)
          .attr('fill', livenessColor(determineLiveness(ev.label, statesRef.current, nodesRef.current)))

        const from = positions.get(ev.label)
        if (from) {
          for (const [otherLabel, to] of positions.entries()) {
            if (otherLabel === ev.label) continue
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
        const color = '#f59e0b'

        g.select('.state-ring')
          .interrupt()
          .attr('stroke', color)
          .attr('opacity', 0.8).attr('r', 55).attr('stroke-width', 3)
          .transition().duration(500).ease(d3.easeCubicOut)
          .attr('r', 30).attr('opacity', 0)

        g.select('.inner-fill')
          .interrupt()
          .attr('fill', color)
          .transition().duration(100).attr('fill-opacity', 0.5)
          .transition().duration(500).attr('fill-opacity', 0.15)
          .transition().duration(300)
          .attr('fill', livenessColor(determineLiveness(ev.label, statesRef.current, nodesRef.current)))
      }

    }
  }, [events])

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
