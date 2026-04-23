//! Per-node rules engine.
//!
//! Pure functions — no I/O, no locks. Called from the node's
//! `handle_vertex_message` for every incoming consensus event, and from the
//! 1 Hz `control_loop` tick.
//!
//! Phase C ships a skeleton that handles the cardinality check for
//! `EntityTypeClaim` (core of the bad-actor-resistance story). Phase D adds
//! placement-constraint evaluation. Phase E adds the full DSL with
//! `proximity_duration_s`, `tick`, scoring, and GameEnd.

use std::collections::HashMap;

use serde::Deserialize;

use crate::game_state::{EntityRecord, LocalGameState};
use crate::games::{GameConfig, Rule};
use crate::geom;
use crate::protocol::{GamePayload, Position, StatePatch, WireMessage};

pub struct RuleContext<'a> {
    pub game: &'a GameConfig,
    pub local: &'a LocalGameState,
    pub now_ms: u64,
}

#[derive(Debug, Clone)]
pub enum RuleDecision {
    Accept,
    Reject {
        rule_id: String,
        reason: String,
    },
    Emit {
        rule_id: String,
        patches: Vec<StatePatch>,
    },
    IncrementScore {
        rule_id: String,
        team: String,
        by: i64,
    },
    End {
        winner_team: Option<String>,
        reason: String,
    },
}

/// Maximum plausible per-second velocity for an entity, in metres. Used by
/// the `physically_plausible` predicate to flag fabricated `SensorReading`s.
/// Tuned generously: a player dragging across the 60m field in a single
/// 200ms UI frame is ~300 m/s; the field's realistic max is well under 50.
pub const MAX_PLAUSIBLE_VELOCITY_M_PER_S: f32 = 50.0;

/// Evaluate an incoming consensus event against the active game.
///
/// Returns a list of decisions. Cardinality violations on `EntityTypeClaim`
/// produce `Reject`; implausible physics on `SensorReading` produce `Reject`;
/// `on: sensor_reading` rules whose predicate matches produce `Emit`; the
/// default is a single `Accept`.
pub fn evaluate(ctx: &RuleContext, incoming: &WireMessage) -> Vec<RuleDecision> {
    let mut out = Vec::new();

    let Some(payload) = &incoming.game else {
        out.push(RuleDecision::Accept);
        return out;
    };

    match payload {
        GamePayload::EntityTypeClaim { entity_type, team } => {
            if let Some(reason) =
                reject_for_cardinality(ctx, &incoming.state.peer_id, entity_type, team)
            {
                out.push(RuleDecision::Reject {
                    rule_id: "cardinality".to_string(),
                    reason,
                });
            }
        }
        GamePayload::SensorReading { pos, observed_at_ms, .. } => {
            // Bad-actor rejection: refuse readings that claim physically
            // impossible movement relative to the entity's last-known pos.
            if let Some(reason) = reject_for_impossible_physics(
                ctx,
                &incoming.state.peer_id,
                *pos,
                *observed_at_ms,
            ) {
                out.push(RuleDecision::Reject {
                    rule_id: "physically_plausible".to_string(),
                    reason,
                });
                return out;
            }
            // Fire any `on: sensor_reading` rule. The proximity tracker is
            // expected to have been updated by `update_proximity` before this
            // evaluator runs.
            for rule in ctx.game.rules.iter().filter(|r| r.on == "sensor_reading") {
                if let Some(d) = fire_rule(ctx, rule, Some(&incoming.state.peer_id), None) {
                    out.push(d);
                }
            }
        }
        _ => {}
    }

    if out.is_empty() {
        out.push(RuleDecision::Accept);
    }
    out
}

/// Per-tick evaluation — called at 1 Hz from `control_loop`. Runs from the
/// local node's perspective: "self" is this node's entity.
pub fn tick(ctx: &RuleContext) -> Vec<RuleDecision> {
    let mut out = Vec::new();
    for rule in ctx.game.rules.iter().filter(|r| r.on == "tick") {
        if let Some(d) = fire_rule(ctx, rule, None, None) {
            out.push(d);
        }
    }
    out
}

/// Evaluate `on: game_state_delta` rules. Called after a `GameStateDelta`
/// arrives. `real_changes` holds the patches whose target entity actually
/// changed in the local pre-apply state (so `property_changed` doesn't fire
/// on no-op re-applies).
pub fn evaluate_delta(
    ctx: &RuleContext,
    sender_peer_id: &str,
    real_changes: &[StatePatch],
) -> Vec<RuleDecision> {
    if real_changes.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for rule in ctx.game.rules.iter().filter(|r| r.on == "game_state_delta") {
        if let Some(d) = fire_rule(ctx, rule, Some(sender_peer_id), Some(real_changes)) {
            out.push(d);
        }
    }
    out
}

// --- Rule predicate / effect DSL ---

/// Predicate AST. Anything a game rule's `when` block can express.
///
/// Every predicate is side-effect-free and terminating — no loops, no
/// arithmetic beyond the `increment` in effects, no cross-rule dependencies.
/// That keeps per-node evaluation deterministic: given the same ordered
/// event stream, every node reaches the same rule decisions.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Predicate {
    /// Conjunction — all child predicates must hold.
    All { of: Vec<Predicate> },
    /// Disjunction — any child predicate must hold.
    #[allow(dead_code)]
    Any { of: Vec<Predicate> },
    /// Negation.
    #[allow(dead_code)]
    Not { of: Box<Predicate> },
    /// `self`'s entity type matches `entity_type`.
    EntityIs { entity_type: String },
    /// Some peer entity of type `peer_entity_type` has been within `max_m` of
    /// `self` for at least `min_s` seconds continuously (tracked via
    /// `LocalGameState.proximity_tracker` keyed per rule).
    ProximityDurationS {
        peer_entity_type: String,
        max_m: f32,
        min_s: u64,
        /// When `true`, only peer entities sharing `self`'s team qualify.
        /// Both entities must have `Some(team)` — two `None`-team entities
        /// do *not* count as "same team."
        #[serde(default)]
        same_team: bool,
        /// When `true`, only peer entities on a *different* team qualify.
        /// Both must have `Some(team)`. Setting both `same_team` and
        /// `different_team` is contradictory and the predicate always fails.
        #[serde(default)]
        different_team: bool,
    },
    /// One of the patches applied in this evaluation changed `key` on an
    /// entity of `target_entity_type`. Meaningful only under
    /// `on: game_state_delta`.
    PropertyChanged {
        target_entity_type: String,
        key: String,
    },
    /// An entity of `target_entity_type` has `key` currently equal to
    /// `value`. Unknown entities fail silently — a value can't be "equal"
    /// if no candidate exists.
    #[allow(dead_code)]
    PropertyEquals {
        target_entity_type: String,
        key: String,
        value: serde_json::Value,
    },
    /// Every entity of `entity_type` is farther than `min_m` from `self`.
    /// Mirrors the `placement.requires` form so games can use it both at
    /// placement time and during play (e.g. "flag stays >20m from every
    /// base").
    #[allow(dead_code)]
    FartherThanMFrom {
        entity_type: String,
        min_m: f32,
    },
    /// DSL-exposed alias of the cardinality gate applied implicitly to every
    /// `EntityTypeClaim`. Fires (i.e. predicate returns `true`) when the
    /// incoming claim would push the cluster over the game's `max` for the
    /// `(entity_type, team)` tuple. Intended for use with a `reject` effect
    /// in a custom `on: entity_type_claim` rule.
    #[allow(dead_code)]
    CardinalityViolates {
        entity_type: String,
        #[serde(default)]
        team: Option<String>,
    },
    /// DSL-exposed alias of the physical-plausibility gate applied
    /// implicitly to every `SensorReading`. Evaluates the sender's claimed
    /// position/time against their last-known position; returns `true` if
    /// the implied velocity exceeds `max_velocity_m_per_s`. Intended with a
    /// `reject` effect; the implicit gate already uses the same thresholds
    /// (`MAX_PLAUSIBLE_VELOCITY_M_PER_S`) when no rule covers it.
    #[allow(dead_code)]
    PhysicallyPlausible {
        max_velocity_m_per_s: f32,
    },
    /// True once the current `Playing` phase has been running for at least
    /// `min_s` seconds. Start point is the consensus-pinned
    /// `countdown_zero_ns + 3_000_000_000ns` moment that `handle_vertex_message`
    /// uses to flip `CountingDown → Playing`, so every node computes an
    /// identical elapsed time from the same anchor. If no countdown has been
    /// pinned yet (game hasn't started, or `countdown_zero_ns` is `None`), the
    /// predicate is `false`.
    GameTimeElapsedS { min_s: u64 },
    /// True once `ctx.local.scores[team]` ≥ `min`. Intended as the trigger
    /// for an `end_game` effect anchored on a neutral/stable entity so only
    /// one node broadcasts the `GameEnd`. Missing team key counts as 0.
    ScoreAtLeast { team: String, min: i64 },
    /// True when `self_entity.properties[key]` is a number and
    /// `ctx.now_ms - value < max_age_ms`. Intended for self-scoped "am I
    /// recently flagged?" checks — e.g. "am I currently frozen" (property
    /// set within the last 30s) so a rule can gate on its own time-bounded
    /// state without needing to clear the property at expiry. Missing or
    /// non-numeric properties evaluate to `false`.
    PropertyAgeMs { key: String, max_age_ms: u64 },
    /// True when *every* entity of `entity_type` has `properties[key]` set
    /// to a number within the last `max_age_ms` of `ctx.now_ms`. Empty
    /// matching sets evaluate to `false` (vacuously-true would be a surprise
    /// for callers gating win-conditions on population counts). Intended for
    /// aggregate "have all runners been frozen simultaneously?" checks.
    AllEntitiesPropertyRecent {
        entity_type: String,
        key: String,
        max_age_ms: u64,
    },
}

/// Effect AST. Anything a game rule's `effect` block can express.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Effect {
    /// Set a property on every entity of `target_entity_type`. The `value`
    /// may be the literal `"self.team"` which resolves to the triggering
    /// actor's team at evaluation time.
    SetProperty {
        target_entity_type: String,
        key: String,
        value: serde_json::Value,
    },
    /// Set a property on *only* the self-entity (the entity the rule is
    /// currently evaluating against). Unlike `SetProperty`, this emits a
    /// single per-peer patch. Intended for per-entity state that must be
    /// kept distinct between instances of the same entity type — e.g.
    /// freeze_tag's per-runner `frozen_since_ms` timestamp. `value` accepts
    /// the same `"self.team"` / `"now_ms"` templates as `SetProperty`.
    SetPropertyOnSelf {
        key: String,
        value: serde_json::Value,
    },
    /// Increment `team`'s score by `by`. `team` may be the literal
    /// `"self.team"` to use the triggering actor's team.
    IncrementScore {
        team: String,
        #[serde(default = "one")]
        by: i64,
    },
    /// End the game. `winner_team` can be a fixed string, the literal
    /// `"self.team"` (resolves to the triggering actor's team), or null.
    EndGame {
        #[serde(default)]
        winner_team: Option<String>,
        reason: String,
    },
    /// Reject the incoming message with a human-readable reason. The rule's
    /// `id` becomes the `RuleDecision::Reject.rule_id`. Intended for use
    /// with predicates like `cardinality_violates` or `physically_plausible`
    /// when a game wants to customise rejection messages.
    #[allow(dead_code)]
    Reject { reason: String },
    /// Broadcast a pre-computed delta without modifying any specific entity
    /// type. Lets a game author stage a manual patch set; the runtime wraps
    /// the patches in a `GameStateDelta` message. Rarely needed — `set_property`
    /// is usually preferable — but exposed for DSL completeness.
    #[allow(dead_code)]
    BroadcastDelta { patches: Vec<StatePatch> },
}

fn one() -> i64 {
    1
}

/// Evaluate one rule. `trigger_peer_id` is the "self" perspective: for
/// `on: sensor_reading` it's the sender of the reading; for `on: tick` it's
/// the local node; for `on: game_state_delta` it's the sender of the delta.
/// `real_changes` is only populated for `game_state_delta` triggers.
fn fire_rule(
    ctx: &RuleContext,
    rule: &Rule,
    trigger_peer_id: Option<&str>,
    real_changes: Option<&[StatePatch]>,
) -> Option<RuleDecision> {
    // Resolve "self" entity — the perspective this rule evaluates from.
    let self_peer_id = trigger_peer_id.unwrap_or(&ctx.local.peer_id);
    let self_entity = ctx
        .local
        .entities
        .values()
        .find(|e| e.peer_id == self_peer_id)?;
    if self_entity.entity_type.is_none() {
        // "Self" hasn't claimed anything yet — rule doesn't apply.
        return None;
    }

    let predicate: Predicate = match serde_json::from_value(rule.when.clone()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "[rules] malformed when in '{}' of '{}': {}",
                rule.id, ctx.game.id, e
            );
            return None;
        }
    };

    if !eval_predicate(&predicate, ctx, self_entity, rule, real_changes) {
        return None;
    }

    let effect: Effect = match serde_json::from_value(rule.effect.clone()) {
        Ok(e) => e,
        Err(e) => {
            eprintln!(
                "[rules] malformed effect in '{}' of '{}': {}",
                rule.id, ctx.game.id, e
            );
            return None;
        }
    };

    Some(apply_effect(&effect, self_entity, ctx, &rule.id))
}

fn eval_predicate(
    p: &Predicate,
    ctx: &RuleContext,
    self_entity: &EntityRecord,
    rule: &Rule,
    real_changes: Option<&[StatePatch]>,
) -> bool {
    match p {
        Predicate::All { of } => of
            .iter()
            .all(|q| eval_predicate(q, ctx, self_entity, rule, real_changes)),
        Predicate::Any { of } => of
            .iter()
            .any(|q| eval_predicate(q, ctx, self_entity, rule, real_changes)),
        Predicate::Not { of } => !eval_predicate(of, ctx, self_entity, rule, real_changes),
        Predicate::EntityIs { entity_type } => {
            self_entity.entity_type.as_deref() == Some(entity_type.as_str())
        }
        Predicate::ProximityDurationS { peer_entity_type, max_m: _, min_s, same_team, different_team } => {
            // Proximity tracker is maintained by `update_proximity`. A key
            // exists iff the pair has been within the rule's max_m continuously.
            // We check the tracker for any peer of `peer_entity_type` whose
            // entry's age >= min_s.
            let threshold_ms = min_s.saturating_mul(1000);
            ctx.local
                .entities
                .values()
                .filter(|e| e.entity_type.as_deref() == Some(peer_entity_type.as_str()))
                .filter(|peer| {
                    if *same_team {
                        matches!((&self_entity.team, &peer.team), (Some(st), Some(pt)) if st == pt)
                    } else if *different_team {
                        matches!((&self_entity.team, &peer.team), (Some(st), Some(pt)) if st != pt)
                    } else {
                        true
                    }
                })
                .any(|peer| {
                    let key = proximity_key(&rule.id, &self_entity.label, &peer.label);
                    ctx.local
                        .proximity_tracker
                        .get(&key)
                        .map(|start| ctx.now_ms.saturating_sub(*start) >= threshold_ms)
                        .unwrap_or(false)
                })
        }
        Predicate::PropertyChanged { target_entity_type, key } => {
            let Some(changes) = real_changes else { return false };
            changes.iter().any(|patch| {
                if patch.key != *key {
                    return false;
                }
                ctx.local
                    .entities
                    .values()
                    .any(|e| {
                        e.peer_id == patch.target_peer_id
                            && e.entity_type.as_deref() == Some(target_entity_type.as_str())
                    })
            })
        }
        Predicate::PropertyEquals { target_entity_type, key, value } => {
            // Fail silently on unknown entity — consistent with the plan's
            // "unknown-entity predicates fail silently" rule.
            ctx.local.entities.values().any(|e| {
                e.entity_type.as_deref() == Some(target_entity_type.as_str())
                    && e.properties.get(key) == Some(value)
            })
        }
        Predicate::FartherThanMFrom { entity_type, min_m } => {
            let Some(my_pos) = self_entity.pos else { return false };
            // Every entity of `entity_type` must be farther than `min_m`
            // from `self`. Matches the placement-constraint semantics.
            ctx.local.entities.values().all(|e| {
                if e.entity_type.as_deref() != Some(entity_type.as_str()) {
                    return true;
                }
                match e.pos {
                    Some(p) => !geom::in_range(my_pos, p, *min_m),
                    None => true,
                }
            })
        }
        Predicate::CardinalityViolates { .. } | Predicate::PhysicallyPlausible { .. } => {
            // These DSL leaves intentionally match the implicit gates run by
            // `evaluate()` directly (see `reject_for_cardinality` and
            // `reject_for_impossible_physics`). Evaluating them here inside
            // a `fire_rule` context doesn't make sense without access to
            // the inbound wire — the implicit gates cover the expected
            // cases. Treat as `false` so a rule carrying them never fires
            // spuriously.
            false
        }
        Predicate::GameTimeElapsedS { min_s } => {
            // Anchor is `countdown_zero_ns + 3s` — the consensus timestamp at
            // which `handle_vertex_message` flipped the phase to `Playing`.
            // Nanoseconds since UNIX epoch are directly comparable to the
            // millisecond-precision `now_ms` supplied by the runtime (both
            // derive from the same wall clock), so converting the anchor ns →
            // ms and subtracting gives a consistent elapsed-play duration.
            let Some(zero_ns) = ctx.local.countdown_zero_ns else {
                return false;
            };
            let start_ns = zero_ns.saturating_add(3_000_000_000);
            let start_ms = (start_ns / 1_000_000) as u64;
            let elapsed_ms = ctx.now_ms.saturating_sub(start_ms);
            elapsed_ms >= min_s.saturating_mul(1_000)
        }
        Predicate::ScoreAtLeast { team, min } => {
            ctx.local.scores.get(team).copied().unwrap_or(0) >= *min
        }
        Predicate::PropertyAgeMs { key, max_age_ms } => {
            // Self-scoped: read the property off `self_entity`. Missing or
            // non-numeric values are `false` — a runner who was never frozen
            // shouldn't match "am I currently frozen".
            let Some(v) = self_entity.properties.get(key) else {
                return false;
            };
            let Some(ts) = v.as_u64() else {
                return false;
            };
            ctx.now_ms.saturating_sub(ts) < *max_age_ms
        }
        Predicate::AllEntitiesPropertyRecent {
            entity_type,
            key,
            max_age_ms,
        } => {
            // Aggregate across every entity of the given type. Requires at
            // least one match and every match's property to be a numeric
            // timestamp within the window. Empty sets are `false` so a
            // "freezers win when all runners frozen" rule doesn't fire before
            // any runner has even claimed.
            let mut saw_any = false;
            for e in ctx.local.entities.values() {
                if e.entity_type.as_deref() != Some(entity_type.as_str()) {
                    continue;
                }
                saw_any = true;
                let Some(v) = e.properties.get(key) else {
                    return false;
                };
                let Some(ts) = v.as_u64() else {
                    return false;
                };
                if ctx.now_ms.saturating_sub(ts) >= *max_age_ms {
                    return false;
                }
            }
            saw_any
        }
    }
}

fn apply_effect(
    e: &Effect,
    self_entity: &EntityRecord,
    ctx: &RuleContext,
    rule_id: &str,
) -> RuleDecision {
    match e {
        Effect::SetProperty { target_entity_type, key, value } => {
            let resolved = resolve_template(value, self_entity, ctx);
            // Emit one patch per entity matching target_entity_type.
            let patches: Vec<StatePatch> = ctx
                .local
                .entities
                .values()
                .filter(|e| e.entity_type.as_deref() == Some(target_entity_type.as_str()))
                .map(|e| StatePatch {
                    target_peer_id: e.peer_id.clone(),
                    key: key.clone(),
                    value: resolved.clone(),
                })
                .collect();
            RuleDecision::Emit { rule_id: rule_id.to_string(), patches }
        }
        Effect::SetPropertyOnSelf { key, value } => {
            // Exactly one patch, targeted at the self-entity's peer. This is
            // the "per-entity" counterpart to SetProperty — used when two
            // instances of the same entity type need independent state
            // (e.g. two runners each with their own `frozen_since_ms`).
            let resolved = resolve_template(value, self_entity, ctx);
            let patches = vec![StatePatch {
                target_peer_id: self_entity.peer_id.clone(),
                key: key.clone(),
                value: resolved,
            }];
            RuleDecision::Emit { rule_id: rule_id.to_string(), patches }
        }
        Effect::IncrementScore { team, by } => {
            let resolved_team = if team == "self.team" {
                self_entity.team.clone().unwrap_or_default()
            } else {
                team.clone()
            };
            RuleDecision::IncrementScore {
                rule_id: rule_id.to_string(),
                team: resolved_team,
                by: *by,
            }
        }
        Effect::EndGame { winner_team, reason } => {
            // Special winner_team resolvers:
            //   * `"self.team"` — use the triggering actor's team.
            //   * `"highest_score"` — pick the team with the strictly highest
            //     score in `ctx.local.scores`. Ties resolve to `None` so the
            //     UI can render "draw" rather than picking arbitrarily.
            //   * any other string — used verbatim.
            let resolved = match winner_team.as_deref() {
                Some("self.team") => self_entity.team.clone(),
                Some("highest_score") => highest_scoring_team(ctx),
                Some(other) => Some(other.to_string()),
                None => None,
            };
            RuleDecision::End {
                winner_team: resolved,
                reason: reason.clone(),
            }
        }
        Effect::Reject { reason } => RuleDecision::Reject {
            rule_id: rule_id.to_string(),
            reason: reason.clone(),
        },
        Effect::BroadcastDelta { patches } => RuleDecision::Emit {
            rule_id: rule_id.to_string(),
            patches: patches.clone(),
        },
    }
}

/// Resolve a templated effect value against the current rule context.
///
/// Supported string templates:
///   * `"self.team"` — replaced with the triggering actor's team (empty
///     string if they're teamless).
///   * `"now_ms"` — replaced with `ctx.now_ms` as a JSON number. Useful for
///     "pulse" rules whose `set_property` must emit a new value every tick
///     so `property_changed` fires on the delta side. Single-source (only
///     the rule's originating node emits), so nodes don't diverge on the
///     value.
///
/// Any other value is returned unchanged.
fn resolve_template(
    v: &serde_json::Value,
    self_entity: &EntityRecord,
    ctx: &RuleContext,
) -> serde_json::Value {
    if let Some(s) = v.as_str() {
        if s == "self.team" {
            return serde_json::Value::String(self_entity.team.clone().unwrap_or_default());
        }
        if s == "now_ms" {
            return serde_json::Value::Number(serde_json::Number::from(ctx.now_ms));
        }
    }
    v.clone()
}

/// Pick the team with the strictly highest `ctx.local.scores` value, skipping
/// bookkeeping keys (prefixed `__`). Returns `None` when no team has scored
/// or when the top score is tied across multiple teams — callers (e.g.
/// `end_game`) then render this as a draw.
fn highest_scoring_team(ctx: &RuleContext) -> Option<String> {
    let mut top: Option<(String, i64)> = None;
    let mut tied = false;
    for (team, score) in &ctx.local.scores {
        if team.starts_with("__") {
            continue;
        }
        match &top {
            Some((_, best)) if *score > *best => {
                top = Some((team.clone(), *score));
                tied = false;
            }
            Some((_, best)) if *score == *best => {
                tied = true;
            }
            None => top = Some((team.clone(), *score)),
            _ => {}
        }
    }
    if tied {
        return None;
    }
    top.map(|(t, _)| t)
}

// --- Proximity tracker maintenance ---

/// Refresh the proximity tracker on `LocalGameState` against the current
/// entity positions. Called before each rule evaluation pass. Keys are
/// rule-scoped (`"<rule_id>|<labelA>|<labelB>"` with A<B) so rules with
/// different `max_m` thresholds don't interfere.
pub fn update_proximity(
    state: &mut LocalGameState,
    game: &GameConfig,
    now_ms: u64,
) {
    // Collect rule-specific thresholds up front.
    let mut prox_rules: Vec<ProximityTrack> = Vec::new();
    for rule in &game.rules {
        let Ok(pred) = serde_json::from_value::<Predicate>(rule.when.clone()) else { continue };
        collect_proximity_predicates(&pred, &rule.id, &mut prox_rules);
    }
    if prox_rules.is_empty() {
        // Nothing to maintain — shed any stale entries to avoid unbounded growth.
        state.proximity_tracker.clear();
        return;
    }

    // Build the set of currently-maintained keys so we can evict stale ones.
    let mut alive: std::collections::HashSet<String> = std::collections::HashSet::new();

    let entities: Vec<EntityRecord> = state.entities.values().cloned().collect();
    for r in &prox_rules {
        // Find all (self, peer) pairs where self matches `entity_is` and peer
        // matches `peer_entity_type`.
        for s_entity in entities
            .iter()
            .filter(|e| e.entity_type.as_deref() == Some(r.self_type.as_str()))
        {
            let Some(s_pos) = s_entity.pos else { continue };
            for p_entity in entities
                .iter()
                .filter(|e| e.entity_type.as_deref() == Some(r.peer_type.as_str()))
            {
                if p_entity.peer_id == s_entity.peer_id {
                    continue;
                }
                // Team filtering — must match eval_predicate semantics.
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
                let Some(p_pos) = p_entity.pos else { continue };
                let key = proximity_key(&r.rule_id, &s_entity.label, &p_entity.label);
                if geom::in_range(s_pos, p_pos, r.max_m) {
                    // Insert start time on entry; preserve existing start on
                    // continued proximity. Idempotent.
                    state.proximity_tracker.entry(key.clone()).or_insert(now_ms);
                    alive.insert(key);
                }
                // When NOT in range we don't insert — and the eviction pass
                // below drops the key if it existed.
            }
        }
    }

    state.proximity_tracker.retain(|k, _| alive.contains(k));
}

/// Walk a predicate tree and collect every `proximity_duration_s` predicate
/// along with the `entity_is` "self" type it's paired with (if any). Used by
/// `update_proximity` to know which pairs to track.
fn collect_proximity_predicates(
    pred: &Predicate,
    rule_id: &str,
    out: &mut Vec<ProximityTrack>,
) {
    match pred {
        Predicate::All { of } | Predicate::Any { of } => {
            // Pair any `entity_is` sibling with every `proximity_duration_s`
            // sibling. Matches the current DSL usage in all three games.
            let self_type = of.iter().find_map(|p| match p {
                Predicate::EntityIs { entity_type } => Some(entity_type.clone()),
                _ => None,
            });
            for child in of {
                if let Predicate::ProximityDurationS {
                    peer_entity_type,
                    max_m,
                    min_s: _,
                    same_team,
                    different_team,
                } = child
                {
                    if let Some(st) = &self_type {
                        out.push(ProximityTrack {
                            rule_id: rule_id.to_string(),
                            self_type: st.clone(),
                            peer_type: peer_entity_type.clone(),
                            max_m: *max_m,
                            same_team: *same_team,
                            different_team: *different_team,
                        });
                    }
                }
                collect_proximity_predicates(child, rule_id, out);
            }
        }
        Predicate::Not { of } => collect_proximity_predicates(of, rule_id, out),
        _ => {}
    }
}

struct ProximityTrack {
    rule_id: String,
    self_type: String,
    peer_type: String,
    max_m: f32,
    same_team: bool,
    different_team: bool,
}

fn proximity_key(rule_id: &str, label_a: &str, label_b: &str) -> String {
    let (lo, hi) = if label_a <= label_b {
        (label_a, label_b)
    } else {
        (label_b, label_a)
    };
    format!("{rule_id}|{lo}|{hi}")
}

// --- Bad-actor rejection: physically_plausible ---

fn reject_for_impossible_physics(
    ctx: &RuleContext,
    sender_peer_id: &str,
    new_pos: Position,
    observed_at_ms: u64,
) -> Option<String> {
    let entity = ctx.local.entities.values().find(|e| e.peer_id == sender_peer_id)?;
    let last_pos = entity.pos?;
    let last_ms = entity.last_seen_ms;
    if observed_at_ms <= last_ms {
        return None;
    }
    let dt_s = (observed_at_ms - last_ms) as f32 / 1000.0;
    if dt_s <= 0.0 {
        return None;
    }
    let d = geom::dist(last_pos, new_pos);
    let v = d / dt_s;
    if v > MAX_PLAUSIBLE_VELOCITY_M_PER_S {
        return Some(format!(
            "implausible velocity {v:.1} m/s (moved {d:.2}m in {dt_s:.3}s; max {MAX_PLAUSIBLE_VELOCITY_M_PER_S})"
        ));
    }
    None
}

fn reject_for_cardinality(
    ctx: &RuleContext,
    claimer_peer_id: &str,
    entity_type: &str,
    team: &Option<String>,
) -> Option<String> {
    // Find the entity-type definition.
    let Some(etype) = ctx.game.entity_types.iter().find(|e| e.id == entity_type) else {
        return Some(format!(
            "entity_type '{entity_type}' not defined by game '{}'",
            ctx.game.id
        ));
    };

    // Validate team value against game spec.
    match (etype.team.as_deref(), team) {
        (None, None) => {} // teamless entity — OK.
        (None, Some(t)) => {
            return Some(format!(
                "entity_type '{entity_type}' is teamless; got team={t}"
            ));
        }
        (Some("per_team"), None) => {
            return Some(format!(
                "entity_type '{entity_type}' requires a team; none given"
            ));
        }
        (Some("per_team"), Some(t)) => {
            if !ctx.game.teams.iter().any(|gt| gt == t) {
                return Some(format!(
                    "team '{t}' not defined by game '{}' (valid: {})",
                    ctx.game.id,
                    ctx.game.teams.join(", ")
                ));
            }
        }
        (Some(fixed), Some(t)) if fixed == t => {} // matches fixed team
        (Some(fixed), Some(t)) => {
            return Some(format!(
                "entity_type '{entity_type}' requires team={fixed}; got team={t}"
            ));
        }
        (Some(fixed), None) => {
            return Some(format!(
                "entity_type '{entity_type}' requires team={fixed}; none given"
            ));
        }
    }

    // Count existing claims for this (type, team) tuple, excluding the
    // claimer themselves (so they can re-broadcast their own claim).
    let already = count_claims(&ctx.local.entities, entity_type, team.as_deref(), claimer_peer_id);
    if already >= etype.max as usize {
        return Some(format!(
            "{entity_type}{} already at max cardinality ({})",
            team.as_ref().map(|t| format!("/{t}")).unwrap_or_default(),
            etype.max
        ));
    }

    None
}

fn count_claims(
    entities: &HashMap<String, EntityRecord>,
    entity_type: &str,
    team: Option<&str>,
    exclude_peer_id: &str,
) -> usize {
    entities
        .values()
        .filter(|e| e.peer_id != exclude_peer_id)
        .filter(|e| e.entity_type.as_deref() == Some(entity_type))
        .filter(|e| match team {
            Some(t) => e.team.as_deref() == Some(t),
            None => e.team.is_none(),
        })
        .count()
}

// --- Placement constraint evaluation ---

/// Parsed form of a `placement.requires` clause. Kept in lockstep with the
/// JSON schema documented in `games/*.json`. Unknown `kind` values fail
/// parsing, which is intentional — silently passing unrecognised rules would
/// let Ready-Up succeed on broken configs.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PlacementRequire {
    /// My entity must be within `max_m` of at least one entity of
    /// `entity_type`. If `same_team` is set, only entities sharing my team
    /// count.
    WithinMOf {
        entity: String,
        #[serde(default)]
        same_team: bool,
        max_m: f32,
    },
    /// My entity must be farther than `min_m` from *every* entity of
    /// `entity_type` (i.e. no such entity within `min_m`).
    FartherThanMFrom { entity: String, min_m: f32 },
}

/// Evaluate whether the given local node's entity satisfies all placement
/// constraints. Returns `false` if the node has no claimed entity yet, if
/// its position is unknown, or if any rule that targets its entity type is
/// unsatisfied. Rules that don't target my entity type are ignored.
///
/// This is the `placement_ok` flag surfaced to the UI — the Ready-Up button
/// is disabled until every applicable rule passes.
pub fn evaluate_placement(
    game: &GameConfig,
    local_label: &str,
    entities: &HashMap<String, EntityRecord>,
) -> bool {
    let Some(my_entity) = entities.get(local_label) else { return false };
    let Some(my_type) = my_entity.entity_type.as_deref() else { return false };
    let Some(my_pos) = my_entity.pos else { return false };

    for rule in &game.placement {
        if rule.entity != my_type {
            continue;
        }
        let parsed: PlacementRequire = match serde_json::from_value(rule.requires.clone()) {
            Ok(p) => p,
            Err(e) => {
                eprintln!(
                    "[rules] malformed placement.requires for '{}' in '{}': {}",
                    rule.entity, game.id, e
                );
                return false;
            }
        };
        if !satisfies(&parsed, my_entity, my_pos, entities) {
            return false;
        }
    }
    true
}

fn satisfies(
    req: &PlacementRequire,
    my_entity: &EntityRecord,
    my_pos: crate::protocol::Position,
    entities: &HashMap<String, EntityRecord>,
) -> bool {
    match req {
        PlacementRequire::WithinMOf {
            entity,
            same_team,
            max_m,
        } => entities.values().any(|e| {
            if e.entity_type.as_deref() != Some(entity.as_str()) {
                return false;
            }
            if *same_team && e.team != my_entity.team {
                return false;
            }
            match e.pos {
                Some(p) => geom::in_range(my_pos, p, *max_m),
                None => false,
            }
        }),
        PlacementRequire::FartherThanMFrom { entity, min_m } => entities.values().all(|e| {
            if e.entity_type.as_deref() != Some(entity.as_str()) {
                return true; // not a target — doesn't constrain
            }
            match e.pos {
                Some(p) => !geom::in_range(my_pos, p, *min_m),
                None => true, // unknown position can't be proved too-close
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctf_config() -> GameConfig {
        GameConfig {
            id: "ctf".into(),
            name: "CTF".into(),
            teams: vec!["red".into(), "blue".into()],
            entity_types: vec![
                crate::games::EntityTypeDef { id: "flag".into(), min: 1, max: 1, team: None, visual: None },
                crate::games::EntityTypeDef { id: "base".into(), min: 1, max: 1, team: Some("per_team".into()), visual: None },
                crate::games::EntityTypeDef { id: "player".into(), min: 2, max: 4, team: Some("per_team".into()), visual: None },
            ],
            placement: vec![],
            rules: vec![],
            duration_s: None,
            obstacles: vec![],
        }
    }

    fn blank_state() -> LocalGameState {
        LocalGameState::new("agent-a".into(), "PK_A".into(), None)
    }

    #[test]
    fn accepts_first_flag_claim() {
        let game = ctf_config();
        let mut state = blank_state();
        state.active_game_id = Some("ctf".into());
        let ctx = RuleContext { game: &game, local: &state, now_ms: 0 };
        let wire = WireMessage {
            kind: crate::protocol::MessageKind::EntityTypeClaim,
            message_id: "m1".into(),
            sent_at_ms: 0,
            state: crate::protocol::SharedState { peer_id: "PK_A".into(), last_seen_ms: 0, status: "".into() },
            note: None,
            game: Some(GamePayload::EntityTypeClaim { entity_type: "flag".into(), team: None }),
        };
        let decisions = evaluate(&ctx, &wire);
        assert!(matches!(decisions.as_slice(), [RuleDecision::Accept]));
    }

    #[test]
    fn rejects_second_flag() {
        let game = ctf_config();
        let mut state = blank_state();
        state.active_game_id = Some("ctf".into());
        // Pretend another peer already claimed flag.
        state.entities.insert(
            "agent-b".into(),
            EntityRecord {
                label: "agent-b".into(),
                peer_id: "PK_B".into(),
                entity_type: Some("flag".into()),
                team: None,
                ..Default::default()
            },
        );
        let ctx = RuleContext { game: &game, local: &state, now_ms: 0 };
        let wire = WireMessage {
            kind: crate::protocol::MessageKind::EntityTypeClaim,
            message_id: "m1".into(),
            sent_at_ms: 0,
            state: crate::protocol::SharedState { peer_id: "PK_A".into(), last_seen_ms: 0, status: "".into() },
            note: None,
            game: Some(GamePayload::EntityTypeClaim { entity_type: "flag".into(), team: None }),
        };
        let decisions = evaluate(&ctx, &wire);
        assert!(matches!(decisions.as_slice(), [RuleDecision::Reject { .. }]));
    }

    fn ctf_with_placement() -> GameConfig {
        GameConfig {
            id: "ctf".into(),
            name: "CTF".into(),
            teams: vec!["red".into(), "blue".into()],
            entity_types: vec![
                crate::games::EntityTypeDef { id: "flag".into(), min: 1, max: 1, team: None, visual: None },
                crate::games::EntityTypeDef { id: "base".into(), min: 1, max: 1, team: Some("per_team".into()), visual: None },
                crate::games::EntityTypeDef { id: "player".into(), min: 2, max: 4, team: Some("per_team".into()), visual: None },
            ],
            placement: vec![
                crate::games::PlacementRule {
                    entity: "player".into(),
                    requires: serde_json::json!({
                        "kind": "within_m_of",
                        "entity": "base",
                        "same_team": true,
                        "max_m": 2.0,
                    }),
                },
                crate::games::PlacementRule {
                    entity: "flag".into(),
                    requires: serde_json::json!({
                        "kind": "farther_than_m_from",
                        "entity": "base",
                        "min_m": 20.0,
                    }),
                },
            ],
            rules: vec![],
            duration_s: None,
            obstacles: vec![],
        }
    }

    fn entity(label: &str, peer_id: &str, t: Option<&str>, team: Option<&str>, pos: Option<(f32, f32)>) -> EntityRecord {
        EntityRecord {
            label: label.into(),
            peer_id: peer_id.into(),
            entity_type: t.map(str::to_string),
            team: team.map(str::to_string),
            pos: pos.map(|(x, y)| crate::protocol::Position { x, y }),
            ..Default::default()
        }
    }

    #[test]
    fn placement_false_when_no_entity_claimed() {
        let game = ctf_with_placement();
        let mut entities = HashMap::new();
        entities.insert("me".into(), entity("me", "PK", None, None, Some((10.0, 10.0))));
        assert!(!evaluate_placement(&game, "me", &entities));
    }

    #[test]
    fn placement_false_when_position_missing() {
        let game = ctf_with_placement();
        let mut entities = HashMap::new();
        entities.insert("me".into(), entity("me", "PK", Some("player"), Some("red"), None));
        assert!(!evaluate_placement(&game, "me", &entities));
    }

    #[test]
    fn placement_true_when_no_rule_targets_my_type() {
        // Base has no placement rule in CTF → always satisfied.
        let game = ctf_with_placement();
        let mut entities = HashMap::new();
        entities.insert("me".into(), entity("me", "PK", Some("base"), Some("red"), Some((5.0, 5.0))));
        assert!(evaluate_placement(&game, "me", &entities));
    }

    #[test]
    fn player_within_m_of_same_team_base() {
        let game = ctf_with_placement();
        let mut entities = HashMap::new();
        // Red player at (5,5); red base at (6,5): dist=1.0 <= 2.0 → ok.
        entities.insert("me".into(), entity("me", "PK", Some("player"), Some("red"), Some((5.0, 5.0))));
        entities.insert("base_r".into(), entity("base_r", "PK_BR", Some("base"), Some("red"), Some((6.0, 5.0))));
        entities.insert("base_b".into(), entity("base_b", "PK_BB", Some("base"), Some("blue"), Some((5.5, 5.0))));
        assert!(evaluate_placement(&game, "me", &entities));
    }

    #[test]
    fn player_not_within_m_of_same_team_base_fails() {
        // Red player at (5,5); red base at (50,50) → dist >> 2.0 → fail.
        let game = ctf_with_placement();
        let mut entities = HashMap::new();
        entities.insert("me".into(), entity("me", "PK", Some("player"), Some("red"), Some((5.0, 5.0))));
        entities.insert("base_r".into(), entity("base_r", "PK_BR", Some("base"), Some("red"), Some((50.0, 50.0))));
        // Blue base is close but wrong team.
        entities.insert("base_b".into(), entity("base_b", "PK_BB", Some("base"), Some("blue"), Some((5.5, 5.0))));
        assert!(!evaluate_placement(&game, "me", &entities));
    }

    #[test]
    fn flag_farther_than_min_m_from_every_base() {
        let game = ctf_with_placement();
        let mut entities = HashMap::new();
        // Flag at (30,15); bases at (5,15) and (55,15). Min dist 25m > 20m → ok.
        entities.insert("me".into(), entity("me", "PK", Some("flag"), None, Some((30.0, 15.0))));
        entities.insert("base_r".into(), entity("base_r", "PK_BR", Some("base"), Some("red"), Some((5.0, 15.0))));
        entities.insert("base_b".into(), entity("base_b", "PK_BB", Some("base"), Some("blue"), Some((55.0, 15.0))));
        assert!(evaluate_placement(&game, "me", &entities));
    }

    #[test]
    fn flag_too_close_to_any_base_fails() {
        let game = ctf_with_placement();
        let mut entities = HashMap::new();
        // Flag 10m from red base — fails.
        entities.insert("me".into(), entity("me", "PK", Some("flag"), None, Some((15.0, 15.0))));
        entities.insert("base_r".into(), entity("base_r", "PK_BR", Some("base"), Some("red"), Some((5.0, 15.0))));
        entities.insert("base_b".into(), entity("base_b", "PK_BB", Some("base"), Some("blue"), Some((55.0, 15.0))));
        assert!(!evaluate_placement(&game, "me", &entities));
    }

    #[test]
    fn placement_empty_rules_always_true_for_claimed_entity() {
        // Territory has no placement rules at all.
        let mut game = ctf_with_placement();
        game.placement.clear();
        let mut entities = HashMap::new();
        entities.insert("me".into(), entity("me", "PK", Some("player"), Some("red"), Some((100.0, 100.0))));
        assert!(evaluate_placement(&game, "me", &entities));
    }

    #[test]
    fn rejects_teamless_value_when_team_required() {
        let game = ctf_config();
        let state = blank_state();
        let ctx = RuleContext { game: &game, local: &state, now_ms: 0 };
        let wire = WireMessage {
            kind: crate::protocol::MessageKind::EntityTypeClaim,
            message_id: "m1".into(),
            sent_at_ms: 0,
            state: crate::protocol::SharedState { peer_id: "PK_A".into(), last_seen_ms: 0, status: "".into() },
            note: None,
            game: Some(GamePayload::EntityTypeClaim { entity_type: "player".into(), team: None }),
        };
        let decisions = evaluate(&ctx, &wire);
        assert!(matches!(decisions.as_slice(), [RuleDecision::Reject { .. }]));
    }

    // --- Phase E tests: proximity, sensor_reading, delta, physics ---

    fn ctf_with_rules() -> GameConfig {
        let mut g = ctf_with_placement();
        g.rules = vec![
            crate::games::Rule {
                id: "flag_capture".into(),
                on: "sensor_reading".into(),
                when: serde_json::json!({
                    "kind": "all",
                    "of": [
                        { "kind": "entity_is", "entity_type": "player" },
                        { "kind": "proximity_duration_s", "peer_entity_type": "flag", "max_m": 1.0, "min_s": 10 }
                    ]
                }),
                effect: serde_json::json!({
                    "kind": "set_property",
                    "target_entity_type": "flag",
                    "key": "owner_team",
                    "value": "self.team"
                }),
            },
            crate::games::Rule {
                id: "score_capture".into(),
                on: "game_state_delta".into(),
                when: serde_json::json!({
                    "kind": "property_changed",
                    "target_entity_type": "flag",
                    "key": "owner_team"
                }),
                effect: serde_json::json!({
                    "kind": "increment_score",
                    "team": "self.team",
                    "by": 1
                }),
            },
        ];
        g
    }

    fn sensor_wire(sender_peer_id: &str, pos: (f32, f32), observed_at_ms: u64) -> WireMessage {
        WireMessage {
            kind: crate::protocol::MessageKind::SensorReading,
            message_id: format!("sr-{}-{observed_at_ms}", sender_peer_id),
            sent_at_ms: observed_at_ms,
            state: crate::protocol::SharedState {
                peer_id: sender_peer_id.into(),
                last_seen_ms: observed_at_ms,
                status: "".into(),
            },
            note: None,
            game: Some(GamePayload::SensorReading {
                pos: crate::protocol::Position { x: pos.0, y: pos.1 },
                readings: vec![],
                observed_at_ms,
            }),
        }
    }

    #[test]
    fn proximity_tracker_accrues_then_resets() {
        let game = ctf_with_rules();
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        state.entities.insert("me".into(), entity("me", "PK_ME", Some("player"), Some("red"), Some((0.0, 0.0))));
        state.entities.insert("flg".into(), entity("flg", "PK_FLG", Some("flag"), None, Some((0.5, 0.0))));

        // t=1000ms: pair within 1m, tracker gets entry with start=1000.
        update_proximity(&mut state, &game, 1000);
        let key = proximity_key("flag_capture", "flg", "me");
        assert_eq!(state.proximity_tracker.get(&key), Some(&1000));

        // t=5000ms: still within 1m, start should remain 1000.
        update_proximity(&mut state, &game, 5000);
        assert_eq!(state.proximity_tracker.get(&key), Some(&1000));

        // Move flag out of range; tracker drops entry.
        state.entities.get_mut("flg").unwrap().pos = Some(crate::protocol::Position { x: 10.0, y: 0.0 });
        update_proximity(&mut state, &game, 6000);
        assert!(!state.proximity_tracker.contains_key(&key));

        // Move flag back in range; new start=7000.
        state.entities.get_mut("flg").unwrap().pos = Some(crate::protocol::Position { x: 0.5, y: 0.0 });
        update_proximity(&mut state, &game, 7000);
        assert_eq!(state.proximity_tracker.get(&key), Some(&7000));
    }

    // --- Team-filtered proximity tests ---

    /// Build a game with a single `proximity_duration_s` rule that has the
    /// given `same_team` / `different_team` flags. Two player entity types
    /// so we can test peer matching independently of self.
    fn game_with_team_proximity(same_team: bool, different_team: bool) -> GameConfig {
        GameConfig {
            id: "team_prox".into(),
            name: "Team Proximity Test".into(),
            teams: vec!["red".into(), "blue".into()],
            entity_types: vec![
                crate::games::EntityTypeDef { id: "player".into(), min: 1, max: 6, team: Some("per_team".into()), visual: None },
            ],
            placement: vec![],
            rules: vec![crate::games::Rule {
                id: "team_prox_rule".into(),
                on: "tick".into(),
                when: serde_json::json!({
                    "kind": "all",
                    "of": [
                        { "kind": "entity_is", "entity_type": "player" },
                        { "kind": "proximity_duration_s", "peer_entity_type": "player", "max_m": 3.0, "min_s": 2, "same_team": same_team, "different_team": different_team }
                    ]
                }),
                effect: serde_json::json!({
                    "kind": "increment_score",
                    "team": "self.team",
                    "by": 1
                }),
            }],
            duration_s: None,
            obstacles: vec![],
        }
    }

    #[test]
    fn proximity_same_team_only_tracks_matching() {
        let game = game_with_team_proximity(true, false);
        let mut state = LocalGameState::new("a".into(), "PK_A".into(), None);
        state.active_game_id = Some("team_prox".into());
        // Red player A at (0,0), red player B at (1,0), blue player C at (2,0).
        state.entities.insert("a".into(), entity("a", "PK_A", Some("player"), Some("red"), Some((0.0, 0.0))));
        state.entities.insert("b".into(), entity("b", "PK_B", Some("player"), Some("red"), Some((1.0, 0.0))));
        state.entities.insert("c".into(), entity("c", "PK_C", Some("player"), Some("blue"), Some((2.0, 0.0))));

        update_proximity(&mut state, &game, 1000);

        // A↔B are same team (red) and within 3m → tracked.
        let key_ab = proximity_key("team_prox_rule", "a", "b");
        assert!(state.proximity_tracker.contains_key(&key_ab), "same-team pair A↔B should be tracked");

        // A↔C are different teams → NOT tracked under same_team.
        let key_ac = proximity_key("team_prox_rule", "a", "c");
        assert!(!state.proximity_tracker.contains_key(&key_ac), "cross-team pair A↔C should NOT be tracked");

        // B↔C are different teams → NOT tracked under same_team.
        let key_bc = proximity_key("team_prox_rule", "b", "c");
        assert!(!state.proximity_tracker.contains_key(&key_bc), "cross-team pair B↔C should NOT be tracked");
    }

    #[test]
    fn proximity_different_team_only_tracks_opposing() {
        let game = game_with_team_proximity(false, true);
        let mut state = LocalGameState::new("a".into(), "PK_A".into(), None);
        state.active_game_id = Some("team_prox".into());
        state.entities.insert("a".into(), entity("a", "PK_A", Some("player"), Some("red"), Some((0.0, 0.0))));
        state.entities.insert("b".into(), entity("b", "PK_B", Some("player"), Some("red"), Some((1.0, 0.0))));
        state.entities.insert("c".into(), entity("c", "PK_C", Some("player"), Some("blue"), Some((2.0, 0.0))));

        update_proximity(&mut state, &game, 1000);

        // A↔B are same team → NOT tracked under different_team.
        let key_ab = proximity_key("team_prox_rule", "a", "b");
        assert!(!state.proximity_tracker.contains_key(&key_ab), "same-team pair A↔B should NOT be tracked");

        // A↔C are different teams and within 3m → tracked.
        let key_ac = proximity_key("team_prox_rule", "a", "c");
        assert!(state.proximity_tracker.contains_key(&key_ac), "cross-team pair A↔C should be tracked");

        // B↔C are different teams and within 3m → tracked.
        let key_bc = proximity_key("team_prox_rule", "b", "c");
        assert!(state.proximity_tracker.contains_key(&key_bc), "cross-team pair B↔C should be tracked");
    }

    #[test]
    fn proximity_same_team_none_excluded() {
        // Two entities with team: None should NOT match same_team: true.
        let game = game_with_team_proximity(true, false);
        let mut state = LocalGameState::new("a".into(), "PK_A".into(), None);
        state.active_game_id = Some("team_prox".into());
        state.entities.insert("a".into(), entity("a", "PK_A", Some("player"), None, Some((0.0, 0.0))));
        state.entities.insert("b".into(), entity("b", "PK_B", Some("player"), None, Some((1.0, 0.0))));

        update_proximity(&mut state, &game, 1000);

        let key_ab = proximity_key("team_prox_rule", "a", "b");
        assert!(!state.proximity_tracker.contains_key(&key_ab), "two None-team entities should NOT match same_team");
    }

    #[test]
    fn proximity_both_flags_never_fires() {
        // Contradictory: both same_team and different_team are true.
        // Nothing should ever be tracked.
        let game = game_with_team_proximity(true, true);
        let mut state = LocalGameState::new("a".into(), "PK_A".into(), None);
        state.active_game_id = Some("team_prox".into());
        state.entities.insert("a".into(), entity("a", "PK_A", Some("player"), Some("red"), Some((0.0, 0.0))));
        state.entities.insert("b".into(), entity("b", "PK_B", Some("player"), Some("red"), Some((1.0, 0.0))));
        state.entities.insert("c".into(), entity("c", "PK_C", Some("player"), Some("blue"), Some((2.0, 0.0))));

        update_proximity(&mut state, &game, 1000);

        // same_team passes for A↔B but different_team then rejects it.
        assert!(state.proximity_tracker.is_empty(), "contradictory flags should produce no tracker entries");
    }

    #[test]
    fn sensor_reading_fires_flag_capture_after_10s_proximity() {
        let game = ctf_with_rules();
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        state.entities.insert("me".into(), entity("me", "PK_ME", Some("player"), Some("red"), Some((0.0, 0.0))));
        state.entities.insert("flg".into(), entity("flg", "PK_FLG", Some("flag"), None, Some((0.5, 0.0))));

        // Start proximity at t=0.
        update_proximity(&mut state, &game, 0);
        // Advance state to t=10000 and simulate SensorReading.
        let ctx = RuleContext { game: &game, local: &state, now_ms: 10_000 };
        let wire = sensor_wire("PK_ME", (0.5, 0.0), 10_000);
        let decisions = evaluate(&ctx, &wire);
        // Expect exactly one Emit setting flag.owner_team = "red".
        let emits: Vec<_> = decisions
            .iter()
            .filter_map(|d| match d {
                RuleDecision::Emit { rule_id, patches } => Some((rule_id, patches)),
                _ => None,
            })
            .collect();
        assert_eq!(emits.len(), 1, "decisions: {decisions:?}");
        let (rule_id, patches) = emits[0];
        assert_eq!(rule_id, "flag_capture");
        assert_eq!(patches.len(), 1);
        assert_eq!(patches[0].key, "owner_team");
        assert_eq!(patches[0].value, serde_json::json!("red"));
        assert_eq!(patches[0].target_peer_id, "PK_FLG");
    }

    #[test]
    fn sensor_reading_does_not_fire_before_duration() {
        let game = ctf_with_rules();
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        state.entities.insert("me".into(), entity("me", "PK_ME", Some("player"), Some("red"), Some((0.0, 0.0))));
        state.entities.insert("flg".into(), entity("flg", "PK_FLG", Some("flag"), None, Some((0.5, 0.0))));
        update_proximity(&mut state, &game, 0);
        // Only 5 seconds elapsed — below min_s=10.
        let ctx = RuleContext { game: &game, local: &state, now_ms: 5_000 };
        let wire = sensor_wire("PK_ME", (0.5, 0.0), 5_000);
        let decisions = evaluate(&ctx, &wire);
        assert!(matches!(decisions.as_slice(), [RuleDecision::Accept]));
    }

    #[test]
    fn delta_property_changed_fires_score() {
        let game = ctf_with_rules();
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        state.entities.insert("me".into(), entity("me", "PK_ME", Some("player"), Some("red"), Some((0.0, 0.0))));
        state.entities.insert("flg".into(), entity("flg", "PK_FLG", Some("flag"), None, Some((0.5, 0.0))));

        let ctx = RuleContext { game: &game, local: &state, now_ms: 10_000 };
        let real_changes = vec![StatePatch {
            target_peer_id: "PK_FLG".into(),
            key: "owner_team".into(),
            value: serde_json::json!("red"),
        }];
        let decisions = evaluate_delta(&ctx, "PK_ME", &real_changes);
        let scored: Vec<_> = decisions
            .iter()
            .filter_map(|d| match d {
                RuleDecision::IncrementScore { team, by, .. } => Some((team.clone(), *by)),
                _ => None,
            })
            .collect();
        assert_eq!(scored, vec![("red".to_string(), 1)]);
    }

    #[test]
    fn delta_with_no_real_changes_fires_nothing() {
        let game = ctf_with_rules();
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        state.entities.insert("me".into(), entity("me", "PK_ME", Some("player"), Some("red"), Some((0.0, 0.0))));
        state.entities.insert("flg".into(), entity("flg", "PK_FLG", Some("flag"), None, Some((0.5, 0.0))));

        let ctx = RuleContext { game: &game, local: &state, now_ms: 10_000 };
        let decisions = evaluate_delta(&ctx, "PK_ME", &[]);
        assert!(decisions.is_empty());
    }

    #[test]
    fn physics_rejects_impossible_jump() {
        let game = ctf_with_rules();
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        // Previous position seen 100ms ago at (0,0); new reading claims (50,0).
        // That's 500 m/s — far above MAX_PLAUSIBLE_VELOCITY_M_PER_S.
        let mut e = entity("me", "PK_ME", Some("player"), Some("red"), Some((0.0, 0.0)));
        e.last_seen_ms = 1_000;
        state.entities.insert("me".into(), e);

        let ctx = RuleContext { game: &game, local: &state, now_ms: 1_100 };
        let wire = sensor_wire("PK_ME", (50.0, 0.0), 1_100);
        let decisions = evaluate(&ctx, &wire);
        assert!(
            decisions
                .iter()
                .any(|d| matches!(d, RuleDecision::Reject { rule_id, .. } if rule_id == "physically_plausible")),
            "decisions: {decisions:?}"
        );
    }

    #[test]
    fn property_equals_fires_when_entity_has_value() {
        let mut game = ctf_with_placement();
        // Rule: once flag.owner_team == "red", game ends with red as winner.
        game.rules.push(crate::games::Rule {
            id: "red_wins".into(),
            on: "game_state_delta".into(),
            when: serde_json::json!({
                "kind": "property_equals",
                "target_entity_type": "flag",
                "key": "owner_team",
                "value": "red",
            }),
            effect: serde_json::json!({ "kind": "end_game", "winner_team": "red", "reason": "red captured" }),
        });
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        let mut me = entity("me", "PK_ME", Some("player"), Some("red"), Some((0.0, 0.0)));
        state.entities.insert("me".into(), me.clone());
        let mut flag = entity("flg", "PK_FLG", Some("flag"), None, Some((0.5, 0.0)));
        flag.properties.insert("owner_team".into(), serde_json::json!("red"));
        state.entities.insert("flg".into(), flag);
        let _ = &mut me;

        let ctx = RuleContext { game: &game, local: &state, now_ms: 1_000 };
        let patches = vec![StatePatch {
            target_peer_id: "PK_FLG".into(),
            key: "owner_team".into(),
            value: serde_json::json!("red"),
        }];
        let decisions = evaluate_delta(&ctx, "PK_ME", &patches);
        assert!(
            decisions
                .iter()
                .any(|d| matches!(d, RuleDecision::End { winner_team, .. } if winner_team.as_deref() == Some("red"))),
            "decisions: {decisions:?}"
        );
    }

    #[test]
    fn farther_than_m_from_predicate_blocks_when_close() {
        let mut game = ctf_with_placement();
        game.rules.push(crate::games::Rule {
            id: "flag_safe".into(),
            on: "tick".into(),
            when: serde_json::json!({
                "kind": "all",
                "of": [
                    { "kind": "entity_is", "entity_type": "flag" },
                    { "kind": "farther_than_m_from", "entity_type": "base", "min_m": 10.0 }
                ]
            }),
            effect: serde_json::json!({ "kind": "set_property", "target_entity_type": "flag", "key": "safe", "value": true }),
        });

        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        // Flag sits 5m from a base (< 10m threshold) — predicate should fail
        // → rule shouldn't fire.
        state.entities.insert("me".into(), entity("me", "PK_ME", Some("flag"), None, Some((5.0, 0.0))));
        state.entities.insert("base".into(), entity("base", "PK_B", Some("base"), Some("red"), Some((0.0, 0.0))));

        let ctx = RuleContext { game: &game, local: &state, now_ms: 0 };
        let decisions = tick(&ctx);
        assert!(decisions.is_empty(), "flag close to base should not fire: {decisions:?}");

        // Move flag 20m away — predicate passes.
        state.entities.get_mut("me").unwrap().pos = Some(Position { x: 30.0, y: 0.0 });
        let ctx = RuleContext { game: &game, local: &state, now_ms: 0 };
        let decisions = tick(&ctx);
        assert!(
            decisions.iter().any(|d| matches!(d, RuleDecision::Emit { .. })),
            "flag far from base should fire: {decisions:?}"
        );
    }

    #[test]
    fn end_game_self_team_resolves_to_triggering_team() {
        let mut game = ctf_with_placement();
        game.rules.push(crate::games::Rule {
            id: "capture_wins".into(),
            on: "game_state_delta".into(),
            when: serde_json::json!({ "kind": "property_changed", "target_entity_type": "flag", "key": "owner_team" }),
            effect: serde_json::json!({ "kind": "end_game", "winner_team": "self.team", "reason": "first capture" }),
        });
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        state.entities.insert("me".into(), entity("me", "PK_ME", Some("player"), Some("blue"), Some((0.0, 0.0))));
        state.entities.insert("flg".into(), entity("flg", "PK_FLG", Some("flag"), None, Some((0.5, 0.0))));

        let ctx = RuleContext { game: &game, local: &state, now_ms: 0 };
        let patches = vec![StatePatch {
            target_peer_id: "PK_FLG".into(),
            key: "owner_team".into(),
            value: serde_json::json!("blue"),
        }];
        let decisions = evaluate_delta(&ctx, "PK_ME", &patches);
        assert!(
            decisions
                .iter()
                .any(|d| matches!(d, RuleDecision::End { winner_team, .. } if winner_team.as_deref() == Some("blue"))),
            "self.team should resolve to blue: {decisions:?}"
        );
    }

    #[test]
    fn reject_effect_produces_reject_decision() {
        let mut game = ctf_with_placement();
        // Trivially-matching rule that always rejects (uses entity_is for
        // the player, which the fixture entity is).
        game.rules.push(crate::games::Rule {
            id: "no_players".into(),
            on: "tick".into(),
            when: serde_json::json!({ "kind": "entity_is", "entity_type": "player" }),
            effect: serde_json::json!({ "kind": "reject", "reason": "test rejection" }),
        });
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        state.entities.insert("me".into(), entity("me", "PK_ME", Some("player"), Some("red"), Some((0.0, 0.0))));

        let ctx = RuleContext { game: &game, local: &state, now_ms: 0 };
        let decisions = tick(&ctx);
        assert!(
            decisions
                .iter()
                .any(|d| matches!(d, RuleDecision::Reject { rule_id, .. } if rule_id == "no_players")),
            "decisions: {decisions:?}"
        );
    }

    #[test]
    fn physics_allows_reasonable_movement() {
        let game = ctf_with_rules();
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        // 2m in 200ms = 10 m/s — below the 50 m/s threshold.
        let mut e = entity("me", "PK_ME", Some("player"), Some("red"), Some((0.0, 0.0)));
        e.last_seen_ms = 1_000;
        state.entities.insert("me".into(), e);

        let ctx = RuleContext { game: &game, local: &state, now_ms: 1_200 };
        let wire = sensor_wire("PK_ME", (2.0, 0.0), 1_200);
        let decisions = evaluate(&ctx, &wire);
        assert!(
            !decisions
                .iter()
                .any(|d| matches!(d, RuleDecision::Reject { .. })),
            "decisions: {decisions:?}"
        );
    }

    // --- Time limit / highest_score / now_ms template tests ---

    /// Build a `ctf`-shaped game with a single `on: tick` rule that fires
    /// once `game_time_elapsed_s >= min_s` and calls `end_game` with the
    /// given winner resolver. Kept local to these tests so the predicate is
    /// exercised without dragging in the full shipped ctf.json.
    fn ctf_with_time_limit(min_s: u64, winner_team: &str) -> GameConfig {
        let mut g = ctf_with_placement();
        g.duration_s = Some(min_s);
        g.rules.push(crate::games::Rule {
            id: "time_limit".into(),
            on: "tick".into(),
            when: serde_json::json!({
                "kind": "all",
                "of": [
                    { "kind": "entity_is", "entity_type": "flag" },
                    { "kind": "game_time_elapsed_s", "min_s": min_s }
                ]
            }),
            effect: serde_json::json!({
                "kind": "end_game",
                "winner_team": winner_team,
                "reason": "test time limit"
            }),
        });
        g
    }

    /// Anchor the elapsed-time clock: `countdown_zero_ns` = 0, so play
    /// starts at `0 + 3_000_000_000ns = 3s` past the UNIX epoch. A `now_ms`
    /// of `3_000 + elapsed_ms` therefore maps directly to `elapsed_ms`
    /// seconds of play. Tests set `now_ms` relative to this anchor.
    fn state_with_countdown_zero() -> LocalGameState {
        let mut s = LocalGameState::new("me".into(), "PK_ME".into(), None);
        s.active_game_id = Some("ctf".into());
        s.countdown_zero_ns = Some(0);
        s
    }

    #[test]
    fn game_time_elapsed_is_false_before_threshold() {
        let game = ctf_with_time_limit(600, "highest_score");
        let mut state = state_with_countdown_zero();
        // Flag exists and is the local entity.
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        // 100s into play — start is at 3000ms, elapsed = 100_000ms.
        let ctx = RuleContext { game: &game, local: &state, now_ms: 3_000 + 100_000 };
        let decisions = tick(&ctx);
        assert!(
            decisions.is_empty(),
            "time_limit should not fire before threshold: {decisions:?}"
        );
    }

    #[test]
    fn game_time_elapsed_fires_end_game_at_threshold() {
        let game = ctf_with_time_limit(600, "highest_score");
        let mut state = state_with_countdown_zero();
        state.scores.insert("red".into(), 42);
        state.scores.insert("blue".into(), 17);
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        // 600s into play → 600_000ms elapsed past the 3s countdown offset.
        let ctx = RuleContext { game: &game, local: &state, now_ms: 3_000 + 600_000 };
        let decisions = tick(&ctx);
        let ends: Vec<_> = decisions
            .iter()
            .filter_map(|d| match d {
                RuleDecision::End { winner_team, reason } => {
                    Some((winner_team.clone(), reason.clone()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(ends.len(), 1, "expected one End decision: {decisions:?}");
        let (winner, reason) = &ends[0];
        // highest_score picks red (42 > 17).
        assert_eq!(winner.as_deref(), Some("red"), "decisions: {decisions:?}");
        assert!(reason.contains("time limit"), "reason: {reason}");
    }

    /// Build a single-rule game that ends when `freezers` reaches `min` points,
    /// anchored on an `entity_is: "flag"` filter so the test harness (which
    /// inserts a flag as `self`) is the one evaluator that sees the predicate
    /// fire. Mirrors the freeze_tag.json `freezers_win` rule shape.
    fn ctf_with_score_threshold(min: i64) -> GameConfig {
        let mut g = ctf_with_placement();
        g.rules.push(crate::games::Rule {
            id: "score_threshold".into(),
            on: "tick".into(),
            when: serde_json::json!({
                "kind": "all",
                "of": [
                    { "kind": "entity_is", "entity_type": "flag" },
                    { "kind": "score_at_least", "team": "freezers", "min": min }
                ]
            }),
            effect: serde_json::json!({
                "kind": "end_game",
                "winner_team": "freezers",
                "reason": "reached threshold"
            }),
        });
        g
    }

    #[test]
    fn score_at_least_fires_end_game_when_threshold_met() {
        let game = ctf_with_score_threshold(5);
        let mut state = state_with_countdown_zero();
        state.scores.insert("freezers".into(), 5);
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        let ctx = RuleContext { game: &game, local: &state, now_ms: 3_000 };
        let decisions = tick(&ctx);
        let ends: Vec<_> = decisions
            .iter()
            .filter_map(|d| match d {
                RuleDecision::End { winner_team, reason } => {
                    Some((winner_team.clone(), reason.clone()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(ends.len(), 1, "expected one End decision: {decisions:?}");
        let (winner, reason) = &ends[0];
        assert_eq!(winner.as_deref(), Some("freezers"), "decisions: {decisions:?}");
        assert!(reason.contains("threshold"), "reason: {reason}");
    }

    #[test]
    fn score_at_least_does_not_fire_below_threshold() {
        let game = ctf_with_score_threshold(5);
        let mut state = state_with_countdown_zero();
        // One shy of the threshold — predicate must be false.
        state.scores.insert("freezers".into(), 4);
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        let ctx = RuleContext { game: &game, local: &state, now_ms: 3_000 };
        let decisions = tick(&ctx);
        assert!(
            decisions.is_empty(),
            "score_at_least should not fire below threshold: {decisions:?}"
        );
    }

    #[test]
    fn score_at_least_treats_missing_team_as_zero() {
        // Never inserted a `freezers` score → should behave as 0, i.e. not fire.
        let game = ctf_with_score_threshold(1);
        let mut state = state_with_countdown_zero();
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        let ctx = RuleContext { game: &game, local: &state, now_ms: 3_000 };
        let decisions = tick(&ctx);
        assert!(
            decisions.is_empty(),
            "missing team key should count as 0: {decisions:?}"
        );
    }

    // --- property_age_ms (self-scoped freshness predicate) --------------

    /// Build a single-rule game whose `end_game` effect is gated by
    /// `property_age_ms` on a flag. Returns a config where the flag (unique
    /// entity in CTF) fires the end when it has a fresh `marked_ms` property.
    fn ctf_with_property_age_rule(max_age_ms: u64) -> GameConfig {
        let mut g = ctf_with_placement();
        g.rules.push(crate::games::Rule {
            id: "age_end".into(),
            on: "tick".into(),
            when: serde_json::json!({
                "kind": "all",
                "of": [
                    { "kind": "entity_is", "entity_type": "flag" },
                    { "kind": "property_age_ms", "key": "marked_ms", "max_age_ms": max_age_ms }
                ]
            }),
            effect: serde_json::json!({
                "kind": "end_game",
                "winner_team": "red",
                "reason": "marked recently"
            }),
        });
        g
    }

    #[test]
    fn property_age_ms_fires_when_property_is_recent() {
        let game = ctf_with_property_age_rule(30_000);
        let mut state = state_with_countdown_zero();
        let mut flag = entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0)));
        // Marked 10s ago — within the 30s window.
        flag.properties.insert("marked_ms".into(), serde_json::json!(0u64));
        state.entities.insert("me".into(), flag);
        let ctx = RuleContext { game: &game, local: &state, now_ms: 10_000 };
        let decisions = tick(&ctx);
        assert!(
            decisions
                .iter()
                .any(|d| matches!(d, RuleDecision::End { .. })),
            "expected end: {decisions:?}"
        );
    }

    #[test]
    fn property_age_ms_does_not_fire_when_stale() {
        let game = ctf_with_property_age_rule(30_000);
        let mut state = state_with_countdown_zero();
        let mut flag = entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0)));
        flag.properties.insert("marked_ms".into(), serde_json::json!(0u64));
        state.entities.insert("me".into(), flag);
        // 40s elapsed — outside the 30s window.
        let ctx = RuleContext { game: &game, local: &state, now_ms: 40_000 };
        let decisions = tick(&ctx);
        assert!(decisions.is_empty(), "expected no end: {decisions:?}");
    }

    #[test]
    fn property_age_ms_does_not_fire_when_property_missing() {
        let game = ctf_with_property_age_rule(30_000);
        let mut state = state_with_countdown_zero();
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        let ctx = RuleContext { game: &game, local: &state, now_ms: 5_000 };
        let decisions = tick(&ctx);
        assert!(decisions.is_empty(), "missing property → false: {decisions:?}");
    }

    #[test]
    fn property_age_ms_does_not_fire_when_property_not_numeric() {
        let game = ctf_with_property_age_rule(30_000);
        let mut state = state_with_countdown_zero();
        let mut flag = entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0)));
        flag.properties
            .insert("marked_ms".into(), serde_json::json!("now"));
        state.entities.insert("me".into(), flag);
        let ctx = RuleContext { game: &game, local: &state, now_ms: 5_000 };
        let decisions = tick(&ctx);
        assert!(decisions.is_empty(), "non-numeric property → false: {decisions:?}");
    }

    // --- all_entities_property_recent (aggregate freshness predicate) ----

    /// Build a single-rule game where the flag fires `end_game` iff every
    /// `base` has a fresh `touched_ms` property — used to exercise the
    /// aggregate "all runners frozen" pattern on CTF's two-base shape.
    fn ctf_with_all_bases_fresh_rule(max_age_ms: u64) -> GameConfig {
        let mut g = ctf_with_placement();
        g.rules.push(crate::games::Rule {
            id: "all_fresh_end".into(),
            on: "tick".into(),
            when: serde_json::json!({
                "kind": "all",
                "of": [
                    { "kind": "entity_is", "entity_type": "flag" },
                    { "kind": "all_entities_property_recent",
                      "entity_type": "base",
                      "key": "touched_ms",
                      "max_age_ms": max_age_ms }
                ]
            }),
            effect: serde_json::json!({
                "kind": "end_game",
                "winner_team": "red",
                "reason": "all bases touched"
            }),
        });
        g
    }

    fn insert_base(state: &mut LocalGameState, label: &str, peer_id: &str, team: &str, ts: Option<u64>) {
        let mut b = entity(label, peer_id, Some("base"), Some(team), Some((0.0, 0.0)));
        if let Some(v) = ts {
            b.properties.insert("touched_ms".into(), serde_json::json!(v));
        }
        state.entities.insert(label.into(), b);
    }

    #[test]
    fn all_entities_property_recent_fires_when_all_fresh() {
        let game = ctf_with_all_bases_fresh_rule(30_000);
        let mut state = state_with_countdown_zero();
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        insert_base(&mut state, "br", "PK_BR", "red", Some(1_000));
        insert_base(&mut state, "bb", "PK_BB", "blue", Some(2_000));
        let ctx = RuleContext { game: &game, local: &state, now_ms: 5_000 };
        let decisions = tick(&ctx);
        assert!(
            decisions
                .iter()
                .any(|d| matches!(d, RuleDecision::End { .. })),
            "expected end: {decisions:?}"
        );
    }

    #[test]
    fn all_entities_property_recent_false_when_one_is_stale() {
        let game = ctf_with_all_bases_fresh_rule(30_000);
        let mut state = state_with_countdown_zero();
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        // Blue base touched 1s ago (fresh); red base touched 40s ago (stale).
        insert_base(&mut state, "br", "PK_BR", "red", Some(0));
        insert_base(&mut state, "bb", "PK_BB", "blue", Some(39_000));
        let ctx = RuleContext { game: &game, local: &state, now_ms: 40_000 };
        let decisions = tick(&ctx);
        assert!(decisions.is_empty(), "one stale → false: {decisions:?}");
    }

    #[test]
    fn all_entities_property_recent_false_when_one_is_missing_property() {
        let game = ctf_with_all_bases_fresh_rule(30_000);
        let mut state = state_with_countdown_zero();
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        insert_base(&mut state, "br", "PK_BR", "red", Some(1_000));
        insert_base(&mut state, "bb", "PK_BB", "blue", None); // no touched_ms
        let ctx = RuleContext { game: &game, local: &state, now_ms: 5_000 };
        let decisions = tick(&ctx);
        assert!(decisions.is_empty(), "missing property on one → false: {decisions:?}");
    }

    #[test]
    fn all_entities_property_recent_false_when_no_matching_entities() {
        // Empty matching set is `false` (not vacuously true) — prevents a
        // win-condition rule firing before any instances have been claimed.
        let game = ctf_with_all_bases_fresh_rule(30_000);
        let mut state = state_with_countdown_zero();
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        // No bases in the state at all.
        let ctx = RuleContext { game: &game, local: &state, now_ms: 5_000 };
        let decisions = tick(&ctx);
        assert!(decisions.is_empty(), "empty set → false: {decisions:?}");
    }

    // --- set_property_on_self (per-entity write effect) ------------------

    #[test]
    fn set_property_on_self_emits_single_patch_targeting_self_only() {
        // Rule: on tick, the flag writes its own `marked_ms`. Crucially, this
        // must NOT fan out to every entity of the same type — the whole point
        // of `set_property_on_self` is per-entity state for games like
        // freeze_tag where two runners each need their own timestamp.
        let mut game = ctf_with_placement();
        game.rules.push(crate::games::Rule {
            id: "self_mark".into(),
            on: "tick".into(),
            when: serde_json::json!({ "kind": "entity_is", "entity_type": "flag" }),
            effect: serde_json::json!({
                "kind": "set_property_on_self",
                "key": "marked_ms",
                "value": "now_ms"
            }),
        });

        let mut state = state_with_countdown_zero();
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        // A teammate-style "other" entity of the same type shouldn't matter —
        // this test only has one flag, but we add a second base to prove
        // SetProperty and SetPropertyOnSelf diverge: if this rule was a plain
        // `set_property` on flag, both flag entities would receive patches
        // (n == 2); on-self should still emit exactly 1 patch.
        state.entities.insert(
            "other_flag".into(),
            entity("other_flag", "PK_OTHER", Some("flag"), None, Some((50.0, 50.0))),
        );

        let ctx = RuleContext { game: &game, local: &state, now_ms: 7_000 };
        let decisions = tick(&ctx);
        let patches = decisions
            .iter()
            .find_map(|d| match d {
                RuleDecision::Emit { rule_id, patches } if rule_id == "self_mark" => {
                    Some(patches.clone())
                }
                _ => None,
            })
            .expect("expected self_mark emit");
        assert_eq!(patches.len(), 1, "should patch only self: {patches:?}");
        assert_eq!(patches[0].target_peer_id, "PK_ME");
        assert_eq!(patches[0].key, "marked_ms");
        assert_eq!(patches[0].value, serde_json::json!(7_000u64));
    }

    #[test]
    fn game_time_elapsed_is_false_without_countdown() {
        // countdown_zero_ns = None → predicate always false regardless of now_ms.
        let game = ctf_with_time_limit(1, "highest_score");
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        let ctx = RuleContext { game: &game, local: &state, now_ms: 1_000_000 };
        let decisions = tick(&ctx);
        assert!(decisions.is_empty(), "no countdown → no time limit: {decisions:?}");
    }

    #[test]
    fn highest_score_resolves_to_strict_leader() {
        let game = ctf_with_time_limit(1, "highest_score");
        let mut state = state_with_countdown_zero();
        // Only blue has scored — it wins outright.
        state.scores.insert("blue".into(), 5);
        state.scores.insert("red".into(), 0);
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        let ctx = RuleContext { game: &game, local: &state, now_ms: 3_000 + 1_500 };
        let decisions = tick(&ctx);
        let winner = decisions
            .iter()
            .find_map(|d| match d {
                RuleDecision::End { winner_team, .. } => winner_team.clone(),
                _ => None,
            });
        assert_eq!(winner.as_deref(), Some("blue"), "decisions: {decisions:?}");
    }

    #[test]
    fn highest_score_ties_resolve_to_none() {
        let game = ctf_with_time_limit(1, "highest_score");
        let mut state = state_with_countdown_zero();
        state.scores.insert("blue".into(), 3);
        state.scores.insert("red".into(), 3);
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        let ctx = RuleContext { game: &game, local: &state, now_ms: 3_000 + 1_500 };
        let decisions = tick(&ctx);
        // Tie → End decision still fires but winner_team == None (the UI
        // renders this as "draw").
        let end = decisions
            .iter()
            .find_map(|d| match d {
                RuleDecision::End { winner_team, .. } => Some(winner_team.clone()),
                _ => None,
            });
        assert_eq!(end, Some(None), "tie should resolve to None: {decisions:?}");
    }

    #[test]
    fn highest_score_ignores_bookkeeping_keys() {
        // Keys prefixed `__` are internal (e.g. `__countdown_start_ms`) and
        // must never win the "highest score" tiebreak over a real team.
        let game = ctf_with_time_limit(1, "highest_score");
        let mut state = state_with_countdown_zero();
        state.scores.insert("__internal".into(), 999);
        state.scores.insert("red".into(), 1);
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("flag"), None, Some((30.0, 15.0))),
        );
        let ctx = RuleContext { game: &game, local: &state, now_ms: 3_000 + 1_500 };
        let decisions = tick(&ctx);
        let winner = decisions
            .iter()
            .find_map(|d| match d {
                RuleDecision::End { winner_team, .. } => winner_team.clone(),
                _ => None,
            });
        assert_eq!(winner.as_deref(), Some("red"), "decisions: {decisions:?}");
    }

    #[test]
    fn set_property_now_ms_resolves_to_ctx_now() {
        // Rule: on tick, a base within 1m of the flag for ≥1s emits a delta
        // patching flag.hold_pulse_ms to the current now_ms. Verifies that
        // the `now_ms` template flows through set_property end-to-end and
        // produces a numeric JSON value (not the literal string).
        let mut game = ctf_with_placement();
        game.rules.push(crate::games::Rule {
            id: "hold_pulse".into(),
            on: "tick".into(),
            when: serde_json::json!({
                "kind": "all",
                "of": [
                    { "kind": "entity_is", "entity_type": "base" },
                    { "kind": "proximity_duration_s", "peer_entity_type": "flag", "max_m": 1.0, "min_s": 1 }
                ]
            }),
            effect: serde_json::json!({
                "kind": "set_property",
                "target_entity_type": "flag",
                "key": "hold_pulse_ms",
                "value": "now_ms"
            }),
        });

        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        // Local = red base; flag sits 0.5m away.
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("base"), Some("red"), Some((0.0, 0.0))),
        );
        state.entities.insert(
            "flg".into(),
            entity("flg", "PK_FLG", Some("flag"), None, Some((0.5, 0.0))),
        );
        // Seed the proximity tracker so the 1s duration is already satisfied.
        update_proximity(&mut state, &game, 0);

        let ctx = RuleContext { game: &game, local: &state, now_ms: 42_000 };
        let decisions = tick(&ctx);
        let patches = decisions
            .iter()
            .find_map(|d| match d {
                RuleDecision::Emit { rule_id, patches } if rule_id == "hold_pulse" => {
                    Some(patches.clone())
                }
                _ => None,
            })
            .expect("expected hold_pulse emit");
        assert_eq!(patches.len(), 1);
        assert_eq!(patches[0].key, "hold_pulse_ms");
        assert_eq!(patches[0].target_peer_id, "PK_FLG");
        assert_eq!(patches[0].value, serde_json::json!(42_000u64));
    }

    #[test]
    fn hold_pulse_delta_increments_holding_team_score() {
        // Integration-flavoured test: once the base's hold_pulse delta lands,
        // every node's `on: game_state_delta` handler fires the score rule,
        // resolving `self.team` against the delta sender (the base's team).
        let mut game = ctf_with_placement();
        game.rules.push(crate::games::Rule {
            id: "hold_score".into(),
            on: "game_state_delta".into(),
            when: serde_json::json!({
                "kind": "property_changed",
                "target_entity_type": "flag",
                "key": "hold_pulse_ms"
            }),
            effect: serde_json::json!({
                "kind": "increment_score",
                "team": "self.team",
                "by": 1
            }),
        });

        // Observer node — doesn't matter what entity it holds, rules fire
        // off the sender's identity, not local self.
        let mut state = LocalGameState::new("me".into(), "PK_ME".into(), None);
        state.active_game_id = Some("ctf".into());
        state.entities.insert(
            "me".into(),
            entity("me", "PK_ME", Some("player"), Some("blue"), Some((50.0, 10.0))),
        );
        // Delta sender = red base.
        state.entities.insert(
            "base_r".into(),
            entity("base_r", "PK_BR", Some("base"), Some("red"), Some((0.0, 0.0))),
        );
        state.entities.insert(
            "flg".into(),
            entity("flg", "PK_FLG", Some("flag"), None, Some((0.5, 0.0))),
        );

        let ctx = RuleContext { game: &game, local: &state, now_ms: 1_234 };
        let patches = vec![StatePatch {
            target_peer_id: "PK_FLG".into(),
            key: "hold_pulse_ms".into(),
            value: serde_json::json!(1_234u64),
        }];
        let decisions = evaluate_delta(&ctx, "PK_BR", &patches);
        let scored: Vec<_> = decisions
            .iter()
            .filter_map(|d| match d {
                RuleDecision::IncrementScore { team, by, .. } => Some((team.clone(), *by)),
                _ => None,
            })
            .collect();
        assert_eq!(
            scored,
            vec![("red".to_string(), 1)],
            "hold_pulse delta should score the sender's team: {decisions:?}"
        );
    }
}
