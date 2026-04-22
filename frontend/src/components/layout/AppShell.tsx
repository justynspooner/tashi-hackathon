// CSS-grid viewport shell: top chrome row, then three columns (scene tree,
// canvas, inspector), then a bottom drawer row. Desktop-only per A6 — fixed
// widths on the side panels, no responsive breakpoints.

import type { ReactNode } from 'react'

interface Props {
  topChrome: ReactNode
  leftPanel: ReactNode
  center: ReactNode
  rightPanel: ReactNode
  drawer: ReactNode
}

export function AppShell({ topChrome, leftPanel, center, rightPanel, drawer }: Props) {
  return (
    <div
      className="h-screen w-screen overflow-hidden bg-background text-foreground"
      style={{
        display: 'grid',
        gridTemplateColumns: '260px 1fr 340px',
        gridTemplateRows: '48px 1fr var(--drawer-h, 240px)',
        gridTemplateAreas: `
          "chrome chrome chrome"
          "left   canvas right"
          "drawer drawer drawer"
        `,
        // Transition grid-template-rows only when `--drawer-transition-duration`
        // is set > 0ms. BottomDrawer pulses that variable when the user toggles
        // collapse/expand, and keeps it at 0ms during drag-resize so the drawer
        // follows the cursor without easing.
        transition: 'grid-template-rows var(--drawer-transition-duration, 0ms) ease-out',
      }}
    >
      <div style={{ gridArea: 'chrome' }} className="min-w-0">
        {topChrome}
      </div>
      <aside
        style={{ gridArea: 'left' }}
        className="min-h-0 min-w-0 border-r bg-card overflow-hidden flex flex-col"
      >
        {leftPanel}
      </aside>
      <main
        style={{ gridArea: 'canvas' }}
        className="min-h-0 min-w-0 relative overflow-hidden bg-background"
      >
        {center}
      </main>
      <aside
        style={{ gridArea: 'right' }}
        className="min-h-0 min-w-0 border-l bg-card overflow-hidden flex flex-col"
      >
        {rightPanel}
      </aside>
      <section
        style={{ gridArea: 'drawer' }}
        className="min-h-0 min-w-0 border-t bg-card overflow-hidden flex flex-col"
      >
        {drawer}
      </section>
    </div>
  )
}
