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

## Dashboard features

- **Network Topology** — D3 visualization with animated pulses for heartbeats, state changes, and acknowledgements
- **Node Control** — start/stop nodes, change roles (carrier, scout, observer, relay), create/destroy swarms
- **Live Event Log** — virtualized scrolling log filtered by event type, driven by SSE
- **Proofs of Coordination** — expandable table with one-click verification
- **Finality Chart** — real-time area chart tracking consensus finality over time
- **Event Timeline** — chronological view of consensus transactions extracted from proofs
- **Partition Simulation** — create and heal network partitions between nodes to test fault tolerance (macOS only, uses `pfctl`)

## API endpoints

| Method | Path                              | Description                          |
| ------ | --------------------------------- | ------------------------------------ |
| GET    | `/api/events`                     | SSE stream of real-time events       |
| GET    | `/api/state`                      | Current agent states (local + peers) |
| GET    | `/api/proofs`                     | List all proofs                      |
| GET    | `/api/event-log`                  | Tail event log (optional `?limit=`)  |
| GET    | `/api/proofs/:agent/:file/verify` | Verify a specific proof              |
| GET    | `/api/nodes`                      | List configured nodes and status     |
| POST   | `/api/nodes/:label/start`         | Start a node                         |
| POST   | `/api/nodes/:label/stop`          | Stop a node                          |
| POST   | `/api/nodes/:label/role`          | Change a node's role                 |
| POST   | `/api/swarm`                      | Create multiple nodes at once        |
| DELETE | `/api/swarm`                      | Destroy all swarm nodes              |
| GET    | `/api/partitions`                 | List active network partitions       |
| POST   | `/api/partitions/create`          | Create a partition between nodes     |
| POST   | `/api/partitions/heal`            | Heal a partition                     |
| POST   | `/api/clear-artifacts`            | Reset all artifacts                  |

## Event tags

| Tag         | Meaning                                             |
| ----------- | --------------------------------------------------- |
| `DISCOVERY` | Peer session becomes visible                        |
| `HANDSHAKE` | Signed `HELLO` sent/verified via Vertex consensus   |
| `HEARTBEAT` | Ongoing liveness traffic on the UDP control channel |
| `STATE`     | Peer mirroring a role change                        |
| `ACK`       | Acknowledgement of a state change                   |
| `STALE`     | Peer marked stale after 10s without traffic         |
| `RECOVERY`  | Automatic resume when a stale peer returns          |
| `PROOF`     | Proof-of-coordination file written                  |

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
  main.rs       — CLI definition and entry point
  web.rs        — Axum web server, SSE, node lifecycle management
  node.rs       — Vertex engine setup, async loops, message sending
  protocol.rs   — Wire format types (MessageKind, WireMessage, SharedState)
  state.rs      — Runtime state, persistence, cross-thread channel types
  proof.rs      — ProofOfCoordination generation and verification
  pf.rs         — Network partition simulation via macOS pfctl

frontend/
  src/
    App.tsx              — Main layout, SSE wiring
    hooks/useApi.ts      — Data hooks (SSE-driven, no polling)
    lib/utils.ts         — Shared helpers (role colors, formatting)
    types.ts             — TypeScript interfaces
    components/
      NetworkGraph.tsx   — D3 network topology visualization
      NodeControl.tsx    — Node start/stop/role/swarm management
      EventLog.tsx       — Virtualized live event log
      ProofList.tsx      — Proof table with verification
      ProofDetail.tsx    — Expandable proof details
      FinalityChart.tsx  — Consensus finality metrics chart
      EventTimeline.tsx  — Chronological consensus timeline
```

## Design notes

- Vertex handles peer discovery, session establishment, and BFT consensus.
- Heartbeats, state updates, and ACKs flow over a direct UDP control channel (`bind_port + 1000`).
- The Axum server communicates with node threads via `tokio::sync::mpsc` channels — no file-based IPC.
- State changes are pushed to the frontend via SSE in real time.
- Proof files are written to disk under `artifacts/proofs/` for durability.
- Network partitions are simulated using macOS packet filter rules (`pfctl`) to block UDP traffic between specific ports.
