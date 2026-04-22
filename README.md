# Tashi Vertex Explorer

A live coordination explorer built on the [Tashi Vertex](https://github.com/tashigit/tashi-vertex-rs) BFT consensus engine.

A swarm of nodes performs signed handshakes, replicates game state, detects partitions, recovers automatically, and produces cryptographic proofs of coordination — all visible in real time through a browser dashboard. Three ready-to-play multiplayer games (Capture the Flag, King of the Hill, Territory Control) ride on top of the same consensus stream.

---

## Prerequisites

- Rust toolchain (stable)
- CMake ≥ 4.0
- [Bun](https://bun.sh) (or Node) for the frontend

## Quick start

Open two terminals from the project root.

**Terminal 1 — backend + node manager**

```sh
cargo run -- serve
```

On first run this generates keypairs and `artifacts/node-config.json` for you.

> On macOS, run with `sudo` if you want the dashboard to enforce real `pfctl` partitions between nodes:
> ```sh
> sudo cargo run -- serve
> ```

**Terminal 2 — frontend dev server**

```sh
cd frontend && bun install && bun run dev
```

Open **http://localhost:5173**.

### Auto-reload on Rust changes (optional)

```sh
cargo install cargo-watch
cargo watch -x 'run -- serve'
```

---

## What you'll see

The dashboard is a canvas-centric, Unity-style layout:

- **Top chrome** — aggregate phase / node count, global actions (deploy swarm, start/stop all, auto-select game, ready-all), clear artifacts, theme and connection status.
- **Scene tree (left)** — flat list of nodes pre-game; once a game loads, nodes group by team. Obstacles are managed here too.
- **Canvas (center)** — 60×30 m playing field. Drag nodes to reposition them; live comm-range edges and (in-game) team icons render on top. Click any node, edge, or obstacle to inspect it.
- **Inspector (right)** — context-sensitive panel for the current selection: node details and actions, edge distance / partition toggle, or obstacle properties.
- **Bottom drawer** — tabbed: **Events** (virtualized live log), **Timeline** (consensus transactions), **Proofs** (one-click verification), **Finality chart**.

---

## Playing a game

1. Click **Deploy Swarm** in the top chrome to spin up N nodes (default 4).
2. Press **Start All** to launch them. Once they've discovered each other, press **Auto-select Game** to propose and vote one of the three games through consensus.
3. Drag nodes onto the field. Each node claims an entity (flag, base, hill, zone, or player) via a `EntityTypeClaim` that passes through BFT consensus — invalid claims (too many flags, wrong team count, …) are rejected as `RULE_VIOLATION` events.
4. Satisfy placement constraints (e.g. flag ≥ 10 m from any base), then **Ready All**. The countdown starts from the Vertex timestamp of the final ready-up — zero clock skew across nodes.
5. Play: drag a "player" node near a hill / zone / flag and watch scoring rules fire in lockstep on every node. Drag a node outside the 15 m comm radius to trigger a real `pfctl` partition and watch the Finality Chart flatten until you bring it back.

---

## CLI commands

All commands run from the project root.

| Command | Purpose |
| ------- | ------- |
| `cargo run -- serve [--port 3001]` | Start the web server + node manager (the primary way to run) |
| `cargo run -- gen-key` | Generate a fresh Ed25519 keypair |
| `cargo run -- verify --proof-file <path>` | Verify a proof-of-coordination JSON file |
| `cargo run -- stress` | Run the scripted partition-reconciler scenarios (no Vertex, no sudo). Exits non-zero on regression. |
| `cargo run -- run --bind … --secret … --peer-addr … --peer-pubkey …` | Run a single standalone node (advanced) |

---

## Architecture

```
React (Vite) ──proxy──▶ Axum (Rust) ──tokio mpsc──▶ Vertex nodes
   :5173       /api       :3001                      :9000, :9001, …
```

- **Axum web server** (`src/web.rs`) — REST + SSE, owns the node lifecycle, holds all state in memory.
- **Vertex nodes** — each runs in its own thread with a `current_thread` tokio runtime, talking to the web server over `tokio::sync::mpsc` channels.
- **Frontend** — React 19 + Tailwind, driven entirely by Server-Sent Events (no polling).

---

## API endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/events` | SSE stream of real-time events |
| GET    | `/api/state` | Current agent states (local + peers) |
| GET    | `/api/proofs` | List all proofs |
| GET    | `/api/proofs/:agent/:file/verify` | Verify a specific proof |
| GET    | `/api/event-log` | Tail event log (optional `?limit=`) |
| GET    | `/api/nodes` | List configured nodes and status |
| POST   | `/api/nodes/:label/start` · `/stop` | Start / stop a node |
| POST   | `/api/nodes/:label/position` | Move a node (broadcast as `SensorReading`) |
| POST   | `/api/nodes/:label/propose-game/:id` | Propose a game (opens 30 s window) |
| POST   | `/api/nodes/:label/vote-game/:id` | Vote for a proposed game |
| POST   | `/api/nodes/:label/entity-type` | Claim an entity type (+ optional team) |
| POST   | `/api/nodes/:label/ready` | Ready-up (gated by local `placement_ok`) |
| GET    | `/api/game-state` | All nodes' latest game-state snapshots |
| GET    | `/api/games` | Game configs parsed from `./games/*.json` |
| POST   | `/api/swarm` · DELETE | Create / destroy multiple nodes in one call |
| GET    | `/api/partitions` | List active network partitions |
| POST   | `/api/partitions/create` · `/heal` | Manually partition / heal a pair |
| POST   | `/api/clear-artifacts` | Reset artifacts directory |

## Event tags

| Tag | Meaning |
| --- | ------- |
| `DISCOVERY` | Peer session becomes visible |
| `HANDSHAKE` | Signed `HELLO` sent/verified via Vertex consensus |
| `HEARTBEAT` | Liveness traffic on the UDP control channel |
| `STATE` | Peer mirroring a state change |
| `SENSOR` | Position update broadcast (seed or drag-drop) |
| `PROOF` | Proof-of-coordination file written |
| `FINALITY` | Per-event finality feeding the Finality Chart |
| `GAME_EVENT` | Proposal / vote / load / ready / delta / end |
| `RULE` | Rules engine accepted an event (predicate fired, effect applied) |
| `RULE_VIOLATION` | Rules engine rejected an event (cardinality, physics, placement, …) |
| `ACTION` / `ACTION_ERR` | Local command dispatched to / failed at Vertex |

---

## Proof of coordination

Every consensus event carrying transactions is saved as a self-contained JSON proof in `artifacts/proofs/<agent>/`:

- `event_hash` — cryptographic hash from the Vertex BFT engine
- `consensus_at` — nanosecond timestamp when agreement was reached
- `finality_ms` — time from event creation to finality (typically <100 ms on localhost)
- `transactions` — the agreed-upon payload
- `content_hash` — SHA-256 over canonical fields for tamper detection

The `verify` subcommand (or the Proofs tab's **Verify** button) recomputes `content_hash` and checks it matches.

---

## Project layout

```
src/
  main.rs         CLI entry (serve, run, gen-key, verify, stress)
  web.rs          Axum server, SSE, node lifecycle, partition reconciler
  node.rs         Vertex engine setup, async loops, rule dispatch
  rules.rs        Pure rule-engine DSL evaluator
  game_fsm.rs     Proposal/vote window state machine
  game_state.rs   LocalGameState + per-node persistence
  games.rs        GameConfig loader for games/*.json
  protocol.rs     WireMessage, Position, GamePayload
  proof.rs        ProofOfCoordination build + verify
  pf.rs           pfctl-driven partition manager (macOS)
  geom.rs         Distance / range / LOS helpers
  defaults.rs     COMM_RADIUS_M, field dimensions, reconciler cadence
  state.rs        Runtime state, channels, log plumbing
  stress.rs       Scripted reconciler scenarios

games/            ctf.json, king_of_the_hill.json, territory.json
tests/            Integration tests (game configs, rule evaluator)

frontend/src/
  App.tsx                   Wires providers + layout regions
  components/
    layout/                 AppShell + BottomDrawer (CSS-grid viewport)
    top-chrome/             Title bar + Global Actions popover
    scene-tree/             Left panel: nodes grouped by team, obstacles
    canvas/                 Canvas wrappers + HUDs
    inspector/              Right panel: node / edge / obstacle inspectors
    GameView.tsx            Main SVG playing field (drag, edges, entities)
    EventLog / EventTimeline / ProofList / FinalityChart / ConsensusStalledBanner
  hooks/                    useApi (SSE-driven), useGame, useErrorToast
  state/                    React contexts (Selection, Data, Actions, Obstacles)
  game/                     Types, geom, presentation constants
```

---

## Design notes

- Vertex handles peer discovery, session establishment, and BFT consensus.
- All game messages (handshake, heartbeat, sensor, game-lifecycle) share the `WireMessage` envelope. Proofs are written for `StateUpdate | SensorReading | GameStateDelta | GameEnd | RuleViolation`.
- Per-node game state is persisted to `artifacts/{label}-game.json` and tailed by the web server, then pushed to the frontend via SSE.
- Partitions share one `PfPartitionManager`: explicit user severs and the range-based `partition_reconciler` (500 ms cadence, 0.5 m hysteresis around the 15 m comm radius) both converge on the same desired blocked set.
- The rules engine is pure-function — no I/O, no locks — evaluated from the consensus event stream, so every node converges to the same decisions.
- Countdown uses Vertex's `event.consensus_at()` of the final `ReadyUp` to eliminate wall-clock skew.
- Bad-actor transactions (e.g. a `curl`'d `SensorReading` claiming impossible velocity) are rejected by a `physically_plausible` gate on every node.
