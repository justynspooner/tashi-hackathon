# UI Redesign: Canvas-Centric Design Tool Layout

## Context

The current UI is a vertically-scrolling webpage layout with stacked full-width components (NodeControl, GameView, FinalityChart, Tabs, etc.). This redesign transforms it into a **canvas-centric desktop application** inspired by Figma, Unity, and Linear. The playing field becomes the focal point, filling the viewport, with fixed docked panels providing contextual information based on what's selected on the canvas. Dark mode with purple/violet accents gives it a professional, modern design-tool feel.

---

## Layout Architecture

```
+------------------+----------------------------------+-------------------+
|                  |                                  |                   |
|   LEFT PANEL     |          CANVAS                  |   RIGHT PANEL     |
|   (Hierarchy)    |      (Playing Field)             |   (Inspector)     |
|   ~260px         |        fills space               |   ~320px          |
|                  |                                  |                   |
|   - Scene tree   |   [Floating Toolbar]             |   Context-aware:  |
|   - Nodes list   |   (centered, bottom)             |   - Entity props  |
|   - Entity tree  |                                  |   - Node details  |
|                  |                                  |   - Edge info     |
|                  |                                  |                   |
+------------------+----------------------------------+-------------------+
|                  BOTTOM DRAWER (collapsible, ~240px)                    |
|   Tabs: [Event Log] [Timeline] [Proofs] [Finality Chart]              |
+------------------------------------------------------------------------+
|  STATUS BAR: Connected | Game Phase | Nodes: 5 | Entities: 8          |
+------------------------------------------------------------------------+
```

All panels are collapsible. Canvas resizes to fill available space.

---

## New File Structure

```
frontend/src/
  App.tsx                           (rewrite: providers + AppShell)
  index.css                         (rewrite: dark-only, purple accent)
  main.tsx                          (unchanged)

  context/
    SelectionContext.tsx             (NEW)
    PanelContext.tsx                 (NEW)

  hooks/
    useApi.ts                       (unchanged)
    useGame.ts                      (unchanged)
    useSelection.ts                 (NEW: wraps SelectionContext)
    usePanelLayout.ts               (NEW: wraps PanelContext)

  layout/
    AppShell.tsx                     (NEW: CSS Grid viewport shell)
    LeftPanel.tsx                    (NEW: hierarchy panel chrome)
    RightPanel.tsx                   (NEW: inspector panel chrome)
    BottomDrawer.tsx                 (NEW: tabbed collapsible drawer)
    FloatingToolbar.tsx              (NEW: game actions bar)
    StatusBar.tsx                    (NEW: connection/phase strip)
    PanelHeader.tsx                  (NEW: reusable header with collapse)

  components/
    canvas/
      GameCanvas.tsx                (REFACTORED from GameView.tsx)
      EntityGlyph.tsx               (EXTRACTED from GameView.tsx)
      SelectionRing.tsx             (NEW: highlight for selected items)

    hierarchy/
      SceneTree.tsx                 (NEW: tree view builder)
      NodeTreeItem.tsx              (NEW)
      EntityTreeItem.tsx            (NEW)

    inspector/
      InspectorRouter.tsx           (NEW: renders based on selection)
      EmptyInspector.tsx            (NEW: overview when nothing selected)
      EntityInspector.tsx           (NEW: from NodeGameRuntime/Controls)
      NodeInspector.tsx             (NEW: from NodeCard internals)
      EdgeInspector.tsx             (NEW: connection + partition toggle)

    toolbar/
      SwarmControls.tsx             (EXTRACTED from NodeControl.tsx)
      GamePhaseControls.tsx         (EXTRACTED from NodeControl.tsx)

    drawer/
      EventLogPanel.tsx             (ADAPTED from EventLog.tsx)
      EventTimelinePanel.tsx        (ADAPTED from EventTimeline.tsx)
      ProofListPanel.tsx            (ADAPTED from ProofList.tsx)
      FinalityChartPanel.tsx        (ADAPTED from FinalityChart.tsx)

  lib/
    utils.ts                        (unchanged)
    node-control-helpers.ts         (NEW: extracted constants/helpers)

  game/                             (unchanged)
```

---

## Implementation Phases

### Phase 0: Extract & Prepare (non-breaking)
1. Extract helpers from `NodeControl.tsx` into `lib/node-control-helpers.ts`:
   - `TAG_COLORS`, `PHASE_LABELS`, `PHASE_COLORS`, `shortId`, `shortMessageId`, `formatMmSs`, `formatTs`, `entityGlyph`, `countClaims`, `extractProximityRules`, `tallyPicks`
2. Extract `EntityGlyph` from `GameView.tsx` into `components/canvas/EntityGlyph.tsx`
3. Verify app works unchanged after extractions

### Phase 1: Foundation
1. Create `context/SelectionContext.tsx`:
   - Selection kinds: `entity | node | edge | none`
   - Actions: `SELECT_ENTITY`, `SELECT_NODE`, `SELECT_EDGE`, `DESELECT`
   - `useSelection()` hook exposes `{ selection, selectEntity, selectNode, selectEdge, deselect }`
2. Create `context/PanelContext.tsx`:
   - State: `{ leftOpen, rightOpen, bottomOpen, bottomHeight }`
   - Actions: `TOGGLE_LEFT`, `TOGGLE_RIGHT`, `TOGGLE_BOTTOM`, `SET_BOTTOM_HEIGHT`
3. Rewrite `index.css` with dark-only purple theme (see Theme section below)
4. Add `class="dark"` to `<html>` in `index.html`
5. Create `layout/AppShell.tsx` with CSS Grid layout

### Phase 2: Canvas Migration
1. Create `components/canvas/GameCanvas.tsx` from `GameView.tsx`:
   - Remove `<Card>` wrapper; SVG fills container with `width="100%" height="100%"`
   - `viewBox` stays as-is (coordinate system unchanged)
   - Add selection handlers: click entity -> `selectEntity(label)`, click edge -> `selectEdge(a, b)`, click background -> `deselect()`
   - D3 drag `end`: if drag distance < 3px, treat as selection click
   - Add `SelectionRing.tsx` - pulsing purple glow around selected item
2. Place `GameCanvas` in canvas grid cell
3. Move Scoreboard/GameTimer to floating HUD overlay on canvas

### Phase 3: Left Panel (Hierarchy)
1. Create `hierarchy/SceneTree.tsx`:
   - Build tree: Game > Teams > Entities (when game active)
   - Flat node list when no game active
   - Collapsible tree nodes
2. Create `NodeTreeItem.tsx` / `EntityTreeItem.tsx`
3. Clicking tree items triggers selection (bidirectional with canvas)
4. Create `layout/LeftPanel.tsx` with `PanelHeader` and collapse button

### Phase 4: Right Panel (Inspector)
1. Create `inspector/InspectorRouter.tsx` - switches on `selection.kind`
2. Create `inspector/EmptyInspector.tsx` - game overview, consensus status
3. Create `inspector/EntityInspector.tsx`:
   - Entity type, team, position
   - Claim controls, ready-up
   - Game runtime data (scores, proximity rules, properties)
4. Create `inspector/NodeInspector.tsx`:
   - Node status (running/stopped), start/stop controls
   - Phase badge, peer list
   - Game selection (propose/vote)
   - Mini event log
5. Create `inspector/EdgeInspector.tsx`:
   - Connection status, distance, LOS info
   - Partition toggle button
6. Create `layout/RightPanel.tsx`

### Phase 5: Bottom Drawer
1. Create `layout/BottomDrawer.tsx` with tabs + resize handle
2. Adapt existing EventLog, EventTimeline, ProofList, FinalityChart:
   - Remove outer Card wrappers
   - Make heights flexible
3. Resize handle: drag to adjust `bottomHeight` (clamp 120px - 50vh)

### Phase 6: Floating Toolbar + Status Bar
1. Create `toolbar/SwarmControls.tsx` (create/destroy swarm, start/stop all)
2. Create `toolbar/GamePhaseControls.tsx` (propose/vote/ready-all/clear)
3. Create `layout/FloatingToolbar.tsx` - positioned bottom-center of canvas
4. Create `layout/StatusBar.tsx` - connection, phase, node/entity counts

### Phase 7: Polish
1. Panel collapse/expand CSS transitions (`transition: grid-template-*`)
2. Keyboard shortcuts (1/2/3 toggle panels, Escape deselects)
3. Selection sync: tree highlights when canvas selects and vice versa
4. Smooth drawer resize interaction

---

## Theme: Dark Mode + Purple/Violet

Replace current dual light/dark theme with dark-only:

```css
:root {
  /* Surface elevation (4 levels) */
  --background:         oklch(0.13 0.005 285);   /* viewport bg */
  --surface-1:          oklch(0.16 0.008 285);   /* panels */
  --surface-2:          oklch(0.19 0.010 285);   /* cards within panels */
  --surface-3:          oklch(0.22 0.012 285);   /* overlays/popovers */

  /* Map to shadcn tokens */
  --card:               oklch(0.16 0.008 285);
  --popover:            oklch(0.22 0.012 285);
  --foreground:         oklch(0.93 0.005 285);
  --muted-foreground:   oklch(0.60 0.010 285);

  /* Purple/violet accent */
  --primary:            oklch(0.70 0.15 290);
  --primary-foreground: oklch(0.98 0 0);
  --accent:             oklch(0.25 0.04 290);
  --accent-foreground:  oklch(0.85 0.08 290);
  --ring:               oklch(0.60 0.12 290);
  --selection-glow:     oklch(0.75 0.18 290);

  /* Subtle borders */
  --border:             oklch(1 0 0 / 8%);
  --input:              oklch(1 0 0 / 10%);

  --destructive:        oklch(0.65 0.20 25);
}
```

---

## CSS Grid Shell (AppShell.tsx)

```css
.app-shell {
  display: grid;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  grid-template-columns: var(--left-w, 260px) 1fr var(--right-w, 320px);
  grid-template-rows: 1fr var(--bottom-h, 240px) 24px;
  transition: grid-template-columns 200ms ease, grid-template-rows 200ms ease;
}
```

When panels collapse, CSS variables update to `0px` with smooth transition.

---

## Selection System

**Canvas-side**: Modify D3 drag `end` handler - if drag distance < 3px, emit selection instead of move. Edges get click -> `selectEdge()` (instead of immediate partition toggle). Background click -> `deselect()`.

**Visual feedback**: `SelectionRing.tsx` renders a pulsing purple glow (using CSS animation) as an SVG element positioned at the selected entity/edge.

**Inspector-side**: `InspectorRouter` reads selection context and renders the appropriate inspector component.

---

## Key Decisions

- **Not incremental after Phase 1**: Phase 0 is non-breaking; Phase 1+ requires committing to the new layout (the layouts are fundamentally different architectures)
- **Selection via React Context**: Selection state is needed by canvas, left panel, right panel, and toolbar simultaneously - Context avoids prop drilling
- **D3 drag/click coexistence**: Use drag distance threshold (< 3px = click/select, >= 3px = drag/move)
- **Edge behavior change**: Clicking edges now selects them; partition toggle moves to EdgeInspector panel (more intentional UX)
- **Existing hooks stay in App.tsx**: All `useApi`/`useGame` hooks remain lifted at the top level, data flows down via props

---

## Critical Files to Modify

| File | Action |
|------|--------|
| `frontend/src/App.tsx` | Rewrite (providers + AppShell) |
| `frontend/src/index.css` | Rewrite (dark-only purple theme) |
| `frontend/index.html` | Add `class="dark"` to `<html>` |
| `frontend/src/components/GameView.tsx` | Refactor into `canvas/GameCanvas.tsx` |
| `frontend/src/components/NodeControl.tsx` | Decompose into hierarchy/inspector/toolbar |
| `frontend/src/components/EventLog.tsx` | Adapt for drawer tab |
| `frontend/src/components/EventTimeline.tsx` | Adapt for drawer tab |
| `frontend/src/components/ProofList.tsx` | Adapt for drawer tab |
| `frontend/src/components/FinalityChart.tsx` | Adapt for drawer tab |

---

## Verification

1. All nodes appear in hierarchy tree (left panel)
2. Clicking entities/nodes/edges on canvas updates inspector (right panel)
3. D3 drag-to-move entities still works (drag > 3px threshold)
4. D3 zoom/pan still works on canvas
5. Partition toggling works from EdgeInspector
6. SSE real-time updates reflect in all panels
7. Game lifecycle works: propose -> vote -> claim -> ready -> play -> end
8. Event log, proofs, timeline all render in bottom drawer tabs
9. Panel collapse/expand works with smooth transitions
10. Canvas fills available space responsively when panels collapse
11. All existing API interactions preserved (start/stop node, swarm, move, etc.)
