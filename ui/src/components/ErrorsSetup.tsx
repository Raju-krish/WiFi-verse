import { editTopo, startLab, useStore } from '../store'
import type { Fault, Security } from '../types'

const ALL: Security[] = ['open', 'owe', 'wpa2-psk', 'wpa3-sae', 'ft-psk']
const LABEL: Record<Security, string> = { open: 'Open', owe: 'OWE', 'wpa2-psk': 'WPA2', 'wpa3-sae': 'WPA3', 'ft-psk': 'FT-PSK' }

const SCENARIOS: { fault: Fault; title: string; text: string; see: string; modes: Security[] }[] = [
  { fault: 'none', title: 'Working network', text: 'No mistake. A baseline to compare the failures with, and the place to practise deauthentication.', see: 'A normal connection.', modes: ALL },
  {
    fault: 'wrong_password',
    title: 'Wrong password',
    text: "The client has a password that differs from the access point's.",
    see: 'WPA2: EAPOL messages 1 and 2, then the AP gives up with reason 15. WPA3: the SAE exchange ends with status 1.',
    modes: ['wpa2-psk', 'wpa3-sae', 'ft-psk'],
  },
  { fault: 'mac_blocked', title: 'Client blocked by the AP', text: "The AP has the client's MAC address on its deny list.", see: 'Every Authentication is refused with status 1.', modes: ALL },
  {
    fault: 'pmf_mismatch',
    title: 'PMF mismatch',
    text: 'The AP requires protected management frames; the client has them switched off.',
    see: 'Nothing on the air: the client skips the network. The reason is only in its log.',
    modes: ['wpa2-psk'],
  },
  {
    fault: 'security_mismatch',
    title: 'Security mismatch',
    text: 'The client profile expects different security than the AP offers, for example a WPA2 profile on a WPA3 AP.',
    see: 'Nothing on the air again; the client log says the key management does not match.',
    modes: ALL,
  },
]

export function ErrorsSetup() {
  const topo = useStore((s) => s.topo)
  const labState = useStore((s) => s.lab.state)
  const locked = labState !== 'stopped'
  const running = labState === 'running'
  const fault = topo.fault ?? 'none'
  const current = SCENARIOS.find((s) => s.fault === fault) ?? SCENARIOS[0]
  const needsPassword = topo.security !== 'open' && topo.security !== 'owe'

  const pick = (s: (typeof SCENARIOS)[number]) =>
    editTopo((t) => ({ ...t, fault: s.fault, security: s.modes.includes(t.security) ? t.security : s.modes[0] }))

  return (
    <div className="ftsetup">
      <div className="ftsetup-fixed">
        <b>Predesigned lab</b>
        <span>1 access point (ap1) and 1 client (sta1), 8 m apart. The client keeps trying, so you see several attempts. About 25 seconds after the start, recording pauses.</span>
      </div>

      <div>
        <h4>Choose what goes wrong</h4>
        <div className="opts five">
          {SCENARIOS.map((s) => (
            <button key={s.fault} className={`opt${fault === s.fault ? ' on' : ''}`} disabled={locked} onClick={() => pick(s)}>
              <b>{s.title}</b>
              <span>{s.text}</span>
              <em>You will see: {s.see}</em>
            </button>
          ))}
        </div>
      </div>

      <div>
        <h4>Security of the network</h4>
        <div className="segmented">
          {current.modes.map((m) => (
            <button key={m} className={topo.security === m ? 'on' : ''} disabled={locked} onClick={() => editTopo((t) => ({ ...t, security: m }))}>
              {LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      <div className="ftsetup-run">
        {needsPassword && (
          <label className="field inline">
            <span>Password of the AP</span>
            <input type="text" value={topo.passphrase} maxLength={63} disabled={locked} onChange={(e) => editTopo((t) => ({ ...t, passphrase: e.target.value }))} />
          </label>
        )}
        <button className="btn primary" disabled={labState === 'starting' || labState === 'stopping' || running} onClick={() => void startLab()}>
          {labState === 'starting' ? 'Starting...' : running ? 'Lab running' : 'Start the lab'}
        </button>
        <button className="btn ghost" disabled={!running} onClick={() => document.getElementById('attempts')?.scrollIntoView({ behavior: 'smooth' })}>
          Show the attempts
        </button>
      </div>
      {fault === 'wrong_password' && <p className="muted">The client gets the same password with the characters &quot;wrong-&quot; in front of it.</p>}
      {locked && <p className="muted">The lab is running. Stop it to choose another scenario.</p>}
    </div>
  )
}
