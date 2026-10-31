import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clamp } from './panes'
import type { Frame } from '../types'

export const ROW_H = 22
export type TimeFormat = 'rel' | 'tod'

interface Col {
  key: string
  title: string
  width: number
  min: number
  align?: 'right'
}

const BASE: Col[] = [
  { key: 'n', title: 'No.', width: 64, min: 40, align: 'right' },
  { key: 'time', title: 'Time', width: 100, min: 60, align: 'right' },
  { key: 'src', title: 'Source', width: 150, min: 60 },
  { key: 'dst', title: 'Destination', width: 160, min: 60 },
  { key: 'proto', title: 'Protocol', width: 84, min: 50 },
  { key: 'len', title: 'Length', width: 66, min: 44, align: 'right' },
  { key: 'ch', title: 'Ch', width: 40, min: 30, align: 'right' },
  { key: 'sig', title: 'Signal', width: 64, min: 40, align: 'right' },
]

/** Wireshark's default colouring rules, plus tints for the 802.11 events that matter in a roam. */
export function rowClass(f: Frame): string {
  const p = f.proto
  if (f.type === 'Deauth' || f.type === 'Disassoc') return 'c-bad'
  if (f.type.startsWith('EAPOL')) return 'c-eapol'
  if (p === 'ARP') return 'c-arp'
  if (p === 'ICMP' || p === 'ICMPv6') return 'c-icmp'
  if (f.type === 'Beacon' || f.type.startsWith('Probe')) return 'c-quiet'
  if (f.type === 'Auth' || f.type.includes('Assoc') || f.type.startsWith('FT-')) return 'c-mgmt'
  return ''
}

const MAC = /^([0-9a-f]{2}(?::[0-9a-f]{2}){5})(.*)$/i

interface Props {
  rows: Frame[]
  selected: number | null
  onSelect: (n: number) => void
  follow: boolean
  onFollow: (on: boolean) => void
  timeFormat: TimeFormat
  showSignal: boolean
  resolve: boolean
  macs: Record<string, string>
  emptyText: string
}

export function PacketList({ rows, selected, onSelect, follow, onFollow, timeFormat, showSignal, resolve, macs, emptyText }: Props) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem('wifilab.cols') ?? '{}') as Record<string, number>
    } catch {
      return {}
    }
  })
  const box = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, h: 300 })
  const cols = BASE.filter((c) => c.key !== 'sig' || showSignal).map((c) => ({ ...c, width: widths[c.key] ?? c.width }))
  const template = `${cols.map((c) => `${c.width}px`).join(' ')} minmax(260px, 1fr)`
  const minWidth = cols.reduce((a, c) => a + c.width, 0) + 260

  useEffect(() => {
    localStorage.setItem('wifilab.cols', JSON.stringify(widths))
  }, [widths])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, h: el.clientHeight })))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [rows.length, follow])

  const index = selected === null ? -1 : rows.findIndex((f) => f.n === selected)
  useEffect(() => {
    const el = box.current
    if (!el || index < 0) return
    const top = index * ROW_H
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight - ROW_H) el.scrollTop = Math.max(0, top - el.clientHeight / 2)
    // Only react to the selection moving or appearing in the list, not to rows streaming in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, index >= 0])

  const first = clamp(Math.floor(scroll.top / ROW_H) - 10, 0, rows.length)
  const last = clamp(Math.ceil((scroll.top + scroll.h) / ROW_H) + 10, 0, rows.length)

  const name = (value: string) => {
    if (!resolve) return value
    if (value.toLowerCase().startsWith('ff:ff:ff:ff:ff:ff')) return value.replace(/ff:ff:ff:ff:ff:ff/i, 'Broadcast')
    const m = MAC.exec(value)
    return m && macs[m[1].toLowerCase()] ? `${macs[m[1].toLowerCase()]}${m[2]}` : value
  }

  const time = (f: Frame) => (timeFormat === 'rel' ? f.rel.toFixed(6) : new Date(f.t * 1000).toLocaleTimeString([], { hour12: false }) + '.' + String(Math.floor((f.t % 1) * 1e6)).padStart(6, '0'))

  const startResize = (e: React.PointerEvent<HTMLElement>, c: Col & { width: number }) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const w0 = c.width
    const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [c.key]: clamp(w0 + ev.clientX - x0, c.min, 600) }))
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : e.key === 'PageDown' ? 15 : e.key === 'PageUp' ? -15 : e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0
    if (!step || rows.length === 0) return
    e.preventDefault()
    onFollow(false)
    onSelect(rows[clamp(index < 0 ? 0 : index + step, 0, rows.length - 1)].n)
  }

  return (
    <div
      className="pl"
      ref={box}
      tabIndex={0}
      onKeyDown={onKey}
      onScroll={(e) => {
        const el = e.currentTarget
        setScroll({ top: el.scrollTop, h: el.clientHeight })
        const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4
        if (atEnd !== follow) onFollow(atEnd)
      }}
    >
      <div style={{ minWidth }}>
        <div className="pl-head" style={{ gridTemplateColumns: template }}>
          {cols.map((c) => (
            <div key={c.key} className={c.align === 'right' ? 'r' : ''} title={c.key === 'sig' ? 'Signal strength (dBm) at this sniffer' : undefined}>
              {c.title}
              <i className="col-grip" onPointerDown={(e) => startResize(e, c)} />
            </div>
          ))}
          <div>Info</div>
        </div>
        {rows.length === 0 ? (
          <div className="pl-empty">{emptyText}</div>
        ) : (
          <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
            <div style={{ position: 'absolute', top: first * ROW_H, left: 0, right: 0 }}>
              {rows.slice(first, last).map((f) => (
                <div key={f.n} className={`pl-row ${rowClass(f)}${f.n === selected ? ' sel' : ''}`} style={{ gridTemplateColumns: template, height: ROW_H }} onClick={() => onSelect(f.n)}>
                  <div className="r">{f.n}</div>
                  <div className="r">{time(f)}</div>
                  <div>{name(f.scol)}</div>
                  <div>{name(f.dcol)}</div>
                  <div>{f.proto}</div>
                  <div className="r">{f.len ?? ''}</div>
                  <div className="r">{f.ch ?? ''}</div>
                  {showSignal && <div className="r">{f.rssi ?? ''}</div>}
                  <div className="info">{f.info}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
