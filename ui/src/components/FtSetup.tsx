import { setFtOptions, setSecurity, startLab, useStore, walkTo, getState, toast } from '../store'
import type { FtKeys } from '../types'

const KEYS: { id: FtKeys; title: string; text: string; see: string }[] = [
  {
    id: 'local',
    title: 'Local generation',
    text: 'Every AP knows the passphrase and works out PMK-R0 and PMK-R1 itself. The APs never talk to each other.',
    see: 'No AP-to-AP messages in either log.',
  },
  {
    id: 'pull',
    title: 'Pull',
    text: 'The new AP asks the old one (the R0KH) for PMK-R1 while the client is already roaming.',
    see: 'A PMK-R1 pull request and response between the APs, in the middle of the roam.',
  },
  {
    id: 'push',
    title: 'Push',
    text: 'As soon as the client joins, its AP (the R0KH) sends PMK-R1 to the other APs. The key is waiting when the client arrives.',
    see: 'A PMK-R1 push right after the first association, nothing at roam time. Fastest roam.',
  },
]

const MOVES = [
  {
    ds: false,
    title: 'Over the air',
    text: 'The client sends its FT Authentication straight to the new AP.',
    see: 'FT Authentication x2, Reassociation x2, all on the air: 4 frames, no EAPOL.',
  },
  {
    ds: true,
    title: 'Over the DS',
    text: 'The client asks its current AP, which relays the request to the new AP over the wired network and brings back the answer.',
    see: 'FT Action request and response with the old AP, then Reassociation x2. The relay itself is wired, so it appears only in the AP logs.',
  },
]

export function FtSetup() {
  const topo = useStore((s) => s.topo)
  const labState = useStore((s) => s.lab.state)
  const keys = topo.ft_keys ?? 'local'
  const ds = topo.ft_over_ds ?? false
  const ft = topo.security === 'ft-psk'
  const locked = labState !== 'stopped'

  const run = async () => {
    if (getState().lab.state === 'stopped') await startLab()
    const s = getState()
    const sta = s.topo.nodes.find((n) => n.kind === 'sta')
    const aps = s.topo.nodes.filter((n) => n.kind === 'ap')
    if (s.lab.state !== 'running' || !sta || aps.length < 2) return
    const far = aps[aps.length - 1]
    void walkTo(sta.id, far.x - 2, far.y, 5)
    toast(`${sta.id} walks towards ${far.id}. Its own signal logic decides when to roam.`)
  }

  return (
    <div className="ftsetup">
      <div className="ftsetup-fixed">
        <b>Predesigned lab</b>
        <span>2 access points (ap1 on channel 1, ap2 on channel 6), 1 client (sta1) and a floor to walk on. Mobility domain 4f57, SSID LabNet.</span>
        <div className="segmented small" title="Security mode for the next start">
          <button className={ft ? 'on ft' : ''} disabled={locked} onClick={() => setSecurity('ft-psk')}>
            FT-PSK (802.11r)
          </button>
          <button className={!ft ? 'on psk' : ''} disabled={locked} onClick={() => setSecurity('wpa2-psk')}>
            WPA2-PSK, for comparison
          </button>
        </div>
      </div>

      <div className={`ftsetup-groups${ft ? '' : ' off'}`}>
        <div>
          <h4>1. How does the new AP get PMK-R1?</h4>
          <div className="opts">
            {KEYS.map((k) => (
              <button key={k.id} className={`opt${keys === k.id ? ' on' : ''}`} disabled={locked || !ft} onClick={() => setFtOptions({ ft_keys: k.id })}>
                <b>{k.title}</b>
                <span>{k.text}</span>
                <em>You will see: {k.see}</em>
              </button>
            ))}
          </div>
        </div>
        <div>
          <h4>2. How does the client start the move?</h4>
          <div className="opts">
            {MOVES.map((m) => (
              <button key={m.title} className={`opt${ds === m.ds ? ' on' : ''}`} disabled={locked || !ft} onClick={() => setFtOptions({ ft_over_ds: m.ds })}>
                <b>{m.title}</b>
                <span>{m.text}</span>
                <em>You will see: {m.see}</em>
              </button>
            ))}
          </div>
        </div>
      </div>

      <label className="check ftsetup-capture">
        <input type="checkbox" checked={topo.auto_stop_capture ?? false} disabled={locked} onChange={(e) => setFtOptions({ auto_stop_capture: e.target.checked })} />
        <span>
          <b>Stop the capture when the client has finished roaming.</b> The pcap then holds just the run up to the roam, without minutes of beacons. The lab keeps running; a second roam after that is not recorded, so stop and start the lab for a fresh capture.
        </span>
      </label>
      {!ft && <p className="muted">WPA2-PSK has no key holders and no fast transition: every roam repeats the full 4-way handshake. The two choices above apply to FT only.</p>}
      {locked && <p className="muted">The lab is running. Stop it to change these settings.</p>}
      {ds && ft && (
        <p className="ftsetup-note">
          <b>About over the DS:</b> wpa_supplicant never starts an over-the-DS roam by itself, it only does so when told (the <code>FT_DS</code> command). In this mode the lab plays the client driver: when the signal falls below the roam trigger it scans and, like bgscan, moves only to an AP at least 5 dB stronger, by sending <code>FT_DS</code>. The frames and keys are still the real ones.
        </p>
      )}
      <div className="ftsetup-run">
        <button className="btn primary" disabled={labState === 'starting' || labState === 'stopping'} onClick={() => void run()}>
          {labState === 'running' ? 'Walk the client to ap2' : 'Start the lab and walk the client to ap2'}
        </button>
        <span className="muted">Then follow the roam in the sections below: signal, frame ladder, capture, key check and logs.</span>
      </div>
    </div>
  )
}
