# Freeze Tag 2v2 — Demo Game for Tashi Vertex Explorer

## Context

The Tashi Vertex Explorer (`/Users/justyn/dev/tashi/hackathon-warm-up`) is a BFT‑consensus multiplayer-game platform: every node runs a declarative rule engine and the swarm agrees in lockstep on state, scores, and game-end — no server, no central referee. The shipped games (CTF, King of the Hill, Territory, CTF Park) all hinge on either holding something (a flag, a zone) or standing on something (a hill). None of them showcase the simplest possible park mechanic: **one person tags another**.

We want a minimal, legible demo game — **Freeze Tag 2v2** — that shows proximity-based scoring between *players only* (no flag/base/zone props), ends decisively on a score threshold, and needs no line-of-sight or zone math. It's the shortest path from "four people in a park with phones" to "watch the swarm agree who won."

## Design

**Freeze Tag 2v2**
- **Teams:** `freezers` (2 players), `runners` (2 players).
- **Scoring:** a freezer within **1 m of a different-team runner for 2 s** scores **+1** for team `freezers`. Uses the CTF pulse-then-delta pattern so every node converges via consensus rather than diverging per-tick.
- **Placement:** freezers must spawn ≥5 m from every runner.
- **End:** **first to 5 points wins** (requires a new `score_at_least` predicate — see below). A 5-minute safety timeout using the existing `game_time_elapsed_s` + `highest_score` pattern is **not** included per the user's "first-to-N" call.

## DSL Extension — new `score_at_least` Predicate

The current DSL has no score-threshold predicate (confirmed by reading `src/rules.rs` — all predicates listed at lines 156–239). First-to-N cannot be expressed in pure JSON. Add one variant:

**File: `/Users/justyn/dev/tashi/hackathon-warm-up/src/rules.rs`**

1. **Add enum variant** after line 238 (`GameTimeElapsedS { min_s: u64 },`), inside `enum Predicate`:
   ```rust
   /// True once `ctx.local.scores[team]` ≥ `min`. Intended as the trigger
   /// for an `end_game` effect anchored on a neutral/stable entity so only
   /// one node broadcasts the `GameEnd`. Missing team key counts as 0.
   ScoreAtLeast { team: String, min: i64 },
   ```

2. **Add eval arm** after line 443 (after the `GameTimeElapsedS` arm), inside `eval_predicate()`:
   ```rust
   Predicate::ScoreAtLeast { team, min } => {
       ctx.local.scores.get(team).copied().unwrap_or(0) >= *min
   }
   ```

3. **Add a unit test** next to the existing score-related tests around lines 1641–1733 (the test helpers already populate `state.scores`). Pattern: build a `RuleContext` with `state.scores.insert("freezers".into(), 5)`, assert the predicate fires; drop the score to 4, assert it doesn't.

That's the entire Rust change — ~10 lines of production code + one test. No changes to `game_state.rs`, `web.rs`, or the frontend.

## New Game Config

**File (new): `/Users/justyn/dev/tashi/hackathon-warm-up/games/freeze_tag.json`**

Modelled on `games/ctf.json` (the pulse+delta scoring + anchored `end_game` pattern at `games/ctf.json:22–57`), simplified to players-only:

```json
{
  "id": "freeze_tag",
  "name": "Freeze Tag 2v2",
  "teams": ["freezers", "runners"],
  "entity_types": [
    { "id": "freezer", "min": 2, "max": 2, "team": "freezers", "visual": "player" },
    { "id": "runner",  "min": 2, "max": 2, "team": "runners",  "visual": "player" }
  ],
  "placement": [
    { "entity": "freezer", "requires": { "kind": "farther_than_m_from", "entity": "runner", "min_m": 5.0 } }
  ],
  "rules": [
    {
      "//": "Tag pulse — a freezer within 1m of a runner for 2s writes now_ms onto every runner. The value changes each tick of continued proximity so the delta-side score rule fires in lockstep on every node (pattern from ctf.json hold_pulse).",
      "id": "tag_pulse",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "freezer" },
        { "kind": "proximity_duration_s", "peer_entity_type": "runner", "different_team": true, "max_m": 1.0, "min_s": 2 }
      ] },
      "effect": { "kind": "set_property", "target_entity_type": "runner", "key": "tag_pulse_ms", "value": "now_ms" }
    },
    {
      "//": "Tag scoring — delta-triggered, +1 to freezers per tagged-runner pulse. Runs once per node per patch so consensus converges score.",
      "id": "tag_score",
      "on": "game_state_delta",
      "when": { "kind": "property_changed", "target_entity_type": "runner", "key": "tag_pulse_ms" },
      "effect": { "kind": "increment_score", "team": "freezers", "by": 1 }
    },
    {
      "//": "First-to-5 — anchored on a single freezer (entity_is filter) so exactly one GameEnd broadcasts. Requires the new score_at_least predicate.",
      "id": "freezers_win",
      "on": "tick",
      "when": { "kind": "all", "of": [
        { "kind": "entity_is", "entity_type": "freezer" },
        { "kind": "score_at_least", "team": "freezers", "min": 5 }
      ] },
      "effect": { "kind": "end_game", "winner_team": "freezers", "reason": "Freezers reached 5 tags" }
    }
  ]
}
```

**Why two separate entity types (`freezer`, `runner`) instead of one `player` per_team:** CTF Park uses a single `player` type, but it distinguishes behaviour via flag-holding, not team alone. Our tag rule needs to pick "freezer near runner" cleanly — two types make `proximity_duration_s { peer_entity_type: "runner" }` trivially correct. Cardinality is keyed by `(entity_type, team)` in `src/games.rs:14–25`, so a fixed `team` field on `EntityTypeDef` is the "rare but supported" path (noted in the doc comment at line 20).

## Test Updates (optional but recommended)

**File: `/Users/justyn/dev/tashi/hackathon-warm-up/src/games.rs`**

- Add `const FREEZE_TAG_JSON: &str = include_str!("../games/freeze_tag.json");` at line 123.
- Add a `freeze_tag_parses_and_has_expected_shape` test in the style of `king_of_the_hill_parses` (line 155) — assert `id == "freeze_tag"`, entity types include `freezer`/`runner` with `min == 2, max == 2`, and rule IDs include `tag_pulse`, `tag_score`, `freezers_win`.
- Add `freeze_tag.json` to the list at line 224 in `all_shipped_configs_have_nonempty_entity_types`.

**File: `/Users/justyn/dev/tashi/hackathon-warm-up/tests/game_config_load.rs`** (per the earlier Plan agent's finding — confirm with `ls tests/` at implementation time)

- Add `"freeze_tag"` to the `expected` set so the integration loader test asserts the config is wired up.

## Frontend Notes (no changes required)

- Games are discovered dynamically by `games::load_all()` (`src/games.rs:90`), called from `src/web.rs` at boot. `GET /api/games` picks up `freeze_tag.json` automatically.
- `PRESENTATIONS` in `frontend/src/game/presentation.ts` falls back to `no_game` for unknown game IDs — cosmetic only.
- `TEAM_COLORS` only defines `red`/`blue`/`green`; `freezers`/`runners` will render in neutral grey via the fallback. Acceptable for a first demo; polish later if needed.
- Entity glyphs are switched on `entity_type` (the `id` field) in `frontend/src/lib/node-control-helpers.ts:86–95`. `freezer`/`runner` will render as the generic dot fallback. Acceptable.

## Files to Modify / Create

| Path | Change |
|---|---|
| `src/rules.rs` | Add `Predicate::ScoreAtLeast { team, min }` variant (~line 239) + eval arm (~line 443) + unit test (~line 1710) |
| `games/freeze_tag.json` | **Create new** — full config above |
| `src/games.rs` | Add `FREEZE_TAG_JSON` constant + `freeze_tag_parses_and_has_expected_shape` test + include in `all_shipped_configs_have_nonempty_entity_types` |
| `tests/game_config_load.rs` | Add `"freeze_tag"` to expected set |

## Verification

Per `README.md:37, 50, 92`:

1. **Unit tests first** — `cargo test` should pass including the new `score_at_least` test and the freeze_tag config parse test.
2. **Start the backend** — `cargo run -- serve` (add `--port 3001` if needed; `sudo` may be required per README).
3. **Start the frontend** — `cd frontend && bun install && bun run dev`.
4. **Confirm discovery** — `curl localhost:<port>/api/games` returns freeze_tag in the list.
5. **Run it** — propose `freeze_tag` via the consensus vote flow in the UI; four nodes each claim one freezer or one runner; Ready-Up gates until the 5 m placement constraint is satisfied.
6. **Confirm a tag scored** — watch the SSE stream (`src/web.rs` emits JSON frames) for:
   - `GameStateDelta` patches with `key: "tag_pulse_ms"` (tag_pulse rule firing).
   - `IncrementScore` events for team `freezers` (tag_score rule firing) — one per node per pulse.
7. **Confirm match end** — once `freezers` score reaches 5, a single `GameEnd` event should broadcast with `winner_team: "freezers"` and reason `"Freezers reached 5 tags"`.
