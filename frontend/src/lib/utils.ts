import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function timeSince(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 2000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  return `${Math.floor(diff / 60_000)}m ago`
}

export function truncateId(id: string, maxLen = 16): string {
  if (id.length <= maxLen) return id
  return id.slice(0, 8) + '...' + id.slice(-8)
}

export function roleColor(role: string) {
  switch (role) {
    case 'carrier': return 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30'
    case 'scout': return 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30'
    case 'observer': return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
    case 'relay': return 'bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30'
    default: return 'bg-gray-500/15 text-gray-700 dark:text-gray-400 border-gray-500/30'
  }
}

export function statusBadgeVariant(status: string) {
  if (status === 'ready') return 'default' as const
  if (status === 'stale') return 'destructive' as const
  return 'secondary' as const
}

export function roleHex(role: string) {
  switch (role) {
    case 'carrier': return '#3b82f6'
    case 'scout': return '#f59e0b'
    case 'observer': return '#10b981'
    case 'relay': return '#a855f7'
    default: return '#6b7280'
  }
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
