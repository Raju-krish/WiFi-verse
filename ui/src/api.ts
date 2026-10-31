import type { Attempt, CompareState, Connection, Frame, FrameDetail, FtConfig, LabSnapshot, LogLine, Roam, RunInfo, Security, Topology } from './types'

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const j = await res.json()
      msg = Array.isArray(j.detail)
        ? j.detail.map((d: { loc: string[]; msg: string }) => `${d.loc.slice(1).join('.')}: ${d.msg}`).join('; ')
        : String(j.detail ?? msg)
    } catch {
      /* keep the status line */
    }
    throw new Error(msg)
  }
  return (await res.json()) as T
}

export interface StateResponse {
  lab: LabSnapshot
  roams: Roam[]
  captures: Record<string, { frames: number; decrypted: number }>
}

export const api = {
  state: () => call<StateResponse>('GET', '/state'),
  presets: () => call<Record<string, Topology>>('GET', '/presets'),
  start: (topo: Topology) => call<LabSnapshot>('POST', '/lab/start', topo),
  stop: () => call<LabSnapshot>('POST', '/lab/stop'),
  move: (id: string, x: number, y: number) => call('POST', `/nodes/${id}/position`, { x, y }),
  tx: (id: string, dbm: number) => call('POST', `/nodes/${id}/tx`, { dbm }),
  walk: (id: string, x: number, y: number, speed: number) => call('POST', `/nodes/${id}/walk`, { x, y, speed }),
  stopWalk: (id: string) => call('DELETE', `/nodes/${id}/walk`),
  roam: (id: string, ap: string) => call('POST', `/nodes/${id}/roam`, { ap }),
  frames: (p: { src: string; limit?: number; beacons?: boolean; t_from?: number; t_to?: number }) => {
    const q = new URLSearchParams({ src: p.src, limit: String(p.limit ?? 200) })
    if (p.beacons) q.set('beacons', 'true')
    if (p.t_from !== undefined) q.set('t_from', String(p.t_from))
    if (p.t_to !== undefined) q.set('t_to', String(p.t_to))
    return call<Frame[]>('GET', `/frames?${q}`)
  },
  frameDetail: (src: string, n: number, decrypted: boolean, run?: string | null) =>
    call<FrameDetail>('GET', `/frames/${src}/${n}?${new URLSearchParams({ decrypted: String(decrypted), ...(run ? { run } : {}) })}`),
  captures: () => call<string[]>('GET', '/captures'),
  runs: () => call<RunInfo[]>('GET', '/runs'),
  runFrames: (run: string, src: string, window?: { t_from: number; t_to: number }) =>
    call<Frame[]>('GET', `/runs/${run}/frames?${new URLSearchParams({ src, ...(window ? { t_from: String(window.t_from), t_to: String(window.t_to) } : {}) })}`),
  filter: (src: string, expr: string, run?: string | null) =>
    call<{ numbers: number[]; error: string | null }>('GET', `/captures/${src}/filter?${new URLSearchParams({ expr, ...(run ? { run } : {}) })}`),
  ping: (id: string, count: number) => call<{ output: string }>('POST', `/nodes/${id}/ping`, { count }),
  keys: () => call<{ ts: number; node: string; nodes: string[]; kind: string; key: string }[]>('GET', '/keys'),
  ftConfig: (run: string) => call<FtConfig>('GET', `/ft?${new URLSearchParams({ run })}`),
  logWindow: (run: string, nodes: string[], t_from: number, t_to: number, match = '', newest?: { quiet: boolean }) =>
    call<LogLine[]>('GET', `/logs?${new URLSearchParams({ run, nodes: nodes.join(','), t_from: String(t_from), t_to: String(t_to), match, ...(newest ? { tail: 'true', limit: '10000', quiet: String(newest.quiet) } : {}) })}`),
  connection: (sta: string, ap: string, run?: string | null) =>
    call<{ connections: Connection[]; mode: Security | null }>('GET', `/connection?${new URLSearchParams({ sta, ap, ...(run ? { run } : {}) })}`),
  reconnect: (id: string) => call('POST', `/nodes/${id}/reconnect`),
  attempts: (sta: string, ap: string, run?: string | null) =>
    call<{ attempts: Attempt[]; mode: Security | null; fault: string }>('GET', `/attempts?${new URLSearchParams({ sta, ap, ...(run ? { run } : {}) })}`),
  deauth: (ap: string, sta: string, kind: 'deauth' | 'disassoc', reason: number) => call<{ output: string }>('POST', `/nodes/${ap}/deauth`, { sta, kind, reason }),
  captureResume: () => call('POST', '/capture/resume'),
  cliCatalog: () => call<Record<'ap' | 'sta', { usage: string; help: string }[]>>('GET', '/cli'),
  cli: (id: string, command: string) => call<{ output: string }>('POST', `/nodes/${id}/cli`, { command }),
  nodeLog: (id: string, p: { lines: number; match: string; run: string }) =>
    call<{ lines: string[]; matches: number; size: number }>('GET', `/nodes/${id}/log?${new URLSearchParams({ lines: String(p.lines), match: p.match, run: p.run })}`),
}

export function pcapUrl(src: string, decrypted: boolean, run?: string | null): string {
  return `/api/captures/${src}/pcap?${new URLSearchParams({ decrypted: String(decrypted), ...(run ? { run } : {}) })}`
}

export type { CompareState }
