// Tabbed, resizable bottom drawer holding Proofs / Timeline / Finality Chart /
// Event Log panels. The overall shell height is controlled via the
// `--drawer-h` CSS variable on the app-shell root; this component exposes a
// drag handle that tweaks that variable between 120px and 50vh.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type DrawerTab = 'events' | 'timeline' | 'proofs' | 'chart'

interface Props {
  tab: DrawerTab
  onTabChange: (tab: DrawerTab) => void
  eventCount: number
  proofCount: number
  events: ReactNode
  timeline: ReactNode
  proofs: ReactNode
  chart: ReactNode
  collapsed: boolean
  onToggleCollapsed: () => void
}

const MIN_H = 120
const COLLAPSED_H = 36

export function BottomDrawer({
  tab,
  onTabChange,
  eventCount,
  proofCount,
  events,
  timeline,
  proofs,
  chart,
  collapsed,
  onToggleCollapsed,
}: Props) {
  // Drawer height is driven by the `--drawer-h` CSS var on `<body>` so the
  // grid layout in AppShell can respond to it via
  // `grid-template-rows: 48px 1fr var(--drawer-h, 240px)`. When collapsed we
  // pin to `COLLAPSED_H` so the tab strip is still visible.
  //
  // Animation: AppShell has `transition: grid-template-rows` keyed on the
  // `--drawer-transition-duration` CSS var. We pulse that var to 200ms when
  // the collapsed state toggles and pin it to 0ms during drag-resize, so the
  // drawer animates smoothly on toggle but tracks the cursor 1:1 on drag.
  const [dragging, setDragging] = useState(false)
  const dragStartYRef = useRef(0)
  const startHRef = useRef(240)
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setH = useCallback((h: number) => {
    document.body.style.setProperty('--drawer-h', `${h}px`)
  }, [])

  const setTransitionDuration = useCallback((ms: number) => {
    document.body.style.setProperty('--drawer-transition-duration', `${ms}ms`)
  }, [])

  // Pulse the transition on for the collapse/expand toggle, then reset so
  // subsequent drag-resizes stay instant.
  useEffect(() => {
    setTransitionDuration(200)
    if (collapsed) {
      setH(COLLAPSED_H)
    } else {
      // Restore previous height, or a sensible default if no prior drag.
      const cur = getComputedStyle(document.body).getPropertyValue('--drawer-h').trim()
      if (!cur || cur === `${COLLAPSED_H}px`) setH(240)
    }
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current)
    transitionTimerRef.current = setTimeout(() => setTransitionDuration(0), 220)
    return () => {
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current)
    }
  }, [collapsed, setH, setTransitionDuration])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const dy = dragStartYRef.current - e.clientY
      const next = Math.max(MIN_H, Math.min(window.innerHeight * 0.5, startHRef.current + dy))
      setH(next)
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'row-resize'
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
  }, [dragging, setH])

  const handleDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
    if (collapsed) return
    // Drag-resize must be 1:1 — kill any in-flight transition pulse.
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current)
      transitionTimerRef.current = null
    }
    setTransitionDuration(0)
    const cur = parseFloat(
      getComputedStyle(document.body).getPropertyValue('--drawer-h').trim() || '240'
    )
    startHRef.current = Number.isFinite(cur) ? cur : 240
    dragStartYRef.current = e.clientY
    setDragging(true)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Resize handle (only interactive when not collapsed). */}
      {!collapsed && (
        <div
          onMouseDown={handleDragStart}
          className="h-1 shrink-0 cursor-row-resize hover:bg-primary/40 transition-colors"
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize drawer"
        />
      )}

      <Tabs
        value={tab}
        onValueChange={v => onTabChange(v as DrawerTab)}
        className="flex flex-col min-h-0 flex-1"
      >
        <div className="shrink-0 border-b flex items-center gap-2 px-3 py-1.5">
          <TabsList className="h-7">
            <TabsTrigger value="events" className="text-[11px] gap-1 h-6 px-2">
              Events
              {eventCount > 0 && (
                <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                  {eventCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="timeline" className="text-[11px] h-6 px-2">
              Timeline
            </TabsTrigger>
            <TabsTrigger value="proofs" className="text-[11px] gap-1 h-6 px-2">
              Proofs
              {proofCount > 0 && (
                <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                  {proofCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="chart" className="text-[11px] h-6 px-2">
              Finality Chart
            </TabsTrigger>
          </TabsList>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 ml-auto"
            onClick={onToggleCollapsed}
            title={collapsed ? 'Expand drawer' : 'Collapse drawer'}
          >
            {collapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
        </div>

        {!collapsed && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <TabsContent value="events" className="h-full overflow-hidden m-0">
              {events}
            </TabsContent>
            <TabsContent value="timeline" className="h-full overflow-auto m-0 p-3">
              {timeline}
            </TabsContent>
            <TabsContent value="proofs" className="h-full overflow-auto m-0 p-3">
              {proofs}
            </TabsContent>
            <TabsContent value="chart" className="h-full overflow-auto m-0 p-3">
              {chart}
            </TabsContent>
          </div>
        )}
      </Tabs>
    </div>
  )
}
