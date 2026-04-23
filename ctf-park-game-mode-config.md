# CTF_Park Game Mode Config

## Context

We designed a park-friendly Capture the Flag ruleset (tag-based, no shooting, 7-minute rounds, 8-12 players). Now we need to map those physical rules to a game mode config that the engine can evaluate. The engine uses a proximity-based JSON DSL with `tick`/`delta`-triggered rules, so discrete park events (flag capture = 3pts, jailbreak = 1pt) must be translated into continuous proximity-based scoring.

The engine now supports `same_team` / `different_team` filters on `proximity_duration_s` (see `add-team-filtering-to-proximity-duration-s-predicate.md`). This plan uses those filters to model the natural asymmetry of park CTF — jails belong to a team, and only **enemy** players earn a jailbreak point by raiding them.

## Key Design Decisions

### Single neutral flag, per-team jails
The engine's `set_property` targets ALL entities of a type. The flag stays a single neutral entity so per-team scoring still flows through the base that detects it (`self.team`). Jails, however, are **per-team** — each team holds captured opponents on their own side. Making jails `team: "per_team"` lets the jail-break rule distinguish "my jail" from "enemy jail" cleanly with `different_team: true`, matching the physical rule where raiding the enemy's jail (not your own) is what earns the point.

### Continuous scoring maps the 3:1 ratio
Physical rules: 3 pts per flag capture, 1 pt per jailbreak. Engine equivalent: **3 pts/sec** while the flag is held at a base, **1 pt/sec** while an opposing player occupies a jail zone. The 3:1 weight ratio is preserved.

### Team filtering via predicate flags where perspective is ambiguous
Two patterns in this config:

1. **Flag scoring** — the `base` fires the rule (`entity_is: base`) and `"self.team"` in the effect carries the team. No predicate-level filter needed: there is one neutral flag, and only one base can be near it at a time. Team identity is unambiguous from the `base`'s perspective.
2. **Jail-break scoring** — the `player` fires the rule. Both teams have a jail, and we must fire *only* when the player is near the **enemy** jail. We encode that with `different_team: true` on `proximity_duration_s`. Without this flag the rule would also fire when a player stands at their own jail (self-scoring), which the physical ruleset doesn't permit.

### Player min raised to 4
Park mode targets 8-12 players (4-6 per team). The `min: 4` enforces this. Can be lowered to 2 for dev testing.

## Files to Create/Modify

### 1. NEW: `games/ctf_park.json`

```json
{
  "id": "ctf_park",
  "name": "Park Capture the Flag",
  "teams": ["red", "blue"],
  "duration_s": 420,
  "entity_types": [
    { "id": "flag",   "min": 1, "max": 1, "team": null,       "visual": "flag" },
    { "id": "jail",   "min": 1, "max": 1, "team": "per_team", "visual": "jail" },
    { "id": "base",   "min": 1, "max": 1, "team": "per_team", "visual": "base" },
    { "id": "player", "min": 4, "max": 6, "team": "per_team", "visual": "player" }
  ],
  "placement": [
    { "entity": "player", "requires": { "kind": "within_m_of",        "entity": "base", "same_team": true, "max_m": 3.0 } },
    { "entity": "jail",   "requires": { "kind": "within_m_of",        "entity": "base", "same_team": true, "max_m": 4.0 } },
    { "entity": "flag",   "requires": { "kind": "farther_than_m_from", "entity": "base",                   "min_m": 15.0 } },
    { "entity": "jail",   "requires": { "kind": "farther_than_m_from", "entity": "flag",                   "min_m": 8.0 } }
  ],
  "rules": [
    {
      "//": "Mark flag holder — base detects flag within 1m for 3s, stamps flag.holding_team for the UI. 3s dwell (vs 1s vanilla CTF) represents physically securing the flag at base. No team filter on proximity needed: the flag is neutral and the rule fires from the base's perspective, so self.team resolves to the capturing team directly.",
      "id": "mark_flag_holder",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "base" },
        { "kind": "proximity_duration_s", "peer_entity_type": "flag", "max_m": 1.0, "min_s": 3 }
      ] },
      "effect": { "kind": "set_property", "target_entity_type": "flag", "key": "holding_team", "value": "self.team" }
    },
    {
      "//": "Flag hold pulse — same trigger, writes now_ms each tick so the delta-triggered score rule fires 1/sec. Maps the park '3 pts per capture' into 3 pts/sec of possession.",
      "id": "flag_hold_pulse",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "base" },
        { "kind": "proximity_duration_s", "peer_entity_type": "flag", "max_m": 1.0, "min_s": 3 }
      ] },
      "effect": { "kind": "set_property", "target_entity_type": "flag", "key": "hold_pulse_ms", "value": "now_ms" }
    },
    {
      "//": "Flag hold scoring — delta-triggered, 3 pts per tick of flag possession at base. Primary objective.",
      "id": "flag_hold_score",
      "on": "game_state_delta",
      "when": { "kind": "property_changed", "target_entity_type": "flag", "key": "hold_pulse_ms" },
      "effect": { "kind": "increment_score", "team": "self.team", "by": 3 }
    },
    {
      "//": "Mark jail liberator — player within 2m of an *enemy* jail for 4s stamps jail.liberating_team. `different_team: true` on the proximity predicate filters out the player's own jail, so camping your own side is a no-op. 4s dwell creates a vulnerability window for physical tagging.",
      "id": "mark_jail_liberator",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "player" },
        { "kind": "proximity_duration_s", "peer_entity_type": "jail", "different_team": true, "max_m": 2.0, "min_s": 4 }
      ] },
      "effect": { "kind": "set_property", "target_entity_type": "jail", "key": "liberating_team", "value": "self.team" }
    },
    {
      "//": "Jail free pulse — same different-team trigger, writes now_ms each tick for delta-based scoring. Maps park '1 pt per jailbreak' into 1 pt/sec while raiding an enemy jail. 3:1 ratio vs flag mirrors physical scoring weights.",
      "id": "jail_free_pulse",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "player" },
        { "kind": "proximity_duration_s", "peer_entity_type": "jail", "different_team": true, "max_m": 2.0, "min_s": 4 }
      ] },
      "effect": { "kind": "set_property", "target_entity_type": "jail", "key": "free_pulse_ms", "value": "now_ms" }
    },
    {
      "//": "Jail free scoring — delta-triggered, 1 pt per tick of enemy-jail presence. Secondary objective.",
      "id": "jail_free_score",
      "on": "game_state_delta",
      "when": { "kind": "property_changed", "target_entity_type": "jail", "key": "free_pulse_ms" },
      "effect": { "kind": "increment_score", "team": "self.team", "by": 1 }
    },
    {
      "//": "7-minute time limit — fires from the flag node only (single source). highest_score picks winner; ties = draw.",
      "id": "time_limit",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "flag" },
        { "kind": "game_time_elapsed_s", "min_s": 420 }
      ] },
      "effect": { "kind": "end_game", "winner_team": "highest_score", "reason": "7-minute time limit reached" }
    }
  ]
}
```

### 2. MODIFY: `src/games.rs` — add drift-guard test

Add `include_str!` constant at ~line 94:
```rust
const CTF_PARK_JSON: &str = include_str!("../games/ctf_park.json");
```

Add shape test after the `territory_parses` test (~line 140). The assertions lock in the per-team jail and the team-filtered jail rules — if either gets lost in a refactor, this test fails loudly:
```rust
#[test]
fn ctf_park_parses_and_has_expected_shape() {
    let g = parse("ctf_park.json", CTF_PARK_JSON);
    assert_eq!(g.id, "ctf_park");
    assert_eq!(g.teams, vec!["red".to_string(), "blue".to_string()]);
    assert!(g.entity_types.iter().any(|e| e.id == "flag" && e.team.is_none() && e.max == 1));
    assert!(g.entity_types.iter().any(|e| e.id == "jail" && e.team.as_deref() == Some("per_team") && e.max == 1));
    assert!(g.entity_types.iter().any(|e| e.id == "base" && e.team.as_deref() == Some("per_team")));
    assert!(g.entity_types.iter().any(|e| e.id == "player" && e.min == 4 && e.max == 6));
    assert_eq!(g.placement.len(), 4);
    assert_eq!(g.duration_s, Some(420));
    let rule_ids: Vec<&str> = g.rules.iter().map(|r| r.id.as_str()).collect();
    assert!(rule_ids.contains(&"mark_flag_holder"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"flag_hold_pulse"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"flag_hold_score"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"mark_jail_liberator"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"jail_free_pulse"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"jail_free_score"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"time_limit"), "rules: {rule_ids:?}");

    // Lock in that the jail-break rules actually use `different_team: true`.
    // The park ruleset depends on this filter — losing it silently would turn
    // jail-camping into self-scoring. Walk the rule JSON to confirm.
    for id in ["mark_jail_liberator", "jail_free_pulse"] {
        let rule = g.rules.iter().find(|r| r.id == id).expect(id);
        let clauses = rule.when.get("of").and_then(|v| v.as_array()).expect("of[]");
        let prox = clauses
            .iter()
            .find(|c| c.get("kind").and_then(|k| k.as_str()) == Some("proximity_duration_s"))
            .unwrap_or_else(|| panic!("{id} missing proximity_duration_s"));
        assert_eq!(
            prox.get("different_team").and_then(|v| v.as_bool()),
            Some(true),
            "{id} must filter different_team: true",
        );
    }
}
```

Add `ctf_park.json` to the `all_shipped_configs_have_nonempty_entity_types` loop at ~line 144:
```rust
("ctf_park.json", CTF_PARK_JSON),
```

### 3. MODIFY: `tests/game_config_load.rs` — update expected set

Update the expected set at line 33:
```rust
let expected: HashSet<&str> = ["ctf", "ctf_park", "king_of_the_hill", "territory"].into_iter().collect();
```

### 4. MODIFY: `frontend/src/game/presentation.ts` — register presentation

Add to `PRESENTATIONS` at ~line 30 so the game passes `presentationFor` resolution (avoids falling back to `no_game`):
```typescript
ctf_park: {},
```

### 5. MODIFY: `frontend/src/game/types.test.ts` — add parse test

Import and add a describe block mirroring the existing three. Assert `id`, 4 placement rules, duration_s = 420, and that the jail entity is per-team so frontend type assumptions stay aligned with the Rust side.

## Rule-to-Park-Rule Mapping

| Park Rule | Engine Rule(s) | Mechanism |
|-----------|---------------|-----------|
| Flag capture = 3 pts | `mark_flag_holder` + `flag_hold_pulse` + `flag_hold_score` | 3 pts/sec while flag is at a base (neutral flag, base-perspective) |
| Jailbreak = 1 pt | `mark_jail_liberator` + `jail_free_pulse` + `jail_free_score` | 1 pt/sec while player is at **enemy** jail (`different_team: true`) |
| Can't score by camping own jail | `different_team: true` on jail proximity predicates | Predicate fails when `self.team == peer.team` |
| 7-minute rounds | `time_limit` | `game_time_elapsed_s: 420` |
| Anti-camping buffer (flag) | Placement: `flag farther_than_m_from base 15m` | Flag must be 15m+ from any base |
| Jail lives on own team's side | Placement: `jail within_m_of base same_team 4m` | Each team's jail sits near its own base |
| Separate objectives | Placement: `jail farther_than_m_from flag 8m` | Neither team's jail overlaps the flag |
| Players start at base | Placement: `player within_m_of base same_team 3m` | Players must be within 3m of own base |
| Highest score wins / draw | `end_game winner_team: "highest_score"` | Ties resolve to null (draw) |

## Verification

1. **`cargo test`** — all drift-guard tests pass (games.rs inline tests + `tests/game_config_load.rs`)
2. **JSON parses cleanly** — `serde_json::from_str::<GameConfig>(ctf_park_json)` succeeds, including the new `different_team` field (backward-compatible via `#[serde(default)]`)
3. **Rule IDs are unique** — 7 rules, all distinct IDs
4. **Placement rules use supported `kind` values** — `within_m_of` (with and without `same_team`) and `farther_than_m_from`
5. **All `on` triggers are recognised** — `tick` and `game_state_delta` only
6. **Entity type cardinality** — min <= max for all entity types; jail is `per_team` so the placement requirement `min: 1, max: 1` means one jail *per team*, not one total
7. **Team filter actually fires correctly** — manual check: load `ctf_park`, stand a red player at the red jail → no score increment; move them to the blue jail → `jail_free_score` starts firing at 1 pt/sec after 4s dwell
8. **`cd frontend && bun run build`** — frontend compiles with `ctf_park` registered in `PRESENTATIONS`
