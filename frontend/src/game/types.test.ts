// Uses Bun's built-in test runner (`bun test`). No extra deps.
//
// Parse-check the shipped Rust-authored `games/*.json` configs through the
// hand-written TS types. Any drift between the Rust GameConfig and the TS
// GameConfig fails CI rather than hitting at runtime. Mirrors the Rust
// equivalent in `src/games.rs`.
import { describe, expect, test } from 'bun:test'
import ctf from '../../../games/ctf.json' with { type: 'json' }
import koth from '../../../games/king_of_the_hill.json' with { type: 'json' }
import territory from '../../../games/territory.json' with { type: 'json' }
import type { GameConfig } from './types'

function asConfig(raw: unknown, name: string): GameConfig {
  // Runtime validator — each field is asserted so a schema change in any
  // shipped JSON will fail the relevant assertion with a clear message.
  const c = raw as GameConfig
  expect(typeof c.id, `${name}.id`).toBe('string')
  expect(c.id.length, `${name}.id`).toBeGreaterThan(0)
  expect(typeof c.name, `${name}.name`).toBe('string')
  expect(typeof c.comm_radius_m, `${name}.comm_radius_m`).toBe('number')
  expect(c.comm_radius_m, `${name}.comm_radius_m`).toBeGreaterThan(0)
  expect(Array.isArray(c.teams), `${name}.teams`).toBe(true)
  expect(Array.isArray(c.entity_types), `${name}.entity_types`).toBe(true)
  expect(c.entity_types.length, `${name}.entity_types`).toBeGreaterThan(0)
  for (const et of c.entity_types) {
    expect(typeof et.id, `${name}.entity_types[].id`).toBe('string')
    expect(typeof et.min, `${name}.entity_types[].min`).toBe('number')
    expect(typeof et.max, `${name}.entity_types[].max`).toBe('number')
    expect(et.min, `${name}.entity_types[].min<=max`).toBeLessThanOrEqual(et.max)
  }
  expect(Array.isArray(c.placement), `${name}.placement`).toBe(true)
  expect(Array.isArray(c.rules), `${name}.rules`).toBe(true)
  return c
}

describe('ctf.json', () => {
  const cfg = asConfig(ctf, 'ctf')

  test('id and teams match expected shape', () => {
    expect(cfg.id).toBe('ctf')
    expect(cfg.teams).toEqual(['red', 'blue'])
  })

  test('has flag, base, player entity types', () => {
    const ids = cfg.entity_types.map(e => e.id).sort()
    expect(ids).toEqual(['base', 'flag', 'player'])
  })

  test('declares both placement rules', () => {
    expect(cfg.placement.length).toBe(2)
  })

  test('declares flag_capture, score_capture, and capture_wins rules', () => {
    // capture_wins exercises the `end_game` effect (Phase-E completeness)
    // so the DSL's full effect surface ships in at least one game.
    const ids = cfg.rules.map(r => r.id).sort()
    expect(ids).toEqual(['capture_wins', 'flag_capture', 'score_capture'])
  })
})

describe('king_of_the_hill.json', () => {
  const cfg = asConfig(koth, 'king_of_the_hill')

  test('id matches', () => {
    expect(cfg.id).toBe('king_of_the_hill')
  })

  test('has hill entity type', () => {
    expect(cfg.entity_types.some(e => e.id === 'hill')).toBe(true)
  })
})

describe('territory.json', () => {
  const cfg = asConfig(territory, 'territory')

  test('id matches', () => {
    expect(cfg.id).toBe('territory')
  })

  test('has no placement rules', () => {
    expect(cfg.placement.length).toBe(0)
  })
})
