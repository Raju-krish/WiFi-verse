import { useSyncExternalStore } from 'react'
import { api } from './api'
import { LIMITS, nextId } from './model'
import type { ApLive, CompareState, Frame, LabSnapshot, LabState, NodeCfg, Roam, Sample, StaLive, Topology } from './types'

export interface State {
  topo: Topology
  /** Which setup `topo` belongs to: the fixed 802.11r lab or the free playground. */
  topoKind: LabKind
  lab: { state: LabState; error: string | null; runDir: string | null }
  pos: Record<string, { x: number; y: number }>
  live: { stas: StaLive[]; aps: ApLive[] }
  macs: Record<string, string>
  history: Record<string, Sample[]>
  roams: Roam[]
  frames: Record<string, Frame[]>
  captureSrc: string
  /** Saved run shown in the capture panel; null means the current (live) run. */
  viewRun: string | null
  /** Bumped when something outside the capture panel (a roam frame) asks it to show the selected frame. */
  focusTick: number
  /** Asks the capture panel to apply a display filter (n makes repeated requests distinct). */
  pendingFilter: { expr: string; n: number } | null
  /** Asks the daemon console to open a tab. */
  pendingTab: { tab: 'terminal' | 'logs' | 'roam'; n: number } | null
  captureStopped: boolean
  /** Recording is paused because the client is connected; it resumes on reconnect. */
  capturePaused: boolean
  /** Bumped when the client connected again, so the connection panel measures the new attempt. */
  connectTick: number
  /** A code to show in the catalogue, set from an attempt or a deauthentication. */
  codeFocus: { kind: 'status' | 'reason'; code: number; n: number } | null
  /** Status and reason codes met in the current run, so the catalogue can mark them. */
  seenCodes: { status: number[]; reason: number[] }
  selected: string | null
  selectedRoam: number | null
  selectedFrame: { src: string; n: number } | null
  ws: 'connecting' | 'open' | 'closed'
  walkMode: boolean
  toast: string | null
  compare: CompareState
}

const STORAGE_KEYS = { playground: 'wifilab.topology.v1', ft: 'wifilab.ft.topology.v1', connect: 'wifilab.connect.topology.v1', errors: 'wifilab.errors.topology.v1' } as const
export type LabKind = keyof typeof STORAGE_KEYS
const MAX_FRAMES = 20000
const HISTORY_SECONDS = 600

export const DEFAULT_TOPO: Topology = {
  name: 'Two APs and one walking client',
  ssid: 'LabNet',
  passphrase: 'labpassword123',
  security: 'ft-psk',
  path_loss_exponent: 3.5,
  nodes: [
    { id: 'ap1', kind: 'ap', x: 0, y: 0, channel: 1, tx_dbm: 10 },
    { id: 'ap2', kind: 'ap', x: 40, y: 0, channel: 6, tx_dbm: 10 },
    { id: 'sta1', kind: 'sta', x: 2, y: 0, tx_dbm: 10, roam_threshold_dbm: -65 },
    { id: 'snf1', kind: 'sniffer', x: 20, y: 6, channel: 1 },
  ],
}

// The 802.11r lab: two access points and one client, nothing else.
export const FT_TOPO: Topology = {
  name: '802.11r Fast Transition',
  ssid: 'LabNet',
  passphrase: 'labpassword123',
  security: 'ft-psk',
  ft_keys: 'local',
  ft_over_ds: false,
  auto_stop_capture: true,
  path_loss_exponent: 3.5,
  nodes: [
    { id: 'ap1', kind: 'ap', x: 0, y: 0, channel: 1, tx_dbm: 10 },
    { id: 'ap2', kind: 'ap', x: 40, y: 0, channel: 6, tx_dbm: 10 },
    { id: 'sta1', kind: 'sta', x: 2, y: 0, tx_dbm: 10, roam_threshold_dbm: -65 },
  ],
}

// The client-connection lab: one access point and one client.
export const CONNECT_TOPO: Topology = {
  name: '802.11 client connection',
  ssid: 'LabNet',
  passphrase: 'labpassword123',
  security: 'wpa2-psk',
  pause_capture_when_connected: true,
  path_loss_exponent: 3.5,
  nodes: [
    { id: 'ap1', kind: 'ap', x: 0, y: 0, channel: 1, tx_dbm: 10 },
    { id: 'sta1', kind: 'sta', x: 8, y: 0, tx_dbm: 10, roam_threshold_dbm: -65 },
  ],
}

// The connection-errors lab: one access point and one client, with a deliberate mistake that makes the client fail.
export const ERRORS_TOPO: Topology = {
  name: '802.11 connection errors',
  ssid: 'LabNet',
  passphrase: 'labpassword123',
  security: 'wpa2-psk',
  fault: 'wrong_password',
  pause_capture_when_connected: true,
  path_loss_exponent: 3.5,
  nodes: [
    { id: 'ap1', kind: 'ap', x: 0, y: 0, channel: 1, tx_dbm: 10 },
    { id: 'sta1', kind: 'sta', x: 8, y: 0, tx_dbm: 10, roam_threshold_dbm: -65 },
  ],
}

const DEFAULTS: Record<LabKind, Topology> = { playground: DEFAULT_TOPO, ft: FT_TOPO, connect: CONNECT_TOPO, errors: ERRORS_TOPO }

/** The predesigned labs have a fixed set of devices. */
const SHAPE: Partial<Record<LabKind, { ap: number; sta: number }>> = { ft: { ap: 2, sta: 1 }, connect: { ap: 1, sta: 1 }, errors: { ap: 1, sta: 1 } }

function loadTopo(kind: LabKind): Topology {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[kind])
    if (raw) {
      const saved = { ...DEFAULTS[kind], ...(JSON.parse(raw) as Topology) }
      const count = (k: string) => saved.nodes.filter((n) => n.kind === k).length
      const shape = SHAPE[kind]
      if (!shape || (count('ap') === shape.ap && count('sta') === shape.sta && count('sniffer') === 0)) return saved
    }
  } catch {
    /* fall through to the default */
  }
  return structuredClone(DEFAULTS[kind])
}

let state: State = {
  topo: loadTopo('playground'),
  topoKind: 'playground',
  lab: { state: 'stopped', error: null, runDir: null },
  pos: {},
  live: { stas: [], aps: [] },
  macs: {},
  history: {},
  roams: [],
  frames: {},
  captureSrc: 'global',
  viewRun: null,
  focusTick: 0,
  pendingFilter: null,
  pendingTab: null,
  captureStopped: false,
  capturePaused: false,
  connectTick: 0,
  codeFocus: null,
  seenCodes: { status: [], reason: [] },
  selected: null,
  selectedRoam: null,
  selectedFrame: null,
  ws: 'connecting',
  walkMode: false,
  toast: null,
  compare: { status: 'idle', rounds: 3, step: '', runs: [] },
}

const listeners = new Set<() => void>()

export function getState(): State {
  return state
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  listeners.forEach((l) => l())
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => selector(state),
  )
}

export function toast(message: string): void {
  setState({ toast: message })
  setTimeout(() => state.toast === message && setState({ toast: null }), 5000)
}

function persistTopo(topo: Topology): void {
  try {
    localStorage.setItem(STORAGE_KEYS[state.topoKind], JSON.stringify(topo))
  } catch {
    /* storage may be unavailable; the lab still works */
  }
}

/** Load the setup of a lab page. Only possible while the lab is stopped, because a running lab owns the topology. */
export function loadLab(kind: LabKind): void {
  if (state.lab.state !== 'stopped' || state.topoKind === kind) return
  setState({ topo: loadTopo(kind), topoKind: kind, selected: null, selectedFrame: null, selectedRoam: null, roams: [], frames: {}, history: {}, viewRun: null })
}

export function editTopo(fn: (t: Topology) => Topology): void {
  const topo = fn(state.topo)
  persistTopo(topo)
  setState({ topo })
}

export function isRunning(): boolean {
  return state.lab.state === 'running'
}

// ---- snapshot / events -----------------------------------------------------------------------------------------

function applyLab(lab: LabSnapshot): void {
  const macs: Record<string, string> = { ...state.macs, ...(lab.aliases ?? {}) }
  for (const n of lab.nodes) if (n.mac) macs[n.mac] = n.id
  const patch: Partial<State> = {
    lab: { state: lab.state, error: state.lab.error, runDir: lab.run_dir },
    macs,
  }
  if (lab.state === 'running' && lab.nodes.length) {
    patch.pos = Object.fromEntries(lab.nodes.map((n) => [n.id, { x: n.x, y: n.y }]))
    if (state.lab.state !== 'running' && state.topo.nodes.length === 0) {
      patch.topo = { ...state.topo, nodes: lab.nodes }
    }
  }
  setState(patch)
}

function pushSample(id: string, s: Sample): void {
  const cutoff = s.t - HISTORY_SECONDS
  const list = (state.history[id] ?? []).filter((x) => x.t >= cutoff)
  list.push(s)
  setState({ history: { ...state.history, [id]: list } })
}

function onMessage(m: { type: string; [k: string]: unknown }): void {
  switch (m.type) {
    case 'snapshot': {
      applyLab(m.lab as LabSnapshot)
      const frames = m.frames as Frame[]
      setState({ roams: m.roams as Roam[], frames: frames.length ? { ...state.frames, global: frames } : state.frames, captureStopped: m.capture === 'stopped', capturePaused: m.capture === 'paused' })
      break
    }
    case 'capture':
      setState({ captureStopped: m.state === 'stopped', capturePaused: m.state === 'paused' })
      break
    case 'lab': {
      const s = m.state as LabState
      setState({ lab: { ...state.lab, state: s, error: (m.error as string | null) ?? null } })
      if (s === 'stopped') setState({ live: { stas: [], aps: [] }, walkMode: false })
      break
    }
    case 'state': {
      const stas = m.stas as StaLive[]
      const aps = m.aps as ApLive[]
      const pos = { ...state.pos }
      for (const s of stas) pos[s.id] = { x: s.x, y: s.y }
      setState({ live: { stas, aps }, pos })
      for (const s of stas) pushSample(s.id, { t: m.t as number, x: s.x, y: s.y, rssi: s.rssi, ap: s.ap })
      break
    }
    case 'move': {
      const id = m.id as string
      const x = m.x as number
      const y = m.y as number
      setState({ pos: { ...state.pos, [id]: { x, y } } })
      const node = state.topo.nodes.find((n) => n.id === id)
      if (node?.kind === 'sta') pushSample(id, { t: Date.now() / 1000, x, y, rssi: null, ap: null })
      break
    }
    case 'roam': {
      const roam = m.roam as Roam
      setState({ roams: [...state.roams.filter((r) => r.t !== roam.t), roam], selectedRoam: roam.t })
      break
    }
    case 'frames': {
      const src = m.src as string
      const have = state.frames[src] ?? []
      // A snapshot and a queued batch can overlap, and frame numbers only grow.
      const lastN = have.length ? have[have.length - 1].n : 0
      const incoming = (m.frames as Frame[]).filter((f) => f.n > lastN)
      if (incoming.length === 0) break
      const merged = [...have, ...incoming]
      setState({ frames: { ...state.frames, [src]: merged.length > MAX_FRAMES ? merged.slice(-MAX_FRAMES) : merged } })
      break
    }
    case 'resync':
      void refresh()
      break
  }
}

export async function refresh(): Promise<void> {
  try {
    const s = await api.state()
    applyLab(s.lab)
    setState({ roams: s.roams })
    if (s.lab.state === 'running') {
      const frames = await api.frames({ src: 'global', limit: 2000, beacons: true })
      setState({ frames: { ...state.frames, global: frames } })
    }
  } catch {
    /* the socket status already shows the problem */
  }
}

let socket: WebSocket | null = null

export function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return
  setState({ ws: 'connecting' })
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`)
  socket = ws
  ws.onopen = () => setState({ ws: 'open' })
  ws.onmessage = (e) => onMessage(JSON.parse(e.data as string))
  ws.onclose = () => {
    setState({ ws: 'closed' })
    setTimeout(connect, 1500)
  }
}

// ---- lab control -------------------------------------------------------------------------------------------------

export async function startLab(): Promise<void> {
  const topo = state.topo
  setState({
    lab: { state: 'starting', error: null, runDir: null },
    history: {},
    roams: [],
    frames: {},
    captureStopped: false,
    capturePaused: false,
    selectedFrame: null,
    selectedRoam: null,
    pos: Object.fromEntries(topo.nodes.map((n) => [n.id, { x: n.x, y: n.y }])),
  })
  try {
    const lab = await api.start({ ...topo, nodes: topo.nodes.map(({ mac: _mac, ...n }) => n) })
    applyLab(lab)
    setState({ lab: { state: lab.state, error: null, runDir: lab.run_dir } })
  } catch (e) {
    const message = (e as Error).message
    setState({ lab: { state: 'stopped', error: message, runDir: null } })
    toast(message)
  }
}

export async function stopLab(): Promise<void> {
  setState({ lab: { ...state.lab, state: 'stopping' } })
  try {
    await api.stop()
  } finally {
    setState({ lab: { ...state.lab, state: 'stopped' }, live: { stas: [], aps: [] }, walkMode: false })
  }
}

// ---- topology editing ---------------------------------------------------------------------------------------------

export function addNode(kind: NodeCfg['kind'], x: number, y: number): void {
  if (state.topoKind !== 'playground') return toast('This setup is fixed. Use the Playground to build your own.')
  if (state.lab.state !== 'stopped') return toast('Stop the lab to add or remove devices')
  const count = state.topo.nodes.filter((n) => n.kind === kind).length
  if (count >= LIMITS[kind]) return toast(`At most ${LIMITS[kind]} of that device`)
  const id = nextId(state.topo.nodes, kind)
  const node: NodeCfg =
    kind === 'ap'
      ? { id, kind, x, y, channel: 1, tx_dbm: 10 }
      : kind === 'sta'
        ? { id, kind, x, y, tx_dbm: 10, roam_threshold_dbm: -65 }
        : { id, kind, x, y, channel: 1 }
  editTopo((t) => ({ ...t, nodes: [...t.nodes, node] }))
  setState({ selected: id })
}

export function removeNode(id: string): void {
  if (state.topoKind !== 'playground') return toast('This setup is fixed.')
  if (state.lab.state !== 'stopped') return toast('Stop the lab to add or remove devices')
  editTopo((t) => ({ ...t, nodes: t.nodes.filter((n) => n.id !== id) }))
  setState({ selected: state.selected === id ? null : state.selected })
}

export function updateNode(id: string, patch: Partial<NodeCfg>): void {
  editTopo((t) => ({ ...t, nodes: t.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }))
}

const sendTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lastSent = new Map<string, number>()

export function moveNode(id: string, x: number, y: number): void {
  if (state.lab.state === 'running') {
    setState({ pos: { ...state.pos, [id]: { x, y } } })
    const send = () => {
      lastSent.set(id, Date.now())
      api.move(id, x, y).catch((e: Error) => toast(e.message))
    }
    clearTimeout(sendTimers.get(id))
    if (Date.now() - (lastSent.get(id) ?? 0) > 80) send()
    else sendTimers.set(id, setTimeout(send, 80))
    const node = state.topo.nodes.find((n) => n.id === id)
    if (node?.kind === 'sta') pushSample(id, { t: Date.now() / 1000, x, y, rssi: null, ap: null })
  } else if (state.lab.state === 'stopped') {
    updateNode(id, { x, y })
  }
}

export function setSecurity(security: Topology['security']): void {
  if (state.lab.state !== 'stopped') return
  editTopo((t) => ({ ...t, security }))
}

export function setFtOptions(patch: { ft_keys?: Topology['ft_keys']; ft_over_ds?: boolean; auto_stop_capture?: boolean; pause_capture_when_connected?: boolean }): void {
  if (state.lab.state !== 'stopped') return toast('Stop the lab to change these settings')
  editTopo((t) => ({ ...t, ...patch }))
}

export async function walkTo(id: string, x: number, y: number, speed = 3): Promise<void> {
  try {
    await api.walk(id, x, y, speed)
  } catch (e) {
    toast((e as Error).message)
  }
}

export async function roamTo(id: string, ap: string): Promise<void> {
  try {
    await api.roam(id, ap)
  } catch (e) {
    toast((e as Error).message)
  }
}

export function resetTopology(): void {
  if (state.lab.state !== 'stopped') return
  const fresh = structuredClone(DEFAULTS[state.topoKind])
  persistTopo(fresh)
  setState({ topo: fresh, selected: null })
}
