import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { fmtMs, SECURITY_INFO } from '../model'
import { useStore } from '../store'
import type { Connection, Frame, Security } from '../types'
import { showFrame } from './RoamPanel'
import { openTab } from './Learn'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const COLORS = { auth: '#64748b', assoc: '#2563eb', eapol: '#d97706', sae: '#7c3aed' }

function describe(f: Frame, mode: Security | null): { label: string; color: string } {
  if (f.type.startsWith('EAPOL')) return { label: `EAPOL message ${f.type.slice(-1)} of 4`, color: COLORS.eapol }
  if (f.type === 'Auth') {
    if (f.alg === '3') return { label: Number(f.aseq) === 1 ? 'SAE commit' : 'SAE confirm', color: COLORS.sae }
    return { label: 'Authentication (open system)', color: COLORS.auth }
  }
  const owe = mode === 'owe'
  if (f.type.includes('Req')) return { label: owe ? 'Association request + DH key' : 'Association request', color: owe ? COLORS.sae : COLORS.assoc }
  return { label: owe ? 'Association response + DH key' : 'Association response', color: owe ? COLORS.sae : COLORS.assoc }
}

export function ConnectionPanel() {
  const topo = useStore((s) => s.topo)
  const macs = useStore((s) => s.macs)
  const labState = useStore((s) => s.lab.state)
  const runDir = useStore((s) => s.lab.runDir)
  const tick = useStore((s) => s.connectTick)
  const selectedFrame = useStore((s) => s.selectedFrame)
  const sta = topo.nodes.find((n) => n.kind === 'sta')
  const ap = topo.nodes.find((n) => n.kind === 'ap')
  const run = runDir?.split('/').pop() ?? null
  const [result, setResult] = useState<{ connections: Connection[]; mode: Security | null } | null>(null)
  const [pick, setPick] = useState<number | null>(null)
  const [frames, setFrames] = useState<Frame[]>([])
  const [loading, setLoading] = useState(false)
  const known = useRef(0)

  useEffect(() => {
    known.current = 0
    setResult(null)
    setPick(null)
  }, [run])

  // Measure from the capture. While the lab runs, keep trying for a few seconds until a new attempt shows up.
  useEffect(() => {
    if (!sta || !ap || !run || labState === 'starting' || labState === 'stopping') return
    let alive = true
    const poll = async () => {
      for (let tries = 0; alive; tries++) {
        try {
          const r = await api.connection(sta.id, ap.id, run)
          if (!alive) return
          setResult(r)
          if (labState !== 'running' || r.connections.length > known.current || tries >= 8) {
            known.current = r.connections.length
            return
          }
        } catch {
          if (labState !== 'running' || tries >= 8) return
        }
        await sleep(1000)
      }
    }
    void poll()
    return () => {
      alive = false
    }
  }, [run, labState, tick, sta?.id, ap?.id])

  const list = result?.connections ?? []
  const idx = pick !== null && pick < list.length ? pick : list.length - 1
  const conn: Connection | undefined = list[idx]
  const mode = result?.mode ?? null

  useEffect(() => {
    if (!conn || !run) {
      setFrames([])
      return
    }
    let alive = true
    setLoading(true)
    api
      .runFrames(run, 'global', { t_from: conn.t_start - 0.01, t_to: conn.t_end + 0.02 })
      .then((f) => alive && setFrames(f))
      .catch(() => alive && setFrames([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [conn?.t_start, conn?.t_end, run])

  if (!sta || !ap) return <div className="empty">This lab needs one access point and one client.</div>

  const lanes = [sta.id, ap.id]
  const laneOf = (mac: string) => lanes.find((id) => macs[mac] === id)
  const rows = frames.filter((f) => (f.type === 'Auth' || f.type.includes('Assoc') || f.type.startsWith('EAPOL')) && laneOf(f.sa) && laneOf(f.da) && laneOf(f.sa) !== laneOf(f.da))
  const W = 760
  const laneX = [130, W - 130]
  const rowH = 38
  const top = 52
  const H = top + Math.max(rows.length, 1) * rowH + 18
  const t0 = rows[0]?.t ?? conn?.t_start ?? 0
  const info = mode ? SECURITY_INFO[mode] : null

  if (!runDir || list.length === 0) {
    return (
      <div className="empty">
        {labState === 'running' || labState === 'starting' ? 'Measuring the connection from the capture...' : 'Start the lab and the client connects to the access point. Every connection attempt is measured here from the frames on the air.'}
      </div>
    )
  }

  return (
    <div className="roam-grid conn-grid">
      <div className="roam-list">
        {list.map((c, i) => (
          <button key={c.t_start} className={`roam-card${i === idx ? ' on' : ''}`} onClick={() => setPick(i)}>
            <span className="badge psk">#{i + 1}</span>
            <b>{i === 0 ? 'First connection' : `Reconnection ${i}`}</b>
            <span className="muted">{new Date(c.t_start * 1000).toLocaleTimeString()}{c.sae > 0 ? ' · SAE' : mode === 'wpa3-sae' ? ' · SAE skipped' : ''}</span>
            <span className="big">{fmtMs(c.duration_ms)}</span>
          </button>
        ))}
      </div>
      {conn && (
        <div className="roam-detail">
          <div className="stats">
            <div>
              <small>Time to connect</small>
              <b>{fmtMs(conn.duration_ms)}</b>
              <span>first Authentication to the last frame of the exchange</span>
            </div>
            <div>
              <small>Frames</small>
              <b>{conn.frames_total}</b>
              <span>
                {conn.auth} auth{conn.sae ? ` (${conn.sae} SAE)` : ''}, {conn.assoc} assoc, {conn.eapol} EAPOL
              </span>
            </div>
            <div>
              <small>4-way handshake</small>
              <b className={conn.eapol ? 'warn' : 'good'}>{conn.eapol ? `${conn.eapol} EAPOL` : 'none'}</b>
              <span>{info?.label}</span>
            </div>
            <div>
              <small>Data on the air</small>
              <b>{info?.data ?? '-'}</b>
              <span>management frames protected: {info?.pmf ?? '-'}</span>
            </div>
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} className="ladder" role="img" aria-label="Frames exchanged while the client connected">
            {lanes.map((id, i) => (
              <g key={id}>
                <rect x={laneX[i] - 46} y={6} width={92} height={26} rx={13} fill={i === 0 ? '#eff6ff' : '#fff'} stroke={i === 0 ? '#2563eb' : '#cbd5e1'} />
                <text x={laneX[i]} y={23} textAnchor="middle" fontSize="12" fontWeight="700" fill="#0f172a">
                  {id}
                </text>
                <text x={laneX[i]} y={44} textAnchor="middle" fontSize="10" fill="#64748b">
                  {i === 0 ? 'client' : 'access point'}
                </text>
                <line x1={laneX[i]} x2={laneX[i]} y1={top - 6} y2={H - 8} stroke="#cbd5e1" strokeDasharray="4 4" />
              </g>
            ))}
            {rows.length === 0 && (
              <text x={W / 2} y={top + 24} textAnchor="middle" fontSize="13" fill="#64748b">
                {loading ? 'Loading the frames from the capture...' : 'No frames found in this capture.'}
              </text>
            )}
            {rows.map((f, i) => {
              const y = top + i * rowH + 18
              const a = laneX[lanes.indexOf(laneOf(f.sa) as string)]
              const b = laneX[lanes.indexOf(laneOf(f.da) as string)]
              const dir = b > a ? 1 : -1
              const { label, color } = describe(f, mode)
              const sel = selectedFrame?.n === f.n
              return (
                <g key={f.n} className="ladder-row" onClick={() => showFrame(f.n, runDir)} style={{ cursor: 'pointer' }}>
                  <rect x={0} y={y - 17} width={W} height={rowH - 2} fill={sel ? '#eff6ff' : 'transparent'} />
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
          <p className="note">
            {mode === 'open' && 'Open: authentication and association, then data. No keys exist, so the capture shows everything in plain text.'}
            {mode === 'owe' && 'OWE: the Diffie-Hellman public keys travel in the association frames, then the 4-way handshake creates the session key. Nobody typed a password.'}
            {mode === 'wpa2-psk' && 'WPA2-Personal: the key comes from the password, and the four EAPOL messages create a fresh session key. Those four frames are what an attacker would record to guess the password offline.'}
            {mode === 'wpa3-sae' && (conn.sae > 0 ? 'WPA3-Personal: SAE commit and confirm in the Authentication frames agree the key without exposing anything to guess offline, then the 4-way handshake derives the session key.' : 'WPA3-Personal, reconnection: the client offered the key it cached last time (its PMKID), so the SAE exchange was skipped. The 4-way handshake still ran, to make a fresh session key.')}{' '}
            Click a frame to decode it.{' '}
            <button className="btn small" onClick={() => openTab('roam')}>
              Open the daemon logs of this connection
            </button>
          </p>
        </div>
      )}
    </div>
  )
}
