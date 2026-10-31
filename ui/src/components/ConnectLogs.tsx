import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { apColor, fmtMs, SECURITY_INFO } from '../model'
import { useStore } from '../store'
import type { Connection, LogLine, Security } from '../types'

interface Step {
  id: string
  title: string
  modes?: Security[]
  why: (mode: Security | null) => string
  re: RegExp
}

// The first step whose pattern matches a line owns it, so the order matters.
const STEPS: Step[] = [
  {
    id: 'pick',
    title: 'Client picks the network',
    why: (m) =>
      `wpa_supplicant scans, chooses the BSS whose SSID and security match its profile, reads the RSN element in the beacon and settles on the key management${m === 'open' ? ' (an open network has no RSN element, so nothing is negotiated)' : ''}. It also looks in its PMKSA cache: a cached key lets it skip the expensive part of the exchange.`,
    re: /Considering connect request|Request association|Selecting BSS|OWE: Look for|Using SAE auth_alg|using KEY_MGMT|supports MFP|PMKSA cache search|PMKSA cache entry found|Trying to use cached PMKSA|Scan completed|-> SCANNING|MGMT group cipher|WPA: (Selected|AP |using|set AP|Set own|clearing)|RSN: clearing/,
  },
  {
    id: 'sae',
    title: 'SAE: password to shared key',
    modes: ['wpa3-sae'],
    why: () =>
      'Both sides turn the password into a point on an elliptic curve (the counter lines are the password-element search, run for a fixed number of rounds so its duration does not leak the password), swap a commit and a confirm in Authentication frames, and end with the same PMK without sending anything that can be guessed offline. With a cached PMKSA this step is skipped.',
    re: /SAE:|SME SAE|SAE authentication|auth_alg=3|[Aa]dded PMKSA|PMKSA-CACHE-ADDED|PMKSA caching|No PSK for STA/,
  },
  {
    id: 'owe',
    title: 'OWE: Diffie-Hellman in the association',
    modes: ['owe'],
    why: () =>
      'There is no password. The client puts its Diffie-Hellman public key in the Association Request, the AP answers with its own in the Association Response, and both compute the same secret, which becomes the PMK. Someone who only listens cannot work it out.',
    re: /OWE:|Diffie-Hellman/,
  },
  {
    id: 'auth',
    title: 'Authentication',
    why: (m) => (m === 'wpa3-sae' ? 'The state machine moves to AUTHENTICATING once SAE has finished.' : 'The client sends an Authentication frame (open system, algorithm 0) and the AP accepts it. Nothing is proved here: it only opens the door to association.'),
    re: /SME: Trying to authenticate|nl80211: Authenticate|authentication: STA|authentication reply|authentication OK|open system|SME: Authentication response|IEEE 802\.11: authenticated|-> AUTHENTICATING/,
  },
  {
    id: 'assoc',
    title: 'Association',
    why: () => 'The client asks to join with its capabilities and the RSN element it chose; the AP checks them, answers with an association ID (AID) and records the station.',
    re: /^(?!WPS:).*[Aa]ssociat/,
  },
  {
    id: 'handshake',
    title: '4-way handshake',
    modes: ['owe', 'wpa2-psk', 'wpa3-sae', 'ft-psk'],
    why: (m) =>
      `Four EAPOL-Key messages prove both sides hold the same PMK${m === 'owe' ? ' (the one from Diffie-Hellman)' : m === 'wpa3-sae' ? ' (the one SAE produced)' : ' (derived from the password)'}, mix in fresh nonces to derive the PTK, and deliver the group key (GTK) under the KEK.`,
    re: /^(?!.*(handshake completed|Key negotiation completed)).*(4-Way|EAPOL-Key|IEEE 802\.1X|PTK|GTK|WPA: |EAPOL: PMKSA|group key|EAPOL-4WAY)/,
  },
  {
    id: 'keys',
    title: 'Keys installed, port opens',
    why: (m) => (m === 'open' ? 'Nothing was negotiated, so the port opens as soon as the station is associated.' : 'Both sides install the pairwise and group keys in the driver and mark the port authorized. Encrypted data can flow.'),
    re: /set_key|port status: Authorized|CTRL-EVENT-CONNECTED|-> COMPLETED|handshake completed|Key negotiation completed|AP-STA-CONNECTED|authorized=1|binding station/,
  },
]

// Shown only with "Show every log line": the password-element search repeats about forty times.
const NOISE = /SAE: (counter|pwd-seed|pwd-value)/

const kindOf = (id: string) => (id.startsWith('ap') ? 'hostapd, access point' : 'wpa_supplicant, client')

export function ConnectLogs() {
  const topo = useStore((s) => s.topo)
  const runDir = useStore((s) => s.lab.runDir)
  const labState = useStore((s) => s.lab.state)
  const tick = useStore((s) => s.connectTick)
  const run = runDir?.split('/').pop() ?? null
  const sta = topo.nodes.find((n) => n.kind === 'sta')
  const ap = topo.nodes.find((n) => n.kind === 'ap')
  const [conns, setConns] = useState<Connection[]>([])
  const [mode, setMode] = useState<Security | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [lines, setLines] = useState<LogLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [early, setEarly] = useState(false)
  const [everything, setEverything] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  useEffect(() => {
    setConns([])
    setPicked(null)
  }, [run])

  useEffect(() => {
    if (!sta || !ap || !run || labState === 'starting' || labState === 'stopping') return
    let alive = true
    const load = () =>
      api
        .connection(sta.id, ap.id, run)
        .then((r) => {
          if (!alive) return
          setConns(r.connections)
          setMode(r.mode)
        })
        .catch(() => undefined)
    void load()
    const timer = labState === 'running' ? setInterval(load, 1500) : undefined
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [run, labState, tick, sta?.id, ap?.id])

  const idx = picked !== null && picked < conns.length ? picked : conns.length - 1
  const conn: Connection | undefined = conns[idx]
  const t0 = conn?.t_start ?? 0

  useEffect(() => {
    if (!conn || !run || !sta || !ap) return
    let alive = true
    setLoading(true)
    api
      .logWindow(run, [ap.id, sta.id], conn.t_start - (early ? 6 : 0.06), conn.t_end + 0.35)
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
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [conn?.t_start, conn?.t_end, run, early, sta?.id, ap?.id])

  const steps = STEPS.filter((s) => !s.modes || (mode && s.modes.includes(mode)))
  const tagged = useMemo(
    () =>
      lines.map((l) => {
        const hit = steps.find((s) => s.re.test(l.text))
        return { ...l, step: hit?.id ?? null, noise: NOISE.test(l.text) }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, mode],
  )
  const shown = tagged.filter((l) => (everything || (l.step && !l.noise)) && !hidden.has(l.node) && (!step || l.step === step))
  const counts = Object.fromEntries(steps.map((s) => [s.id, tagged.filter((l) => l.step === s.id && (everything || !l.noise)).length]))

  const facts = useMemo(() => {
    const onSta = lines.filter((l) => l.node === sta?.id)
    const onAp = lines.filter((l) => l.node === ap?.id)
    const grab = (src: LogLine[], re: RegExp) => {
      for (const l of src) {
        const m = re.exec(l.text)
        if (m) return { line: l, m }
      }
      return null
    }
    return {
      keyMgmt: grab(onSta, /RSN: using KEY_MGMT (\S+)/)?.m[1] ?? null,
      mfp: grab(onSta, /Selected AP supports MFP: (.+)/)?.m[1] ?? null,
      cached: grab(onSta, /^(?!.*No PMKSA).*PMKSA cache entry found/),
      saeGroup: grab(onSta, /Selected SAE group (\d+)/)?.m[1] ?? null,
      saeStart: grab(onAp, /start SAE authentication/)?.line ?? null,
      saeDone: grab(onAp, /State Confirmed -> Accepted/)?.line ?? null,
      oweGroup: grab(onSta, /OWE: Try to use group (\d+)/)?.m[1] ?? null,
      apDone: grab(onAp, /pairwise key handshake completed/)?.line ?? null,
      staDone: grab(onSta, /Key negotiation completed.*\[(PTK=\S+ GTK=\S+)\]/)?.m[1] ?? null,
      connected: grab(onSta, /CTRL-EVENT-CONNECTED/)?.line ?? null,
    }
  }, [lines, sta?.id, ap?.id])

  if (!sta || !ap) return <div className="empty">This lab needs one access point and one client.</div>
  if (conns.length === 0)
    return <div className="empty">No connection yet. Start the lab: the client connects by itself, and its log lines and the access point&apos;s appear here, step by step.</div>

  const nodeColor = (id: string) => (id === ap.id ? apColor(topo.nodes, id) : '#0f172a')
  const info = mode ? SECURITY_INFO[mode] : null

  return (
    <div className="roamlogs">
      <div className="log-tools">
        <select value={idx} onChange={(e) => setPicked(Number(e.target.value))} aria-label="Connection">
          {conns.map((c, i) => (
            <option key={c.t_start} value={i}>
              {i === 0 ? 'First connection' : `Reconnection ${i}`} · {new Date(c.t_start * 1000).toLocaleTimeString([], { hour12: false })} · {info?.label} · {fmtMs(c.duration_ms)}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={early} onChange={(e) => setEarly(e.target.checked)} /> Include the scan before it
        </label>
        <label className="check">
          <input type="checkbox" checked={everything} onChange={(e) => setEverything(e.target.checked)} /> Show every log line
        </label>
      </div>

      <div className="ftcard">
        <h4>What the daemons agreed on, from their own logs ({info?.label})</h4>
        <ul className="checks">
          {facts.keyMgmt ? (
            <li className="info">
              wpa_supplicant chose key management <code>{facts.keyMgmt}</code>.
            </li>
          ) : (
            mode === 'open' && <li className="info">No key management was logged: the beacon carries no RSN element, so there are no keys to negotiate.</li>
          )}
          {facts.mfp && (
            <li className={/require/i.test(facts.mfp) && !/not|do not/i.test(facts.mfp) ? 'ok' : 'info'}>
              Protected management frames (PMF): <code>{facts.mfp}</code>.
            </li>
          )}
          {mode === 'wpa3-sae' && facts.cached && <li className="ok">The client found the key in its PMKSA cache and used it instead of a new SAE exchange.</li>}
          {mode === 'wpa3-sae' && !facts.cached && facts.saeGroup && (
            <li className="info">
              No cached key, so a full SAE exchange ran on curve group <code>{facts.saeGroup}</code> (NIST P-256).
              {facts.saeStart && facts.saeDone ? ` The AP spent ${((facts.saeDone.t - facts.saeStart.t) * 1000).toFixed(1)} ms from the first commit to accepting the confirm.` : ''}
            </li>
          )}
          {mode === 'owe' && facts.oweGroup && (
            <li className="info">
              Diffie-Hellman on group <code>{facts.oweGroup}</code> (NIST P-256) inside the association; no password involved.
            </li>
          )}
          {facts.apDone && (
            <li className="ok">
              hostapd logged <code>pairwise key handshake completed (RSN)</code>
              {facts.staDone ? `, and wpa_supplicant logged the same as ${facts.staDone}.` : '.'}
            </li>
          )}
          {mode === 'open' && facts.connected === null && lines.some((l) => /AP-STA-CONNECTED/.test(l.text)) && (
            <li className="info">hostapd logged AP-STA-CONNECTED straight after association: no handshake, no keys, data in plain text.</li>
          )}
          {lines.length === 0 && !loading && <li className="info">No log lines in this window.</li>}
        </ul>
      </div>

      <div className="rl-body">
        <ol className="rl-steps">
          <li>
            <button className={!step ? 'on' : ''} onClick={() => setStep(null)}>
              All steps <small>{tagged.filter((l) => l.step && (everything || !l.noise)).length} lines</small>
            </button>
          </li>
          {steps.map((s, i) => (
            <li key={s.id}>
              <button className={step === s.id ? 'on' : ''} disabled={!counts[s.id]} onClick={() => setStep(step === s.id ? null : s.id)}>
                <b>{i + 1}</b> {s.title} <small>{counts[s.id]} lines</small>
              </button>
              {step === s.id && <p>{s.why(mode)}</p>}
            </li>
          ))}
        </ol>
        <div className="rl-main">
          <div className="term-cmds">
            {[sta.id, ap.id].map((id) => (
              <button key={id} className={`chipbtn${hidden.has(id) ? '' : ' on'}`} onClick={() => setHidden((h) => { const n = new Set(h); if (!n.delete(id)) n.add(id); return n })} style={{ borderColor: nodeColor(id) }}>
                <i style={{ background: nodeColor(id) }} />
                {id}
                <small>{kindOf(id)}</small>
              </button>
            ))}
          </div>
          {step && <p className="rl-why">{steps.find((s) => s.id === step)?.why(mode)}</p>}
          <div className="logbox rl-log">
            {loading && lines.length === 0 ? (
              <div className="term-dim">Reading the logs...</div>
            ) : error ? (
              <div className="term-dim">{error}</div>
            ) : shown.length === 0 ? (
              <div className="term-dim">No log lines in this window.</div>
            ) : (
              shown.slice(0, 1500).map((l, i) => (
                <div key={i} className={`rl-row${/hexdump/.test(l.text) || l.noise ? ' dim' : ''}`}>
                  <span className="rl-t">{`${l.t >= t0 ? '+' : '-'}${Math.abs((l.t - t0) * 1000).toFixed(1)} ms`}</span>
                  <span className="rl-n" style={{ color: nodeColor(l.node) === '#0f172a' ? '#e2e8f0' : nodeColor(l.node) }}>{l.node}</span>
                  {l.step && <span className="rl-s">{steps.findIndex((s) => s.id === l.step) + 1}</span>}
                  <span className="rl-x" title={l.text}>{l.text}</span>
                </div>
              ))
            )}
          </div>
          <div className="log-foot">Times are relative to the first Authentication frame of the connection. Lines come from the daemons&apos; own debug logs ({ap.id}.log and {sta.id}.log) and include key material.</div>
        </div>
      </div>
    </div>
  )
}
