import { api } from './api'
import { distance } from './model'
import { getState, setState, startLab, stopLab, toast } from './store'
import type { Roam, Security } from './types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!cond()) {
    if (getState().compare.status !== 'running') throw new Error('cancelled')
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

export function cancelComparison(): void {
  if (getState().compare.status === 'running') setState({ compare: { ...getState().compare, status: 'idle', step: 'cancelled' } })
}

/** Runs the same walk with FT on and off, `rounds` times each, and records every roam's measured handoff. */
export async function runComparison(rounds: number): Promise<void> {
  const topo = getState().topo
  const aps = topo.nodes.filter((n) => n.kind === 'ap')
  const sta = topo.nodes.find((n) => n.kind === 'sta')
  if (aps.length < 2 || !sta) return toast('The comparison needs at least two APs and one client')
  const target = aps.reduce((far, ap) => (distance(sta, ap) > distance(sta, far) ? ap : far))
  const original: Security = topo.security
  setState({ compare: { status: 'running', rounds, step: 'starting', runs: [] } })

  try {
    if (getState().lab.state !== 'stopped') await stopLab()
    for (let round = 1; round <= rounds; round++) {
      for (const mode of ['ft-psk', 'wpa2-psk'] as Security[]) {
        const label = `round ${round}/${rounds}: ${mode === 'ft-psk' ? 'FT on' : 'FT off'}`
        setState({ compare: { ...getState().compare, step: `${label} - starting lab` } })
        setState({ topo: { ...getState().topo, security: mode } })
        await startLab()
        await waitFor(() => getState().lab.state === 'running', 60000, 'the lab to start')
        await waitFor(() => getState().live.stas.some((s) => s.id === sta.id && s.ap !== null), 30000, 'the client to associate')

        const before = getState().roams.length
        setState({ compare: { ...getState().compare, step: `${label} - client walking to ${target.id}` } })
        await api.walk(sta.id, target.x, target.y, 4)
        const walkMs = (distance(sta, target) / 4) * 1000
        await waitFor(() => getState().roams.length > before, walkMs + 20000, 'a roam')
        await sleep(2500) // let the one-second roam analysis arrive
        const roam: Roam | undefined = getState().roams.filter((r) => r.sta === sta.id && r.handoff_ms !== undefined).at(-1)
        if (!roam) throw new Error('the roam was seen but could not be measured')
        setState({ compare: { ...getState().compare, runs: [...getState().compare.runs, { mode, round, roam }] } })
        await stopLab()
        await sleep(1500)
      }
    }
    setState({ compare: { ...getState().compare, status: 'done', step: 'finished' } })
  } catch (e) {
    const message = (e as Error).message
    setState({ compare: { ...getState().compare, status: message === 'cancelled' ? 'idle' : 'error', step: '', error: message } })
    if (getState().lab.state !== 'stopped') await stopLab()
  } finally {
    setState({ topo: { ...getState().topo, security: original } })
  }
}
