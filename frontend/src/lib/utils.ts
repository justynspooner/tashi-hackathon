import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function timeSince(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 5000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  return `${Math.floor(diff / 60_000)}m ago`
}

export function truncateId(id: string, maxLen = 16): string {
  if (id.length <= maxLen) return id
  return id.slice(0, 8) + '...' + id.slice(-8)
}

export function statusBadgeVariant(status: string) {
  if (status === 'ready') return 'default' as const
  if (status === 'stale') return 'destructive' as const
  return 'secondary' as const
}

export function kindBadgeVariant(kind: string) {
  switch (kind) {
    case 'hello': return 'default' as const
    case 'state_update': return 'default' as const
    default: return 'secondary' as const
  }
}

export function kindClass(kind: string) {
  switch (kind) {
    case 'hello': return 'bg-blue-500'
    case 'heartbeat': return 'bg-green-500'
    case 'state_update': return 'bg-amber-500'
    default: return 'bg-gray-500'
  }
}

export function kindIcon(kind: string) {
  switch (kind) {
    case 'hello': return 'H'
    case 'heartbeat': return 'HB'
    case 'state_update': return 'SU'
    default: return '?'
  }
}
