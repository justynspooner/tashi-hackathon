// Shared types for the game demo.
//
// Keep in lockstep with the Rust side:
//   - `src/protocol.rs` (Position, SensorDatum, GamePayload)
//   - `src/game_state.rs` (GamePhase, EntityRecord, LocalGameState)
//   - `games/*.json` (GameConfig)

export interface Position {
  x: number
  y: number
}

export interface SensorDatum {
  peer_id: string
  distance_m: number
  angle_rad: number
}

export type GamePhase =
  | 'no_game'
  | 'proposing'
  | 'voting'
  | 'loaded'
  | 'placing_entities'
  | 'ready'
  | 'counting_down'
  | 'playing'
  | 'ended'

export interface EntityRecord {
  label: string
  peer_id: string
  entity_type?: string | null
  team?: string | null
  pos?: Position | null
  properties?: Record<string, unknown>
  claimed_at_ms?: number
  last_seen_ms?: number
}

export interface LocalGameSnapshot {
  label: string
  peer_id: string
  phase: GamePhase
  active_game_id: string | null
  entities: Record<string, EntityRecord>
  my_position?: Position | null
  scores?: Record<string, number>
  proposal_window?: unknown
  vote_window?: unknown
  countdown_zero_ns?: number | null
  placement_ok?: boolean
  ready_peers?: string[]
}

// -------- Game config (loaded via GET /api/games once Phase C lands) -------

export interface EntityTypeDef {
  id: string
  min: number
  max: number
  team: null | 'per_team'
  visual: string
}

export interface PlacementRule {
  entity: string
  requires: Record<string, unknown>
}

export interface Rule {
  id: string
  on: string
  when: Record<string, unknown>
  effect: Record<string, unknown>
}

export interface GameConfig {
  id: string
  name: string
  comm_radius_m: number
  teams: string[]
  entity_types: EntityTypeDef[]
  placement: PlacementRule[]
  rules: Rule[]
}
