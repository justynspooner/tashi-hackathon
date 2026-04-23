# Add Team Filtering to `proximity_duration_s` Predicate

## Context

The game engine's `proximity_duration_s` runtime predicate has no team filter — it matches **any** peer entity of the given type regardless of team. Meanwhile, placement constraints (`within_m_of`) already support `same_team: bool` (rules.rs line 787). This inconsistency limits the DSL's expressiveness.

Current workaround: use neutral entities (single flag, single jail) so team resolution happens only in effects via `"self.team"`. This works for simple CTF configs but can't express team-aware proximity like "player near enemy player = tag" or "player near ally base = heal."

The fix: add optional `same_team` and `different_team` boolean fields to `ProximityDurationS`, mirroring the placement constraint pattern. All existing configs remain backward-compatible via `#[serde(default)]`.

## Changes

### 1. `src/rules.rs` — Predicate enum (~line 170)

Add two `#[serde(default)]` fields:

```rust
ProximityDurationS {
    peer_entity_type: String,
    max_m: f32,
    min_s: u64,
    #[serde(default)]
    same_team: bool,
    #[serde(default)]
    different_team: bool,
},
```

### 2. `src/rules.rs` — `eval_predicate` (~line 344)

Add a team filter to the entity iteration, between the `.filter(|e| entity_type...)` and `.any(|peer| ...)`:

```rust
.filter(|peer| {
    if *same_team {
        matches!((&self_entity.team, &peer.team), (Some(st), Some(pt)) if st == pt)
    } else if *different_team {
        matches!((&self_entity.team, &peer.team), (Some(st), Some(pt)) if st != pt)
    } else {
        true
    }
})
```

Semantics: both entities must have `Some(team)` for any team comparison. Two `None`-team entities do NOT count as "same team" — this prevents neutral entities (flag, jail) from accidentally matching.

### 3. `src/rules.rs` — `ProximityTrack` struct (~line 648)

Add the fields so `update_proximity` can apply matching filters:

```rust
struct ProximityTrack {
    rule_id: String,
    self_type: String,
    peer_type: String,
    max_m: f32,
    same_team: bool,
    different_team: bool,
}
```

### 4. `src/rules.rs` — `collect_proximity_predicates` (~line 625)

Update the destructure to extract the new fields and pass them into `ProximityTrack`.

### 5. `src/rules.rs` — `update_proximity` (~line 584)

Add team filtering after the `peer_id == self_entity.peer_id` guard:

```rust
if r.same_team {
    match (&s_entity.team, &p_entity.team) {
        (Some(st), Some(pt)) if st == pt => {}
        _ => continue,
    }
}
if r.different_team {
    match (&s_entity.team, &p_entity.team) {
        (Some(st), Some(pt)) if st != pt => {}
        _ => continue,
    }
}
```

This ensures the tracker only stores entries for valid team-filtered pairs, keeping it consistent with `eval_predicate`.

### 6. `src/rules.rs` — New tests

| Test | Validates |
|------|-----------|
| `proximity_same_team_only_tracks_matching` | `update_proximity` creates entries only for same-team pairs |
| `proximity_different_team_only_tracks_opposing` | `update_proximity` creates entries only for cross-team pairs |
| `proximity_same_team_none_excluded` | Entities with `team: None` never match `same_team: true` |
| `proximity_both_flags_never_fires` | Both `same_team` + `different_team` = always false (contradictory) |

### 7. `frontend/src/lib/node-control-helpers.ts` — `ProximityRuleInfo` interface (~line 150)

Add optional fields:
```typescript
sameTeam?: boolean
differentTeam?: boolean
```

### 8. `frontend/src/lib/node-control-helpers.ts` — `extractProximityRules` (~line 181)

Extract `same_team`/`different_team` from the parsed clause and include in output.

### 9. `frontend/src/components/inspector/components/EntityComponent.tsx` — dedup key (~line 393)

Update to include team filter so rules with same (peer, maxM, minS) but different team filters render separately:
```typescript
const key = `${r.peerEntityType}|${r.maxM}|${r.minS}|${r.sameTeam ?? ''}|${r.differentTeam ?? ''}`
```

## Key Design Decisions

- **Two booleans, not an enum** — matches the existing `PlacementRequire::WithinMOf` pattern. Natural JSON authoring: `"same_team": true`.
- **`None` team excluded from comparisons** — `None == None` should NOT count as same team. Prevents neutral entities (flag, jail) from matching team filters.
- **Tracker and predicate must agree** — both `update_proximity` and `eval_predicate` apply the same team filter, so the tracker only maintains entries for valid pairs. No wasted tracking, no mismatch.
- **Backward compatible** — `#[serde(default)]` means all existing configs parse unchanged.

## Verification

1. `cargo test` — all existing tests pass unchanged (backward compatibility)
2. New tests cover same_team, different_team, None-team edge case, and contradictory flags
3. `cd frontend && bun run build` — frontend compiles with updated types
4. Manually verify: load a game config with `"same_team": true` on a proximity rule and confirm it only fires for same-team pairs
