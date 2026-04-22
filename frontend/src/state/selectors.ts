// Derived selectors over selection + nodes + game snapshots. Kept as plain
// functions so the canvas HUD pill, the HUD itself, and any inspector
// component see the same "source-of-truth" label for fallback logic.

import type { NodeInfo } from '@/types'
import type { EntityRecord, LocalGameSnapshot } from '@/game/types'
import type { Selection } from './SelectionContext'

/**
 * Resolve the label that should drive the canvas HUD (timer / scoreboard /
 * countdown / flag-holder). When a node is explicitly selected, use it;
 * otherwise fall back to the first node in the current list so the HUD
 * still has a meaningful vantage point.
 *
 * Returns null only when there are zero nodes.
 */
export function selectHudSourceLabel(
  selection: Selection,
  nodes: NodeInfo[],
): string | null {
  if (selection.kind === 'node') return selection.label
  return nodes[0]?.label ?? null
}

/**
 * Is the HUD currently showing fallback data (nothing user-selected)?
 */
export function isHudSourceFallback(selection: Selection): boolean {
  return selection.kind !== 'node'
}

/**
 * Pull the snapshot associated with a selection (or the fallback HUD source).
 */
export function resolveSnapshot(
  label: string | null,
  snapshots: Record<string, LocalGameSnapshot>,
): LocalGameSnapshot | undefined {
  if (!label) return undefined
  return snapshots[label]
}

/**
 * Resolve the entity record (if any) for a given node label. Looks at the
 * owning snapshot first, then falls back to peer snapshots — a node's claim
 * might be visible elsewhere before the node's own snapshot lands.
 */
export function resolveEntity(
  label: string | null,
  snapshots: Record<string, LocalGameSnapshot>,
): EntityRecord | undefined {
  if (!label) return undefined
  const own = snapshots[label]?.entities?.[label]
  if (own) return own
  for (const snap of Object.values(snapshots)) {
    const hit = snap.entities?.[label]
    if (hit) return hit
  }
  return undefined
}

/**
 * Build a canonical view of all entity claims across snapshots. Each node's
 * snapshot should converge to the same set; we merge by label, preferring
 * the richest (i.e. `entity_type`-set) record.
 */
export function canonicalEntities(
  snapshots: Record<string, LocalGameSnapshot>,
): Record<string, EntityRecord> {
  const out: Record<string, EntityRecord> = {}
  for (const snap of Object.values(snapshots)) {
    for (const [label, rec] of Object.entries(snap.entities)) {
      const existing = out[label]
      if (!existing || (!existing.entity_type && rec.entity_type)) {
        out[label] = rec
      }
    }
  }
  return out
}
