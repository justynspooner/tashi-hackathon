// Default inspector state — shown when nothing is selected. Per B7 we just
// prompt the user to select a node; no game overview or stats, so the hint
// stays uncluttered.

import { PanelHeader } from '@/components/layout/PanelHeader'
import { MousePointerClick } from 'lucide-react'

export function EmptyInspector() {
  return (
    <>
      <PanelHeader title="Inspector" />
      <div className="flex-1 min-h-0 flex items-center justify-center p-6 text-center">
        <div className="space-y-2 max-w-[220px]">
          <div className="mx-auto h-8 w-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
            <MousePointerClick className="h-4 w-4" />
          </div>
          <div className="text-sm font-medium">Nothing selected</div>
          <div className="text-xs text-muted-foreground">
            Select a node from the scene tree or canvas to inspect it.
          </div>
        </div>
      </div>
    </>
  )
}
