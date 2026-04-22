// Visual/field configuration. The playing field is an infinite canvas — the
// frontend has no bounded "field" to speak of. This module owns the pixels-
// per-metre scale used by every canvas helper and per-game theming. Obstacles
// are a pure rendering concern (the Rust backend does not know about them)
// and are owned by the `ObstaclesContext` — the user adds / positions /
// resizes them manually via the scene tree + canvas.

export const PX_PER_M = 20

export const COMM_RADIUS_M = 15

/** Shape used by the frontend LOS check. The obstacle state in
 *  `ObstaclesContext` is a superset (it also carries an id + label) — this is
 *  the structural minimum `hasLos` needs so the geometry helper stays free of
 *  UI concerns. */
export interface Obstacle {
  x: number
  y: number
  r: number
  blocks_los?: boolean
}

export interface GamePresentation {
  // Reserved for future per-game visuals (colour palette, background art,
  // etc.). Presentations used to inline default obstacles here; obstacle
  // placement now belongs to the user, not the game config.
  _placeholder?: never
}

export const PRESENTATIONS: Record<string, GamePresentation> = {
  no_game: {},
  ctf: {},
  king_of_the_hill: {},
  territory: {},
}

export function presentationFor(gameId: string | null | undefined): GamePresentation {
  if (!gameId) return PRESENTATIONS.no_game
  return PRESENTATIONS[gameId] ?? PRESENTATIONS.no_game
}

// Team colours used by entity visuals.
export const TEAM_COLORS: Record<string, string> = {
  red: '#ef4444',
  blue: '#3b82f6',
  green: '#22c55e',
}

export function teamColor(team: string | null | undefined): string {
  if (!team) return '#9ca3af' // neutral grey
  return TEAM_COLORS[team] ?? '#9ca3af'
}

// Convert metre coordinates to SVG pixel coordinates.
export function toPxX(xM: number): number {
  return xM * PX_PER_M
}
export function toPxY(yM: number): number {
  return yM * PX_PER_M
}
export function fromPxX(xPx: number): number {
  return xPx / PX_PER_M
}
export function fromPxY(yPx: number): number {
  return yPx / PX_PER_M
}

