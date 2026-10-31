import { useEffect, useRef } from 'react'
import { api } from '../api'
import { apColor, CHANNEL_COLOR, distance, modelRssi, signalColor } from '../model'
import { editTopo, removeNode, roamTo, setSecurity, setState, toast, updateNode, useStore, walkTo } from '../store'
import type { Channel, NodeCfg, Security } from '../types'
import { Glyph } from './FloorPlan'

const MODES: Record<Security, string> = { open: 'Open', owe: 'OWE', 'wpa2-psk': 'WPA2', 'wpa3-sae': 'WPA3', 'ft-psk': 'FT-PSK (802.11r)' }
const MODES_FOR = {
  playground: ['open', 'owe', 'wpa2-psk', 'wpa3-sae', 'ft-psk'],
  ft: ['ft-psk', 'wpa2-psk'],
  connect: ['open', 'owe', 'wpa2-psk', 'wpa3-sae'],
  errors: ['open', 'owe', 'wpa2-psk', 'wpa3-sae', 'ft-psk'],
} as const

function NetworkSettings() {
  const topo = useStore((s) => s.topo)
  const kind = useStore((s) => s.topoKind)
  const labState = useStore((s) => s.lab.state)
  const locked = labState !== 'stopped'
  const needsPassword = topo.security !== 'open' && topo.security !== 'owe'
  return (
    <div className="inspector-body">
      <h3>Network settings</h3>
      <p className="muted">Select a device on the floor to edit it. These settings apply to the whole lab.</p>
      <label className="field">
        <span>SSID</span>
        <input type="text" value={topo.ssid} disabled={locked} maxLength={32} onChange={(e) => editTopo((t) => ({ ...t, ssid: e.target.value }))} />
      </label>
      <label className="field">
        <span>Passphrase</span>
        <input type="text" value={topo.passphrase} disabled={locked || !needsPassword} maxLength={63} onChange={(e) => editTopo((t) => ({ ...t, passphrase: e.target.value }))} />
        {!needsPassword && <small className="muted">This security mode has no password.</small>}
      </label>
      <label className="field">
        <span>Path-loss exponent</span>
        <span className="input-unit">
          <input type="range" min={2} max={6} step={0.1} value={topo.path_loss_exponent} disabled={locked} onChange={(e) => editTopo((t) => ({ ...t, path_loss_exponent: Number(e.target.value) }))} />
          <em>{topo.path_loss_exponent.toFixed(1)}</em>
        </span>
        <small className="muted">2 = open space, 3.5 = office, 5 = heavy walls. Applied when the lab starts.</small>
      </label>
      <div className="field">
        <span>Security</span>
        <div className="segmented">
          {MODES_FOR[kind].map((m) => (
            <button key={m} className={topo.security === m ? `on ${m === 'ft-psk' ? 'ft' : m === 'wpa2-psk' ? 'psk' : ''}` : ''} disabled={locked} onClick={() => setSecurity(m)}>
              {MODES[m]}
            </button>
          ))}
        </div>
      </div>
      {locked && <p className="muted">Stop the lab to change network settings.</p>}
    </div>
  )
}

export function Inspector() {
  const selected = useStore((s) => s.selected)
  const topo = useStore((s) => s.topo)
  const pos = useStore((s) => s.pos)
  const live = useStore((s) => s.live)
  const labState = useStore((s) => s.lab.state)
  const frames = useStore((s) => s.frames)
  const node: NodeCfg | undefined = topo.nodes.find((n) => n.id === selected)
  const running = labState === 'running'
  const editable = labState === 'stopped'
  const fixed = useStore((s) => s.topoKind !== 'playground')
  const txTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(txTimer.current), [])

  if (!node) return <NetworkSettings />

  const p = running ? (pos[node.id] ?? node) : node
  const aps = topo.nodes.filter((n) => n.kind === 'ap')
  const sl = live.stas.find((s) => s.id === node.id)
  const apLive = live.aps.find((a) => a.id === node.id)

  const setTx = (dbm: number) => {
    updateNode(node.id, { tx_dbm: dbm })
    if (running) {
      clearTimeout(txTimer.current)
      txTimer.current = setTimeout(() => api.tx(node.id, dbm).catch((e: Error) => toast(e.message)), 150)
    }
  }

  return (
    <div className="inspector-body">
      <div className="inspector-head">
        <span className={`chip kind-${node.kind}`}>
          <Glyph kind={node.kind} size={16} />
        </span>
        <div>
          <h3>{node.id}</h3>
          <small className="muted">{{ ap: 'Access point · hostapd', sta: 'Client · wpa_supplicant', sniffer: 'Sniffer · monitor-mode radio' }[node.kind]}</small>
        </div>
      </div>

      {(node.kind === 'ap' || node.kind === 'sniffer') && (
        <div className="field">
          <span>Channel (2.4 GHz)</span>
          <div className="segmented">
            {([1, 6, 11] as Channel[]).map((c) => (
              <button key={c} disabled={!editable} className={node.channel === c ? 'on' : ''} style={node.channel === c ? { background: CHANNEL_COLOR[c], borderColor: CHANNEL_COLOR[c] } : undefined} onClick={() => updateNode(node.id, { channel: c })}>
                {c}
              </button>
            ))}
          </div>
          {!editable && <small className="muted">Channels are fixed while the lab runs.</small>}
        </div>
      )}

      {node.kind !== 'sniffer' && (
        <label className="field">
          <span>Transmit power</span>
          <span className="input-unit">
            <input type="range" min={0} max={30} step={1} value={node.tx_dbm ?? 10} onChange={(e) => setTx(Number(e.target.value))} />
            <em>{node.tx_dbm ?? 10} dBm</em>
          </span>
          {running && <small className="muted">Applied live through wmediumd.</small>}
        </label>
      )}

      {node.kind === 'sta' && (
        <label className="field">
          <span>Roam trigger</span>
          <span className="input-unit">
            <input type="range" min={-85} max={-45} step={1} value={node.roam_threshold_dbm ?? -65} disabled={!editable} onChange={(e) => updateNode(node.id, { roam_threshold_dbm: Number(e.target.value) })} />
            <em>{node.roam_threshold_dbm ?? -65} dBm</em>
          </span>
          <small className="muted">The client starts scanning for a better AP when its signal falls below this.</small>
        </label>
      )}

      {node.kind === 'sta' && (
        <div className="card-lite">
          <h4>Signal to each AP (model)</h4>
          {aps.map((ap) => {
            const a = running ? (pos[ap.id] ?? ap) : ap
            const r = Math.round(modelRssi(ap.tx_dbm ?? 10, distance(p, a), topo.path_loss_exponent))
            const current = sl?.ap === ap.id
            return (
              <div key={ap.id} className={`apline${current ? ' current' : ''}`}>
                <span className="dot" style={{ background: apColor(topo.nodes, ap.id) }} />
                <b>{ap.id}</b>
                <span className="muted">{distance(p, a).toFixed(1)} m</span>
                <span className="grow" />
                <span style={{ color: signalColor(r), fontWeight: 700 }}>{r} dBm</span>
                {current && <span className="tag">connected</span>}
              </div>
            )
          })}
          {running && sl && (
            <p className="muted small-print">
              {sl.state === 'COMPLETED' ? `Associated to ${sl.ap ?? sl.bssid}, measured ${sl.rssi ?? '-'} dBm.` : `State: ${sl.state}`}
            </p>
          )}
        </div>
      )}

      {node.kind === 'sta' && running && (
        <div className="card-lite">
          <h4>Move this client</h4>
          <div className="btnrow">
            {aps.map((ap) => (
              <button key={`w${ap.id}`} className="btn small" onClick={() => void walkTo(node.id, ap.x + 2, ap.y, 4)}>
                Walk to {ap.id}
              </button>
            ))}
          </div>
          <div className="btnrow">
            {aps.map((ap) => (
              <button key={`r${ap.id}`} className="btn small ghost" disabled={sl?.ap === ap.id} onClick={() => void roamTo(node.id, ap.id)}>
                Force roam to {ap.id}
              </button>
            ))}
          </div>
          <div className="btnrow">
            <button
              className="btn small"
              disabled={sl?.state !== 'COMPLETED'}
              onClick={() =>
                api
                  .ping(node.id, 4)
                  .then((r) => toast(r.output.includes(' 0 received') ? 'Ping got no reply' : (r.output.split('\n').find((l) => l.includes('packets transmitted')) ?? 'Ping finished')))
                  .catch((e: Error) => toast(e.message))
              }
            >
              Ping gateway (4 packets)
            </button>
          </div>
          <small className="muted">Walking uses the radio model, so the client roams by itself when the signal says so. Forcing skips that. The lab sends no traffic on its own.</small>
        </div>
      )}

      {node.kind === 'ap' && running && apLive && (
        <div className="card-lite">
          <h4>Associated clients</h4>
          {apLive.clients.length === 0 && <p className="muted">None.</p>}
          {live.stas.filter((s) => s.ap === node.id).map((s) => (
            <div key={s.id} className="apline">
              <b>{s.id}</b>
              <span className="muted">{s.ip}</span>
              <span className="grow" />
              <span style={{ color: signalColor(s.rssi), fontWeight: 700 }}>{s.rssi ?? '-'} dBm</span>
            </div>
          ))}
        </div>
      )}

      {node.kind === 'sniffer' && (
        <div className="card-lite">
          <h4>Captured by this sniffer</h4>
          <p className="muted">
            {frames[node.id]?.length ?? 0} frames heard on channel {node.channel}. It only hears what path loss allows from where it stands.
          </p>
          <button className="btn small" onClick={() => setState({ captureSrc: node.id })}>
            Show in capture
          </button>
        </div>
      )}

      <div className="spacer" />
      <div className="btnrow">
        <button className="btn small ghost" onClick={() => setState({ selected: null })}>
          Network settings
        </button>
        {!fixed && (
          <button className="btn small danger" disabled={!editable} onClick={() => removeNode(node.id)} title={editable ? 'Remove this device' : 'Stop the lab to remove devices'}>
            Delete
          </button>
        )}
      </div>
    </div>
  )
}
