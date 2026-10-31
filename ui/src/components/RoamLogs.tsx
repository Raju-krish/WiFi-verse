import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { apColor, fmtMs } from '../model'
import { useStore } from '../store'
import type { FtConfig, LogLine, Roam } from '../types'

interface Step {
  id: string
  title: string
  why: string
  re: RegExp | null
}

// A line starts a step when it matches; unmatched "FT:" lines stay in the step that came before them.
const STEPS: Step[] = [
  {
    id: 'trigger',
    title: 'Signal drops, the client scans',
    why: 'wpa_supplicant (bgscan) sees the signal fall below the roam trigger, scans both channels and compares APs. It only moves when another AP is at least 5 dB stronger.',
    re: /bgscan|SIGNAL-CHANGE|Scan completed|Scan results indicate|Skip roam|Selecting BSS|Request association with/,
  },
  {
    id: 'start',
    title: 'Client starts the FT move',
    why: 'The client sees the mobility domain in the AP beacon, finds no cached key for the new AP and chooses FT. Over the air it sends an Authentication frame (algorithm 2) to the new AP; over the DS it sends an FT Action request to its current AP. Either way it carries a fresh SNonce, the R0KH-ID it already knows and the PMKR0Name.',
    re: /SME: FT mobility|Trying to use FT|SME: Trying to authenticate|using KEY_MGMT|Auth Type 2|Authenticate \(ifindex|Capability and Policy/,
  },
  {
    id: 'relay',
    title: 'Over the DS: the old AP relays the request',
    why: 'Instead of an Authentication frame to the new AP, the client sends an FT Action request to the AP it is already on. That AP forwards it over the wired network (the remote request broker, RRB) to the new AP, which does the key work and sends its answer back the same way. The client then goes straight to Reassociation.',
    re: /FT Action|RRB|FT_DS|Send Action frame/,
  },
  {
    id: 'auth',
    title: 'New AP receives it',
    why: 'hostapd on the target AP parses the FT information elements: mobility domain, RSN element, the client SNonce, the R0KH-ID the client used and the PMKR0Name it asks for.',
    re: /FT: Received authentication frame/,
  },
  {
    id: 'exchange',
    title: 'APs exchange the key (pull or push)',
    why: 'Pull: the new AP sends a PMK-R1 request to the R0KH named by the client and gets the key in the response, in the middle of the roam. Push: the old AP already sent PMK-R1 to the new AP when the client joined, so only the earlier push appears. Each message is protected with the secret the two APs share.',
    re: /PMK-R1 pull|PMK-R1 push|Send PMK-R1|Received PMK-R1|sequence number|Deriving and pushing/,
  },
  {
    id: 'derive',
    title: 'PMK-R0 and PMK-R1 derived',
    why: 'With local generation nobody sends keys: the new AP knows the PSK, the SSID, the mobility domain, the client address and the R0KH-ID the client quoted, so it computes PMK-R0, then PMK-R1 for its own R1KH-ID, and the name matches the PMKR0Name the client asked for. With pull or push the new AP got PMK-R1 from its peer in the previous step instead. The client always derives the same PMK-R1 on its side.',
    re: /Derive PMK-R|Found PSK to generate|Generated PMK-R1/,
  },
  {
    id: 'ptk',
    title: 'Both sides derive the PTK',
    why: 'PTK = KDF(PMK-R1, ANonce, SNonce, both addresses). The AP adds its own ANonce here; the client learns it from the response. KCK, KEK and the temporal key (TK) come out of it.',
    re: /Derive PTK|Generated ANonce|Received SNonce/,
  },
  {
    id: 'resp',
    title: 'Authentication response',
    why: 'The AP answers with status 0 (success), its ANonce and the R1KH-ID. The client now derives PMK-R1 and the PTK too.',
    re: /FT authentication response|SME: Authentication response|authentication OK/,
  },
  {
    id: 'reassoc',
    title: 'Reassociation proves both keys, no 4-way handshake',
    why: 'The Reassociation Request carries a MIC made with the KCK, so the AP knows the client holds the same PTK. The response carries the group key (GTK) protected by the KEK. That replaces the four EAPOL messages of WPA2.',
    re: /ssociat|Reassoc|reassoc|ASSOC/,
  },
  {
    id: 'keys',
    title: 'Keys installed, port opens',
    why: 'Both sides push the pairwise key and the group key into the driver (set_key / KEY_DATA) and mark the port authorized. Data can flow again.',
    re: /set_key|KEY_DATA|AUTHORIZED|authorized|EAPOL-4WAY|CTRL-EVENT-CONNECTED|-> COMPLETED/,
  },
]

const STEP_TEST = STEPS.filter((s) => s.re)

function bytesOf(text: string): number[] | null {
  const m = /hexdump(?:_ascii)?\(len=\d+\): ((?:[0-9a-f]{2} ?)+)/i.exec(text)
  return m ? m[1].trim().split(/\s+/).map((h) => parseInt(h, 16)) : null
}
const hexOf = (text: string) => bytesOf(text)?.map((b) => b.toString(16).padStart(2, '0')).join('') ?? null
const asciiOf = (text: string) => bytesOf(text)?.map((b) => String.fromCharCode(b)).join('') ?? null
const macOf = (text: string) => bytesOf(text)?.map((b) => b.toString(16).padStart(2, '0')).join(':') ?? null

export function RoamLogs() {
  const topo = useStore((s) => s.topo)
  const roams = useStore((s) => s.roams)
  const runDir = useStore((s) => s.lab.runDir)
  const run = runDir?.split('/').pop() ?? null
  const sorted = useMemo(() => [...roams].sort((a, b) => b.t - a.t), [roams])
  const [picked, setPicked] = useState<number | null>(null)
  const roam: Roam | undefined = sorted.find((r) => r.t === picked) ?? sorted[0]
  const [ft, setFt] = useState<FtConfig | null>(null)
  const [lines, setLines] = useState<LogLine[]>([])
  const [pushed, setPushed] = useState<LogLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [early, setEarly] = useState(false)
  const [everything, setEverything] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!run) return
    api.ftConfig(run).then(setFt).catch(() => setFt(null))
  }, [run])

  const tAuth = roam ? (roam.t_auth ?? roam.t) : 0
  const tEnd = roam ? (roam.t_end ?? roam.t) : 0
  useEffect(() => {
    if (!roam || !run) return
    let alive = true
    setLoading(true)
    api
      .logWindow(run, [roam.from, roam.to, roam.sta], tAuth - (early ? 6 : 0.2), tEnd + 0.35)
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
  }, [roam?.t, run, early, tAuth, tEnd])

  // A push happens when the client first joins, long before the roam window, so look for it separately.
  useEffect(() => {
    if (!roam || !run || roam.ft_keys !== 'push') {
      setPushed([])
      return
    }
    let alive = true
    api
      .logWindow(run, [roam.from, roam.to], 0, tAuth, 'PMK-R1 push')
      .then((l) => alive && setPushed(l))
      .catch(() => alive && setPushed([]))
    return () => {
      alive = false
    }
  }, [roam?.t, roam?.ft_keys, run, tAuth])

  const tagged = useMemo(() => {
    const current: Record<string, string | null> = {}
    return lines.map((l) => {
      const hit = STEP_TEST.find((s) => s.re!.test(l.text))
      let id: string | null = hit?.id ?? null
      if (!id && /^FT:/.test(l.text)) id = current[l.node] ?? (l.node === roam?.sta ? 'start' : 'auth')
      if (id) current[l.node] = id
      return { ...l, step: id }
    })
  }, [lines, roam?.sta])

  const shown = tagged.filter((l) => (everything || l.step) && !hidden.has(l.node) && (!step || l.step === step))
  const counts = Object.fromEntries(STEPS.map((s) => [s.id, tagged.filter((l) => l.step === s.id).length]))

  const facts = useMemo(() => {
    if (!roam) return null
    const onTarget = lines.filter((l) => l.node === roam.to)
    const find = (re: RegExp, src = onTarget) => src.find((l) => re.test(l.text))
    const requested = find(/Requested PMKR0Name/)
    const derived = find(/FT: PMKR0Name - hexdump/)
    return {
      clientR0kh: (() => {
        const l = find(/STA R0KH-ID - hexdump/)
        return l ? asciiOf(l.text) : null
      })(),
      r1kh: (() => {
        const l = find(/FT: R1KH-ID - hexdump/)
        return l ? macOf(l.text) : null
      })(),
      requested: requested ? hexOf(requested.text) : null,
      derived: derived ? hexOf(derived.text) : null,
      local: find(/Generated PMK-R1 for FT-PSK locally/),
      pullReq: find(/Send PMK-R1 pull request/),
      pullResp: find(/Received PMK-R1 pull response/),
      relayIn: lines.find((l) => l.node === roam.to && /RRB Action Frame/.test(l.text)),
      pushSent: pushed.find((l) => l.node === roam.from && /Send PMK-R1 push/.test(l.text)),
      pushGot: pushed.find((l) => l.node === roam.to && /Received PMK-R1 push/.test(l.text)),
    }
  }, [lines, pushed, roam])

  if (sorted.length === 0)
    return (
      <div className="empty">
        No roam yet. Start the lab, walk a client towards another AP, and its roam appears here with the log lines of both APs and the client. The key-holder settings are shown below as soon as a lab has run.
        {ft && <FtTable ft={ft} />}
      </div>
    )

  const entries = ft ? ft.aps.reduce((n, a) => n + a.r0kh.length + a.r1kh.length, 0) : 0
  const domains = ft ? new Set(ft.aps.map((a) => a.mobility_domain)) : new Set<string>()
  const nodeColor = (id: string) => (topo.nodes.find((n) => n.id === id)?.kind === 'ap' ? apColor(topo.nodes, id) : '#0f172a')
  const short = (h: string | null) => (h ? `${h.slice(0, 8)}\u2026${h.slice(-4)}` : null)

  return (
    <div className="roamlogs">
      <div className="log-tools">
        <select value={roam?.t ?? ''} onChange={(e) => setPicked(Number(e.target.value))} aria-label="Roam">
          {sorted.map((r) => (
            <option key={r.t} value={r.t}>
              {r.sta}: {r.from} → {r.to} · {new Date(r.t * 1000).toLocaleTimeString([], { hour12: false })} · {r.mode === 'ft-psk' ? `FT ${r.ft_keys ?? 'local'}${r.transition === 'ds' ? ' DS' : ''}` : 'WPA2'} · {fmtMs(r.handoff_ms)}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={early} onChange={(e) => setEarly(e.target.checked)} /> Include the scan that triggered it
        </label>
        <label className="check">
          <input type="checkbox" checked={everything} onChange={(e) => setEverything(e.target.checked)} /> Show every log line
        </label>
      </div>

      <div className="ftcard">
        <h4>Are R0KH and R1KH shared between the APs?</h4>
        {!ft ? (
          <p className="muted">Loading the access point settings...</p>
        ) : !ft.ft ? (
          <p>
            <b>Not applicable.</b> This run used WPA2-PSK, so there are no key holders. Every roam repeats the whole 4-way handshake.
          </p>
        ) : (
          <>
            <p className="verdict-line">
              {roam?.ft_keys === 'pull' ? (
                <>
                  <b>Yes, by pull.</b> {roam.to} asked {roam.from} for PMK-R1 over the wired network while the client was roaming. Each AP lists the other as an <code>r0kh=</code> and <code>r1kh=</code> key holder with a shared secret.
                </>
              ) : roam?.ft_keys === 'push' ? (
                <>
                  <b>Yes, by push.</b> {roam.from} sent PMK-R1 to {roam.to} over the wired network as soon as the client joined, so the key was waiting when the client arrived.
                </>
              ) : entries === 0 ? (
                <>
                  <b>No. Nothing is shared or exchanged between the APs.</b> No AP has an <code>r0kh=</code> or <code>r1kh=</code> entry for another, and <code>ft_psk_generate_local=1</code> makes each AP derive its keys itself from the passphrase.
                </>
              ) : (
                <>
                  <b>Yes, the APs are configured with {entries} r0kh/r1kh entries</b> and can exchange PMK-R1 with each other.
                </>
              )}
            </p>
            <FtTable ft={ft} />
            <ul className="checks">
              <li className={domains.size === 1 ? 'ok' : 'bad'}>{domains.size === 1 ? `All APs are in mobility domain ${[...domains][0]}, the one thing they must have in common.` : 'The APs are in different mobility domains, so FT cannot work between them.'}</li>
              <li className="info">
                {entries === 0
                  ? 'No key-holder tables: the APs have no list of each other to push to or pull from.'
                  : `Each AP lists the others as key holders (${entries} r0kh/r1kh entries) and shares a secret with each of them, which protects the key messages.`}
              </li>
              {facts?.clientR0kh && (
                <li className="info">
                  The client quoted R0KH-ID <code>{facts.clientR0kh}</code> to {roam?.to} (it learned it from {roam?.from}).{' '}
                  {entries === 0 ? `${roam?.to} is not that holder, yet it still answered.` : `${roam?.to} uses its r0kh table to know which AP that name belongs to.`}
                </li>
              )}
              {facts?.requested && facts.derived && (
                <li className={facts.requested === facts.derived ? 'ok' : 'bad'}>
                  {facts.requested === facts.derived
                    ? `The PMKR0Name the client asked for (${short(facts.requested)}) is exactly what ${roam?.to} derived by itself: both sides hold the same PMK-R0 without any exchange.`
                    : 'The PMKR0Name derived by the AP differs from the one the client asked for.'}
                </li>
              )}
              {facts?.r1kh && (
                <li className="info">
                  {roam?.to} used its own R1KH-ID <code>{facts.r1kh}</code> for PMK-R1, so the PMK-R1 is specific to this AP.
                </li>
              )}
              {facts?.local && (
                <li className="ok">
                  hostapd logged <code>FT: Generated PMK-R1 for FT-PSK locally</code>.
                </li>
              )}
              {facts?.pullReq && (
                <li className="ok">
                  {roam?.to} sent a PMK-R1 pull request to {roam?.from}
                  {facts.pullResp ? ` and had the answer ${((facts.pullResp.t - facts.pullReq.t) * 1000).toFixed(1)} ms later` : ''}. This is what makes a pull roam slower than local generation or push.
                </li>
              )}
              {roam?.ft_keys === 'pull' && !facts?.pullReq && lines.length > 0 && <li className="bad">No PMK-R1 pull request was logged for this roam.</li>}
              {facts?.pushSent && (
                <li className="ok">
                  {roam?.from} pushed PMK-R1 to {roam?.to} at {new Date(facts.pushSent.t * 1000).toLocaleTimeString([], { hour12: false })}, {(tAuth - facts.pushSent.t).toFixed(1)} s before the roam{facts.pushGot ? ', and' : '.'}
                  {facts.pushGot ? ` ${roam?.to} logged receiving it.` : ''}
                </li>
              )}
              {roam?.ft_keys === 'push' && !facts?.pushSent && pushed.length === 0 && <li className="info">No push is in the log (the client may have joined before this lab started pushing).</li>}
              {roam?.ft_keys === 'push' && lines.length > 0 && !lines.some((l) => /PMK-R1 pull/.test(l.text)) && <li className="ok">No pull request was needed at roam time: the key was already there.</li>}
              {roam?.ft_keys !== 'pull' && roam?.ft_keys !== 'push' && lines.length > 0 && !lines.some((l) => /PMK-R1 (pull|push)/.test(l.text)) && <li className="ok">No PMK-R1 pull or push appears in the AP logs for this roam.</li>}
              {roam?.transition === 'ds' && (
                <li className="info">
                  Over the DS: the client&apos;s FT Action request went to {roam.from}, which relayed it to {roam.to} over the wired network
                  {facts?.relayIn ? ` (${roam.to} logged the relayed action frame)` : ''}; the answer came back the same way.
                </li>
              )}
            </ul>
          </>
        )}
      </div>

      <div className="rl-body">
        <ol className="rl-steps">
          <li>
            <button className={!step ? 'on' : ''} onClick={() => setStep(null)}>
              All steps <small>{tagged.filter((l) => l.step).length} lines</small>
            </button>
          </li>
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button className={step === s.id ? 'on' : ''} disabled={!counts[s.id]} onClick={() => setStep(step === s.id ? null : s.id)}>
                <b>{i + 1}</b> {s.title} <small>{counts[s.id]} lines</small>
              </button>
              {step === s.id && <p>{s.why}</p>}
            </li>
          ))}
        </ol>
        <div className="rl-main">
          <div className="term-cmds">
            {[roam!.sta, roam!.from, roam!.to].map((id) => (
              <button key={id} className={`chipbtn${hidden.has(id) ? '' : ' on'}`} onClick={() => setHidden((h) => { const n = new Set(h); if (!n.delete(id)) n.add(id); return n })} style={{ borderColor: nodeColor(id) }}>
                <i style={{ background: nodeColor(id) }} />
                {id}
                <small>{id === roam!.sta ? 'wpa_supplicant, client' : id === roam!.from ? 'hostapd, old AP' : 'hostapd, new AP'}</small>
              </button>
            ))}
          </div>
          {step && <p className="rl-why">{STEPS.find((s) => s.id === step)?.why}</p>}
          <div className="logbox rl-log">
            {loading && lines.length === 0 ? (
              <div className="term-dim">Reading the logs...</div>
            ) : error ? (
              <div className="term-dim">{error}</div>
            ) : shown.length === 0 ? (
              <div className="term-dim">No log lines in this window.</div>
            ) : (
              shown.slice(0, 1500).map((l, i) => (
                <div key={i} className={`rl-row${/hexdump/.test(l.text) ? ' dim' : ''}`}>
                  <span className="rl-t">{`${l.t >= tAuth ? '+' : '-'}${Math.abs((l.t - tAuth) * 1000).toFixed(1)} ms`}</span>
                  <span className="rl-n" style={{ color: nodeColor(l.node) === '#0f172a' ? '#e2e8f0' : nodeColor(l.node) }}>{l.node}</span>
                  {l.step && <span className="rl-s">{STEPS.findIndex((s) => s.id === l.step) + 1}</span>}
                  <span className="rl-x" title={l.text}>{l.text}</span>
                </div>
              ))
            )}
          </div>
          <div className="log-foot">Times are relative to the first FT Authentication frame of the roam. Lines come from the daemons' own debug logs ({roam?.from}.log, {roam?.to}.log, {roam?.sta}.log) and include key material.</div>
        </div>
      </div>
    </div>
  )
}

export function FtTable({ ft }: { ft: FtConfig }) {
  if (!ft.ft) return null
  return (
    <table className="fttable">
      <thead>
        <tr>
          <th>AP</th>
          <th title="nas_identifier in hostapd.conf">R0KH-ID</th>
          <th title="r1_key_holder in hostapd.conf">R1KH-ID</th>
          <th>Mobility domain</th>
          <th>r0kh= / r1kh= entries</th>
          <th>Keys generated locally</th>
        </tr>
      </thead>
      <tbody>
        {ft.aps.map((a) => (
          <tr key={a.id}>
            <td>{a.id}</td>
            <td>{a.r0kh_id}</td>
            <td>{a.r1kh_id}</td>
            <td>{a.mobility_domain}</td>
            <td>{a.r0kh.length + a.r1kh.length === 0 ? 'none' : `${a.r0kh.length} / ${a.r1kh.length}`}</td>
            <td>{a.generate_local ? 'yes' : 'no'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
