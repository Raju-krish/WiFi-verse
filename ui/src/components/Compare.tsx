import { useState } from 'react'
import { cancelComparison, runComparison } from '../compare'
import { fmtMs } from '../model'
import { useStore } from '../store'
import type { CompareRun } from '../types'

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const stats = (runs: CompareRun[], pick: (r: CompareRun) => number | undefined) => {
  const v = runs.map(pick).filter((x): x is number => x !== undefined)
  return { mean: mean(v), min: Math.min(...v), max: Math.max(...v), values: v }
}

export function Compare() {
  const cmp = useStore((s) => s.compare)
  const topo = useStore((s) => s.topo)
  const labState = useStore((s) => s.lab.state)
  const [rounds, setRounds] = useState(3)
  const ready = topo.nodes.filter((n) => n.kind === 'ap').length >= 2 && topo.nodes.some((n) => n.kind === 'sta')
  const running = cmp.status === 'running'
  const ft = cmp.runs.filter((r) => r.mode === 'ft-psk')
  const psk = cmp.runs.filter((r) => r.mode === 'wpa2-psk')
  const sFt = stats(ft, (r) => r.roam.handoff_ms)
  const sPsk = stats(psk, (r) => r.roam.handoff_ms)
  const max = Math.max(sFt.max || 0, sPsk.max || 0, 1)
  const both = ft.length > 0 && psk.length > 0

  const column = (title: string, cls: string, runs: CompareRun[], s: ReturnType<typeof stats>) => (
    <div className={`cmp-col ${cls}`}>
      <h4>
        <span className={`badge ${cls}`}>{cls === 'ft' ? 'FT' : 'PSK'}</span> {title}
      </h4>
      <div className="cmp-big">{runs.length ? fmtMs(s.mean) : '-'}</div>
      <small className="muted">average handoff over {runs.length} roam{runs.length === 1 ? '' : 's'}</small>
      <div className="cmp-bar">
        <div style={{ width: `${runs.length ? (s.mean / max) * 100 : 0}%` }} />
        {s.values.map((v, i) => (
          <i key={i} style={{ left: `${(v / max) * 100}%` }} title={fmtMs(v)} />
        ))}
      </div>
      <dl>
        <dt>Range</dt>
        <dd>{runs.length ? `${fmtMs(s.min)} to ${fmtMs(s.max)}` : '-'}</dd>
        <dt>Frames in the exchange</dt>
        <dd>{runs.length ? stats(runs, (r) => r.roam.frames_total).mean.toFixed(0) : '-'}</dd>
        <dt>EAPOL (4-way handshake)</dt>
        <dd>{runs.length ? stats(runs, (r) => r.roam.eapol).mean.toFixed(0) : '-'}</dd>
        <dt>Authentication</dt>
        <dd>{runs.length ? (cls === 'ft' ? 'Fast BSS Transition' : 'Open System') : '-'}</dd>
      </dl>
    </div>
  )

  return (
    <div>
      <div className="toolbar">
        <label className="field inline">
          <span>Rounds per mode</span>
          <select value={rounds} disabled={running} onChange={(e) => setRounds(Number(e.target.value))}>
            {[1, 2, 3, 5].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        {!running ? (
          <button className="btn primary" disabled={!ready || labState === 'starting' || labState === 'stopping'} onClick={() => void runComparison(rounds)}>
            Run FT on vs FT off
          </button>
        ) : (
          <button className="btn danger" onClick={cancelComparison}>
            Cancel
          </button>
        )}
        <span className="muted grow">
          {running ? cmp.step : ready ? 'Starts the lab for each mode, walks the first client to the farthest AP and measures the roam from the capture.' : 'Needs two APs and a client on the floor plan.'}
        </span>
      </div>
      {running && <div className="progress"><div style={{ width: `${(cmp.runs.length / (cmp.rounds * 2)) * 100}%` }} /></div>}
      {cmp.status === 'error' && <div className="empty error">Comparison stopped: {cmp.error}</div>}
      {cmp.runs.length > 0 && (
        <>
          <div className="cmp-grid">
            {column('FT on (802.11r)', 'ft', ft, sFt)}
            {column('FT off (WPA2-PSK)', 'psk', psk, sPsk)}
          </div>
          {both && (
            <p className="verdict">
              With 802.11r the handoff took <b>{fmtMs(sFt.mean)}</b> against <b>{fmtMs(sPsk.mean)}</b> without it:{' '}
              <b>{(sPsk.mean / sFt.mean).toFixed(1)}x faster</b>, and {psk.length ? stats(psk, (r) => r.roam.eapol).mean.toFixed(0) : 0} fewer frames of 4-way handshake. These times come from the captured frames on a virtual medium, so trust the ratio, not the absolute milliseconds.
            </p>
          )}
        </>
      )}
      {cmp.runs.length === 0 && !running && <div className="empty">No comparison run yet.</div>}
    </div>
  )
}
