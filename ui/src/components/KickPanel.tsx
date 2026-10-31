import { useState } from 'react'
import { api } from '../api'
import { REASON_ROWS, lookup } from '../data/dot11'
import { setState, toast, useStore } from '../store'

const COMMON = [1, 2, 3, 4, 6, 7, 8, 12, 15, 34, 71]

export function KickPanel() {
  const topo = useStore((s) => s.topo)
  const running = useStore((s) => s.lab.state === 'running')
  const [kind, setKind] = useState<'deauth' | 'disassoc'>('deauth')
  const [reason, setReason] = useState(3)
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<string | null>(null)
  const ap = topo.nodes.find((n) => n.kind === 'ap')
  const sta = topo.nodes.find((n) => n.kind === 'sta')
  const row = lookup('reason', reason)
  const pmf = topo.security === 'owe' || topo.security === 'wpa3-sae'

  const send = async () => {
    if (!ap || !sta) return
    setBusy(true)
    try {
      await api.deauth(ap.id, sta.id, kind, reason)
      setLast(`${kind === 'deauth' ? 'Deauthentication' : 'Disassociation'} with reason ${reason} sent from ${ap.id} to ${sta.id}.`)
      setState((s) => ({ connectTick: s.connectTick + 1 }))
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ftsetup">
      <p className="muted">
        A deauthentication ends the authentication and with it the association; a disassociation ends only the association. Either carries a reason code. Choose one and the access point sends it to the client, then watch what the client does and what the capture shows. This works when the client is connected, so use a working network (or a fault that lets the client connect).
      </p>
      <div className="kick-row">
        <div className="segmented small">
          <button className={kind === 'deauth' ? 'on' : ''} onClick={() => setKind('deauth')}>
            Deauthentication
          </button>
          <button className={kind === 'disassoc' ? 'on' : ''} onClick={() => setKind('disassoc')}>
            Disassociation
          </button>
        </div>
        <label className="field inline">
          <span>Reason</span>
          <select value={reason} onChange={(e) => setReason(Number(e.target.value))}>
            {REASON_ROWS.filter((r) => !r.reserved).map((r) => (
              <option key={r.code} value={r.code}>
                {r.code} · {r.name.length > 60 ? `${r.name.slice(0, 58)}…` : r.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" disabled={!running || busy} onClick={() => void send()}>
          {busy ? 'Sending...' : `Send from ${ap?.id ?? 'the AP'}`}
        </button>
      </div>
      <div className="kick-chips">
        {COMMON.map((c) => (
          <button key={c} className={`chipbtn${reason === c ? ' on' : ''}`} onClick={() => setReason(c)} title={lookup('reason', c)?.name}>
            {c}
          </button>
        ))}
      </div>
      {row && (
        <div className="code-card">
          <small>Reason {row.code}</small>
          <b>{row.name}</b>
          {row.note && <span>{row.note.plain}</span>}
        </div>
      )}
      {pmf && <p className="ftsetup-note">This network uses protected management frames, so the capture shows the frame but not its reason code: it is encrypted. The client believes it because only the AP could have made it; an attacker's forged frame would be dropped.</p>}
      {last && <p className="muted">{last} Most clients reconnect straight away: look for a new attempt above, and for the frames in the capture.</p>}
      {!running && <p className="muted">Start the lab to send one.</p>}
    </div>
  )
}
