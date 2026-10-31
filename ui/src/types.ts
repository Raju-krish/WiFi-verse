export type Kind = 'ap' | 'sta' | 'sniffer'
export type Security = 'open' | 'owe' | 'wpa2-psk' | 'wpa3-sae' | 'ft-psk'
export type Channel = 1 | 6 | 11
export type Fault = 'none' | 'wrong_password' | 'mac_blocked' | 'pmf_mismatch' | 'security_mismatch'
export type LabState = 'stopped' | 'starting' | 'running' | 'stopping'

export interface NodeCfg {
  id: string
  kind: Kind
  x: number
  y: number
  channel?: Channel
  tx_dbm?: number
  roam_threshold_dbm?: number
  mac?: string | null
}

export interface Connection {
  t_start: number
  t_end: number
  duration_ms: number
  frames_total: number
  auth: number
  sae: number
  assoc: number
  eapol: number
}

export interface Attempt {
  t_start: number
  t_end: number
  duration_ms: number
  outcome: 'connected' | 'rejected' | 'failed' | 'no_response' | 'dropped'
  stage: string
  status: number | null
  eapol: number[]
  sae: number
  frames_total: number
  ended_by: { t: number; kind: 'Deauth' | 'Disassoc'; reason: number | null; from: 'ap' | 'client' } | null
}

export type FtKeys = 'local' | 'pull' | 'push'

export interface Topology {
  name: string
  ssid: string
  passphrase: string
  security: Security
  ft_keys?: FtKeys
  ft_over_ds?: boolean
  auto_stop_capture?: boolean
  pause_capture_when_connected?: boolean
  fault?: Fault
  path_loss_exponent: number
  nodes: NodeCfg[]
}

export interface StaLive {
  id: string
  x: number
  y: number
  rssi: number | null
  bssid: string
  ap: string | null
  state: string
  ip: string
  mac: string
}

export interface ApLive {
  id: string
  clients: string[]
  mac: string
}

export interface Frame {
  src: string
  n: number
  t: number
  rel: number
  len: number | null
  rssi: number | null
  ch: number | null
  type: string
  sa: string
  da: string
  scol: string
  dcol: string
  bssid: string
  alg: string
  aseq?: string
  reason?: string
  status: string
  proto: string
  info: string
  dec: boolean
}

export interface Roam {
  sta: string
  from: string
  to: string
  t: number
  mode: Security
  t_auth?: number
  t_end?: number
  auth_alg?: string
  frames_total?: number
  auth?: number
  reassoc?: number
  eapol?: number
  handoff_ms?: number
  scan_to_auth_ms?: number
  transition?: 'air' | 'ds'
  ft_action?: number
  ft_keys?: FtKeys
  ft_over_ds?: boolean
  error?: string
}

export interface Sample {
  t: number
  x: number
  y: number
  rssi: number | null
  ap: string | null
}

export interface LabSnapshot {
  state: LabState
  name: string | null
  security: Security | null
  ssid: string | null
  path_loss_exponent: number | null
  aliases?: Record<string, string>
  nodes: NodeCfg[]
  run_dir: string | null
}

export interface TreeNode {
  l: string
  f: string
  v: string
  p: number
  s: number
  c?: TreeNode[]
}

export interface FrameDetail {
  n: number
  src: string
  hex: string
  radiotap_len: number
  tree: TreeNode[]
}

export interface FtConfig {
  ft: boolean
  aps: {
    id: string
    key_mgmt: string
    mobility_domain: string
    r0kh_id: string
    r1kh_id: string
    generate_local: boolean
    over_ds: boolean
    r0kh: string[]
    r1kh: string[]
  }[]
}

export interface LogLine {
  t: number
  node: string
  text: string
}

export interface RunInfo {
  id: string
  mode: string
  sources: string[]
  current: boolean
}

export interface CompareRun {
  mode: Security
  round: number
  roam: Roam
}

export interface CompareState {
  status: 'idle' | 'running' | 'done' | 'error'
  rounds: number
  step: string
  runs: CompareRun[]
  error?: string
}
