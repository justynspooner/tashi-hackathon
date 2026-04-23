// Uses Bun's built-in test runner (`bun test`). No extra deps.
//
// Parse-check the shipped Rust-authored `games/*.json` configs through the
// hand-written TS types. Any drift between the Rust GameConfig and the TS
// GameConfig fails CI rather than hitting at runtime. Mirrors the Rust
// equivalent in `src/games.rs`.
import { describe, expect, test } from 'bun:test'
import ctf from '../../../games/ctf.json' with { type: 'json' }
import ctfPark from '../../../games/ctf_park.json' with { type: 'json' }
import freezeTag from '../../../games/freeze_tag.json' with { type: 'json' }
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

  test('declares mark_holding, hold_pulse, hold_score, and time_limit rules', () => {
    // 10-minute hold-the-flag scoring:
    //   - mark_holding stamps flag.holding_team for the UI pill,
    //   - hold_pulse writes now_ms to flag.hold_pulse_ms every tick the flag
    //     sits in a base, so the delta side
    //   - hold_score can increment the holding team's score in lockstep on
    //     every node,
    //   - time_limit ends the game after duration_s with the highest-score
    //     team as winner.
    const ids = cfg.rules.map(r => r.id).sort()
    expect(ids).toEqual(['hold_pulse', 'hold_score', 'mark_holding', 'time_limit'])
  })

  test('declares a duration_s time limit', () => {
    expect(cfg.duration_s).toBe(600)
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

describe('freeze_tag.json', () => {
  const cfg = asConfig(freezeTag, 'freeze_tag')

  test('id and teams match expected shape', () => {
    expect(cfg.id).toBe('freeze_tag')
    expect(cfg.teams).toEqual(['freezers', 'runners'])
  })

  test('freezer and runner use fixed-team shape (not per_team)', () => {
    // This is the first game to pin entity types to a specific team string.
    // The frontend claim-picker UI and backend `reject_for_cardinality` both
    // special-case `'per_team'` — a drift here turns claims into silent
    // "requires team=X; none given" rejects (exactly the bug this test
    // guards against).
    const freezer = cfg.entity_types.find(e => e.id === 'freezer')
    const runner = cfg.entity_types.find(e => e.id === 'runner')
    expect(freezer?.team).toBe('freezers')
    expect(runner?.team).toBe('runners')
  })

  test('both entity types field exactly 2 players', () => {
    for (const et of cfg.entity_types) {
      expect(et.min, `${et.id}.min`).toBe(2)
      expect(et.max, `${et.id}.max`).toBe(2)
    }
  })

  test('declares freeze_runner, freezers_win, and runners_win_timeout rules', () => {
    const ids = cfg.rules.map(r => r.id).sort()
    expect(ids).toEqual(['freeze_runner', 'freezers_win', 'runners_win_timeout'])
  })

  test('match clock is 2 minutes', () => {
    // runners_win_timeout gates on game_time_elapsed_s: 120; the duration_s
    // field drives the UI countdown. Keep them aligned.
    expect(cfg.duration_s).toBe(120)
  })
})

describe('ctf_park.json', () => {
  const cfg = asConfig(ctfPark, 'ctf_park')

  test('id and teams match expected shape', () => {
    expect(cfg.id).toBe('ctf_park')
    expect(cfg.teams).toEqual(['red', 'blue'])
  })

  test('jail is per-team so the different_team filter can discriminate', () => {
    // The park ruleset scores jail-breaks only at the *enemy* jail. That
    // asymmetry depends on jail being per-team + proximity_duration_s
    // carrying `different_team: true` on the jail rules. If either leg drifts
    // (jail becomes neutral, or the flag gets dropped from the rule), this
    // test fails on the structural half.
    const jail = cfg.entity_types.find(e => e.id === 'jail')
    expect(jail).toBeDefined()
    expect(jail!.team).toBe('per_team')
  })

  test('has flag, jail, base, player entity types', () => {
    const ids = cfg.entity_types.map(e => e.id).sort()
    expect(ids).toEqual(['base', 'flag', 'jail', 'player'])
  })

  test('declares all four placement rules', () => {
    expect(cfg.placement.length).toBe(4)
  })

  test('declares a 7-minute duration_s time limit', () => {
    expect(cfg.duration_s).toBe(420)
  })
})
