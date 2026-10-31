import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { apColor } from '../model'
import { useStore } from '../store'
import type { LogLine } from '../types'

const WINDOWS: [string, number][] = [
  ['Last 10 seconds', 10],
  ['Last minute', 60],
  ['Last 5 minutes', 300],
  ['Whole run', 0],
]
const QUICK = ['authenticat', 'associat', 'deauth', 'EAPOL', 'WPA:', 'SAE', 'PTK', 'CTRL-EVENT', 'STA ']
const MAX_NODES = 6

const clock = (t: number) => {
  const d = new Date(t * 1000)
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

export function MergedLogs() {
  const topo = useStore((s) => s.topo)
  const runDir = useStore((s) => s.lab.runDir)
  const viewRun = useStore((s) => s.viewRun)
  const running = useStore((s) => s.lab.state === 'running')
  const run = viewRun ?? runDir?.split('/').pop() ?? null
  const daemons = topo.nodes.filter((n) => n.kind !== 'sniffer')
  const [picked, setPicked] = useState<string[] | null>(null)
  const chosen = (picked ?? daemons.map((n) => n.id)).filter((id) => daemons.some((n) => n.id === id)).slice(0, MAX_NODES)
  const [match, setMatch] = useState('')
  const [windowS, setWindowS] = useState(60)
  const [auto, setAuto] = useState(true)
  const [quiet, setQuiet] = useState(true)
  const [lines, setLines] = useState<LogLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const key = chosen.join(',')

  useEffect(() => {
    if (!run || chosen.length === 0) {
      setLines([])
      return
    }
    let alive = true
    const load = () =>
      api
        .logWindow(run, chosen, 0, 1e12, match.trim(), { quiet })
        .then((l) => {
          if (!alive) return
          setLines(l)
          setError(null)
        })
        .catch((e: Error) => {
          if (!alive) return
          setLines([])
          setError(e.message)
        })
    const t = setTimeout(load, match ? 250 : 0)
    const timer = auto && running && !viewRun ? setInterval(load, 1500) : undefined
    return () => {
      alive = false
      clearTimeout(t)
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, key, match, auto, running, viewRun, quiet])

  // The window is measured from the newest line, so it works whatever the browser clock says.
  const shown = useMemo(() => {
    const kept = lines
    const newest = kept.length ? kept[kept.length - 1].t : 0
    const inWindow = windowS ? kept.filter((l) => l.t >= newest - windowS) : kept
    return inWindow.slice(-1500)
  }, [lines, windowS])

  useEffect(() => {
    if (auto && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [shown, auto])

  const toggle = (id: string) => {
    const cur = new Set(chosen)
    if (!cur.delete(id)) {
      if (cur.size >= MAX_NODES) return
      cur.add(id)
    }
    setPicked(daemons.map((n) => n.id).filter((x) => cur.has(x)))
  }
  const color = (id: string) => (topo.nodes.find((n) => n.id === id)?.kind === 'ap' ? apColor(topo.nodes, id) : '#e2e8f0')

  if (daemons.length === 0) return <div className="empty">Add an access point or a client to read its log.</div>

  return (
    <div className="roamlogs">
      <div className="log-tools">
        <input type="search" spellCheck={false} placeholder="Only lines containing..." value={match} onChange={(e) => setMatch(e.target.value)} aria-label="Filter the merged log" />
        <select value={windowS} onChange={(e) => setWindowS(Number(e.target.value))} aria-label="Time window">
          {WINDOWS.map(([label, s]) => (
            <option key={s} value={s}>
              {label}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Follow
        </label>
        <label className="check" title="The lab polls wpa_supplicant for the signal every second">
          <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} /> Hide the lab's own polling
        </label>
      </div>
      <div className="term-cmds">
        {daemons.map((n) => (
          <button key={n.id} className={`chipbtn${chosen.includes(n.id) ? ' on' : ''}`} onClick={() => toggle(n.id)} style={chosen.includes(n.id) && n.kind === 'ap' ? { borderColor: color(n.id) } : undefined}>
            {n.kind === 'ap' && <i style={{ background: color(n.id) }} />}
            {n.id}
            <small>{n.kind === 'ap' ? 'hostapd' : 'wpa_supplicant'}</small>
          </button>
        ))}
        <span className="muted">Up to {MAX_NODES} devices at a time, merged by time.</span>
      </div>
      <div className="term-cmds">
        {QUICK.map((q) => (
          <button key={q} className={`chipbtn${match === q ? ' on' : ''}`} onClick={() => setMatch(match === q ? '' : q)}>
            {q.trim()}
          </button>
        ))}
      </div>
      <div className="logbox rl-log" ref={box}>
        {!run ? (
          <div className="term-dim">Start the lab, or pick a saved run in the capture panel, to read the daemon logs.</div>
        ) : error ? (
          <div className="term-dim">{error}</div>
        ) : shown.length === 0 ? (
          <div className="term-dim">No log lines in this window.</div>
        ) : (
          shown.map((l, i) => (
            <div key={i} className={`rl-row${/hexdump/.test(l.text) ? ' dim' : ''}`}>
              <span className="rl-t" style={{ width: 100 }}>{clock(l.t)}</span>
              <span className="rl-n" style={{ color: color(l.node) }}>{l.node}</span>
              <span className="rl-x" title={l.text}>{l.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="log-foot">
        {shown.length} line{shown.length === 1 ? '' : 's'} from the daemons&apos; own debug logs ({chosen.map((id) => `${id}.log`).join(', ')}); they include key material. Type any text to filter, for example a MAC address.
      </div>
    </div>
  )
}
