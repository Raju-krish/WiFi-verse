import { useEffect, useState } from 'react'
import { api } from '../api'
import { codeLabel, lookup } from '../data/dot11'
import { setState, useStore } from '../store'
import type { Attempt, Frame } from '../types'
import { showFrame } from './RoamPanel'
import { openTab } from './Learn'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const OUTCOME = {
  connected: { text: 'Connected', cls: 'good' },
  rejected: { text: 'Rejected', cls: 'bad' },
  failed: { text: 'Failed', cls: 'warn' },
  no_response: { text: 'No answer', cls: 'idle' },
  dropped: { text: 'Dropped', cls: 'warn' },
} as const
const STAGES = ['Authentication', 'Association', '4-way handshake', 'Connected']

const lookupFocus = (kind: 'status' | 'reason', code: number) => {
  setState((s) => ({ codeFocus: { kind, code, n: (s.codeFocus?.n ?? 0) + 1 } }))
  document.getElementById('codes')?.scrollIntoView({ behavior: 'smooth' })
}

function explain(a: Attempt): string {
  const eap = a.eapol.length ? `message ${Math.max(...a.eapol)}` : ''
  switch (a.outcome) {
    case 'rejected':
      return `The AP refused the client during ${a.stage} and answered with ${a.status === null ? 'an error' : `status ${a.status}`}. No keys were set up and the client was never associated.`
    case 'failed':
      return `The client was associated, but the 4-way handshake stopped after EAPOL ${eap}. Without it there are no keys and no data. ${a.ended_by ? `The AP then gave up and sent a ${a.ended_by.kind === 'Deauth' ? 'Deauthentication' : 'Disassociation'}${a.ended_by.reason ? ` with reason ${a.ended_by.reason}` : ''}.` : ''}`
    case 'no_response':
      return `The client sent a request, but no answer came back during ${a.stage}. The AP was out of range, busy, or silently ignoring it.`
    case 'dropped':
      return 'The association was accepted but ended straight away.'
    default:
      return a.ended_by
        ? `The client connected. Then the ${a.ended_by.from === 'ap' ? 'AP' : 'client'} ended it with a ${a.ended_by.kind === 'Deauth' ? 'Deauthentication' : 'Disassociation'}${a.ended_by.reason ? ` (reason ${a.ended_by.reason})` : ', whose reason code is hidden because the frame is protected'}.`
        : 'The client connected.'
  }
}

export function AttemptsPanel() {
  const topo = useStore((s) => s.topo)
  const macs = useStore((s) => s.macs)
  const labState = useStore((s) => s.lab.state)
  const runDir = useStore((s) => s.lab.runDir)
  const kickTick = useStore((s) => s.connectTick)
  const selectedFrame = useStore((s) => s.selectedFrame)
  const sta = topo.nodes.find((n) => n.kind === 'sta')
  const ap = topo.nodes.find((n) => n.kind === 'ap')
  const run = runDir?.split('/').pop() ?? null
  const fault = topo.fault ?? 'none'
  const [list, setList] = useState<Attempt[]>([])
  const [pick, setPick] = useState<number | null>(null)
  const [frames, setFrames] = useState<Frame[]>([])
  const [why, setWhy] = useState<string[]>([])

  useEffect(() => {
    setList([])
    setPick(null)
    setWhy([])
    setState({ seenCodes: { status: [], reason: [] } })
  }, [run])

  useEffect(() => {
    if (!sta || !ap || !run || labState === 'starting' || labState === 'stopping') return
    let alive = true
    const load = async () => {
      try {
        const r = await api.attempts(sta.id, ap.id, run)
        if (!alive) return
        setList(r.attempts)
        const status = [...new Set(r.attempts.map((x) => x.status).filter((x): x is number => x != null))]
        const reason = [...new Set(r.attempts.map((x) => x.ended_by?.reason).filter((x): x is number => x != null))]
        setState({ seenCodes: { status, reason } })
      } catch {
        /* the capture may not have a first frame yet */
      }
    }
    void load()
    let timer: ReturnType<typeof setInterval> | undefined
    if (labState === 'running') timer = setInterval(() => void load(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [run, labState, kickTick, sta?.id, ap?.id])

  const idx = pick !== null && pick < list.length ? pick : list.length - 1
  const a: Attempt | undefined = list[idx]

  useEffect(() => {
    if (!a || !run) {
      setFrames([])
      return
    }
    let alive = true
    void (async () => {
      try {
        const f = await api.runFrames(run, 'global', { t_from: a.t_start - 0.01, t_to: a.t_end + 0.02 })
        if (alive) setFrames(f)
      } catch {
        if (alive) setFrames([])
      }
    })()
    return () => {
      alive = false
    }
  }, [a?.t_start, a?.t_end, run])

  // Faults that never reach the air leave their only trace in the client log.
  const silent = list.length === 0 && (fault === 'pmf_mismatch' || fault === 'security_mismatch') && !!run && labState === 'running'
  useEffect(() => {
    if (!silent || !sta || !run) return
    let alive = true
    void (async () => {
      for (let i = 0; i < 6 && alive; i++) {
        try {
          const lines = await api.logWindow(run, [sta.id], 0, 1e12, 'skip RSN IE')
          if (lines.length) {
            if (alive) setWhy([...new Set(lines.map((l) => l.text.trim()))].slice(0, 3))
            return
          }
        } catch {
          /* try again */
        }
        await sleep(2000)
      }
    })()
    return () => {
      alive = false
    }
  }, [silent, run, sta?.id])

  if (!sta || !ap) return <div className="empty">This lab needs one access point and one client.</div>

  const apMac = Object.entries(macs).find(([, id]) => id === ap.id)?.[0]
  const staMac = Object.entries(macs).find(([, id]) => id === sta.id)?.[0]
  const ladder = frames.filter(
    (f) => (f.type === 'Auth' || f.type.includes('Assoc') || f.type.startsWith('EAPOL') || f.type === 'Deauth' || f.type === 'Disassoc') && [f.sa, f.da].every((m) => m === apMac || m === staMac) && f.sa !== f.da,
  )
  const W = 760
  const laneX = [130, W - 130]
  const rowH = 38
  const top = 52
  const H = top + Math.max(ladder.length, 1) * rowH + 18
  const t0 = ladder[0]?.t ?? a?.t_start ?? 0

  const label = (f: Frame): { text: string; color: string } => {
    const fromAp = f.sa === apMac
    const st = f.status === '' ? 0 : Number(f.status)
    const refused = fromAp && st > 0
    if (f.type === 'Deauth' || f.type === 'Disassoc') {
      const name = f.type === 'Deauth' ? 'Deauthentication' : 'Disassociation'
      return { text: f.reason ? `${name}, reason ${Number(f.reason)}` : `${name}, reason hidden (protected)`, color: '#dc2626' }
    }
    if (f.type.startsWith('EAPOL')) return { text: `EAPOL message ${f.type.slice(-1)} of 4`, color: '#d97706' }
    const base = f.type === 'Auth' ? (f.alg === '3' ? (Number(f.aseq) === 1 ? 'SAE commit' : 'SAE confirm') : 'Authentication') : f.type.includes('Req') ? 'Association request' : 'Association response'
    return refused ? { text: `${base}: refused, status ${st}`, color: '#dc2626' } : { text: base, color: f.type === 'Auth' ? '#64748b' : '#2563eb' }
  }

  if (list.length === 0) {
    return (
      <div className="empty">
        {silent ? (
          <>
            <b>Nothing was sent.</b> The client never transmitted an Authentication frame, so there is no status or reason code to read. The capture holds only beacons and probes. The only trace is in the client log:
            {why.length > 0 && (
              <pre className="why-log">{why.join('\n')}</pre>
            )}
            <button className="btn small" onClick={() => openTab('roam')}>
              Open the logs
            </button>
          </>
        ) : labState === 'running' || labState === 'starting' ? (
          'Waiting for the first connection attempt...'
        ) : (
          'Start the lab: the client tries to connect and every attempt, good or bad, is measured here from the frames on the air.'
        )}
      </div>
    )
  }

  const stageIndex = a ? (a.outcome === 'connected' ? 3 : a.stage === 'authentication' ? 0 : a.stage === 'association' ? 1 : 2) : 0
  const counts = list.reduce<Record<string, number>>((m, x) => ({ ...m, [x.outcome]: (m[x.outcome] ?? 0) + 1 }), {})
  const statusRow = a?.status != null ? lookup('status', a.status) : undefined
  const reason = a?.ended_by?.reason ?? null
  const reasonRow = reason != null ? lookup('reason', reason) : undefined

  return (
    <div className="roam-grid conn-grid">
      <div className="roam-list">
        <p className="muted small-print">
          {list.length} attempt{list.length === 1 ? '' : 's'}: {Object.entries(counts).map(([k, n]) => `${n} ${OUTCOME[k as keyof typeof OUTCOME].text.toLowerCase()}`).join(', ')}
        </p>
        {list.map((x, i) => (
          <button key={x.t_start} className={`roam-card${i === idx ? ' on' : ''}`} onClick={() => setPick(i)}>
            <span className={`badge out-${OUTCOME[x.outcome].cls}`}>{OUTCOME[x.outcome].text}</span>
            <b>Attempt {i + 1}</b>
            <span className="muted">
              {x.status != null ? `status ${x.status}` : x.ended_by?.reason != null ? `reason ${x.ended_by.reason}` : x.stage}
            </span>
            <span className="big">{x.frames_total}</span>
          </button>
        ))}
      </div>
      {a && (
        <div className="roam-detail">
          <ol className="stages">
            {STAGES.map((s, i) => (
              <li key={s} className={i < stageIndex || (i === stageIndex && a.outcome === 'connected') ? 'done' : i === stageIndex ? 'stop' : ''}>
                {s}
              </li>
            ))}
          </ol>
          <p className="note">{explain(a)}</p>
          <div className="codes-row">
            {a.status != null && (
              <div className="code-card">
                <small>Status code in the AP&apos;s answer</small>
                <b>{codeLabel('status', a.status)}</b>
                {statusRow?.note && <span>{statusRow.note.plain}</span>}
                <button className="link" onClick={() => lookupFocus('status', a.status as number)}>
                  Find it in the catalogue
                </button>
              </div>
            )}
            {a.ended_by && (
              <div className="code-card">
                <small>
                  {a.ended_by.kind === 'Deauth' ? 'Deauthentication' : 'Disassociation'} from the {a.ended_by.from === 'ap' ? 'AP' : 'client'}
                </small>
                <b>{reason != null ? codeLabel('reason', reason) : 'Reason hidden: the frame is protected (PMF)'}</b>
                {reasonRow?.note && <span>{reasonRow.note.plain}</span>}
                {reason == null && <span>With protected management frames the reason code is encrypted, so an eavesdropper can neither read nor forge it.</span>}
                {reason != null && (
                  <button className="link" onClick={() => lookupFocus('reason', reason)}>
                    Find it in the catalogue
                  </button>
                )}
              </div>
            )}
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} className="ladder" role="img" aria-label="Frames of this attempt">
            {[sta.id, ap.id].map((id, i) => (
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
            {ladder.length === 0 && (
              <text x={W / 2} y={top + 24} textAnchor="middle" fontSize="13" fill="#64748b">
                Loading the frames from the capture...
              </text>
            )}
            {ladder.map((f, i) => {
              const y = top + i * rowH + 18
              const fromSta = f.sa === staMac
              const x1 = fromSta ? laneX[0] : laneX[1]
              const x2 = fromSta ? laneX[1] : laneX[0]
              const dir = x2 > x1 ? 1 : -1
              const { text, color } = label(f)
              const sel = selectedFrame?.n === f.n
              return (
                <g key={f.n} className="ladder-row" onClick={() => showFrame(f.n, runDir)} style={{ cursor: 'pointer' }}>
                  <rect x={0} y={y - 17} width={W} height={rowH - 2} fill={sel ? '#eff6ff' : 'transparent'} />
                  <line x1={x1} x2={x2 - dir * 8} y1={y} y2={y} stroke={color} strokeWidth="2.2" />
                  <path d={`M${x2},${y} l${-dir * 9},-5 l0,10 z`} fill={color} />
                  <text x={(x1 + x2) / 2} y={y - 6} textAnchor="middle" fontSize="12" fontWeight="600" fill={color}>
                    {text}
                  </text>
                  <text x={W - 6} y={y + 4} textAnchor="end" fontSize="10.5" fill="#64748b">
                    +{((f.t - t0) * 1000).toFixed(1)} ms
                  </text>
                </g>
              )
            })}
          </svg>
          <p className="note">Click a frame to decode it in the capture. Red arrows carry an error: a refused request or the end of the connection.</p>
        </div>
      )}
    </div>
  )
}
