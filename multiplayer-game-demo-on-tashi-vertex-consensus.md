# Multiplayer Game Demo on Tashi Vertex Consensus

## Context

The Tashi Vertex Explorer today is a consensus-visualisation dashboard: a Rust
backend spawns child "agent" processes that run the Tashi Vertex BFT engine,
exchange `Hello`/`Heartbeat`/`StateUpdate` messages, and broadcast events over
SSE to a React + D3 frontend that renders a force-directed graph of nodes and
manual partitions.

We want to turn this foundation into a compelling demonstration that
decentralised consensus can drive a real, interactive application. The vehicle
is a top-down 2D multiplayer game. Every in-game entity — flag, team bases,
each player — **is** a consensus node. Three games ship pre-installed (Capture
the Flag, King of the Hill, Territory Control) and nodes vote their way
through game selection, entity-type claims, readiness, and a running game —
all coordinated through the ordered consensus event stream.

Every node lives on the playing field from the moment it's created — the
web server assigns a random non-overlapping position on `POST /api/swarm`,
and the new child broadcasts that position as its first post-handshake
`SensorReading` so all nodes see a consistent seed state. Dragging is for
moving **already-placed** entities, never for "putting them onto" the field.

Physics is real: each node has a fixed communication radius; when a pair
goes out of range, the `PfPartitionManager` auto-applies a real `pfctl`
partition, so Vertex UDP transport is physically blocked. This is active
from node creation — you can drag two nodes apart *before loading any
game* and watch `pfctl` cut them off. When the network fragments below
BFT quorum, consensus visibly stalls — that flatlining FinalityChart is
the demo's payoff. Obstacles (rocks) are a frontend-only rendering cue —
they hide the dashed comm edge visually when they block line of sight,
but don't influence `pfctl` (see Pre-game defaults section for the
rationale).

Per-node rules engines in Rust enforce the active game's invariants against
every consensus event and reject bad-actor transactions (e.g. claiming a
second flag, fabricating an impossible sensor reading). Sensor events are
broadcast **only on drag drop**, giving a crisp one-event-per-move timeline.

## Outcome

A user can:

1. Spin up N nodes via Add Swarm. Nodes immediately appear at random
   non-overlapping positions on the full-width 2D playing field between the
   Node Control row and the FinalityChart. `pfctl` reconciler is already
   running — dragging two nodes apart at this stage is enough to partition
   them; consensus/finality reacts on the existing NetworkGraph + FinalityChart.
2. Propose a game on any node; see a 30s proposal window, a 30s vote window,
   and the majority-winning game load on every node.
3. Claim entity types (e.g. agent-a = Flag, agent-b = Red Base, …) with
   cardinality-violating claims rejected in real time. The entity's visual
   on the playing field swaps from the generic node circle to the
   type-specific icon on acceptance.
4. Drag the already-placed entities into their starting formations.
   Placement-constraint violations (e.g. flag < 20m from any base) keep the
   Ready button disabled.
5. Watch every node Ready-up → a synchronised 3s countdown (local, derived
   from the consensus timestamp of the final `ReadyUp`) → game runs.
6. Drag entities during play. Drops publish `SensorReading`s. Capture-the-flag
   ownership changes happen via a declarative rule DSL. Scores update. Nodes
   that move out of range get `pfctl`-partitioned live.

## Target architecture

### New message kinds and payload

`src/protocol.rs`:

```rust
pub enum MessageKind {
    Hello, Heartbeat, StateUpdate,
    GameProposal, GameVote,
    EntityTypeClaim, SensorReading, ReadyUp,
    GameStateDelta, RuleViolation, GameEnd,
}

pub struct WireMessage {
    pub kind: MessageKind,
    pub message_id: String,
    pub sent_at_ms: u64,
    pub state: SharedState,          // retained — hellos/heartbeats still use it
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game: Option<GamePayload>,   // new, opt-in per kind
}

#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GamePayload {
    GameProposal    { game_id: String },
    GameVote        { game_id: String },
    EntityTypeClaim { entity_type: String, team: Option<String> },
    SensorReading   { pos: Position, readings: Vec<SensorDatum>, observed_at_ms: u64 },
    ReadyUp,
    GameStateDelta  { patches: Vec<StatePatch> },
    RuleViolation   { rule_id: String, offender_msg_id: String, reason: String },
    GameEnd         { winner_team: Option<String>, reason: String },
}

pub struct Position  { pub x: f32, pub y: f32 }
pub struct SensorDatum { pub peer_id: String, pub distance_m: f32, pub angle_rad: f32 }
```

The `#[serde(default)]` on `game` keeps old proof JSONs parseable.

### Game configs — shared fixture JSON

Canonical files at `/Users/justyn/dev/tashi/hackathon-warm-up/games/{ctf,king_of_the_hill,territory}.json`.
Loaded by Rust at node startup (new `--games-dir` CLI arg, default `./games`)
and served to the frontend via a new `GET /api/games` endpoint. Hand-written
matching types in Rust (`src/games.rs`) and TS (`frontend/src/game/types.ts`)
— small surface, parse failures surface immediately at boot.

Schema (sketch) — rules-relevant fields only:

```jsonc
{
  "id": "ctf",
  "name": "Capture the Flag",
  "comm_radius_m": 8,
  "teams": ["red", "blue"],
  "entity_types": [
    { "id": "flag",   "min": 1, "max": 1, "team": null,       "visual": "flag"   },
    { "id": "base",   "min": 1, "max": 1, "team": "per_team", "visual": "base"   },
    { "id": "player", "min": 2, "max": 4, "team": "per_team", "visual": "player" }
  ],
  "placement": [
    { "entity": "player", "requires": { "within_m_of": { "entity": "base", "same_team": true, "max_m": 2.0 } } },
    { "entity": "flag",   "requires": { "farther_than_m_from": { "entity": "base", "min_m": 20.0 } } }
  ],
  "rules": [
    { "id": "flag_capture",
      "on": "sensor_reading",
      "when": { "all": [
        { "entity_is": "player" },
        { "proximity_duration_s": { "peer_is": "flag", "max_m": 1.0, "min_s": 10 } },
        { "flag_owner_is_not": "self.team" }
      ] },
      "effect": { "set_property": { "target": "flag", "key": "owner_team", "value": "self.team" } }
    }
  ]
}
```

**Field dimensions and obstacles are frontend-only** — they're rendering
concerns and no rule predicate references them. They live in
`frontend/src/game/presentation.ts` keyed by `game_id` (see Frontend
section). The backend doesn't read or care about obstacles; `pfctl`
reconciliation uses pure range only. LOS-severance behind a rock is a
visual concern (the frontend hides the dashed comm edge when the line
intersects a rock), and `pfctl` still allows the UDP transport in that
case. This is a deliberate simplification: keeps the rules schema focused
and the backend free of rendering data, at the cost of obstacles not
physically breaking consensus — range alone does.

**Rule DSL is deliberately restricted**: no loops, no arithmetic beyond
`increment`, only declarative predicate trees (`all`/`any`/`not` over leaf
predicates like `entity_is`, `proximity_duration_s`, `farther_than_m_from`,
`property_equals`, `property_changed`, `cardinality_violates`,
`physically_plausible`) and a small set of effects (`set_property`,
`increment_score`, `reject`, `broadcast_delta`, `end_game`). This keeps the
Rust evaluator provably terminating and makes per-node reproducibility easy
to reason about. KotH and Territory exercise the same DSL via `on: "tick"`
+ `proximity_duration_s` for zone-holding.

### Pre-game defaults

The playing field exists from the moment the first node is created, before
any game is loaded.

- **Backend** (`src/defaults.rs`, new): only `PRE_GAME_COMM_RADIUS_M = 12.0`
  and `MIN_SEP_M = 2.5` (for random-placement min separation). The backend
  doesn't know field dimensions or obstacles.
- **Frontend** (`frontend/src/game/presentation.ts`, new): `FIELD_WIDTH_M =
  60`, `FIELD_HEIGHT_M = 30`, `PX_PER_M = 20` (→ 1200×600 px canvas), and a
  per-game-id map of `{ gradient, obstacles[] }` — e.g. CTF has
  red/blue-split gradient + a couple of rocks; KotH has a concentric-rings
  gradient + no obstacles; pre-game has a neutral grey gradient + no
  obstacles. Field size is fixed across all games (pragmatic choice — keeps
  positions meaningful across game transitions).
- When a game is loaded, `partition_reconciler` switches from
  `PRE_GAME_COMM_RADIUS_M` to the loaded game's `comm_radius_m`. It runs
  continuously from server startup, not gated on game state.
- Frontend range calculations for rendering the dashed comm-edge layer use
  the same radius (from `useGameState`), plus an in-browser LOS check
  against the presentation's obstacles for the visual "rocks block line of
  sight" cue.

### Position assignment on node creation

`POST /api/swarm` and `POST /api/nodes` (single-add) assign each new node
a random non-overlapping position before spawning the child process. Simple
rejection sampling in a new helper in `src/geom.rs`:

```rust
pub fn place_randomly_without_overlap(
    existing: &[Position],
    field: (f32, f32),        // (width_m, height_m)
    min_sep_m: f32,           // e.g. 2.5
    rng: &mut impl rand::Rng,
) -> Position;
```

- Draw `(x, y)` uniformly in the field.
- Retry up to 200 times if within `min_sep_m` of any existing position.
- On retry exhaustion, fall back to a grid-fill pass (deterministic, covers
  the field).

The assigned position is passed to the child as new CLI args
`--initial-x` and `--initial-y`. Inside the child, after the first
`SyncPoint` (where the `Hello` is currently sent), broadcast an initial
`SensorReading` carrying that position so every node observes the new
entity's starting location in consensus order. This also seeds
`partition_reconciler` via the persisted `{label}-game.json`.

On frontend side, `GameView` renders a "generic node" visual (neutral grey
circle with the node's label) for any node that hasn't yet made an
`EntityTypeClaim`. When a claim is accepted, the visual swaps to the
type-specific icon. Stopped nodes are rendered dimmed but kept on the
field (consistent with how NodeControl handles stopped nodes).

### Per-node rules engine — `src/rules.rs` (new)

```rust
pub struct RuleContext<'a> { pub game: &'a GameConfig, pub local: &'a LocalGameState, pub now_ms: u64 }

pub enum RuleDecision {
    Accept,
    Reject { rule_id: String, reason: String },
    Emit   { delta: Vec<StatePatch> },
    End    { winner_team: Option<String>, reason: String },
}

pub fn evaluate(ctx: &RuleContext, incoming: &WireMessage) -> Vec<RuleDecision>;
pub fn tick    (ctx: &RuleContext) -> Vec<RuleDecision>;
```

Pure functions. No I/O, no locks. Called from `handle_vertex_message` right
after the existing peer-state update; `tick` invoked at 1 Hz from the
200ms `control_loop`. The engine keeps a `proximity_tracker:
HashMap<(EntityId, EntityId), u64>` on `LocalGameState` for time-based
predicates and a bounded `sensor_history` ring buffer (~256 entries) so that
a late-arriving `EntityTypeClaim` can cause affected sensor events to be
re-scored without divergence. Idempotency of effects is a required property:
setting a property to its current value is a no-op.

### Per-node local game state — `src/game_state.rs` (new)

```rust
pub enum GamePhase {
    NoGame, Proposing, Voting, Loaded, PlacingEntities, Ready, CountingDown, Playing, Ended,
}

pub struct LocalGameState {
    pub phase: GamePhase,
    pub active_game: Option<GameConfig>,
    pub entities: HashMap<String /*peer_id*/, EntityRecord>,
    pub my_entity: Option<String>,
    pub my_position: Option<Position>,
    pub scores: HashMap<String, i64>,
    pub proposal_window: Option<ProposalWindow>,
    pub vote_window:     Option<VoteWindow>,
    pub proximity_tracker: HashMap<(String, String), u64>,
    pub sensor_history: VecDeque<WireMessage>,
    pub countdown_zero_ns: Option<u128>,   // from event.consensus_at() of final ReadyUp
}
```

Persisted at `artifacts/{label}-game.json` alongside the existing
`{label}-state.json`. Written inside `handle_vertex_message` after every
applied decision; the existing `file_watcher` in `web.rs` gains a tailer that
turns `*-game.json` updates into a new `WebEvent::GameStateChanged` SSE
message.

### Game-selection FSM

Lives inside `handle_vertex_message` in `src/node.rs` (thin dispatch; heavy
lifting in `src/game_fsm.rs` new module).

- `NoGame → Proposing`: first observed `GameProposal` opens a 30s window.
- `Proposing → Voting`: when distinct proposers ≥ `(swarm_size / 2) + 1`.
  On transition the local node auto-broadcasts its own `GameVote` for the
  proposal it observed most often (ties broken lexicographically by
  `game_id`).
- `Voting → Loaded`: after 30s or when every live peer has voted. Game with
  most votes wins (lex tie-break).
- `Loaded → PlacingEntities` immediately.
- `PlacingEntities → Ready`: when local rules evaluation says placement
  constraints satisfied for this node's claimed entity.
- `Ready → CountingDown` (all nodes): the final `ReadyUp` observed in
  consensus order. `countdown_zero_ns = event.consensus_at()` — identical
  across every node, eliminating clock skew. No countdown messages are
  broadcast.
- `CountingDown → Playing` when `now_ns ≥ countdown_zero_ns + 3_000_000_000`.
- `Playing → Ended` on any observed `GameEnd`.

Swarm size is passed into each child via a new `--swarm-size N` CLI flag
(set by `web.rs` on spawn) so nodes can compute the majority threshold
locally.

### Range + `pfctl` auto-sync — web server side

The web server is the only process that can call `sudo pfctl` on macOS, so
it owns the reconciler. Child nodes don't drive partitioning; they just
publish `SensorReading`s. The reconciler uses **range only** — obstacles
live in the frontend and don't influence consensus transport.

New module `src/geom.rs`:

```rust
pub fn in_range(a: Position, b: Position, radius_m: f32) -> bool;
pub fn connected_pairs(
    entities: &HashMap<String, EntityRecord>,
    radius_m: f32,
) -> HashSet<(String, String)>;
pub fn place_randomly_without_overlap(
    existing: &[Position],
    field: (f32, f32),        // passed in by caller from frontend-known dims
    min_sep_m: f32,
    rng: &mut impl rand::Rng,
) -> Position;
```

Field dimensions used by `place_randomly_without_overlap` are hardcoded in
the web server at the same 60m×30m as the frontend (trivially consistent
— one-line constants on each side). LOS lives only in the frontend
(`frontend/src/game/geom.ts`) since obstacles are frontend-owned and only
drive comm-edge rendering.

New background task in `src/web.rs` (`partition_reconciler`):

1. Every 500ms, aggregate current positions from `artifacts/{label}-game.json`
   snapshots (the same files `file_watcher` tails for SSE).
2. Compute `connected_pairs` (range-only); blocked-set = all-pairs − connected.
3. Map labels → UDP ports via the existing `label_to_port` helper.
4. Diff against live `PfPartitionManager::blocked_pairs()`; apply via a new
   atomic API.

Add to `src/pf.rs`:

```rust
pub async fn set_blocked(&self, pairs: HashSet<PortPair>) -> anyhow::Result<()>;
```

Replaces the internal set then does one `reload_rules()` call, avoiding the
current per-mutation `pfctl -f` churn. **Hysteresis**: don't block until
distance > `radius + 0.5m`, don't unblock until distance < `radius - 0.5m`
— prevents flapping on noisy movement near the boundary.

### Frontend — new `GameView` + selection overlay

`frontend/src/App.tsx` (modify): insert a new full-width `<GameView/>` between
the `NodeControl`/`NetworkGraph` row and `<FinalityChart/>`.

`frontend/src/components/GameView.tsx` (new):

- SVG-based (stays consistent with existing D3 graph). Outer `<g>` wrapped in
  `d3-zoom`.
- **Rendered in every phase**, including `NoGame`. The field is the single
  source of truth for where every node lives, from the moment it's created.
- Fixed 1200×600 px for a 60m×30m field (`20 px/m`), pulled from
  `frontend/src/game/presentation.ts`. Only `comm_radius_m` varies per
  loaded game and drives the comm-edge filter.
- Per-game presentation (gradient, obstacles array) looked up by `game_id`
  from the same `presentation.ts` module. No game loaded → neutral grey
  gradient, no obstacles.
- Layers, bottom-up: field background (gradient from presentation), rock
  obstacles (from presentation — frontend-only), dashed communication
  edges (for every pair in range and with in-browser LOS via
  `frontend/src/game/geom.ts::hasLos`), translucent comm-radius rings,
  entity icons, drag capture rects, countdown overlay.
- **Entity visuals** switch on phase:
  - Pre-`EntityTypeClaim`: neutral grey circle with the node's label (same
    look regardless of whether a game is loaded or not).
  - Post-claim: type-specific icon (flag 🚩, base as crenellated rect,
    player as directional triangle with team colour).
  - Stopped nodes: dimmed, non-draggable.
- `d3.drag()` — record pointer offset on `start`, move locally on `drag`,
  `POST /api/nodes/{label}/position {x,y}` only on `end`. Backend turns it
  into a `SensorReading` transaction. **Drag is enabled in every phase**,
  not just Playing — dragging pre-game exercises `partition_reconciler`
  and lets you demo `pfctl` partitioning without loading a game at all.

`frontend/src/components/GameSelectOverlay.tsx` (new): absolute overlay shown
when `phase ∈ {NoGame, Proposing, Voting}`. Three "Propose" buttons for the
pre-installed games; live tally bar chart; 30s countdown for each window.

`frontend/src/components/NodeControl.tsx` (modify): each NodeCard gains a
phase-aware status chip, an entity-type+team selector (cardinality-hit
options greyed out from the live snapshot), and a Ready-up button (enabled
only when the node's snapshot has `placement_ok=true`, written by the rules
engine).

`frontend/src/hooks/useGame.ts` (new): `useGames()`, `useGameState()` (via
SSE `game_state_changed`), `useGameActions()` with
`proposeGame/voteGame/claimEntity/moveEntity/readyUp`. Mirrors the shape of
`useApi.ts`.

`frontend/src/components/EventLog.tsx` (modify): add a red-backgrounded
`RULE_VIOLATION` tag rendering. No new plumbing required — the backend
already surfaces `log("RULE_VIOLATION", …)` via the existing SSE event-log
channel.

### Backend wiring

`src/node.rs` (modify):

- New CLI args `--initial-x` and `--initial-y` (f32). Store on
  `RuntimeState` as `initial_position: Option<Position>`.
- Extend `FileCommand` + `NodeCommand` enums with new variants for
  `propose_game`, `vote_game`, `claim_entity`, `set_position`, `ready_up`.
  Both the file-polling fallback (CLI runs) and the in-process mpsc channel
  (`web.rs`-embedded runs) need handling; keep them symmetric.
- On the first `SyncPoint` — right after the existing `Hello` send — also
  broadcast a seed `SensorReading` carrying `initial_position` (with empty
  `readings` vec since the node hasn't observed peers yet). This writes
  the position into consensus order and triggers the first
  `{label}-game.json` persistence.
- `handle_vertex_message`: after `update_peer_state`, call
  `rules::evaluate(…)` for every incoming `WireMessage`. Apply decisions:
  reject → log + broadcast `RuleViolation`; emit → broadcast
  `GameStateDelta`; end → broadcast `GameEnd`.
- `engine_loop`: widen the proof-emission filter from `matches!(k,
  StateUpdate)` to also include `GameStateDelta`, `GameEnd`, `RuleViolation`
  (so the Proofs tab picks up game-significant events). `StateUpdate` and
  `Hello`/`Heartbeat` paths unchanged.
- On events with transactions, pass `event.consensus_at()` into
  `handle_vertex_message` so the final `ReadyUp` can record the countdown
  zero.
- `control_loop`: add a 1 Hz `rules::tick(…)` invocation that emits any
  resulting deltas via the existing `tx_req_sender` channel.

`src/web.rs` (modify):

- `POST /api/swarm` (and the single-node add path): before spawning each
  child, call `geom::place_randomly_without_overlap` against the set of
  already-placed node positions and the default field dimensions; pass the
  chosen `(x, y)` via the new `--initial-x`/`--initial-y` CLI args.
  Persisted positions for the non-overlap check come from the same
  `{label}-game.json` snapshots the reconciler uses; for a fresh run,
  start from an empty set.
- New endpoints: `GET /api/games`, `POST /api/nodes/{label}/propose-game/{id}`,
  `POST /api/nodes/{label}/vote-game/{id}`, `POST /api/nodes/{label}/entity-type`,
  `POST /api/nodes/{label}/position`, `POST /api/nodes/{label}/ready`,
  `GET /api/games/active`.
- Each node-scoped POST writes the corresponding command to
  `artifacts/{label}-cmd.json` (or through the mpsc channel if embedded),
  preserving the existing "web server never originates consensus transactions"
  invariant.
- `file_watcher`: tail `artifacts/{label}-game.json`; emit
  `WebEvent::GameStateChanged { label, phase, game_id, snapshot }` on
  change.
- Spawn `partition_reconciler` task at startup, using
  `defaults::PRE_GAME_COMM_RADIUS_M` until a game is loaded, then
  `active_game.comm_radius_m`.

`src/state.rs` (modify): extend `WebEvent` with `GameStateChanged`,
`RuleViolated`, `PartitionAuto`. Surface them through the existing SSE
broadcast channel under new `type` discriminants.

## Phasing (each phase independently demoable)

1. **Phase A — foundation & spatial baseline.** `src/defaults.rs`,
   `src/geom.rs` (range + `place_randomly_without_overlap`), extend
   `MessageKind` + `GamePayload` with `SensorReading`, new
   `--initial-x`/`--initial-y` CLI args, seed-`SensorReading` on first
   SyncPoint, `{label}-game.json` persistence of position; frontend
   `presentation.ts` + `geom.ts`; `GameView.tsx` rendering nodes as
   generic circles with drag + dashed range-based (and LOS-filtered)
   communication edges. **End state**: Add Swarm → nodes appear at random
   non-overlapping positions; dragging one moves it; the dashed edges
   respond live.
2. **Phase B — `pfctl` auto-sync.** `partition_reconciler` task in
   `web.rs`; `PfPartitionManager::set_blocked` atomic API; hysteresis at
   the range boundary. **End state**: drag nodes apart → red scissors
   appear on NetworkGraph → FinalityChart finality degrades as quorum is
   lost → heal on return. This entire phase demoable with no game loaded.
3. **Phase C — game configs & selection.** `games/*.json` + `src/games.rs`
   loader; `src/rules.rs` skeleton + unit tests; FSM in child nodes;
   file/mpsc command extensions; `/api/games`,
   `/api/nodes/{label}/{propose,vote}-game/{id}`;
   `GameSelectOverlay`. **End state**: propose, vote, "CTF loaded" on
   every node; active `comm_radius_m` swaps in and reconciler reflects it.
4. **Phase D — claims, placement & ready-up.** `EntityTypeClaim` with
   cardinality rejection; placement-constraint rules; `ReadyUp`; entity
   visuals swap on claim; entity-type assignment UI on NodeControl cards;
   ready-up button + countdown overlay.
5. **Phase E — gameplay rules.** Full rule DSL evaluator (including
   `proximity_duration_s` and 1 Hz `tick`); `GameStateDelta` synthesis;
   score tracking; `GameEnd`; KotH and Territory JSON configs to prove
   DSL sufficiency; bad-actor stress test.

## Critical files (to modify or create)

- `/Users/justyn/dev/tashi/hackathon-warm-up/src/protocol.rs` — extend
  `MessageKind`, add `GamePayload` + `Position` + `SensorDatum`.
- `/Users/justyn/dev/tashi/hackathon-warm-up/src/node.rs` — rules + FSM
  dispatch in `handle_vertex_message`; widen proof filter; extend
  `FileCommand`/`NodeCommand`; 1 Hz `rules::tick` in `control_loop`.
- `/Users/justyn/dev/tashi/hackathon-warm-up/src/rules.rs` **(new)** —
  pure-function rule evaluator.
- `/Users/justyn/dev/tashi/hackathon-warm-up/src/game_state.rs` **(new)** —
  `LocalGameState` + `GamePhase` + persistence.
- `/Users/justyn/dev/tashi/hackathon-warm-up/src/game_fsm.rs` **(new)** —
  proposal/vote windows.
- `/Users/justyn/dev/tashi/hackathon-warm-up/src/games.rs` **(new)** — config
  loader (reuse `serde_json`).
- `/Users/justyn/dev/tashi/hackathon-warm-up/src/geom.rs` **(new)** —
  range-only `in_range`/`connected_pairs` + `place_randomly_without_overlap`.
  No LOS (obstacles are frontend-only).
- `/Users/justyn/dev/tashi/hackathon-warm-up/src/defaults.rs` **(new)** —
  `PRE_GAME_COMM_RADIUS_M`, `MIN_SEP_M`, and the hardcoded field dims used
  for random placement (kept in lockstep with frontend presentation).
- `/Users/justyn/dev/tashi/hackathon-warm-up/src/web.rs` — new endpoints,
  `file_watcher` game-json tailer, `partition_reconciler` task.
- `/Users/justyn/dev/tashi/hackathon-warm-up/src/state.rs` — new `WebEvent`
  variants.
- `/Users/justyn/dev/tashi/hackathon-warm-up/src/pf.rs` — atomic
  `set_blocked(pairs)` API (replaces per-mutation `reload_rules`).
- `/Users/justyn/dev/tashi/hackathon-warm-up/games/ctf.json`,
  `king_of_the_hill.json`, `territory.json` **(new)**.
- `/Users/justyn/dev/tashi/hackathon-warm-up/frontend/src/App.tsx` — insert
  `GameView`, wire new hooks.
- `/Users/justyn/dev/tashi/hackathon-warm-up/frontend/src/components/GameView.tsx`
  **(new)** — SVG field + D3 drag + overlays.
- `/Users/justyn/dev/tashi/hackathon-warm-up/frontend/src/components/GameSelectOverlay.tsx`
  **(new)**.
- `/Users/justyn/dev/tashi/hackathon-warm-up/frontend/src/components/NodeControl.tsx`
  — phase chip, entity-type selector, ready-up button.
- `/Users/justyn/dev/tashi/hackathon-warm-up/frontend/src/components/EventLog.tsx`
  — `RULE_VIOLATION` styling.
- `/Users/justyn/dev/tashi/hackathon-warm-up/frontend/src/hooks/useGame.ts`
  **(new)** — mirrors `useApi.ts`.
- `/Users/justyn/dev/tashi/hackathon-warm-up/frontend/src/game/types.ts`
  **(new)** — hand-written mirror of Rust game-config types (no field or
  obstacles).
- `/Users/justyn/dev/tashi/hackathon-warm-up/frontend/src/game/presentation.ts`
  **(new)** — `FIELD_WIDTH_M`, `FIELD_HEIGHT_M`, `PX_PER_M`, and per-game
  `{ gradient, obstacles[] }` keyed by `game_id` (plus a pre-game default).
- `/Users/justyn/dev/tashi/hackathon-warm-up/frontend/src/game/geom.ts`
  **(new)** — in-browser `inRange` and `hasLos` for comm-edge rendering.

Existing utilities/patterns to reuse (not reinvent):

- `PfPartitionManager::{partition, heal, blocked_pairs, restore}` — atomic
  `set_blocked` builds on this.
- `send_vertex_transaction`, `TxRequest` channel, `process_tx_request` —
  every new broadcast (proposals, votes, sensor readings, deltas) goes
  through the existing path.
- `log(tag, label, message)` in `state.rs` — `RULE_VIOLATION` surfaces
  automatically via this + the SSE log channel.
- `file_watcher` in `web.rs` — already polls `artifacts/` every 200ms;
  extend to tail `*-game.json`.
- `useSSE` throttled-callback pattern in `hooks/useApi.ts` — reuse for
  `game_state_changed`.
- `d3.drag()` — already a dep; no new drag-and-drop library needed.
- `ProofOfCoordination::from_event` — unchanged; just widen the filter for
  which kinds produce proofs.

## Risks and subtleties

- **Byzantine quorum vs. spatial partitions.** If the cluster splits 4-3,
  the 3-side stalls (no BFT quorum); the 4-side progresses. A 3-2-2 split
  stalls everyone. Per the agreed demo intent this is *the point* — surface
  a "consensus stalled — no quorum" banner derived from "no new proofs in
  the last 10s while partitions are live".
- **`pfctl` churn.** Mitigated by 500ms reconciler cadence, atomic
  `set_blocked`, and 0.5m hysteresis at the range boundary.
- **Obstacles are visual only.** By keeping field and obstacles frontend-
  owned, the backend stays rules-focused and the dual-ownership problem is
  avoided. The tradeoff: a player can still consensus-talk to a peer on
  the other side of a rock as long as they're within range. LOS-severance
  is a rendering cue (no dashed edge) rather than a real partition. If
  needed later, promote obstacles to a backend-readable config.
- **Ordering / partial views.** A `SensorReading` may reference peers whose
  `EntityTypeClaim` hasn't yet arrived in consensus order. Unknown-entity
  predicates must fail silently (not reject). On a new claim arriving, the
  rules engine re-scans the bounded `sensor_history`. Idempotent effects
  keep re-runs safe.
- **Countdown clock skew.** Eliminated by pinning `countdown_zero_ns` to the
  Vertex `event.consensus_at()` of the final `ReadyUp` — a consensus-level
  timestamp identical on every node. Never use wall clock.
- **Per-node state divergence.** Every node evaluates rules on the same
  ordered event stream, so all should converge. Two nodes racing to emit
  the same `GameStateDelta` is fine (idempotent). Genuine divergence
  manifests as a `RuleViolation` in the log.
- **Bad-actor resistance.** A `physically_plausible` predicate
  (`max_velocity_m_per_s`) catches fabricated `SensorReading`s that
  contradict an entity's last-known position. Makes the "curl a fake
  reading" demo concrete — all nodes reject in consensus order.
- **Rule DSL Turing-completeness.** Forbidden. No loops, no arithmetic
  beyond `increment`, no cross-rule dependencies inside a single
  evaluation. Each rule is a pure `(event, state) → decision`.
- **`WireMessage` backwards compat.** `game: Option<GamePayload>` with
  `#[serde(default)]` keeps existing proof JSON parseable.
- **Proof emission.** Widen
  `matches!(w.kind, StateUpdate)` in `engine_loop` to include
  `GameStateDelta | GameEnd | RuleViolation` so the Proofs tab remains
  useful for the demo. `Hello`/`Heartbeat` still excluded.

## Verification plan

End-to-end demo script (7 nodes = 1 flag + 2 bases + 2 red players + 2 blue
players):

1. `sudo cargo run -- serve` (sudo for pfctl), `cd frontend && bun run dev`.
2. UI → Add Swarm = 7 → Start All. Nodes appear immediately on `GameView`
   at random non-overlapping positions (generic grey circles with labels).
   Dashed comm edges render between pairs inside the pre-game default
   radius (12m).
3. **Pre-game partition demo**: drag agent-g far from the cluster. Watch
   comm edges drop; red scissors appear on NetworkGraph as
   `partition_reconciler` applies `pfctl` blocks; FinalityChart finality
   points start spacing out if quorum is lost. Drag back — heals.
4. On any node: "Propose CTF". Watch overlay show proposals accumulating.
5. Voting phase opens; votes accumulate; CTF loads on every node. Comm
   radius visibly tightens from 12m to 8m (CTF config) — `pfctl`
   reconciler picks up new blocks immediately if any pair was inside
   12m but outside 8m. Red/blue field gradient + rocks fade in (frontend
   presentation only — rocks hide comm edges visually but don't drive
   `pfctl`).
6. Assign entities on the cards. Try a cardinality-violating claim (second
   flag) — expect `RULE_VIOLATION` event in the log and the claim to be
   rejected. Accepted claims swap the entity's icon on the field.
7. Drag each entity into position. Try dropping the flag within 20m of a
   base — expect the Ready button to stay disabled.
8. Ready-up all 7 nodes. Countdown overlay shows `3 / 2 / 1 / GO!` in
   lockstep on all nodes.
9. During play: drag a red player adjacent to the flag and hold for 10s.
   Rule fires; `flag.owner_team = "red"`; score increments.
10. Drag a player >8m from everyone else. `partition_reconciler` kicks in
    again; FinalityChart flattens until they return.
11. Over curl, send a fake `SensorReading` claiming an impossible jump.
    Every node rejects in consensus order; the log shows synchronised
    `RULE_VIOLATION` entries.

Unit tests:

- `src/rules_tests.rs` — fixture `LocalGameState` + synthetic `WireMessage`,
  one test per predicate variant; golden-file tests for each shipped game's
  full rule set.
- `src/game_fsm_tests.rs` — simulate proposal/vote sequences incl. the 30s
  timeout branch via a mockable clock trait.
- `src/geom_tests.rs` — `in_range`/`connected_pairs` fixtures;
  `place_randomly_without_overlap` invariants (min separation upheld;
  within-bounds; grid fallback triggers and covers on a packed field).
- `frontend/src/game/geom.test.ts` — Vitest coverage of `inRange` /
  `hasLos` (segment-vs-circle) for the comm-edge rendering layer.
- `tests/game_config_load.rs` — parses each shipped `games/*.json` so schema
  drift fails CI rather than at runtime.
- `frontend/src/game/types.test.ts` — Vitest parse-check the same fixtures
  through the TS types.

Stress test (new `cargo run -- stress` CLI): spawns 7 nodes, proposes CTF,
moves a player across the comm-radius boundary 10× over 60s. Asserts:
consensus stalls after a split that loses quorum (no new proofs); recovery
within 5s of heal.

## Open items deferred to implementation

- Trilateration (using `angle_rad` to infer non-visible peer positions) is
  modelled in the `SensorDatum` schema but not needed for the demo — nodes
  publish their own `pos` directly. Leave for a future iteration.
- A "viewer" mode that shows the game state from a specific node's
  perspective (to truly drive home per-node consistency) would be a nice
  addition once Phase D lands; not on the critical path.
