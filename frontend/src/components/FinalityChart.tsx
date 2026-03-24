import { useMemo } from 'react'
import { Bar, BarChart, XAxis, YAxis, Tooltip, Cell } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { Timer } from 'lucide-react'
import { kindClass } from '@/lib/utils'
import type { ProofOfCoordination } from '@/types'

const chartConfig = {
  finality: {
    label: 'Finality (ms)',
    color: 'var(--color-chart-1)',
  },
} satisfies ChartConfig

function barColor(kind: string) {
  const cls = kindClass(kind)
  switch (cls) {
    case 'bg-blue-500': return '#3b82f6'
    case 'bg-green-500': return '#22c55e'
    case 'bg-amber-500': return '#f59e0b'
    case 'bg-purple-500': return '#a855f7'
    default: return '#6b7280'
  }
}

interface DataPoint {
  label: string
  finality: number
  kind: string
  agent: string
}

export function FinalityChart({ proofs }: { proofs: ProofOfCoordination[] }) {
  const data = useMemo(() => {
    const points: DataPoint[] = []
    // Sort proofs by consensus time ascending
    const sorted = [...proofs].sort((a, b) => a.consensus_at - b.consensus_at)
    for (const proof of sorted) {
      const kind = proof.transactions[0]?.kind ?? 'unknown'
      points.push({
        label: `${proof.agent.replace('agent-', '')}:${kind.replace('state_', '')}`,
        finality: proof.finality_ms,
        kind,
        agent: proof.agent,
      })
    }
    return points
  }, [proofs])

  if (data.length === 0) return null

  const avg = Math.round(data.reduce((s, d) => s + d.finality, 0) / data.length)
  const min = Math.min(...data.map(d => d.finality))
  const max = Math.max(...data.map(d => d.finality))

  return (
    <Card>
      <CardHeader className="py-2 px-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Timer className="h-4 w-4" />
          Consensus Finality
          <span className="text-xs font-normal text-muted-foreground ml-auto">
            avg {avg}ms &middot; min {min}ms &middot; max {max}ms
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0">
        <ChartContainer config={chartConfig} className="h-[120px] w-full">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10 }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10 }}
              width={40}
              tickFormatter={(v) => `${v}ms`}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload as DataPoint
                return (
                  <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-sm">
                    <div className="font-medium">{d.agent} &middot; {d.kind}</div>
                    <div className="text-muted-foreground">{d.finality}ms finality</div>
                  </div>
                )
              }}
            />
            <Bar dataKey="finality" radius={[3, 3, 0, 0]}>
              {data.map((d, i) => (
                <Cell key={i} fill={barColor(d.kind)} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
