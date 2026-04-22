// Reusable header strip for the side panels. Keeps typography and spacing
// consistent across SceneTree, Inspector, etc.

import type { ReactNode } from 'react'

interface Props {
  title: string
  subtitle?: string
  children?: ReactNode
}

export function PanelHeader({ title, subtitle, children }: Props) {
  return (
    <div className="shrink-0 border-b px-3 py-2 flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
          {title}
        </div>
        {subtitle && (
          <div className="text-[10px] text-muted-foreground truncate">{subtitle}</div>
        )}
      </div>
      {children}
    </div>
  )
}
