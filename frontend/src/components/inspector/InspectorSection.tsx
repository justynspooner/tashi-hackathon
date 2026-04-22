// Unity-style collapsible component section for the inspector. Each
// Peers/Entity/Events block wraps itself in this shell so headers, spacing,
// and collapse behavior stay consistent.

import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  title: string
  icon?: ReactNode
  /** Optional right-aligned badge/indicator rendered in the section header. */
  accessory?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}

export function InspectorSection({
  title,
  icon,
  accessory,
  defaultOpen = true,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-md border bg-background/50">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
          'hover:bg-muted/40 transition-colors rounded-t-md',
          !open && 'rounded-b-md',
        )}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {icon && <span className="text-foreground/70 shrink-0">{icon}</span>}
        <span className="truncate">{title}</span>
        {accessory && <span className="ml-auto shrink-0">{accessory}</span>}
      </button>
      {open && <div className="px-2 pb-2 pt-1 border-t">{children}</div>}
    </div>
  )
}
