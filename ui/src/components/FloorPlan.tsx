import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, PointerEvent as RPointerEvent } from 'react'
import { apColor, CHANNEL_COLOR, rangeFor, signalColor } from '../model'
import { addNode, moveNode, setState, useStore, walkTo } from '../store'
import type { Kind, NodeCfg } from '../types'

const PALETTE: { kind: Kind; title: string; hint: string }[] = [
  { kind: 'ap', title: 'Access point', hint: 'hostapd' },
  { kind: 'sta', title: 'Client', hint: 'wpa_supplicant' },
  { kind: 'sniffer', title: 'Sniffer', hint: 'monitor radio' },
]

export function Glyph({ kind, size = 22 }: { kind: Kind; size?: number }) {
  const s = size
  if (kind === 'ap')
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M5 12a10 10 0 0 1 14 0" />
        <path d="M8 15a6 6 0 0 1 8 0" />
        <circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
      </svg>
    )
  if (kind === 'sta')
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="5" width="16" height="11" rx="1.5" />
        <path d="M2 19h20" />
      </svg>
    )
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

const snap = (v: number) => Math.round(v * 2) / 2

export function FloorPlan() {
  const topo = useStore((s) => s.topo)
  const pos = useStore((s) => s.pos)
  const live = useStore((s) => s.live)
  const labState = useStore((s) => s.lab.state)
  const selected = useStore((s) => s.selected)
  const walkMode = useStore((s) => s.walkMode)
  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 900, h: 460 })
  const [target, setTarget] = useState<{ x: number; y: number } | null>(null)
  const [cam, setCam] = useState({ k: 1, px: 0, py: 0 })
  const drag = useRef<string | null>(null)
  const pan = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null)
  const viewRef = useRef({ minX: 0, minY: 0, w: 1, h: 1 })
  const baseRef = useRef({ minX: 0, minY: 0, w: 1, h: 1 })
  const running = labState === 'running'
  const editable = labState === 'stopped'
  const topoKind = useStore((s) => s.topoKind)
  const fixed = topoKind !== 'playground'

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const at = (n: NodeCfg) => (running ? (pos[n.id] ?? n) : n)

  const base = useMemo(() => {
    const xs = topo.nodes.map((n) => n.x)
    const ys = topo.nodes.map((n) => n.y)
    const floor10 = (v: number) => Math.floor(v / 10) * 10
    const ceil10 = (v: number) => Math.ceil(v / 10) * 10
    const minX = Math.min(-10, floor10(Math.min(...xs, 0) - 10))
    const maxX = Math.max(50, ceil10(Math.max(...xs, 0) + 10))
    const minY = Math.min(-20, floor10(Math.min(...ys, 0) - 10))
    const maxY = Math.max(20, ceil10(Math.max(...ys, 0) + 10))
    let box = { minX, minY, w: maxX - minX, h: maxY - minY }
    // Match the canvas shape so the floor fills it and nothing is drawn outside it.
    const ratio = size.w / Math.max(size.h, 1)
    if (box.w / box.h < ratio) {
      const w = box.h * ratio
      box = { ...box, minX: box.minX - (w - box.w) / 2, w }
    } else {
      const h = box.w / ratio
      box = { ...box, minY: box.minY - (h - box.h) / 2, h }
    }
    return box
  }, [topo.nodes, size.w, size.h])

  const view = useMemo(() => {
    const w = base.w / cam.k
    const h = base.h / cam.k
    return { minX: base.minX + base.w / 2 + cam.px - w / 2, minY: base.minY + base.h / 2 + cam.py - h / 2, w, h }
  }, [base, cam])
  viewRef.current = view
  baseRef.current = base

  // Trackpad pinch arrives as ctrl+wheel; a plain two-finger scroll is left to the page.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const fx = (e.clientX - rect.left) / rect.width
      const fy = (e.clientY - rect.top) / rect.height
      setCam((c) => {
        const v = viewRef.current
        const b = baseRef.current
        const k = Math.min(8, Math.max(0.5, c.k * Math.exp(-e.deltaY * 0.01)))
        const w = b.w / k
        const h = b.h / k
        const minX = v.minX + fx * v.w - fx * w
        const minY = v.minY + fy * v.h - fy * h
        return { k, px: minX + w / 2 - (b.minX + b.w / 2), py: minY + h / 2 - (b.minY + b.h / 2) }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const ppm = Math.min(size.w / view.w, size.h / view.h)
  const zoomBy = (f: number) => setCam((c) => ({ ...c, k: Math.min(8, Math.max(0.5, c.k * f)) }))
  const unit = 1 / ppm
  const aps = topo.nodes.filter((n) => n.kind === 'ap')
  const sel = topo.nodes.find((n) => n.id === selected)
  const selThreshold = sel?.kind === 'sta' ? (sel.roam_threshold_dbm ?? -65) : -65

  const toWorld = (cx: number, cy: number) => {
    const svg = svgRef.current!
    const pt = svg.createSVGPoint()
    pt.x = cx
    pt.y = cy
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    return { x: snap(p.x), y: snap(p.y) }
  }

  const onPointerDown = (e: RPointerEvent, id: string) => {
    e.stopPropagation()
    setState({ selected: id })
    if (labState === 'starting' || labState === 'stopping') return
    drag.current = id
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: RPointerEvent) => {
    if (drag.current) {
      const p = toWorld(e.clientX, e.clientY)
      moveNode(drag.current, p.x, p.y)
      return
    }
    const s = pan.current
    if (!s) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (!s.moved && Math.hypot(dx, dy) < 4) return
    s.moved = true
    setCam((c) => ({ ...c, px: s.px - dx / ppm, py: s.py - dy / ppm }))
  }
  const onPointerUp = (e: RPointerEvent) => {
    drag.current = null
    const s = pan.current
    pan.current = null
    if (!s || s.moved) return
    const p = toWorld(e.clientX, e.clientY)
    if (walkMode && running && sel?.kind === 'sta') {
      setTarget(p)
      void walkTo(sel.id, p.x, p.y)
      return
    }
    setState({ selected: null })
  }

  // A drag on empty floor pans; a plain click keeps its old meaning (walk target or deselect).
  const onBackground = (e: RPointerEvent) => {
    pan.current = { x: e.clientX, y: e.clientY, px: cam.px, py: cam.py, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const kind = e.dataTransfer.getData('application/x-wifilab-kind') as Kind
    if (!kind) return
    const p = toWorld(e.clientX, e.clientY)
    addNode(kind, p.x, p.y)
  }

  const gridX: number[] = []
  for (let x = Math.ceil(view.minX / 5) * 5; x <= view.minX + view.w; x += 5) gridX.push(x)
  const gridY: number[] = []
  for (let y = Math.ceil(view.minY / 5) * 5; y <= view.minY + view.h; y += 5) gridY.push(y)

  return (
    <div className="floor">
      <div className="palette" aria-label="Device palette">
        <div className="palette-title">{fixed ? 'Predesigned lab' : 'Drag onto the floor'}</div>
        {fixed && <small className="palette-note">{topoKind === 'ft' ? '2 access points and 1 client' : '1 access point and 1 client'}. Drag them to change distances. Use the Playground to add more.</small>}
        {!fixed &&
          PALETTE.map((p) => (
            <div
              key={p.kind}
              className={`palette-item kind-${p.kind}${editable ? '' : ' disabled'}`}
              draggable={editable}
              onDragStart={(e) => e.dataTransfer.setData('application/x-wifilab-kind', p.kind)}
              onClick={() => editable && addNode(p.kind, 10, -8)}
              title={editable ? `Add a ${p.title.toLowerCase()}` : 'Stop the lab to add devices'}
            >
              <span className="palette-icon">
                <Glyph kind={p.kind} />
              </span>
              <span>
                <strong>{p.title}</strong>
                <small>{p.hint}</small>
              </span>
            </div>
          ))}
        <div className="palette-sep" />
        <button
          className={`btn small ${walkMode ? 'primary' : ''}`}
          disabled={!running || sel?.kind !== 'sta'}
          onClick={() => setState({ walkMode: !walkMode })}
          title="Select a client, then click the floor: it walks there at 3 m/s"
        >
          {walkMode ? 'Click the floor...' : 'Walk mode'}
        </button>
        <div className="palette-legend">
          <span className="dot" style={{ background: '#16a34a' }} /> strong
          <span className="dot" style={{ background: '#d97706' }} /> fair
          <span className="dot" style={{ background: '#dc2626' }} /> weak
        </div>
      </div>

      <div
        className="canvas"
        ref={wrapRef}
        onDragOver={(e) => editable && e.preventDefault()}
        onDrop={editable ? onDrop : undefined}
      >
        <svg
          ref={svgRef}
          viewBox={`${view.minX} ${view.minY} ${view.w} ${view.h}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerDown={onBackground}
          className={walkMode && running ? 'walking' : ''}
        >
          <rect x={view.minX} y={view.minY} width={view.w} height={view.h} fill="var(--floor)" />
          {gridX.map((x) => (
            <line key={`gx${x}`} x1={x} x2={x} y1={view.minY} y2={view.minY + view.h} stroke="var(--grid)" strokeWidth={x % 10 === 0 ? unit * 1.1 : unit * 0.6} />
          ))}
          {gridY.map((y) => (
            <line key={`gy${y}`} y1={y} y2={y} x1={view.minX} x2={view.minX + view.w} stroke="var(--grid)" strokeWidth={y % 10 === 0 ? unit * 1.1 : unit * 0.6} />
          ))}
          {gridX
            .filter((x) => x % 10 === 0)
            .map((x) => (
              <text key={`lx${x}`} x={x + unit * 4} y={view.minY + view.h - unit * 6} fontSize={unit * 10} fill="var(--muted)">
                {x} m
              </text>
            ))}

          {aps.map((ap) => {
            const p = at(ap)
            const tx = ap.tx_dbm ?? 10
            const bands = [
              { rssi: -75, fill: '#fde68a', op: 0.22 },
              { rssi: selThreshold, fill: '#bbf7d0', op: 0.3 },
              { rssi: -50, fill: '#86efac', op: 0.32 },
            ]
            return (
              <g key={`cov-${ap.id}`} pointerEvents="none">
                {bands.map((b) => (
                  <circle key={b.rssi} cx={p.x} cy={p.y} r={rangeFor(b.rssi, tx, topo.path_loss_exponent)} fill={b.fill} fillOpacity={b.op} stroke={apColor(topo.nodes, ap.id)} strokeOpacity={0.35} strokeWidth={unit * 1} strokeDasharray={`${unit * 5} ${unit * 4}`} />
                ))}
                <text x={p.x + rangeFor(selThreshold, tx, topo.path_loss_exponent) * 0.707} y={p.y - rangeFor(selThreshold, tx, topo.path_loss_exponent) * 0.707} fontSize={unit * 10} fill="var(--muted)">
                  {selThreshold} dBm
                </text>
              </g>
            )
          })}

          {running &&
            live.stas.map((s) => {
              const ap = topo.nodes.find((n) => n.id === s.ap)
              if (!ap) return null
              const a = at(ap)
              const c = pos[s.id] ?? s
              const color = signalColor(s.rssi)
              return (
                <g key={`link-${s.id}`} pointerEvents="none">
                  <line x1={a.x} y1={a.y} x2={c.x} y2={c.y} stroke={color} strokeWidth={unit * 2.5} strokeLinecap="round" />
                  <g transform={`translate(${(a.x + c.x) / 2},${(a.y + c.y) / 2}) scale(${unit})`}>
                    <rect x={-24} y={-9} width={48} height={16} rx={8} fill="#fff" stroke={color} />
                    <text textAnchor="middle" y={3} fontSize={10} fontWeight={600} fill={color}>
                      {s.rssi ?? '-'} dBm
                    </text>
                  </g>
                </g>
              )
            })}

          {target && walkMode && running && (
            <g transform={`translate(${target.x},${target.y}) scale(${unit})`} pointerEvents="none">
              <circle r={7} fill="none" stroke="#2563eb" strokeWidth={2} strokeDasharray="3 3" />
              <circle r={2} fill="#2563eb" />
            </g>
          )}

          {topo.nodes.map((n) => {
            const p = at(n)
            const isSel = selected === n.id
            const sl = live.stas.find((s) => s.id === n.id)
            const apLive = live.aps.find((a) => a.id === n.id)
            const accent = n.kind === 'ap' ? apColor(topo.nodes, n.id) : n.kind === 'sta' ? signalColor(sl?.rssi ?? null) : '#7c3aed'
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y}) scale(${unit})`} className="node" onPointerDown={(e) => onPointerDown(e, n.id)} style={{ cursor: editable || running ? 'grab' : 'default' }}>
                {isSel && <circle r={25} fill="none" stroke="#2563eb" strokeWidth={2} strokeDasharray="4 3" />}
                {n.kind === 'sniffer' ? (
                  <rect x={-15} y={-15} width={30} height={30} rx={15} fill="#f5f3ff" stroke={accent} strokeWidth={2.5} strokeDasharray="4 3" />
                ) : (
                  <rect x={-17} y={-17} width={34} height={34} rx={n.kind === 'ap' ? 9 : 17} fill="#fff" stroke={accent} strokeWidth={3} />
                )}
                <g transform="translate(-11,-11)" color={accent}>
                  <Glyph kind={n.kind} size={22} />
                </g>
                <text y={31} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--ink)">
                  {n.id}
                </text>
                {(n.kind === 'ap' || n.kind === 'sniffer') && (
                  <g transform="translate(0,-26)">
                    <rect x={-17} y={-9} width={34} height={15} rx={7.5} fill={CHANNEL_COLOR[n.channel ?? 1]} />
                    <text textAnchor="middle" y={2} fontSize={9.5} fontWeight={700} fill="#fff">
                      ch {n.channel}
                    </text>
                  </g>
                )}
                {n.kind === 'ap' && apLive && apLive.clients.length > 0 && (
                  <g transform="translate(15,-15)">
                    <circle r={8} fill="#2563eb" />
                    <text textAnchor="middle" y={3.5} fontSize={10} fontWeight={700} fill="#fff">
                      {apLive.clients.length}
                    </text>
                  </g>
                )}
                {n.kind === 'sta' && sl && (
                  <text y={44} textAnchor="middle" fontSize={9.5} fill="var(--muted)">
                    {sl.ap ? `on ${sl.ap}` : sl.state.toLowerCase()}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        <div className="zoom-bar" onPointerDown={(e) => e.stopPropagation()}>
          <button className="btn small" onClick={() => zoomBy(1 / 1.25)} title="Zoom out" aria-label="Zoom out">
            −
          </button>
          <span>{Math.round(cam.k * 100)}%</span>
          <button className="btn small" onClick={() => zoomBy(1.25)} title="Zoom in" aria-label="Zoom in">
            +
          </button>
          <button className="btn small" disabled={cam.k === 1 && cam.px === 0 && cam.py === 0} onClick={() => setCam({ k: 1, px: 0, py: 0 })} title="Fit the whole floor">
            Reset
          </button>
        </div>
        {!running && <div className="canvas-hint">Design the network, then press <b>Start lab</b>. Drag devices to place them; use + / − to zoom, drag the floor to pan.</div>}
        {running && <div className="canvas-hint">Live: drag any device to move it. Rings mark -50 dBm, the roam trigger and -75 dBm for each AP.</div>}
      </div>
    </div>
  )
}
