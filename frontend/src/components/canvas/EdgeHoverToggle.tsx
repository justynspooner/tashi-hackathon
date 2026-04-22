// Hover-to-toggle quick action for edges (A7).
//
// Lives inside GameView as an HTML overlay (not SVG) so the button can use
// the normal shadcn styling. The overlay positions itself at the midpoint
// of the hovered edge in pixel coords (converted from the SVG viewBox + the
// current zoom transform).
//
// Behaviour:
//   - When the user hovers an edge's invisible hit line, GameView reports
//     the hovered edge to this component via props.
//   - A 150ms setTimeout on mouseleave keeps the button mounted so the
//     cursor can cross the small gap between the line's hit area and the
//     button without losing the target. (The parent clears `hovered`
//     immediately on line mouseleave, so without this grace period the
//     button would unmount before the cursor reached it.)
//   - Clicking the button calls `onToggle(a, b)` and swallows the event so
//     the click doesn't also select the edge.

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Link2, Unlink2 } from 'lucide-react'
import { runWithToast } from '@/hooks/useErrorToast'

interface Props {
  /** Edge the user is currently hovering, or null when not hovering. */
  hovered: { a: string; b: string; mid: { x: number; y: number } } | null
  /** Is the hovered edge currently partitioned? Drives the button icon/label. */
  partitioned: boolean
  /** Toggle partition for the given pair. */
  onToggle: (a: string, b: string) => Promise<void> | void
  /** Callback called with null after the hide-delay elapses — clears hover. */
  onHoverEnd?: () => void
}

const HIDE_DELAY_MS = 150

export function EdgeHoverToggle({ hovered, partitioned, onToggle, onHoverEnd }: Props) {
  // Track a "keep open" state so the hide timer doesn't fire while the
  // cursor is over the button itself.
  const [overButton, setOverButton] = useState(false)
  const hideTimerRef = useRef<number | null>(null)
  const [busy, setBusy] = useState(false)
  // `displayed` is what we actually render. It mirrors `hovered` while the
  // user is hovering the edge, and lingers through the hide-delay window so
  // the button stays mounted while the cursor crosses from the SVG line to
  // the HTML button. Without this, `if (!hovered) return null` removes the
  // button from the DOM the moment the cursor leaves the line, and the
  // wrapper's `onMouseEnter` never fires — making the button unclickable.
  const [displayed, setDisplayed] = useState(hovered)

  useEffect(() => {
    // Cursor is back on the line (or still over the button) — keep open
    // and cancel any pending hide.
    if (hovered || overButton) {
      if (hovered) setDisplayed(hovered)
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
      return
    }
    // Hover cleared and cursor is not over the button → arm the hide timer.
    // We delay clearing `displayed` (and notifying the parent) so the button
    // stays visible across the brief gap between the line and the button.
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      setDisplayed(null)
      onHoverEnd?.()
    }, HIDE_DELAY_MS)
    return () => {
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [hovered, overButton, onHoverEnd])

  if (!displayed) return null

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (!displayed) return
    setBusy(true)
    try {
      await runWithToast(
        partitioned
          ? `Heal partition ${displayed.a} ↔ ${displayed.b}`
          : `Partition ${displayed.a} ↔ ${displayed.b}`,
        async () => {
          await onToggle(displayed.a, displayed.b)
        },
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="absolute z-30 pointer-events-auto -translate-x-1/2 -translate-y-1/2"
      style={{ left: displayed.mid.x, top: displayed.mid.y }}
      onMouseEnter={() => setOverButton(true)}
      onMouseLeave={() => setOverButton(false)}
    >
      <Button
        size="sm"
        variant={partitioned ? 'default' : 'destructive'}
        className="h-6 px-2 text-[10px] shadow-md gap-1"
        disabled={busy}
        onClick={handleClick}
        title={partitioned ? 'Heal this partition' : 'Partition this edge'}
      >
        {partitioned ? (
          <>
            <Link2 className="h-3 w-3" />
            {busy ? 'Healing…' : 'Heal'}
          </>
        ) : (
          <>
            <Unlink2 className="h-3 w-3" />
            {busy ? 'Cutting…' : 'Cut'}
          </>
        )}
      </Button>
    </div>
  )
}
