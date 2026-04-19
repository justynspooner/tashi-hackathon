// Visual/field configuration. This file is the single source of truth for
// playing-field dimensions and obstacle placement — the Rust backend does not
// know about either (obstacles are a rendering concern; field dimensions are
// duplicated as one-line constants in `src/defaults.rs`).

import type { Position } from './types'

export const FIELD_WIDTH_M = 60
export const FIELD_HEIGHT_M = 30
export const PX_PER_M = 20

export const FIELD_WIDTH_PX = FIELD_WIDTH_M * PX_PER_M
export const FIELD_HEIGHT_PX = FIELD_HEIGHT_M * PX_PER_M

export const PRE_GAME_COMM_RADIUS_M = 12

export interface Obstacle {
  x: number
  y: number
  r: number
  blocks_los?: boolean
}

export interface GamePresentation {
  gradient: { from: string; to: string; angle?: number }
  obstacles: Obstacle[]
}

export const PRESENTATIONS: Record<string, GamePresentation> = {
  // No game loaded — neutral grey field.
  no_game: {
    gradient: { from: '#1f2530', to: '#141820' },
    obstacles: [],
  },

  ctf: {
    gradient: { from: '#3b1818', to: '#18273b', angle: 0 },
    obstacles: [
      { x: 20, y: 10, r: 1.8, blocks_los: true },
      { x: 40, y: 20, r: 2.2, blocks_los: true },
      { x: 30, y: 15, r: 1.5, blocks_los: true },
    ],
  },

  king_of_the_hill: {
    gradient: { from: '#1d2a1d', to: '#0f170f' },
    obstacles: [],
  },

  territory: {
    gradient: { from: '#1a1c2e', to: '#101022' },
    obstacles: [
      { x: 15, y: 8, r: 1.6, blocks_los: true },
      { x: 45, y: 22, r: 1.6, blocks_los: true },
    ],
  },
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

export function clampToField(p: Position): Position {
  return {
    x: Math.min(Math.max(p.x, 0), FIELD_WIDTH_M),
    y: Math.min(Math.max(p.y, 0), FIELD_HEIGHT_M),
  }
}
