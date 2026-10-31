import { useState } from 'react'
import { api } from '../api'
import { editTopo, getState, setFtOptions, setSecurity, setState, startLab, toast, useStore } from '../store'
import type { Security } from '../types'

const MODES: { id: Security; title: string; text: string; see: string }[] = [
  {
    id: 'open',
    title: 'Open',
    text: 'No password, no encryption.',
    see: 'Authentication x2, Association x2, nothing else. Data readable on the air.',
  },
  {
    id: 'owe',
    title: 'OWE (Enhanced Open)',
    text: 'No password, but a Diffie-Hellman exchange gives each client its own key.',
    see: 'The DH keys inside the association, then the 4-way handshake. Encrypted data, protected management frames.',
  },
  {
    id: 'wpa2-psk',
    title: 'WPA2-Personal',
    text: 'One shared password, a 4-way handshake for each connection.',
    see: 'Authentication x2, Association x2, EAPOL messages 1 to 4.',
  },
  {
    id: 'wpa3-sae',
    title: 'WPA3-Personal (SAE)',
    text: 'The password is used in a commit and confirm exchange that cannot be guessed offline.',
    see: 'Four SAE Authentication frames, Association x2, then EAPOL 1 to 4. Management frames protected.',
  },
]

export function ConnectSetup() {
  const topo = useStore((s) => s.topo)
  const labState = useStore((s) => s.lab.state)
  const [busy, setBusy] = useState(false)
  const locked = labState !== 'stopped'
  const running = labState === 'running'
  const needsPassword = topo.security === 'wpa2-psk' || topo.security === 'wpa3-sae'
  const sta = topo.nodes.find((n) => n.kind === 'sta')

  const reconnect = async () => {
    if (!sta) return
    setBusy(true)
    try {
      await api.reconnect(sta.id)
      setState((s) => ({ connectTick: s.connectTick + 1 }))
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ftsetup">
      <div className="ftsetup-fixed">
        <b>Predesigned lab</b>
        <span>1 access point (ap1, channel 1) and 1 client (sta1), 8 m apart. Drag the client further away to see the signal fall; the connection stays the same until it is out of range.</span>
      </div>

      <div>
        <h4>Choose the security of the network</h4>
        <div className="opts four">
          {MODES.map((m) => (
            <button key={m.id} className={`opt${topo.security === m.id ? ' on' : ''}`} disabled={locked} onClick={() => setSecurity(m.id)}>
              <b>{m.title}</b>
              <span>{m.text}</span>
              <em>You will see: {m.see}</em>
            </button>
          ))}
        </div>
      </div>

      <label className="check ftsetup-capture">
        <input type="checkbox" checked={topo.pause_capture_when_connected ?? false} disabled={locked} onChange={(e) => setFtOptions({ pause_capture_when_connected: e.target.checked })} />
        <span>
          <b>Stop recording once the client is connected.</b> A few seconds after the connection completes, the capture pauses, so it holds the connection and not minutes of beacons. It resumes by itself on Disconnect and reconnect, on a ping, or with the Resume button in the capture panel.
        </span>
      </label>

      <div className="ftsetup-run">
        {needsPassword && (
          <label className="field inline">
            <span>Password</span>
            <input type="text" value={topo.passphrase} maxLength={63} disabled={locked} onChange={(e) => editTopo((t) => ({ ...t, passphrase: e.target.value }))} />
          </label>
        )}
        <button className="btn primary" disabled={labState === 'starting' || labState === 'stopping' || running} onClick={() => void startLab()}>
          {labState === 'starting' ? 'Starting...' : running ? 'Lab running' : 'Start the lab'}
        </button>
        <button className="btn" disabled={!running || busy} onClick={() => void reconnect()} title="The client drops its connection and joins again, so you can compare the two exchanges">
          {busy ? 'Reconnecting...' : 'Disconnect and reconnect'}
        </button>
        <button className="btn ghost" disabled={!running} onClick={() => getState().lab.state === 'running' && document.getElementById('connection')?.scrollIntoView({ behavior: 'smooth' })}>
          Show the connection
        </button>
      </div>
      {locked && <p className="muted">The lab is running. Stop it to change the security mode.</p>}
      <p className="muted">The client connects by itself as soon as the lab starts. Press Disconnect and reconnect to watch it again: with WPA3 the second time skips the SAE exchange because the key is cached.</p>
    </div>
  )
}
