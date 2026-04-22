// Wraps the canvas (GameView) with HUD overlays, source-indicator pill, and
// edge hover interactions. For Phase 2 we just render the existing GameView
// inside a full-bleed container so the AppShell has a real middle column.
//
// Phase 5 extracts the HUDs out of GameView, adds the CanvasHudSourceIndicator
// pill, and rewires edge click → select vs hover → quick-toggle.

import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
}

export function CanvasArea({ children }: Props) {
  return (
    <div className="relative h-full w-full overflow-auto">
      {children}
    </div>
  )
}
