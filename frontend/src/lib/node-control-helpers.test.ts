// Uses Bun's built-in test runner (`bun test`). No extra deps.
//
// Guards the claim-submission helpers against regression — specifically the
// fixed-team path (e.g. freeze_tag's `freezer` → `'freezers'`), which used
// to be silently treated as teamless by the claim form, causing every node
// to reject the claim with "requires team=freezers; none given".
import { describe, expect, test } from 'bun:test'

import ctf from '../../../games/ctf.json' with { type: 'json' }
import freezeTag from '../../../games/freeze_tag.json' with { type: 'json' }
import koth from '../../../games/king_of_the_hill.json' with { type: 'json' }
import type { EntityRecord, GameConfig, LocalGameSnapshot } from '@/game/types'
import {
  claimTeamFor,
  decayRemainingMs,
  extractDecayRules,
  hasScoreEffects,
  readProposalWindow,
  readVoteWindow,
  tallyPicks,
  teamsForCardinality,
} from './node-control-helpers'

describe('teamsForCardinality', () => {
  test('teamless entity → [null]', () => {
    expect(teamsForCardinality(null, ['red', 'blue'])).toEqual([null])
    expect(teamsForCardinality(undefined, ['red', 'blue'])).toEqual([null])
  })

  test("'per_team' entity → every team", () => {
    expect(teamsForCardinality('per_team', ['red', 'blue'])).toEqual(['red', 'blue'])
  })

  test('fixed-team entity → [that team]', () => {
    // Freeze tag's freezer entity pins to team "freezers" — cardinality must
    // count against that single bucket, not the teamless `null` bucket.
    expect(teamsForCardinality('freezers', ['freezers', 'runners'])).toEqual(['freezers'])
  })

  test('returns a fresh array — mutating the result does not leak into game.teams', () => {
    const teams = ['red', 'blue']
    const out = teamsForCardinality('per_team', teams)
    out.push('green')
    expect(teams).toEqual(['red', 'blue'])
  })
})

describe('claimTeamFor', () => {
  test('teamless → null (ignores any picked team)', () => {
    expect(claimTeamFor(null, '')).toBeNull()
    expect(claimTeamFor(undefined, 'red')).toBeNull()
  })

  test("'per_team' → picked team, or null when none picked", () => {
    expect(claimTeamFor('per_team', 'red')).toBe('red')
    expect(claimTeamFor('per_team', '')).toBeNull()
  })

  test('fixed-team → that exact fixed string, never null', () => {
    // This is the regression guard. Before the fix, the claim form sent
    // `null` here because it didn't recognise the fixed-team shape, and the
    // backend rejected every claim on every node.
    expect(claimTeamFor('freezers', '')).toBe('freezers')
    expect(claimTeamFor('runners', '')).toBe('runners')
    // Picked-team input is ignored for fixed-team entities — the fixed
    // assignment wins.
    expect(claimTeamFor('freezers', 'runners')).toBe('freezers')
  })
})

describe('extractDecayRules', () => {
  test('returns [] for undefined config', () => {
    expect(extractDecayRules(undefined)).toEqual([])
  })

  test('extracts freeze_tag freeze_runner rule (set_property_on_self pattern)', () => {
    // The `freeze_runner` rule is the canonical "decay timer" pattern:
    //   - effect: set_property_on_self { key: "frozen_since_ms", value: now_ms }
    //   - when:   not property_age_ms { key: "frozen_since_ms", max_age_ms: 30000 }
    // Once the rule fires, the guard blocks re-firing for 30s. The UI uses
    // the extracted info to draw a remaining-time countdown chip.
    const decays = extractDecayRules(freezeTag as unknown as GameConfig)
    expect(decays).toHaveLength(1)
    expect(decays[0]).toEqual({
      ruleId: 'freeze_runner',
      targetEntityType: 'runner',
      propertyKey: 'frozen_since_ms',
      durationMs: 30000,
      label: 'frozen',
    })
  })

  test('CTF mark_holding does NOT match — it lacks a not property_age_ms guard', () => {
    // mark_holding sets flag.holding_team every tick the flag is in a base.
    // It's not a one-shot timer — there's no decay window — so the helper
    // must not surface it as a countdown.
    const decays = extractDecayRules(ctf as unknown as GameConfig)
    expect(decays.find(d => d.ruleId === 'mark_holding')).toBeUndefined()
  })

  test('king_of_the_hill has no decay rules', () => {
    expect(extractDecayRules(koth as unknown as GameConfig)).toEqual([])
  })
})

describe('decayRemainingMs', () => {
  const decay = { propertyKey: 'frozen_since_ms', durationMs: 30000 }

  function entityWith(props: Record<string, unknown>): EntityRecord {
    return { label: 'r1', peer_id: 'p1', properties: props }
  }

  test('returns null when property is not set', () => {
    expect(decayRemainingMs(entityWith({}), decay, 1_000_000)).toBeNull()
  })

  test('returns null when property is not a number (e.g. stale string)', () => {
    expect(decayRemainingMs(entityWith({ frozen_since_ms: 'nope' }), decay, 1_000_000)).toBeNull()
  })

  test('returns null when undefined entity (covers the no-claim case)', () => {
    expect(decayRemainingMs(undefined, decay, 1_000_000)).toBeNull()
  })

  test('returns full duration immediately after firing', () => {
    expect(decayRemainingMs(entityWith({ frozen_since_ms: 1_000_000 }), decay, 1_000_000)).toBe(30000)
  })

  test('returns remaining time mid-window', () => {
    // 10s into a 30s freeze → 20s remaining.
    expect(decayRemainingMs(entityWith({ frozen_since_ms: 1_000_000 }), decay, 1_010_000)).toBe(20000)
  })

  test('returns null at exactly the expiry boundary (matches not property_age_ms semantics)', () => {
    // The Rust predicate is `now_ms - value < max_age_ms` — strictly less than.
    // At elapsed == durationMs the property is no longer "recent", which is
    // when the runner becomes re-freezable. Mirror that here so the chip
    // disappears the moment the rule can fire again.
    expect(decayRemainingMs(entityWith({ frozen_since_ms: 1_000_000 }), decay, 1_030_000)).toBeNull()
  })

  test('returns null past expiry', () => {
    expect(decayRemainingMs(entityWith({ frozen_since_ms: 1_000_000 }), decay, 1_040_000)).toBeNull()
  })
})

describe('hasScoreEffects', () => {
  test('false for undefined config', () => {
    expect(hasScoreEffects(undefined)).toBe(false)
  })

  test('true for ctf (hold_score increments scores)', () => {
    expect(hasScoreEffects(ctf as unknown as GameConfig)).toBe(true)
  })

  test('false for freeze_tag (no increment_score effects — wins via end_game)', () => {
    // This is the load-bearing assertion behind hiding the "Hold/Scores"
    // pill row in the entity panel for freeze_tag — those scores stay at 0
    // forever, so showing them is just visual noise.
    expect(hasScoreEffects(freezeTag as unknown as GameConfig)).toBe(false)
  })
})

describe('proposal/vote window readers (GameChoice shape)', () => {
  // The Rust `LocalGameState` was changed to `HashMap<String, GameChoice>`
  // (game_id + keep_roles) when Replay/Change-Roles became distinct consensus
  // keys. The TS shape tracks that — these tests pin it down so a future
  // schema drift doesn't silently break the "you: Replay" pill in the
  // post-game panel or the cold-start GameSelectComponent's committed badge.
  function snapshotWith(
    proposers?: Record<string, { game_id: string; keep_roles: boolean }>,
    votes?: Record<string, { game_id: string; keep_roles: boolean }>,
  ): LocalGameSnapshot {
    return {
      label: 'a',
      peer_id: 'PK_A',
      phase: 'proposing',
      active_game_id: 'freeze_tag',
      entities: {},
      ...(proposers && { proposal_window: { started_at_ms: 0, proposers } }),
      ...(votes && { vote_window: { started_at_ms: 0, votes } }),
    } as LocalGameSnapshot
  }

  test('readProposalWindow returns proposers as GameChoice objects', () => {
    const snap = snapshotWith({
      PK_A: { game_id: 'freeze_tag', keep_roles: true },
      PK_B: { game_id: 'freeze_tag', keep_roles: false },
    })
    const win = readProposalWindow(snap)
    expect(win?.proposers?.PK_A?.game_id).toBe('freeze_tag')
    expect(win?.proposers?.PK_A?.keep_roles).toBe(true)
    expect(win?.proposers?.PK_B?.keep_roles).toBe(false)
  })

  test('readVoteWindow returns votes as GameChoice objects', () => {
    const snap = snapshotWith(undefined, {
      PK_A: { game_id: 'ctf', keep_roles: false },
    })
    expect(readVoteWindow(snap)?.votes?.PK_A?.game_id).toBe('ctf')
    expect(readVoteWindow(snap)?.votes?.PK_A?.keep_roles).toBe(false)
  })

  test('tallyPicks groups by game_id, ignoring keep_roles axis', () => {
    // Three proposers split as (replay-freeze, change-roles-freeze, ctf).
    // The window-wide tally cares about which game is in flight, not the
    // role-preservation intent — so freeze_tag should count as 2, ctf as 1.
    const snap = snapshotWith({
      PK_A: { game_id: 'freeze_tag', keep_roles: true },
      PK_B: { game_id: 'freeze_tag', keep_roles: false },
      PK_C: { game_id: 'ctf', keep_roles: false },
    })
    const tally = tallyPicks({ a: snap }, 'proposal_window')
    expect(tally).toEqual({ freeze_tag: 2, ctf: 1 })
  })
})
