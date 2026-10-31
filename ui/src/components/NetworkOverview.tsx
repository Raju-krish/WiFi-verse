import { useState } from 'react'
import { api } from '../api'
import { apColor, signalColor } from '../model'
import { setState, toast, useStore } from '../store'
import type { NodeCfg } from '../types'
import { Glyph } from './FloorPlan'

const ROLE = { ap: 'Access point', sta: 'Client', sniffer: 'Sniffer' } as const

export function NetworkOverview() {
  const topo = useStore((s) => s.topo)
  const pos = useStore((s) => s.pos)
  const live = useStore((s) => s.live)
  const frames = useStore((s) => s.frames)
  const selected = useStore((s) => s.selected)
  const running = useStore((s) => s.lab.state === 'running')
  const [pinging, setPinging] = useState<string | null>(null)

  if (topo.nodes.length === 0) return <div className="empty">The floor is empty. Drag an access point and a client onto it, then start the lab.</div>

  const ping = async (id: string) => {
    setPinging(id)
    try {
      const r = await api.ping(id, 4)
      toast(r.output.includes(' 0 received') ? `${id}: ping got no reply` : `${id}: ${r.output.split('\n').find((l) => l.includes('packets transmitted')) ?? 'ping finished'}`)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setPinging(null)
    }
  }

  const status = (n: NodeCfg) => {
    if (!running) return <span className="muted">lab not running</span>
    if (n.kind === 'ap') {
      const clients = live.stas.filter((s) => s.ap === n.id)
      return clients.length ? (
        <>
          {clients.length} client{clients.length === 1 ? '' : 's'}: {clients.map((c) => c.id).join(', ')}
        </>
      ) : (
        <span className="muted">no clients</span>
      )
    }
    if (n.kind === 'sta') {
      const s = live.stas.find((x) => x.id === n.id)
      if (!s) return <span className="muted">starting</span>
      if (s.state !== 'COMPLETED') return <>{s.state.toLowerCase()}</>
      return (
        <>
          connected to <b>{s.ap ?? s.bssid}</b>, {s.ip || 'no address yet'},{' '}
          <span style={{ color: signalColor(s.rssi), fontWeight: 700 }}>{s.rssi ?? '-'} dBm</span>
        </>
      )
    }
    return <>{frames[n.id]?.length ?? 0} frames heard</>
  }

  return (
    <table className="cmp-table net-table">
      <thead>
        <tr>
          <th>Device</th>
          <th>Role</th>
          <th>Channel</th>
          <th>Position</th>
          <th>Power</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {topo.nodes.map((n) => {
          const p = running ? (pos[n.id] ?? n) : n
          const sta = live.stas.find((s) => s.id === n.id)
          return (
            <tr key={n.id} className={selected === n.id ? 'on' : ''} onClick={() => setState({ selected: n.id })}>
              <td>
                <span className="net-dev">
                  <Glyph kind={n.kind} size={16} />
                  <b style={n.kind === 'ap' ? { color: apColor(topo.nodes, n.id) } : undefined}>{n.id}</b>
                </span>
              </td>
              <td>{ROLE[n.kind]}</td>
              <td>{n.kind === 'sta' ? (running && sta?.ap ? (topo.nodes.find((a) => a.id === sta.ap)?.channel ?? '-') : '-') : n.channel}</td>
              <td>
                {p.x.toFixed(1)}, {p.y.toFixed(1)} m
              </td>
              <td>{n.kind === 'sniffer' ? 'receive only' : `${n.tx_dbm ?? 10} dBm`}</td>
              <td>{status(n)}</td>
              <td>
                {n.kind === 'sta' && (
                  <button
                    className="btn small"
                    disabled={!running || sta?.state !== 'COMPLETED' || pinging === n.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      void ping(n.id)
                    }}
                    title="Send 4 pings to the gateway, so there is something to capture"
                  >
                    {pinging === n.id ? 'Pinging...' : 'Ping gateway'}
                  </button>
                )}
                {n.kind === 'sniffer' && (
                  <button
                    className="btn small"
                    onClick={(e) => {
                      e.stopPropagation()
                      setState({ captureSrc: n.id })
                      document.getElementById('capture')?.scrollIntoView({ behavior: 'smooth' })
                    }}
                  >
                    Open capture
                  </button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
