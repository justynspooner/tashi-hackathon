# CTF_Park Game Mode Config

## Context

We designed a park-friendly Capture the Flag ruleset (tag-based, no shooting, 7-minute rounds, 8-12 players). Now we need to map those physical rules to a game mode config that the engine can evaluate. The engine uses a proximity-based JSON DSL with `tick`/`delta`-triggered rules, so discrete park events (flag capture = 3pts, jailbreak = 1pt) must be translated into continuous proximity-based scoring.

The engine now supports `same_team` and `different_team` filters on `proximity_duration_s`, which unlocks two previously-unmappable park mechanics: **tagging** (player-vs-enemy-player proximity) and **anti-camping penalties** (player lingering near own base).

## Key Design Decisions

### Single neutral flag + jail (not per-team)
The engine's `set_property` targets ALL entities of a type. With per-team flags, writing `flag.hold_pulse_ms` would hit both teams' flags and double-count scoring. The single-neutral-entity pattern (proven in existing `ctf.json`) avoids this entirely. The neutral jail also serves as the pulse target for tag detection (different key: `tag_pulse_ms` vs `free_pulse_ms`).

### Continuous scoring preserves the park point hierarchy
Physical rules: 3 pts per flag capture, 1 pt per jailbreak, 1 pt per tag (new). Engine equivalent:

| Mechanic | Pts/sec | Park equivalent |
|----------|---------|-----------------|
| Flag held at base | **+3** | Primary objective — capturing the flag |
| Tag (near enemy player) | **+1** | Active defense — tagging invaders (§4.2) |
| Jailbreak (at jail zone) | **+1** | Active offense — freeing teammates (§4.4) |
| Base camping penalty | **−1** | Anti-stall — discourages turtling at base (§4.5, §6.5) |

The 3:1:1 ratio keeps the flag as the dominant objective while rewarding both defensive play (tags) and offensive support (jailbreaks) equally. The camping penalty is a deterrent, not a primary scoring channel — its 45s dwell means it only triggers against genuinely idle defenders.

### Team filtering in proximity predicates enables player-vs-player rules
`proximity_duration_s` now supports `same_team` and `different_team` boolean filters. This unlocks:
- **Tag detection** (`different_team: true`): player within 1.5m of an enemy player for 2s = tag event. The 1.5m range models arm's reach, the 2s dwell models a deliberate two-handed touch (§4.2).
- **Base camping** (`same_team: true`): player within 5m of own base for 45s = camping. The generous dwell means active defenders who move around their base never trigger it — only stationary campers (§4.5, §6.5).

Neutral entities (flag, jail) have `team: null` and are unaffected by team filters — `None` never matches `same_team` or `different_team`.

### Player min raised to 4
Park mode targets 8-12 players (4-6 per team). The `min: 4` enforces this. Can be lowered to 2 for dev testing.

### Park rules the engine cannot model
Some physical rules have no engine equivalent and remain referee-enforced:

| Park rule | Why it can't be modeled |
|-----------|------------------------|
| Tagged player goes to jail (§4.3) | Engine can't move a specific entity to a location |
| Flag drops when carrier tagged (§4.3) | Engine can't target a specific peer entity |
| Free walk immunity after jailbreak (§4.4) | No immunity/invulnerability concept |
| Territory boundaries / centre line (§4.7) | No coordinate-zone predicates |
| Chain jailbreak (§4.4) | Can't model entity chains |
| Mercy rule — auto-free after 3 min (§4.4) | Can't express "time since last property change" |
| Flag passing to teammate (§4.6) | Can't transfer properties between specific entities |

These are all physical-world mechanics enforced by the referee. The engine focuses on what it can measure: proximity, duration, and team identity.

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
    { "id": "jail",   "min": 1, "max": 1, "team": null,       "visual": "jail" },
    { "id": "base",   "min": 1, "max": 1, "team": "per_team", "visual": "base" },
    { "id": "player", "min": 4, "max": 6, "team": "per_team", "visual": "player" }
  ],
  "placement": [
    { "entity": "player", "requires": { "kind": "within_m_of",        "entity": "base", "same_team": true, "max_m": 3.0 } },
    { "entity": "flag",   "requires": { "kind": "farther_than_m_from", "entity": "base",                   "min_m": 15.0 } },
    { "entity": "jail",   "requires": { "kind": "farther_than_m_from", "entity": "base",                   "min_m": 10.0 } },
    { "entity": "jail",   "requires": { "kind": "farther_than_m_from", "entity": "flag",                   "min_m": 8.0 } }
  ],
  "rules": [
    {
      "//": "FLAG CAPTURE — Mark flag holder — base detects flag within 1m for 3s, stamps flag.holding_team for the UI. 3s dwell (vs 1s vanilla CTF) represents physically securing the flag at base.",
      "id": "mark_flag_holder",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "base" },
        { "kind": "proximity_duration_s", "peer_entity_type": "flag", "max_m": 1.0, "min_s": 3 }
      ] },
      "effect": { "kind": "set_property", "target_entity_type": "flag", "key": "holding_team", "value": "self.team" }
    },
    {
      "//": "Flag hold pulse — same trigger, writes now_ms each tick so the delta-triggered score rule fires 1/sec.",
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
      "//": "TAGGING — Mark tagger — player within 1.5m of enemy player for 2s stamps jail.tagger_team for UI. 1.5m models arm's reach, 2s dwell models deliberate two-handed tag (§4.2). different_team ensures only cross-team proximity counts.",
      "id": "mark_tagger",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "player" },
        { "kind": "proximity_duration_s", "peer_entity_type": "player", "max_m": 1.5, "min_s": 2, "different_team": true }
      ] },
      "effect": { "kind": "set_property", "target_entity_type": "jail", "key": "tagger_team", "value": "self.team" }
    },
    {
      "//": "Tag pulse — same trigger, writes now_ms to jail.tag_pulse_ms for delta-based scoring. Uses jail as the neutral pulse target (different key from free_pulse_ms).",
      "id": "tag_pulse",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "player" },
        { "kind": "proximity_duration_s", "peer_entity_type": "player", "max_m": 1.5, "min_s": 2, "different_team": true }
      ] },
      "effect": { "kind": "set_property", "target_entity_type": "jail", "key": "tag_pulse_ms", "value": "now_ms" }
    },
    {
      "//": "Tag scoring — delta-triggered, 1 pt per tick of sustained tag proximity. Rewards active defense.",
      "id": "tag_score",
      "on": "game_state_delta",
      "when": { "kind": "property_changed", "target_entity_type": "jail", "key": "tag_pulse_ms" },
      "effect": { "kind": "increment_score", "team": "self.team", "by": 1 }
    },

    {
      "//": "JAILBREAK — Mark jail liberator — player within 2m of jail for 4s stamps jail.liberating_team for UI (§4.4). Represents reaching the jail zone to free teammates. 4s dwell creates a vulnerability window for physical tagging.",
      "id": "mark_jail_liberator",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "player" },
        { "kind": "proximity_duration_s", "peer_entity_type": "jail", "max_m": 2.0, "min_s": 4 }
      ] },
      "effect": { "kind": "set_property", "target_entity_type": "jail", "key": "liberating_team", "value": "self.team" }
    },
    {
      "//": "Jail free pulse — same trigger, writes now_ms each tick for delta-based scoring. 3:1 ratio vs flag mirrors physical scoring weights.",
      "id": "jail_free_pulse",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "player" },
        { "kind": "proximity_duration_s", "peer_entity_type": "jail", "max_m": 2.0, "min_s": 4 }
      ] },
      "effect": { "kind": "set_property", "target_entity_type": "jail", "key": "free_pulse_ms", "value": "now_ms" }
    },
    {
      "//": "Jail free scoring — delta-triggered, 1 pt per tick of jail presence. Secondary objective.",
      "id": "jail_free_score",
      "on": "game_state_delta",
      "when": { "kind": "property_changed", "target_entity_type": "jail", "key": "free_pulse_ms" },
      "effect": { "kind": "increment_score", "team": "self.team", "by": 1 }
    },

    {
      "//": "ANTI-CAMPING — Camp penalty pulse — player within 5m of own base (same_team) for 45s writes now_ms to flag.camp_pulse_ms (§4.5/§6.5). The 45s dwell is generous: active defenders who patrol or chase never trigger it. Only genuinely idle campers do.",
      "id": "camp_penalty_pulse",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "player" },
        { "kind": "proximity_duration_s", "peer_entity_type": "base", "max_m": 5.0, "min_s": 45, "same_team": true }
      ] },
      "effect": { "kind": "set_property", "target_entity_type": "flag", "key": "camp_pulse_ms", "value": "now_ms" }
    },
    {
      "//": "Camp penalty scoring — delta-triggered, -1 pt per tick of camping. Negative score deters turtling without dominating the economy (45s grace period means it rarely fires in active play).",
      "id": "camp_penalty_score",
      "on": "game_state_delta",
      "when": { "kind": "property_changed", "target_entity_type": "flag", "key": "camp_pulse_ms" },
      "effect": { "kind": "increment_score", "team": "self.team", "by": -1 }
    },

    {
      "//": "TIME LIMIT — 7-minute time limit — fires from the flag node only (single source). highest_score picks winner; ties = draw.",
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

Add shape test after the `territory_parses` test (~line 140):
```rust
#[test]
fn ctf_park_parses_and_has_expected_shape() {
    let g = parse("ctf_park.json", CTF_PARK_JSON);
    assert_eq!(g.id, "ctf_park");
    assert_eq!(g.teams, vec!["red".to_string(), "blue".to_string()]);
    assert!(g.entity_types.iter().any(|e| e.id == "flag" && e.max == 1));
    assert!(g.entity_types.iter().any(|e| e.id == "jail" && e.max == 1));
    assert!(g.entity_types.iter().any(|e| e.id == "base" && e.team.as_deref() == Some("per_team")));
    assert!(g.entity_types.iter().any(|e| e.id == "player" && e.min == 4 && e.max == 6));
    assert_eq!(g.placement.len(), 4);
    assert_eq!(g.duration_s, Some(420));
    let rule_ids: Vec<&str> = g.rules.iter().map(|r| r.id.as_str()).collect();
    // Flag capture (3 rules)
    assert!(rule_ids.contains(&"mark_flag_holder"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"flag_hold_pulse"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"flag_hold_score"), "rules: {rule_ids:?}");
    // Tagging (3 rules, uses different_team)
    assert!(rule_ids.contains(&"mark_tagger"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"tag_pulse"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"tag_score"), "rules: {rule_ids:?}");
    // Jailbreak (3 rules)
    assert!(rule_ids.contains(&"mark_jail_liberator"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"jail_free_pulse"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"jail_free_score"), "rules: {rule_ids:?}");
    // Anti-camping (2 rules, uses same_team)
    assert!(rule_ids.contains(&"camp_penalty_pulse"), "rules: {rule_ids:?}");
    assert!(rule_ids.contains(&"camp_penalty_score"), "rules: {rule_ids:?}");
    // Time limit
    assert!(rule_ids.contains(&"time_limit"), "rules: {rule_ids:?}");
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

## Rule-to-Park-Rule Mapping

| Park Rule (§) | Engine Rule(s) | Mechanism | Team filter |
|----------------|---------------|-----------|-------------|
| Flag capture = 3 pts (§4.1) | `mark_flag_holder` + `flag_hold_pulse` + `flag_hold_score` | 3 pts/sec while flag is at a base | — (neutral flag) |
| **Tagging = 1 pt (§4.2)** | `mark_tagger` + `tag_pulse` + `tag_score` | **1 pt/sec while near enemy player** | **`different_team`** |
| Jailbreak = 1 pt (§4.4) | `mark_jail_liberator` + `jail_free_pulse` + `jail_free_score` | 1 pt/sec while player is at jail zone | — (neutral jail) |
| **No flag-zone camping (§4.5)** | `camp_penalty_pulse` + `camp_penalty_score` | **−1 pt/sec after 45s near own base** | **`same_team`** |
| 7-minute rounds (§5) | `time_limit` | `game_time_elapsed_s: 420` | — |
| Anti-camping buffer — flag (§2) | Placement: `flag farther_than_m_from base 15m` | Flag must be 15m+ from any base | — |
| Anti-camping buffer — jail (§2) | Placement: `jail farther_than_m_from base 10m` | Jail must be 10m+ from bases | — |
| Separate objectives (§2) | Placement: `jail farther_than_m_from flag 8m` | Jail must be 8m+ from flag | — |
| Players start at base (§3) | Placement: `player within_m_of base 3m same_team` | Players must be within 3m of own base | `same_team` |
| Highest score wins / draw (§5) | `end_game winner_team: "highest_score"` | Ties resolve to null (draw) | — |

## Verification

1. **`cargo test`** — all drift-guard tests pass (games.rs inline tests + integration tests)
2. **JSON parses cleanly** — `serde_json::from_str::<GameConfig>(ctf_park_json)` succeeds
3. **Rule IDs are unique** — 12 rules, all distinct IDs
4. **Placement rules use supported `kind` values** — `within_m_of` and `farther_than_m_from` only
5. **All `on` triggers are recognised** — `tick` and `game_state_delta` only
6. **Entity type cardinality** — min <= max for all entity types
7. **Team filter fields parse** — `same_team` and `different_team` on proximity predicates deserialise via `#[serde(default)]`
8. **Negative scoring works** — `increment_score` with `by: -1` uses `i64`, so negative values are valid
