export interface SharedState {
  peer_id: string
  last_seen_ms: number
  role: string
  status: string
}

export interface AgentState {
  file: string
  label: string
  local: SharedState
  peers: Record<string, SharedState>
  last_message_kind: string
  last_message_id: string
}

export interface WireMessage {
  kind: string
  message_id: string
  sent_at_ms: number
  state: SharedState
  note: string | null
}

export interface ProofOfCoordination {
  file: string
  agent: string
  creator: string
  created_at: number
  consensus_at: number
  finality_ms: number
  event_hash: string
  whitened_signature: string
  transactions: WireMessage[]
  content_hash: string
}

export interface VerifyResult {
  valid: boolean
  proof: ProofOfCoordination
  error?: string
}

export interface EventLogEntry {
  ts: number
  tag: string
  label: string
  message: string
}

export interface NodeInfo {
  label: string
  bind: string
  role: string | null
  status: 'running' | 'stopped'
  initial_x?: number | null
  initial_y?: number | null
}
