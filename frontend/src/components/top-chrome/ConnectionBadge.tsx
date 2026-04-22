import { Badge } from '@/components/ui/badge'
import { Wifi, WifiOff } from 'lucide-react'

interface Props {
  connected: boolean
}

export function ConnectionBadge({ connected }: Props) {
  if (connected) {
    return (
      <Badge variant="outline" className="gap-1">
        <Wifi className="h-3 w-3 text-green-500" />
        Live
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1">
      <WifiOff className="h-3 w-3 text-red-500" />
      Disconnected
    </Badge>
  )
}
