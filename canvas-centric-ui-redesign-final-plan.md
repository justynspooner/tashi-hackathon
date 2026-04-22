# Canvas-Centric UI Redesign — Final Plan

## Context

The current frontend at `/Users/justyn/dev/tashi/hackathon-warm-up/frontend` is a vertically-scrolling dashboard (sticky header → `NodeControl` card row → `GameView` SVG → `ConsensusStalledBanner` → `FinalityChart` → `ProofList`/`EventTimeline` tabs → right-slide `EventLog`). The playing field competes for space with everything else and there is no selection/inspector model tying the canvas to per-node/entity context.

The redesign turns this into a Unity/Figma-style desktop tool: persistent top chrome, three-column body (scene tree / canvas / inspector), and a bottom drawer for temporal/debug views. Selection drives the canvas, the inspector, and the canvas HUD in sync. Both light and dark themes are supported with a user-controlled toggle.

This plan folds the A1–A7 and B1–B8 answers into a concrete, phase-ordered implementation.

---

## Decisions Locked In

| Area | Decision |
|------|----------|
| **A1 Top chrome** | Persistent `TopChrome` houses: title, theme toggle, connection badge, node/entity/phase counts, Swarm Actions popover (B5), Clear Artifacts, Event Log toggle button. No separate bottom status bar. |
| **A2 Canvas HUD source** | HUD state (GameTimer, Scoreboard, FlagHolderBadge, CountdownOverlay, EndedBanner) reads from the **selected node label**, falling back to the **first node** when selection is none/edge. A `CanvasHudSourceIndicator` pill at `top-3 left-3` over the SVG shows `HUD: node-a` (italic/muted when it's the fallback), clickable to re-select. HUDs stay on canvas only — NOT duplicated in the right inspector. |
| **A3 Theme** | Keep light AND dark. `ThemeProvider` wraps `App`, toggles `.dark` on `document.documentElement`, persists to `localStorage('tashi-theme')`, supports `'light' \| 'dark' \| 'system'`. Toggle lives in `TopChrome` as a `DropdownMenu`. Pre-hydration inline script in `index.html` prevents flash. |
| **A4 Scene tree** | Single unified row per node (node+entity are the same element). Flat list pre-game; grouped by team once `Object.keys(snapshots).length > 0`, with "Unassigned" group for nodes without a matching entity. |
| **A5 Inspector (Unity-style)** | Header = node summary (label, bind, running/stopped, start/stop). Body = stacked "components": `Peers`, `Entity` (only if snapshot has an entity for this label), `Events`. Each component collapsible. Entity component holds claim UI pre-claim, runtime state post-claim. |
| **A6** | Desktop-only. Fixed `grid-template-columns: 260px 1fr 340px`, no responsive breakpoints. |
| **A7 Edge actions** | Click edge line → select edge → `EdgeInspector` shows partition controls. Hover near edge → HTML-overlay button at edge midpoint for one-click partition toggle. Invisible 20px-wide SVG hit line widens the hover/click target. |
| **B1–B4** | Extract all named helpers (see "Helper extraction checklist"). Document drag-distance threshold and `NodeGameControls`/`NodeGameRuntime` ports explicitly in Phase 4. |
| **B5 Global Actions Panel** | `Popover` triggered from a "Swarm Actions ▾" button in `TopChrome`. Contents: Add Node, Start All, Stop All, Destroy Swarm, Ready All, Auto-select Game (select). Progress subline: `{running}/{total} running · {ready}/{total} ready`. |
| **B6 Toasts** | Install `sonner`. Mount `<Toaster richColors position="top-right" />` in `App.tsx`. `ConsensusStalledBanner` becomes a fire-once-per-stall toast. Silent `.catch(() => {})` at user-initiated call sites becomes `toast.error(...)`; polling/refetch failures stay silent. |
| **B7 Empty states + SSE** | `EmptyInspector` shows "Select a node to inspect it." SSE gets exponential backoff in `useSSE`: 1s → 2s → 4s → 8s → 16s → 30s (cap), reset on successful `connected` message. |
| **B8 Verification** | Expanded checklist (below) covers both themes, HUDs, claim flow, proximity rules, scoreboard flashes, toasts, backoff. |
| **Event Log home** | Tab inside the bottom drawer (alongside Proofs / Timeline / Finality Chart). Right-slide aside goes away; `eventLogOpen` becomes `drawerTab = 'events'`. |

---

## Target Layout

```
+--------------------------------------------------------------------------+
| TopChrome: [Title] [phase·nodes·entities] [Swarm Actions▾] [Clear] [◐] [•]|
+----------+--------------------------------------------+------------------+
|          | [Pill: HUD: node-a ▾]                       |  Inspector       |
|  Scene   | +--------------------------------------+   |  NodeHeader      |
|  Tree    | |     GameTimer/Scoreboard/etc         |   |  > Peers         |
|  (260)   | |        Canvas (SVG)                  |   |  > Entity        |
|          | |   entities, edges, effects           |   |  > Events        |
|   by     | |                                      |   |                  |
|  team    | +--------------------------------------+   |  (340)           |
|          |  Bottom Drawer (resizable)                 |                  |
|          |  Tabs: Events | Timeline | Proofs | Chart  |                  |
+----------+--------------------------------------------+------------------+
```

CSS grid shell in `AppShell.tsx`:
```css
.app-shell {
  display: grid;
  height: 100vh;
  grid-template-columns: 260px 1fr 340px;
  grid-template-rows: 48px 1fr var(--drawer-h, 240px);
}
```

---

## New File Structure

```
frontend/src/
  App.tsx                              (rewrite: providers + AppShell)
  main.tsx                             (edit: wrap in ThemeProvider)
  index.css                            (edit: add a few tokens, keep :root light, .dark dark)

  state/
    SelectionContext.tsx               (NEW)
    selectors.ts                       (NEW: selectHudSourceLabel, useSelectedNode, useSelectedSnapshot)

  components/
    theme-provider.tsx                 (NEW: localStorage + .dark class toggle)

    top-chrome/
      TopChrome.tsx                    (NEW)
      ModeToggle.tsx                   (NEW: light/dark/system dropdown)
      GlobalActionsPanel.tsx           (NEW: swarm actions popover)
      ConnectionBadge.tsx              (NEW: extracted from App.tsx)

    layout/
      AppShell.tsx                     (NEW: CSS grid shell)
      BottomDrawer.tsx                 (NEW: tabbed drawer, resizable)

    scene-tree/
      SceneTree.tsx                    (NEW: team grouping)
      SceneTreeRow.tsx                 (NEW: unified node+entity row)
      TeamGroupHeader.tsx              (NEW: collapsible team header)

    canvas/
      CanvasArea.tsx                   (NEW: wraps GameCanvas + overlays)
      GameCanvas.tsx                   (REFACTORED from GameView.tsx)
      EntityGlyph.tsx                  (EXTRACTED from GameView.tsx)
      SelectionRing.tsx                (NEW: pulsing ring on selected entity)
      CanvasHudSourceIndicator.tsx     (NEW: the pill)
      EdgeHoverToggle.tsx              (NEW: HTML overlay button on edge hover)
      huds/
        GameTimer.tsx                  (EXTRACTED)
        Scoreboard.tsx                 (EXTRACTED)
        FlagHolderBadge.tsx            (EXTRACTED)
        CountdownOverlay.tsx           (EXTRACTED)
        EndedBanner.tsx                (EXTRACTED)

    inspector/
      InspectorRouter.tsx              (NEW: routes on selection.kind)
      EmptyInspector.tsx               (NEW)
      NodeInspector.tsx                (NEW: Unity-style container)
      EdgeInspector.tsx                (NEW: partition controls)
      components/
        PeersComponent.tsx             (NEW: extracted from NodeCard peer table)
        EntityComponent.tsx            (NEW: NodeGameControls + NodeGameRuntime)
        EventsComponent.tsx            (NEW: NodeEventLog extracted)

    drawer-panels/
      EventLogPanel.tsx                (ADAPTED from EventLog.tsx)
      EventTimelinePanel.tsx           (ADAPTED from EventTimeline.tsx)
      ProofListPanel.tsx               (ADAPTED from ProofList.tsx)
      FinalityChartPanel.tsx           (ADAPTED from FinalityChart.tsx)

    ui/                                (shadcn components — add: dropdown-menu, popover, collapsible, sonner)

  game/
    edgeKey.ts                         (NEW: canonical edge-ordering util, shared)

  hooks/
    useApi.ts                          (edit: add backoff in useSSE, toast user-initiated catches)
    useGame.ts                         (edit: toast on user-initiated failures)
    useSelection.ts                    (NEW: thin wrapper around SelectionContext)
    useErrorToast.ts                   (NEW: toast.error helper)

  lib/
    node-control-helpers.ts            (NEW: extracted constants + helpers)
```

---

## Helper Extraction Checklist (Phase 0)

From `NodeControl.tsx` → `lib/node-control-helpers.ts`:
- `TAG_COLORS` (L44–58), `PHASE_LABELS` / `PHASE_COLORS` (L66–88)
- `shortId` (L60), `shortMessageId`, `formatTs`, `formatMmSs` (L468)
- `entityGlyph` (L90–99) — move to `components/canvas/EntityGlyph.tsx`
- `countClaims` (L104–119), `extractProximityRules` (L402–450)
- `tallyPicks` (L202–219), `proximityKey` (L354–357) — must match `rules.rs::proximity_key`
- `closestEntityOfType` (L368–382)
- `HIDDEN_PROPERTY_KEYS` (L478), `PER_NODE_EVENT_CAP = 100` (L1216)
- `visibleScoreTeams` helper (used for Scoreboard)

From `GameView.tsx`:
- `EntityGlyph` component
- Canonical edge-key logic → `game/edgeKey.ts`: `export const edgeKey = (a: string, b: string) => [a, b].sort().join('|')`

Verify app still runs unchanged after extraction — this phase is strictly non-breaking.

---

## Selection Context Shape

```ts
// state/SelectionContext.tsx
type Selection =
  | { kind: 'none' }
  | { kind: 'node'; label: string }
  | { kind: 'edge'; a: string; b: string } // a < b canonical from edgeKey()

// Provider must auto-clear selection when label disappears from `nodes`
useEffect(() => {
  if (selection.kind === 'node' && !nodes.find(n => n.label === selection.label)) {
    setSelection({ kind: 'none' })
  }
  if (selection.kind === 'edge' && (!nodes.find(n => n.label === selection.a) || !nodes.find(n => n.label === selection.b))) {
    setSelection({ kind: 'none' })
  }
}, [nodes, selection])
```

`selectors.ts`:
- `selectHudSourceLabel(selection, nodes): string | null` — returns selection.label if kind='node', else nodes[0]?.label ?? null
- `useSelectedNode()`, `useSelectedSnapshot()`, `useSelectedEntity()` — read-through by label

---

## D3 Drag + Click Disambiguation (GameCanvas.tsx)

Current drag at `GameView.tsx:217–308` reattaches on entity-set changes and reads `onMove` through a ref. Add click detection:

```ts
// in drag.on('start', (event) => {
  ref.current.dragStart = { x: event.sourceEvent.clientX, y: event.sourceEvent.clientY }
  ref.current.wasDrag = false
}
// in drag.on('drag', (event) => {
  const dx = event.sourceEvent.clientX - ref.current.dragStart.x
  const dy = event.sourceEvent.clientY - ref.current.dragStart.y
  if (Math.hypot(dx, dy) >= 3) ref.current.wasDrag = true
  if (ref.current.wasDrag) { /* existing drag-override update */ }
}
// in drag.on('end', (event) => {
  if (!ref.current.wasDrag) selectNode(label)  // click
  else onMoveRef.current(label, finalX, finalY) // drag
}
```

Threshold `3px` in screen coordinates, NOT field metres (zoom-invariant).

Background click on SVG → `deselect()`. Edge click via invisible-20px hit line → `selectEdge(edgeKey(a,b))`.

---

## Edge Hover Button (A7)

Two stacked SVG elements per edge:
1. Visible `<line>` (2px stroke, dashed if partitioned, `pointer-events: none`)
2. Invisible hit `<line>` (`stroke="transparent"`, `stroke-width="20"`, cursor pointer, onClick → select, onMouseEnter → setHoveredEdge)

HTML overlay `EdgeHoverToggle` absolutely positioned at edge midpoint (compute from viewBox coords → screen px), `z-30`, with shadcn `Button` variant="outline" size="sm". 150ms timeout on mouseleave to avoid flicker crossing from line → button. Click calls `onTogglePartition(a, b)` with `e.stopPropagation()`.

---

## Theme Provider (A3)

`components/theme-provider.tsx`:
```tsx
type Theme = 'light' | 'dark' | 'system'
// on mount: read localStorage('tashi-theme'), default 'system'
// resolve 'system' via window.matchMedia('(prefers-color-scheme: dark)')
// apply: root.classList.remove('light','dark'); root.classList.add(resolved)
// listen for system changes with matchMedia.addEventListener('change')
```

Pre-hydration script in `index.html` head (inline, runs before React):
```html
<script>
  (function() {
    const t = localStorage.getItem('tashi-theme') || 'system'
    const isDark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.add(isDark ? 'dark' : 'light')
  })()
</script>
```

`index.css` stays as-is: `:root` already defines light tokens (L51–84), `.dark` defines dark (L86–118). Tailwind v4's `@custom-variant dark (&:is(.dark *))` already keys off the class — no config change needed.

`ModeToggle.tsx` uses shadcn `DropdownMenu` with three items: Light, Dark, System. Uses `lucide-react` `Sun`/`Moon`/`Monitor` icons.

---

## SSE Backoff (useApi.ts useSSE)

```ts
const attemptRef = useRef(0)
const reconnectTimer = useRef<number | null>(null)

const connect = () => {
  const source = new EventSource('/api/events')
  source.onmessage = (e) => {
    const data = JSON.parse(e.data)
    if (data.type === 'connected') {
      attemptRef.current = 0
      setConnected(true)
      // existing handlers...
    }
  }
  source.onerror = () => {
    setConnected(false)
    source.close()
    const delay = Math.min(30_000, 1000 * 2 ** attemptRef.current)
    attemptRef.current++
    reconnectTimer.current = window.setTimeout(connect, delay)
  }
  sourceRef.current = source
}
// on unmount: clearTimeout, source.close()
```

Toast once on first disconnect (after initial connect succeeded), once on reconnect. Do NOT toast during the initial connect attempt or on each retry.

---

## Phased Implementation

Each phase must leave the app in a runnable state. Top chrome lands before layout refactor so `Clear Artifacts` / `Event Log` / connection badge always have a home.

### Phase 0 — Extract & Install (non-breaking)
- Install shadcn: `npx shadcn@latest add dropdown-menu popover collapsible sonner`
- `bun add sonner` (or equivalent)
- Extract helpers to `lib/node-control-helpers.ts` per checklist above
- Extract `EntityGlyph` to `components/canvas/EntityGlyph.tsx`
- Create `game/edgeKey.ts`
- Confirm app still runs identically

### Phase 1 — Foundation: Theme + TopChrome + Toaster + Selection + SSE backoff
- `components/theme-provider.tsx` + pre-hydration script in `index.html`
- `main.tsx`: wrap in `<ThemeProvider>`
- `components/top-chrome/TopChrome.tsx` + `ModeToggle.tsx` + `ConnectionBadge.tsx` + `GlobalActionsPanel.tsx` (popover)
- Mount `<Toaster richColors position="top-right" />` in `App.tsx`
- `hooks/useErrorToast.ts`
- `state/SelectionContext.tsx` + `state/selectors.ts` + `hooks/useSelection.ts`
- Add exponential backoff to `useSSE` in `hooks/useApi.ts`
- Old main body untouched — `TopChrome` replaces the sticky header, everything below stays wired. Verify: `Clear Artifacts` still works, theme toggle switches tokens, popover opens.

### Phase 2 — Three-column shell
- `components/layout/AppShell.tsx` with CSS grid
- `CanvasArea` wrapper in center cell (holds current `GameView`)
- Empty `SceneTree` placeholder in left cell
- Temporary `InspectorRouter` in right cell renders the existing `NodeControl` card row as a "legacy" panel so behavior is preserved
- `BottomDrawer` in bottom row with tabs stubbed (EventTimeline + ProofList + FinalityChart moved here; EventLog stays as aside temporarily)
- Verify: canvas still drags, partition still works, no dead UI.

### Phase 3 — Scene Tree (left panel)
- `scene-tree/SceneTree.tsx`: flat pre-game, team-grouped in-game (`snapshot.entities[*]` → team). "Unassigned" group for no-entity nodes.
- `SceneTreeRow.tsx`: `[team-bar 3px][status-dot][label][entity-badge?][phase-badge?]`
- Wire row click → `selectNode(label)`
- `SelectionRing.tsx` on canvas (pulsing ring around selected entity)
- Canvas entity click uses drag-distance threshold → `selectNode(label)`
- Background canvas click → `deselect()`

### Phase 4 — Inspector (right panel)
Port in sub-steps so issues bisect:
- **4a** `InspectorRouter.tsx` switches on `selection.kind`
- **4b** `EmptyInspector.tsx` with "Select a node to inspect it." hint
- **4c** `NodeInspector.tsx` with header + stacked components
- **4d** `PeersComponent.tsx` extracted from `NodeCard` peer table (L1093–1132)
- **4e** `EntityComponent.tsx` — port of `NodeGameControls` (L799–998: type dropdown from `activeGame.entity_types`, team dropdown when `team === "per_team"`, slot exhaustion via `countClaims`, phase-gated claim, post-claim + Ready Up) AND `NodeGameRuntime` (L480–795: timer, score pills with flash-on-increment, property rows, proximity progress bars deduped by `(peerEntityType, maxM, minS)`, closest-entity watcher, 4Hz/250ms setInterval ticker)
- **4f** `EventsComponent.tsx` — per-node event log (cap 100 via `PER_NODE_EVENT_CAP`)
- Remove the legacy `NodeControl` panel once inspector has parity
- Per-node propose/vote (`NodeGameSelect`) goes inside `EntityComponent` or its own `GameSelectComponent` — confirm during port

### Phase 5 — Canvas HUD source + Edge interactions
- Extract canvas HUDs to `components/canvas/huds/*` (read label via `selectHudSourceLabel`)
- `CanvasHudSourceIndicator.tsx` pill at `top-3 left-3` — shows `HUD: <label>`, italic+muted when fallback (selection.kind !== 'node'), clickable → scene tree focus
- Edge-click: invisible 20px hit line on SVG, click → `selectEdge(edgeKey(a,b))`. Remove immediate partition toggle on click.
- `EdgeHoverToggle.tsx` HTML overlay button at edge midpoint, 150ms mouseleave delay
- `EdgeInspector.tsx` with partition/LOS/distance info + Toggle Partition button
- `ConsensusStalledBanner.tsx` → replace inline render with `toast.warning(...)` fired once per stall transition (track last-fired state in a ref)

### Phase 6 — Global Actions Panel wiring (B5)
- Fill in `GlobalActionsPanel.tsx` popover:
  - Swarm: Add Node, Start All, Stop All, Destroy Swarm (currently at `NodeControl.tsx:1427–1479`)
  - Game: Ready All (L1513–1549 including progress), Auto-select Game (select populated from `games`)
  - Progress subline derived from `nodes` + snapshots: `{running}/{total} running · {ready}/{total} ready`
- Game-selection tally (L1481–1507) → render inside popover when `selectionPhase !== 'none'`

### Phase 7 — Bottom Drawer finalization
- Move `EventLog` into drawer as tab (drop the right-slide aside)
- Resize handle on drawer top edge: drag to adjust `--drawer-h` CSS var (clamp 120px–50vh)
- Remove `eventLogOpen` state; `TopChrome`'s Event Log button now sets drawer tab to `'events'` and opens drawer if collapsed
- Each panel (`EventLogPanel`, `EventTimelinePanel`, `ProofListPanel`, `FinalityChartPanel`) drops its outer `Card` wrapper, fills its tab height

### Phase 8 — Polish + verification
- Replace silent `.catch(() => {})` at user-initiated call sites in `useApi.ts`/`useGame.ts` with `errorToast(...)` from `useErrorToast.ts`. Polling/refetch catches remain silent.
- Panel collapse/expand transitions (grid-template-* animations)
- `Escape` deselects (scope-limited keyboard shortcut; rest deferred per C2)
- Remove dead code (old `EventLog` aside, `ConsensusStalledBanner` inline render)
- Run verification checklist

---

## Critical Files to Modify

| File | Action |
|------|--------|
| `frontend/src/App.tsx` | Rewrite: providers + `AppShell` |
| `frontend/src/main.tsx` | Wrap in `<ThemeProvider>` |
| `frontend/index.html` | Add pre-hydration theme script |
| `frontend/src/index.css` | Leave `:root` and `.dark` blocks — minor token additions only |
| `frontend/src/components/GameView.tsx` | Refactor → `canvas/GameCanvas.tsx`, extract HUDs |
| `frontend/src/components/NodeControl.tsx` | Decompose: globals → `GlobalActionsPanel`, per-node internals → inspector components |
| `frontend/src/components/ConsensusStalledBanner.tsx` | Delete (replaced by toast) |
| `frontend/src/components/EventLog.tsx` | Adapt → `drawer-panels/EventLogPanel.tsx` |
| `frontend/src/components/EventTimeline.tsx` | Adapt → drawer panel |
| `frontend/src/components/ProofList.tsx` | Adapt → drawer panel |
| `frontend/src/components/FinalityChart.tsx` | Adapt → drawer panel |
| `frontend/src/hooks/useApi.ts` | `useSSE` backoff + toast user-initiated catches |
| `frontend/src/hooks/useGame.ts` | Toast user-initiated catches |
| `frontend/package.json` | Add `sonner`; shadcn add `dropdown-menu popover collapsible sonner` |

---

## Verification

Run `bun dev` and confirm:

**Layout**
1. Top chrome shows title, theme toggle, Swarm Actions button, Clear Artifacts, Event Log toggle, connection badge, node/entity/phase counts
2. Three-column grid — 260px left, flexible center, 340px right — no overflow on typical desktop resolution (1440px+)
3. Bottom drawer collapses/resizes (drag handle, clamp 120–50vh)

**Theme (A3 + B8)**
4. Light mode renders correctly (shadcn `:root` tokens)
5. Dark mode renders correctly (`.dark` tokens)
6. System mode follows OS preference and responds to OS toggle live
7. Theme persists across reload (no light-mode flash on dark-preferred users)

**Selection + Canvas HUD (A2)**
8. Clicking an entity on canvas selects the node (drag threshold 3px) — scene tree row highlights, inspector renders
9. Clicking canvas background deselects
10. Scene tree row click selects the same node on canvas
11. `CanvasHudSourceIndicator` pill shows `HUD: <selected>`; italic+muted when showing fallback (first node)
12. GameTimer, Scoreboard, FlagHolderBadge, CountdownOverlay, EndedBanner still update live during play — reading from HUD-source label
13. HUDs are NOT duplicated in the right inspector

**Scene Tree (A4/A5)**
14. Pre-game: flat list of all nodes, status dots reflect running/stopped
15. In-game: grouped by team with collapsible team headers; nodes without a claimed entity appear under "Unassigned"
16. Row shows `[team-bar][status-dot][label][entity-badge when claimed][phase-badge]`

**Inspector (A5)**
17. Empty state shows "Select a node to inspect it." hint
18. Node selection → header (label, bind, running/stopped, start/stop), Peers component, Entity component (when snapshot has entity for this label), Events component
19. Entity component pre-claim: type dropdown from `activeGame.entity_types`, team dropdown when `team === "per_team"`, slot exhaustion respected, claim button phase-gated
20. Entity component post-claim: Ready Up button (individual), scoreboard pills flash on score increment, proximity progress bars render deduped by `(peerEntityType, maxM, minS)`, 4Hz (250ms) ticker smooth
21. Events component shows per-node event log capped at 100

**Edge interactions (A7)**
22. Clicking an edge line selects it — `EdgeInspector` shows partition state, distance, LOS; Toggle Partition button works
23. Hovering near an edge (invisible 20px hit area) shows a floating Toggle button at midpoint; click partitions/unpartitions without selecting the edge
24. Crossing cursor from line → button does not flicker (150ms mouseleave delay)

**Global Actions Panel (B5)**
25. "Swarm Actions ▾" popover opens from top chrome
26. Add Node / Start All / Stop All / Destroy Swarm all work
27. Ready All issues ready-up to all nodes
28. Auto-select Game propagates the selected game to all nodes' propose/vote

**Toasts + SSE (B6/B7)**
29. Consensus stall triggers a toast once (not every render)
30. User-initiated API failure (e.g. Stop a node that's already stopped) surfaces `toast.error(...)`
31. Polling failures do NOT spam toasts
32. SSE disconnect: reconnect attempts follow 1→2→4→8→16→30s cap; one toast on first disconnect, one on reconnect
33. Reload while disconnected → backoff timer resets (no stale state)

**Functional regression (B8)**
34. Drag entity still works (screen-space distance ≥3px → drag; <3px → click/select)
35. D3 zoom/pan still works on canvas
36. Partition toggling changes edge render (dashed/solid) and consensus behavior
37. Countdown 3-2-1-GO fires on `counting_down → playing`
38. EndedBanner shows winner + reason on `ended`
39. Clear Artifacts still clears events + game state + `/api/clear-artifacts`
40. Propose → vote → claim → ready → play → end lifecycle completes end-to-end
41. Event Log (now a drawer tab) still renders, clears, and downloads
42. Game tally during proposing/voting renders inside Swarm Actions popover
43. Ready-up progress shows progress (e.g. `3/5`) during `ready_up` stage

**Cleanup**
44. No `ConsensusStalledBanner` inline render anywhere
45. No right-slide `EventLog` aside anywhere
46. No console errors on load, theme toggle, or connect/disconnect cycles
