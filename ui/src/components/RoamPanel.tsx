import { useEffect, useState } from 'react'
import { api } from '../api'
import { fmtMs, modeLabel } from '../model'
import { getState, setState, useStore } from '../store'
import type { Frame, Roam } from '../types'

const LADDER_TYPES = new Set(['Auth', 'AssocReq', 'AssocResp', 'ReassocReq', 'ReassocResp', 'Deauth', 'Disassoc', 'Action', 'FT-Req', 'FT-Resp', 'FT-Confirm', 'FT-Ack'])

const KEYS_TEXT = { local: 'local keys', pull: 'pull', push: 'push' } as const

/** The FT variant of a roam, for example "push, over the DS". */
const variant = (r: Roam) => (r.mode === 'ft-psk' ? `${KEYS_TEXT[r.ft_keys ?? 'local']}, ${r.transition === 'ds' ? 'over the DS' : 'over the air'}` : '')

const FT_LABELS: Record<string, string> = {
  'FT-Req': 'FT Action request (to old AP)',
  'FT-Resp': 'FT Action response (from old AP)',
  'FT-Confirm': 'FT Action confirm',
  'FT-Ack': 'FT Action ack',
}

// Open the frame in the capture panel: from memory if it is still there, otherwise from the saved capture.
export function showFrame(n: number, runDir: string | null): void {
  const inMemory = (getState().frames.global ?? []).some((f) => f.n === n)
  const run = runDir?.split('/').pop() ?? null
  setState((s) => ({ selectedFrame: { src: 'global', n }, captureSrc: 'global', viewRun: inMemory ? null : run, focusTick: s.focusTick + 1 }))
}

function Ladder({ roam }: { roam: Roam }) {
  const macs = useStore((s) => s.macs)
  const selectedFrame = useStore((s) => s.selectedFrame)
  const runDir = useStore((s) => s.lab.runDir)
  const [frames, setFrames] = useState<Frame[]>([])
  const [loading, setLoading] = useState(true)

  // Read from the saved capture, so the exchange is still there after the lab stops or the live buffer wraps.
  useEffect(() => {
    const run = runDir?.split('/').pop()
    if (!run) {
      setFrames([])
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    const t_from = (roam.t_auth ?? roam.t - 3) - 0.01
    const t_to = (roam.t_end ?? roam.t) + 0.02
    api
      .runFrames(run, 'global', { t_from, t_to })
      .then((f) => live && setFrames(f))
      .catch(() => live && setFrames([]))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [roam.t, roam.t_auth, roam.t_end, runDir])

  const lanes = [roam.sta, roam.from, roam.to]
  const laneOf = (mac: string) => lanes.find((id) => macs[mac] === id)
  const rows = frames.filter((f) => (LADDER_TYPES.has(f.type) || f.type.startsWith('EAPOL')) && laneOf(f.sa) && laneOf(f.da) && laneOf(f.sa) !== laneOf(f.da))
  const W = 760
  const laneX = [90, W / 2, W - 90]
  const rowH = 38
  const top = 52
  const H = top + Math.max(rows.length, 1) * rowH + 18
  const t0 = rows[0]?.t ?? roam.t
  const lane = (id: string | undefined) => laneX[lanes.indexOf(id as string)]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ladder" role="img" aria-label="Frames exchanged during the roam">
      {lanes.map((id, i) => (
        <g key={id}>
          <rect x={laneX[i] - 46} y={6} width={92} height={26} rx={13} fill={i === 0 ? '#eff6ff' : '#fff'} stroke={i === 0 ? '#2563eb' : '#cbd5e1'} />
          <text x={laneX[i]} y={23} textAnchor="middle" fontSize="12" fontWeight="700" fill="#0f172a">
            {id}
          </text>
          <text x={laneX[i]} y={44} textAnchor="middle" fontSize="10" fill="#64748b">
            {i === 0 ? 'client' : i === 1 ? 'old AP' : 'new AP'}
          </text>
          <line x1={laneX[i]} x2={laneX[i]} y1={top - 6} y2={H - 8} stroke="#cbd5e1" strokeDasharray="4 4" />
        </g>
      ))}
      {rows.length === 0 && (
        <text x={W / 2} y={top + 24} textAnchor="middle" fontSize="13" fill="#64748b">
          {loading ? 'Loading the frames from the capture...' : 'No roam frames found in this capture. Download the PCAP to inspect it.'}
        </text>
      )}
      {rows.map((f, i) => {
        const y = top + i * rowH + 18
        const a = lane(laneOf(f.sa))
        const b = lane(laneOf(f.da))
        const eapol = f.type.startsWith('EAPOL')
        const ft = f.alg === '2' || f.type.startsWith('FT-')
        const color = eapol ? '#d97706' : ft ? '#059669' : f.type === 'Deauth' || f.type === 'Disassoc' ? '#dc2626' : '#2563eb'
        const dir = b > a ? 1 : -1
        const isSel = selectedFrame?.n === f.n
        const label = FT_LABELS[f.type] ?? (ft && f.type === 'Auth' ? 'Authentication (FT)' : f.type === 'Auth' ? 'Authentication (open)' : f.type.replace('Reassoc', 'Reassociation ').replace('Assoc', 'Association '))
        return (
          <g key={f.n} className="ladder-row" onClick={() => showFrame(f.n, runDir)} style={{ cursor: 'pointer' }}>
            <rect x={0} y={y - 17} width={W} height={rowH - 2} fill={isSel ? '#eff6ff' : 'transparent'} />
            <line x1={a} x2={b - dir * 8} y1={y} y2={y} stroke={color} strokeWidth="2.2" />
            <path d={`M${b},${y} l${-dir * 9},-5 l0,10 z`} fill={color} />
            <text x={(a + b) / 2} y={y - 6} textAnchor="middle" fontSize="12" fontWeight="600" fill={color}>
              {label}
            </text>
            <text x={W - 6} y={y + 4} textAnchor="end" fontSize="10.5" fill="#64748b">
              +{((f.t - t0) * 1000).toFixed(1)} ms
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function RoamPanel() {
  const roams = useStore((s) => s.roams)
  const selectedRoam = useStore((s) => s.selectedRoam)
  const sorted = [...roams].sort((a, b) => b.t - a.t)
  const current = sorted.find((r) => r.t === selectedRoam) ?? sorted[0]

  if (sorted.length === 0)
    return (
      <div className="empty">
        No roams yet. Start the lab and walk a client from one AP towards another: when its signal drops below the roam trigger it scans, finds the stronger AP and reassociates.
      </div>
    )

  return (
    <div className="roam-grid">
      <div className="roam-list">
        {sorted.map((r) => (
          <button key={r.t} className={`roam-card${current?.t === r.t ? ' on' : ''}`} onClick={() => setState({ selectedRoam: r.t })}>
            <span className={`badge ${r.mode === 'ft-psk' ? 'ft' : 'psk'}`}>{r.mode === 'ft-psk' ? 'FT' : 'PSK'}</span>
            <b>
              {r.sta}: {r.from} → {r.to}
            </b>
            <span className="muted">
              {new Date(r.t * 1000).toLocaleTimeString()}
              {variant(r) && ` · ${variant(r)}`}
            </span>
            <span className="big">{r.error ? 'n/a' : fmtMs(r.handoff_ms)}</span>
          </button>
        ))}
      </div>
      {current && (
        <div className="roam-detail">
          <div className="stats">
            <div>
              <small>Handoff</small>
              <b>{fmtMs(current.handoff_ms)}</b>
              <span>{current.transition === 'ds' ? 'first FT Action request to the end of the exchange' : 'first Authentication to the end of the exchange'}</span>
            </div>
            <div>
              <small>Frames</small>
              <b>{current.frames_total ?? '-'}</b>
              <span>
                {current.transition === 'ds' ? `${current.ft_action ?? 0} FT action` : `${current.auth ?? 0} auth`}, {current.reassoc ?? 0} reassoc
              </span>
            </div>
            <div>
              <small>4-way handshake</small>
              <b className={current.eapol === 0 ? 'good' : 'warn'}>{current.eapol === undefined ? '-' : current.eapol === 0 ? 'skipped' : `${current.eapol} EAPOL`}</b>
              <span>{variant(current) ? `${modeLabel(current.mode)}, ${variant(current)}` : modeLabel(current.mode)}</span>
            </div>
          </div>
          {current.error ? <div className="empty">{current.error}</div> : <Ladder roam={current} />}
          <p className="note">
            {current.mode === 'ft-psk'
              ? 'With 802.11r the new AP already holds the keys, so authentication and reassociation carry the key exchange and the 4-way handshake disappears.'
              : 'Without FT the client reassociates and then repeats the 4-way handshake with the new AP before data can flow again.'}{' '}
            Click a frame to decode it.
          </p>
          {current.mode === 'ft-psk' && current.ft_keys && current.ft_keys !== 'local' && (
            <p className="note">
              {current.ft_keys === 'pull'
                ? 'Key distribution is pull: the new AP asked the old AP for PMK-R1 over the wired network during this roam. That exchange is not on the air; find it in the AP logs (Roam and FT keys tab).'
                : 'Key distribution is push: the old AP sent PMK-R1 to the new AP over the wired network when the client first joined, so nothing is needed during the roam. Find the push in the AP logs (Roam and FT keys tab).'}
            </p>
          )}
          {current.transition === 'ds' && (
            <p className="note">Over the DS: the client sent its request to the old AP, which relayed it to the new AP and brought the answer back over the wired network. Only the client’s side of that appears on the air.</p>
          )}
        </div>
      )}
    </div>
  )
}
