import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Timer } from 'lucide-react'
import type { ProofOfCoordination } from '@/types'

const chartConfig = {
  finality: {
    label: 'Finality (ms)',
    color: 'var(--chart-1)',
  },
} satisfies ChartConfig

interface DataPoint {
  label: string
  finality: number
  kind: string
  agent: string
}

export function FinalityChart({ proofs }: { proofs: ProofOfCoordination[] }) {
  const data = useMemo(() => {
    const points: DataPoint[] = []
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
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
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
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  formatter={(_value, _name, item) => {
                    const d = item.payload as DataPoint
                    return (
                      <div className="text-xs">
                        <div className="font-medium">{d.agent} &middot; {d.kind}</div>
                        <div className="text-muted-foreground">{d.finality}ms finality</div>
                      </div>
                    )
                  }}
                />
              }
            />
            <defs>
              <linearGradient id="fillFinality" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-finality)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="var(--color-finality)" stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <Area
              dataKey="finality"
              type="linear"
              fill="url(#fillFinality)"
              fillOpacity={0.4}
              stroke="var(--color-finality)"
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
