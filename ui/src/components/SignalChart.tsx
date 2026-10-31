import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as RPointerEvent } from 'react'
import { apColor, distance, fmtMs, modeLabel, modelRssi } from '../model'
import { useStore } from '../store'
import type { Roam, Sample } from '../types'

const W = 900
const H = 280
const M = { l: 52, r: 16, t: 14, b: 30 }
const PLOT_W = W - M.l - M.r
const PLOT_H = H - M.t - M.b
const SPAN_DEFAULT = 60
const SPAN_MIN = 5
const SPAN_MAX = 600
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120]
const Y_MIN = -95
const Y_MAX = -25

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const fmtAgo = (s: number) => (s === 0 ? 'now' : s < 60 ? `-${s}s` : `-${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`)
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour12: false })

type Hover = { kind: 'sample'; s: Sample; px: number; py: number } | { kind: 'roam'; r: Roam; px: number; py: number }

export function SignalChart() {
  const topo = useStore((s) => s.topo)
  const history = useStore((s) => s.history)
  const roams = useStore((s) => s.roams)
  const selected = useStore((s) => s.selected)
  const pos = useStore((s) => s.pos)
  const running = useStore((s) => s.lab.state === 'running')
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [span, setSpan] = useState(SPAN_DEFAULT)
  const [end, setEnd] = useState<number | null>(null) // null follows the newest sample
  const [hover, setHover] = useState<Hover | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const pan = useRef<{ x: number; end: number; moved: boolean } | null>(null)
  const viewRef = useRef({ span: SPAN_DEFAULT, tEnd: 0, latest: 0, first: 0 })

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now() / 1000), 250)
    return () => clearInterval(id)
  }, [running])

  const stas = topo.nodes.filter((n) => n.kind === 'sta')
  const sta = stas.find((n) => n.id === selected) ?? stas[0]
  const aps = topo.nodes.filter((n) => n.kind === 'ap')
  const samples = sta ? (history[sta.id] ?? []) : []
  const latest = running ? now : (samples[samples.length - 1]?.t ?? now)
  const tEnd = end ?? latest
  const t0 = tEnd - span
  viewRef.current = { span, tEnd, latest, first: samples[0]?.t ?? latest }

  const X = (t: number) => M.l + ((t - t0) / span) * PLOT_W
  const Y = (v: number) => M.t + ((Y_MAX - clamp(v, Y_MIN, Y_MAX)) / (Y_MAX - Y_MIN)) * PLOT_H
  const visible = samples.filter((s) => s.t >= t0 - 2 && s.t <= tEnd + 2)
  const measured = visible.filter((s) => s.rssi !== null)
  const threshold = sta?.roam_threshold_dbm ?? -65
  const apAt = (id: string) => {
    const ap = aps.find((a) => a.id === id)
    return ap ? (running ? (pos[ap.id] ?? ap) : ap) : null
  }
  const line = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')

  // Zoom the time window around a fraction (0 = left edge, 1 = right edge) of the plot.
  const zoomAt = useCallback((factor: number, fx: number) => {
    const v = viewRef.current
    const next = clamp(v.span * factor, SPAN_MIN, SPAN_MAX)
    const tc = v.tEnd - v.span + fx * v.span
    const newEnd = tc + (1 - fx) * next
    setSpan(next)
    setEnd(newEnd >= v.latest - 0.05 ? null : newEnd)
  }, [])

  // A trackpad pinch arrives as ctrl+wheel; a plain two-finger scroll is left to the page.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const sx = ((e.clientX - rect.left) / rect.width) * W
      zoomAt(Math.exp(e.deltaY * 0.01), clamp((sx - M.l) / PLOT_W, 0, 1))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt, sta])

  const toSvg = (e: RPointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return { sx: ((e.clientX - rect.left) / rect.width) * W, sy: ((e.clientY - rect.top) / rect.height) * H, rect }
  }

  const onDown = (e: RPointerEvent) => {
    const { sx } = toSvg(e)
    if (sx < M.l || sx > W - M.r) return
    pan.current = { x: e.clientX, end: viewRef.current.tEnd, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onMove = (e: RPointerEvent) => {
    const { sx, sy, rect } = toSvg(e)
    const p = pan.current
    if (p) {
      const dx = e.clientX - p.x
      if (!p.moved && Math.abs(dx) < 4) return
      p.moved = true
      setHover(null)
      const v = viewRef.current
      const next = p.end - ((dx / rect.width) * W * v.span) / PLOT_W
      setEnd(next >= v.latest - 0.05 ? null : Math.max(next, v.first))
      return
    }
    if (sx < M.l || sx > W - M.r || sy < M.t || sy > H - M.b) return setHover(null)
    const wrap = wrapRef.current!.getBoundingClientRect()
    const px = e.clientX - wrap.left
    const py = e.clientY - wrap.top
    const roam = roams.filter((r) => r.sta === sta?.id).find((r) => Math.abs(X(r.t_auth ?? r.t) - sx) < 6)
    if (roam) return setHover({ kind: 'roam', r: roam, px, py })
    let best: Sample | null = null
    for (const s of visible) if (!best || Math.abs(X(s.t) - sx) < Math.abs(X(best.t) - sx)) best = s
    setHover(best && Math.abs(X(best.t) - sx) <= 24 ? { kind: 'sample', s: best, px, py } : null)
  }

  const onUp = () => {
    pan.current = null
  }

  const step = TICK_STEPS.find((s) => span / s <= 8) ?? 120
  const ticks: number[] = []
  for (let k = 0; k * step <= span + step; k++) if (tEnd - k * step >= t0 - 0.001) ticks.push(k * step)

  if (!sta) return <div className="empty">Add a client to the floor plan to see its signal.</div>

  const live = end === null
  const hs = hover?.kind === 'sample' ? hover.s : null
  const tipRight = hover ? hover.px > (wrapRef.current?.clientWidth ?? 600) * 0.6 : false

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div className="legend">
        {aps.map((ap) => (
          <span key={ap.id}>
            <i style={{ background: apColor(topo.nodes, ap.id) }} /> {ap.id} (model, ch {ap.channel})
          </span>
        ))}
        <span>
          <i className="measured" /> measured by {sta.id}, coloured by the AP it was on
        </span>
        <span>
          <i className="dash" /> roam trigger {threshold} dBm
        </span>
        <span className="chart-zoom">
          <button className="btn small" onClick={() => zoomAt(1.5, live ? 1 : 0.5)} title="Show more time" aria-label="Zoom out in time">
            −
          </button>
          <b>{span < 60 ? `${Math.round(span)} s` : `${(span / 60).toFixed(1)} min`}</b>
          <button className="btn small" onClick={() => zoomAt(1 / 1.5, live ? 1 : 0.5)} title="Show less time" aria-label="Zoom in in time">
            +
          </button>
          <button className="btn small" disabled={live && span === SPAN_DEFAULT} onClick={() => (setSpan(SPAN_DEFAULT), setEnd(null))} title="Follow the newest data, 60 s window">
            {live ? 'Reset' : 'Back to live'}
          </button>
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label="Signal strength over time"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setHover(null)}
        style={{ touchAction: 'none', cursor: pan.current?.moved ? 'grabbing' : 'crosshair' }}
      >
        {[-30, -40, -50, -60, -70, -80, -90].map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={Y(v)} y2={Y(v)} stroke="var(--grid)" />
            <text x={M.l - 8} y={Y(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {v}
            </text>
          </g>
        ))}
        {ticks.map((s) => (
          <g key={s}>
            <line x1={X(tEnd - s)} x2={X(tEnd - s)} y1={M.t} y2={H - M.b} stroke="var(--grid)" strokeDasharray="2 4" />
            <text x={X(tEnd - s)} y={H - 10} textAnchor="middle" fontSize="11" fill="var(--muted)">
              {live ? fmtAgo(s) : clock(tEnd - s)}
            </text>
          </g>
        ))}
        <text x={14} y={H / 2} transform={`rotate(-90 14 ${H / 2})`} textAnchor="middle" fontSize="11" fill="var(--muted)">
          dBm
        </text>
        <clipPath id="plot-clip">
          <rect x={M.l} y={M.t} width={PLOT_W} height={PLOT_H} />
        </clipPath>
        <rect x={M.l} y={M.t} width={PLOT_W} height={Y(threshold) - M.t} fill="#16a34a" opacity="0.05" />
        <line x1={M.l} x2={W - M.r} y1={Y(threshold)} y2={Y(threshold)} stroke="#64748b" strokeDasharray="6 4" />

        <g clipPath="url(#plot-clip)">
          {aps.map((ap) => {
            const a = apAt(ap.id)!
            const pts: [number, number][] = visible.map((s) => [X(s.t), Y(modelRssi(ap.tx_dbm ?? 10, distance(s, a), topo.path_loss_exponent))])
            return pts.length > 1 ? <path key={ap.id} d={line(pts)} fill="none" stroke={apColor(topo.nodes, ap.id)} strokeWidth="2" opacity="0.6" /> : null
          })}

          {measured.length > 1 && <path d={line(measured.map((s) => [X(s.t), Y(s.rssi as number)]))} fill="none" stroke="#0f172a" strokeWidth="1.5" opacity="0.4" />}
          {measured.map((s) => (
            <circle key={s.t} cx={X(s.t)} cy={Y(s.rssi as number)} r="3.5" fill={s.ap ? apColor(topo.nodes, s.ap) : '#64748b'} stroke="#fff" strokeWidth="1" />
          ))}

          {roams
            .filter((r) => r.sta === sta.id)
            .map((r, i) => {
              const t = r.t_auth ?? r.t
              if (t < t0 || t > tEnd) return null
              const color = r.mode === 'ft-psk' ? '#059669' : '#d97706'
              return (
                <g key={r.t}>
                  <line x1={X(t)} x2={X(t)} y1={M.t} y2={H - M.b} stroke={color} strokeWidth="2" strokeDasharray="3 3" />
                  <text x={X(t) + 5} y={M.t + 12 + (i % 2) * 14} fontSize="11" fontWeight="700" fill={color}>
                    roam {r.from}→{r.to}
                  </text>
                </g>
              )
            })}

          {hs && (
            <g pointerEvents="none">
              <line x1={X(hs.t)} x2={X(hs.t)} y1={M.t} y2={H - M.b} stroke="#475569" strokeWidth="1" />
              {hs.rssi !== null && <circle cx={X(hs.t)} cy={Y(hs.rssi)} r="6" fill="none" stroke="#0f172a" strokeWidth="2" />}
            </g>
          )}
        </g>
        {!running && samples.length === 0 && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="14" fill="var(--muted)">
            Start the lab and move the client to draw its signal.
          </text>
        )}
      </svg>
      <div className="chart-hint">Pinch or use + / − to zoom the time axis, drag sideways to look back, hover a point for details.</div>

      {hover && (
        <div className="chart-tip" style={{ top: Math.max(hover.py - 12, 0), ...(tipRight ? { right: (wrapRef.current?.clientWidth ?? 0) - hover.px + 14 } : { left: hover.px + 14 }) }}>
          {hover.kind === 'roam' ? (
            <>
              <b>
                Roam {hover.r.from} → {hover.r.to}
              </b>
              <span>{modeLabel(hover.r.mode)}</span>
              <span>Handoff {hover.r.error ? 'n/a' : fmtMs(hover.r.handoff_ms)}</span>
              <span className="muted">at {clock(hover.r.t_auth ?? hover.r.t)}</span>
            </>
          ) : (
            <>
              <b>
                {clock(hover.s.t)} <span className="muted">({(latest - hover.s.t).toFixed(1)} s before the newest)</span>
              </b>
              <span>
                {sta.id} at ({hover.s.x.toFixed(1)}, {hover.s.y.toFixed(1)}) m
              </span>
              {hover.s.rssi !== null ? (
                <span>
                  <i className="tip-dot" style={{ background: hover.s.ap ? apColor(topo.nodes, hover.s.ap) : '#64748b' }} />
                  Measured: <b>{hover.s.rssi} dBm</b> on {hover.s.ap ?? 'no AP'}
                </span>
              ) : (
                <span className="muted">No measurement here (the client was not reporting a signal)</span>
              )}
              <span className="muted">Model, the signal each AP should give at this spot:</span>
              {aps.map((ap) => {
                const a = apAt(ap.id)!
                return (
                  <span key={ap.id}>
                    <i className="tip-dot" style={{ background: apColor(topo.nodes, ap.id) }} />
                    {ap.id}: {Math.round(modelRssi(ap.tx_dbm ?? 10, distance(hover.s, a), topo.path_loss_exponent))} dBm, {distance(hover.s, a).toFixed(1)} m away
                  </span>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}
