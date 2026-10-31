import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { fmtMs, SECURITY_INFO } from '../model'
import { getState, setState, startLab, stopLab, useStore } from '../store'
import type { Connection, Security } from '../types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ORDER: Security[] = ['open', 'owe', 'wpa2-psk', 'wpa3-sae']

interface Row {
  mode: Security
  first: Connection
  again?: Connection
}

export function ConnectCompare() {
  const labState = useStore((s) => s.lab.state)
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [step, setStep] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState('')
  const cancel = useRef(false)

  useEffect(
    () => () => {
      cancel.current = true
    },
    [],
  )

  const until = async <T,>(get: () => Promise<T | null | undefined> | T | null | undefined, ms: number, what: string): Promise<T> => {
    const end = Date.now() + ms
    for (;;) {
      if (cancel.current) throw new Error('cancelled')
      try {
        const v = await get()
        if (v) return v
      } catch {
        /* not ready yet */
      }
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await sleep(500)
    }
  }

  const run = async () => {
    const topo = getState().topo
    const sta = topo.nodes.find((n) => n.kind === 'sta')
    const ap = topo.nodes.find((n) => n.kind === 'ap')
    if (!sta || !ap) return
    const original = topo.security
    cancel.current = false
    setRows([])
    setError('')
    setStatus('running')
    try {
      if (getState().lab.state !== 'stopped') await stopLab()
      for (const mode of ORDER) {
        setStep(`${SECURITY_INFO[mode].label}: starting the lab`)
        setState({ topo: { ...getState().topo, security: mode } })
        await startLab()
        await until(() => getState().lab.state === 'running', 60000, 'the lab to start')
        const runId = (getState().lab.runDir ?? '').split('/').pop() ?? ''
        const measure = async (count: number) => {
          const r = await api.connection(sta.id, ap.id, runId)
          return r.connections.length >= count ? r.connections : null
        }
        setStep(`${SECURITY_INFO[mode].label}: first connection`)
        const first = await until(() => measure(1), 30000, 'the first connection')
        setStep(`${SECURITY_INFO[mode].label}: disconnect and reconnect`)
        await sleep(1500)
        await api.reconnect(sta.id)
        const both = await until(() => measure(2), 20000, 'the reconnection')
        setRows((r) => [...r, { mode, first: first[0], again: both[1] }])
        await stopLab()
        await sleep(1500)
      }
      setStatus('done')
      setStep('')
    } catch (e) {
      const message = (e as Error).message
      setStatus(message === 'cancelled' ? 'idle' : 'error')
      setError(message)
      setStep('')
      if (getState().lab.state !== 'stopped') await stopLab()
    } finally {
      setState({ topo: { ...getState().topo, security: original } })
    }
  }

  const running = status === 'running'
  const max = Math.max(1, ...rows.flatMap((r) => [r.first.duration_ms, r.again?.duration_ms ?? 0]))

  return (
    <div>
      <div className="toolbar">
        {!running ? (
          <button className="btn primary" disabled={labState === 'starting' || labState === 'stopping'} onClick={() => void run()}>
            Run all four modes
          </button>
        ) : (
          <button className="btn danger" onClick={() => (cancel.current = true)}>
            Cancel
          </button>
        )}
        <span className="muted grow">{running ? step : 'Starts the lab once for each security mode, lets the client connect, then makes it reconnect, and measures both from the capture.'}</span>
      </div>
      {running && <div className="progress"><div style={{ width: `${(rows.length / ORDER.length) * 100}%` }} /></div>}
      {status === 'error' && <div className="empty error">Comparison stopped: {error}</div>}
      {rows.length === 0 && !running && status !== 'error' && <div className="empty">No comparison run yet.</div>}
      {rows.length > 0 && (
        <table className="cmp-table">
          <thead>
            <tr>
              <th>Security</th>
              <th>First connection</th>
              <th>Frames</th>
              <th>Key exchange</th>
              <th>Reconnection</th>
              <th>Frames</th>
              <th>Key exchange</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.mode}>
                <td>
                  <b>{SECURITY_INFO[r.mode].label}</b>
                </td>
                <td>
                  <div className="cmp-bar slim">
                    <div style={{ width: `${(r.first.duration_ms / max) * 100}%` }} />
                  </div>
                  {fmtMs(r.first.duration_ms)}
                </td>
                <td>{r.first.frames_total}</td>
                <td>{exchange(r.mode, r.first)}</td>
                <td>
                  {r.again ? (
                    <>
                      <div className="cmp-bar slim">
                        <div style={{ width: `${(r.again.duration_ms / max) * 100}%` }} />
                      </div>
                      {fmtMs(r.again.duration_ms)}
                    </>
                  ) : (
                    '-'
                  )}
                </td>
                <td>{r.again?.frames_total ?? '-'}</td>
                <td>{r.again ? exchange(r.mode, r.again) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {status === 'done' && (
        <p className="verdict">
          Open needs the fewest frames but protects nothing. OWE adds a Diffie-Hellman exchange for the same encryption without a password. WPA2 adds the 4-way handshake, WPA3 puts SAE in front of it, and on reconnection WPA3 skips SAE because the key is cached. These times come from a virtual medium, so compare the frame counts rather than the milliseconds.
        </p>
      )}
    </div>
  )
}

function exchange(mode: Security, c: Connection): string {
  const parts: string[] = []
  if (c.sae) parts.push(`SAE ${c.sae}`)
  else if (mode === 'wpa3-sae') parts.push('SAE skipped (cached)')
  if (mode === 'owe') parts.push('DH')
  if (c.eapol) parts.push(`EAPOL ${c.eapol}`)
  return parts.length ? parts.join(' + ') : 'none'
}
