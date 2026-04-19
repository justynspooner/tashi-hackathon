# Tashi Vertex Explorer

A live coordination explorer built on the [Tashi Vertex](https://github.com/tashigit/tashi-vertex-rs) BFT consensus engine. Nodes perform signed handshakes, exchange heartbeats, replicate state, detect staleness, recover automatically, and produce cryptographic proofs of coordination — all visible in real time through a browser dashboard.

## Prerequisites

- Rust toolchain
- CMake >= 4.0
- Node.js / Bun (for the frontend dev server)

## Quick start

**Terminal 1 — Rust API server + node manager:**

```sh
cargo run -- serve
```

If you want to be able to sever connections between nodes, you'll need to run in sudo (MacOS only).

```sh
sudo cargo run -- serve
```

**Terminal 2 — Frontend dev server:**

```sh
cd frontend && bun install && bun run dev
```

Open `http://localhost:5173`. Use the dashboard to start/stop nodes, change roles, and watch consensus events stream in.

For auto-reload on Rust changes:

```sh
cargo install cargo-watch
cargo watch -x 'run -- serve'
```

## Architecture

```
React (Vite)  ──proxy──▶  Axum (Rust)  ──threads──▶  Vertex Nodes
   :5173        /api          :3001                    :9000, :9001
```

- **Axum web server** (`src/web.rs`) — manages node lifecycle, serves REST + SSE APIs, holds all state in memory
- **Vertex nodes** — each runs in its own thread with a `current_thread` tokio runtime, communicating with the web server via `mpsc` channels
- **Frontend** — React 19 + Tailwind, driven by Server-Sent Events (no polling)

## CLI commands

### `serve` — start the web server (primary way to run)

```sh
cargo run -- serve [--port 3001]
```

Generates keypairs and node config automatically on first run. Nodes are started/stopped from the browser.

### `run` — run a standalone node (advanced)

```sh
cargo run -- run \
  --label agent-a \
  --bind 127.0.0.1:9000 \
  --secret <SECRET> \
  --peer-addr 127.0.0.1:9001 \
  --peer-pubkey <PUBKEY> \
  --role carrier \
  --status ready
```

### `gen-key` — generate an Ed25519 keypair

```sh
cargo run -- gen-key
```

### `verify` — verify a proof file

```sh
cargo run -- verify --proof-file artifacts/proofs/agent-a/proof-0.json
```

### `stress` — run the scripted reconciler scenarios (no Vertex, no sudo)

```sh
cargo run -- stress
```

Exercises the range-based `partition_reconciler` against synthetic fixtures:
boundary flapping absorbed by hysteresis, full separation → return, and a 7-node
CTF layout that cleanly partitions red/blue teams. Exits non-zero on any
regression.

## Dashboard features

- **Network Topology** — D3 visualization with animated pulses for heartbeats, state changes, and acknowledgements
- **Game View** — top-down 2D playing field where every node is a spatial entity. Drag to reposition; ranges, comm edges, and (once a game is loaded) team icons render live
- **Game Selection Overlay** — propose, vote, and load one of the three pre-installed games (Capture the Flag, King of the Hill, Territory Control) through consensus
- **Consensus Stalled Banner** — surfaces when partitions drop the cluster below BFT quorum and no new proofs have landed in the last 10s
- **Node Control** — start/stop nodes, change roles (carrier, scout, observer, relay), claim entity types and teams, ready-up, create/destroy swarms
- **Live Event Log** — virtualized scrolling log filtered by event type (incl. `RULE_VIOLATION`), driven by SSE
- **Proofs of Coordination** — expandable table with one-click verification
- **Finality Chart** — real-time area chart tracking consensus finality over time
- **Event Timeline** — chronological view of consensus transactions extracted from proofs
- **Partition Simulation** — create and heal network partitions between nodes to test fault tolerance. Now also driven automatically by the range-based `partition_reconciler` whenever nodes drag out of comm radius (macOS only, uses `pfctl`)

## Game mode

Three games ship pre-installed in `games/*.json`. Each one is a consensus-driven multiplayer match where:

- Every node **is** an entity on the field — flag, team base, or player. Positions are gossiped as `SensorReading` transactions and reach all nodes in the same order.
- Entity type and team claims go through a cardinality rule (e.g. only one flag; two bases; 2-4 players per team). Invalid claims are rejected in consensus order as `RuleViolation` events.
- Placement constraints (e.g. flag ≥ 20 m from any base, players within 2 m of their base) gate the `Ready` button per node.
- Ready-up is unanimous; the countdown starts from the consensus timestamp of the final `ReadyUp`, so every node counts down in lockstep with zero clock skew.
- Gameplay rules (flag capture, hill control, territory hold) are expressed in a restricted declarative DSL (`all`/`any`/`not` predicates over `entity_is`, `proximity_duration_s`, `property_equals`, etc.) and evaluated per-node from the ordered event stream.
- Moving a node out of the active game's `comm_radius_m` trips `partition_reconciler`, which applies a real `pfctl` block. If that loses quorum, the Finality Chart flattens until the partition heals.
- Bad-actor transactions (e.g. a `curl`'d `SensorReading` claiming impossible velocity) are rejected by a `physically_plausible` gate on every node.

## API endpoints

| Method | Path                                            | Description                                                 |
| ------ | ----------------------------------------------- | ----------------------------------------------------------- |
| GET    | `/api/events`                                   | SSE stream of real-time events                              |
| GET    | `/api/state`                                    | Current agent states (local + peers)                        |
| GET    | `/api/proofs`                                   | List all proofs                                             |
| GET    | `/api/event-log`                                | Tail event log (optional `?limit=`)                         |
| GET    | `/api/proofs/:agent/:file/verify`               | Verify a specific proof                                     |
| GET    | `/api/nodes`                                    | List configured nodes and status                            |
| POST   | `/api/nodes/:label/start`                       | Start a node                                                |
| POST   | `/api/nodes/:label/stop`                        | Stop a node                                                 |
| POST   | `/api/nodes/:label/role`                        | Change a node's role                                        |
| POST   | `/api/nodes/:label/position`                    | Set the node's position (broadcast as `SensorReading`)      |
| POST   | `/api/nodes/:label/propose-game/:id`            | Propose a game (starts 30s proposal window)                 |
| POST   | `/api/nodes/:label/vote-game/:id`               | Vote for a proposed game                                    |
| POST   | `/api/nodes/:label/entity-type`                 | Claim an `EntityTypeClaim` (entity type + optional team)    |
| POST   | `/api/nodes/:label/ready`                       | Ready-up (gated by local `placement_ok`)                    |
| GET    | `/api/game-state`                               | All nodes' latest game-state snapshots                      |
| GET    | `/api/games`                                    | Game configs parsed from `./games/*.json`                   |
| POST   | `/api/swarm`                                    | Create multiple nodes at once (auto-assigns positions)      |
| DELETE | `/api/swarm`                                    | Destroy all swarm nodes                                     |
| GET    | `/api/partitions`                               | List active network partitions (manual + reconciler-driven) |
| POST   | `/api/partitions/create`                        | Create a partition between nodes                            |
| POST   | `/api/partitions/heal`                          | Heal a partition                                            |
| POST   | `/api/clear-artifacts`                          | Reset all artifacts                                         |

## Event tags

| Tag               | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `DISCOVERY`       | Peer session becomes visible                                                 |
| `HANDSHAKE`       | Signed `HELLO` sent/verified via Vertex consensus                            |
| `HEARTBEAT`       | Ongoing liveness traffic on the UDP control channel                          |
| `STATE`           | Peer mirroring a role change                                                 |
| `PROOF`           | Proof-of-coordination file written                                           |
| `FINALITY`        | Per-event finality measurement fed into the Finality Chart                   |
| `GAME_EVENT`      | Game-lifecycle step: proposal, vote, load, ready-up, delta, end              |
| `SENSOR`          | Position update broadcast (initial seed or drag-drop)                        |
| `RULE`            | Rules engine accepted a consensus event (predicate fired, effect applied)    |
| `RULE_VIOLATION`  | Rules engine rejected a consensus event (cardinality, physics, placement, …) |
| `ACTION` / `ACTION_ERR` | Local command dispatched to / failed at Vertex                         |

## Proof of coordination

Every consensus event containing transactions is saved as a self-contained JSON proof. Each proof includes:

- **`event_hash`** — cryptographic hash from the Vertex BFT engine, proving super-majority agreement
- **`consensus_at`** — nanosecond timestamp when the network reached agreement
- **`finality_ms`** — time from event creation to consensus finality (typically <100ms on localhost)
- **`transactions`** — the agreed-upon payload
- **`content_hash`** — SHA-256 over canonical proof fields for tamper detection

The `verify` command (or the dashboard's Verify button) recomputes the content hash and checks it matches.

## Project structure

```
src/
  main.rs         — CLI definition (serve, run, gen-key, verify, stress)
  web.rs          — Axum web server, SSE, node lifecycle, partition reconciler
  node.rs         — Vertex engine setup, async loops, rules/FSM dispatch
  protocol.rs     — Wire format (MessageKind, WireMessage, GamePayload, Position)
  state.rs        — Runtime state, persistence, cross-thread channel types
  proof.rs        — ProofOfCoordination generation and verification
  pf.rs           — pfctl-driven partition manager (atomic set_blocked)
  defaults.rs     — PRE_GAME_COMM_RADIUS_M, MIN_SEP_M, field dimensions
  geom.rs         — Pure distance/range helpers + non-overlap random placement
  games.rs        — GameConfig loader for games/*.json
  game_state.rs   — Per-node LocalGameState + persistence to {label}-game.json
  game_fsm.rs     — Proposal/vote window FSM
  rules.rs        — Pure rule-engine DSL evaluator (predicates + effects)
  stress.rs       — Scripted reconciler scenarios (no Vertex, no sudo)
  lib.rs          — Re-exports for integration tests

games/
  ctf.json, king_of_the_hill.json, territory.json

tests/
  game_config_load.rs  — Every shipped game config parses and passes invariants

frontend/
  src/
    App.tsx              — Main layout, SSE wiring, game-view insertion
    hooks/useApi.ts      — Core data hooks (SSE-driven, no polling)
    hooks/useGame.ts     — Game-state / actions hooks (propose, vote, claim, …)
    lib/utils.ts         — Shared helpers (role colors, formatting)
    types.ts             — TypeScript interfaces
    game/
      types.ts           — Hand-written TS mirror of game-config types
      geom.ts            — In-browser inRange / hasLos for comm-edge rendering
      presentation.ts    — Field dims, PX_PER_M, per-game gradient/obstacles
    components/
      NetworkGraph.tsx         — D3 network topology visualization
      NodeControl.tsx          — Node start/stop/role/entity/ready management
      EventLog.tsx             — Virtualized live event log (RULE_VIOLATION styled)
      ProofList.tsx            — Proof table with verification
      ProofDetail.tsx          — Expandable proof details
      FinalityChart.tsx        — Consensus finality metrics chart
      EventTimeline.tsx        — Chronological consensus timeline
      GameView.tsx             — SVG playing field, drag, comm edges, entities
      GameSelectOverlay.tsx    — Propose / vote / load UI
      ConsensusStalledBanner.tsx — Quorum-loss surface
```

## Design notes

- Vertex handles peer discovery, session establishment, and BFT consensus.
- Heartbeats, state updates, sensor readings, and all game-lifecycle messages flow through the same `WireMessage` envelope; proof emission filters on `StateUpdate | SensorReading | GameStateDelta | GameEnd | RuleViolation`.
- The Axum server communicates with node threads via `tokio::sync::mpsc` channels — no file-based IPC on the hot path.
- Per-node game state is persisted to `artifacts/{label}-game.json` and tailed by the web server's `file_watcher`, then pushed to the frontend via SSE.
- Proof files are written to disk under `artifacts/proofs/` for durability.
- Network partitions are driven by two paths that share the same `PfPartitionManager`: explicit user partitions via the dashboard, and the range-based `partition_reconciler` task (500 ms cadence, 0.5 m hysteresis around `comm_radius_m`).
- The rules engine is pure-function — no I/O, no locks — and evaluated from the consensus event stream, so every node converges to the same decisions.
- Countdown uses the Vertex `event.consensus_at()` of the final `ReadyUp` to eliminate wall-clock skew across nodes.
