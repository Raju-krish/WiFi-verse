import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { fmtMs } from '../model'
import { setState, useStore } from '../store'
import type { FtConfig, Roam } from '../types'
import { FtTable } from './RoamLogs'

// ---- small diagrams ---------------------------------------------------------------------------------------------

export interface Msg {
  from: number
  to: number
  label: string
  note?: string
  color?: string
}

export function Sequence({ lanes, msgs }: { lanes: string[]; msgs: Msg[] }) {
  const W = 760
  const rowH = 50
  const top = 44
  const H = top + msgs.length * rowH + 10
  const x = (i: number) => (lanes.length === 2 ? [130, W - 130][i] : 90 + (i * (W - 180)) / (lanes.length - 1))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ladder" role="img" aria-label="Message sequence">
      {lanes.map((name, i) => (
        <g key={name}>
          <rect x={x(i) - 56} y={6} width={112} height={26} rx={13} fill="#fff" stroke="#cbd5e1" />
          <text x={x(i)} y={23} textAnchor="middle" fontSize="12" fontWeight="700" fill="#0f172a">
            {name}
          </text>
          <line x1={x(i)} x2={x(i)} y1={36} y2={H - 6} stroke="#cbd5e1" strokeDasharray="4 4" />
        </g>
      ))}
      {msgs.map((m, i) => {
        const y = top + i * rowH + 26
        const a = x(m.from)
        const b = x(m.to)
        const dir = b > a ? 1 : -1
        const color = m.color ?? '#2563eb'
        return (
          <g key={i}>
            <line x1={a} x2={b - dir * 8} y1={y} y2={y} stroke={color} strokeWidth="2.2" />
            <path d={`M${b},${y} l${-dir * 9},-5 l0,10 z`} fill={color} />
            <text x={(a + b) / 2} y={y - 7} textAnchor="middle" fontSize="12" fontWeight="700" fill={color}>
              {m.label}
            </text>
            {m.note && (
              <text x={(a + b) / 2} y={y + 15} textAnchor="middle" fontSize="10.5" fill="#64748b">
                {m.note}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export interface Link {
  name: string
  how?: string
  detail: ReactNode
  holder: string
}

export function Chain({ items }: { items: Link[] }) {
  return (
    <div className="chain">
      {items.map((it) => (
        <div key={it.name}>
          {it.how && <div className="chain-arrow">↓ {it.how}</div>}
          <div className="chain-box">
            <b>{it.name}</b>
            <span>{it.detail}</span>
            <em>{it.holder}</em>
          </div>
        </div>
      ))}
    </div>
  )
}

export const Term = ({ children }: { children: ReactNode }) => <code className="term-chip">{children}</code>

// ---- live numbers -----------------------------------------------------------------------------------------------

function Measured() {
  const roams = useStore((s) => s.roams)
  const compare = useStore((s) => s.compare.runs)
  const all = new Map<number, Roam>()
  for (const r of [...roams, ...compare.map((c) => c.roam)]) if (r.handoff_ms !== undefined && !r.error) all.set(r.t, r)
  const summary = (mode: string) => {
    const list = [...all.values()].filter((r) => r.mode === mode)
    if (!list.length) return null
    return { ms: list.reduce((a, r) => a + (r.handoff_ms ?? 0), 0) / list.length, n: list.length, eapol: list.reduce((a, r) => a + (r.eapol ?? 0), 0) / list.length }
  }
  const ft = summary('ft-psk')
  const psk = summary('wpa2-psk')
  return (
    <div className="measured-box">
      <b>Measured in your lab</b>
      <span>{ft ? `FT: ${fmtMs(ft.ms)} on average over ${ft.n} roam${ft.n > 1 ? 's' : ''}, ${ft.eapol.toFixed(0)} EAPOL frames.` : 'FT: no roam measured yet.'}</span>
      <span>{psk ? `WPA2-PSK: ${fmtMs(psk.ms)} on average over ${psk.n} roam${psk.n > 1 ? 's' : ''}, ${psk.eapol.toFixed(0)} EAPOL frames.` : 'WPA2-PSK: no roam measured yet.'}</span>
      {!(ft && psk) && (
        <button className="btn small" onClick={() => go('compare')}>
          Measure both with the comparison
        </button>
      )}
    </div>
  )
}

export const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
export const showFilter = (expr: string) => setState((s) => ({ pendingFilter: { expr, n: (s.pendingFilter?.n ?? 0) + 1 } }))
export const openTab = (tab: 'terminal' | 'logs' | 'roam') => setState((s) => ({ pendingTab: { tab, n: (s.pendingTab?.n ?? 0) + 1 } }))

export function TryIt({ children }: { children: ReactNode }) {
  return (
    <div className="tryit">
      <b>See it in your lab</b>
      <div>{children}</div>
    </div>
  )
}

// ---- chapters ---------------------------------------------------------------------------------------------------

export interface Chapter {
  title: string
  body: () => ReactNode
}

const CHAPTERS: Chapter[] = [
  {
    title: 'Why Wi-Fi needs keys',
    body: () => (
      <>
        <p>
          Wi-Fi is radio. Every frame an access point (AP) or a laptop sends goes out through the air in all directions, like speaking in a crowded room. Anyone in range with a receiver can record all of it. That is exactly what the <b>sniffer</b> in this lab does.
        </p>
        <p>
          The answer is <b>encryption</b>: scramble every frame so a recording is useless without a secret <b>key</b>. Both the client and the AP must hold the same key. But they cannot simply send it to each other, because whoever is listening would get it too.
        </p>
        <p>
          So Wi-Fi never sends the key. Both sides <b>calculate</b> it from two things: a secret they already share (the Wi-Fi password) and some random numbers they do swap in the open. An eavesdropper sees the random numbers but not the password, so cannot calculate the key.
        </p>
        <ul>
          <li>Open network: no key, every frame readable by anyone.</li>
          <li>WPA2-PSK: one shared password, a different key is calculated for every connection.</li>
          <li>Everything else in this lab (the 4-way handshake, fast roaming, the key holders) exists to do that calculation safely and quickly.</li>
        </ul>
        <TryIt>
          <button className="btn small" onClick={() => go('capture')}>Open the capture</button> Click a Data frame, then switch the bytes pane between <b>Decrypted</b> and <b>As heard</b>. As heard is what a sniffer records: scrambled. Decrypted is what the lab shows you because it knows the keys.
        </TryIt>
      </>
    ),
  },
  {
    title: 'The family of keys',
    body: () => (
      <>
        <p>One password turns into several keys, each with its own job. Learn these names; every later chapter uses them.</p>
        <Chain
          items={[
            { name: 'Passphrase', detail: 'The Wi-Fi password you type (here: labpassword123).', holder: 'Known to the client and to every AP' },
            { name: 'PMK, pairwise master key', how: 'scramble with the network name (SSID), 4096 rounds', detail: 'A 256-bit number. The same on the client and the AP, every time. It is never sent over the air and never used directly to encrypt data.', holder: 'Client and AP' },
            { name: 'PTK, pairwise transient key', how: 'mix in two random numbers (ANonce, SNonce) and both MAC addresses', detail: 'The session key. Brand new for every connection, so recording one session does not help with the next. It is split into three parts, below.', holder: 'This client and this AP only' },
          ]}
        />
        <div className="three">
          <div>
            <b>KCK</b>
            <span>Key confirmation key. Signs handshake messages (the MIC) to prove the sender knows the key.</span>
          </div>
          <div>
            <b>KEK</b>
            <span>Key encryption key. Wraps other keys when they have to be delivered, for example the group key.</span>
          </div>
          <div>
            <b>TK</b>
            <span>Temporal key. The one that actually encrypts your data frames (AES-CCMP).</span>
          </div>
        </div>
        <p>
          One more key is shared on purpose: the <b>GTK</b>, the group temporal key. The AP creates it and gives the same one to every client, so it can send a single encrypted broadcast or multicast frame that everyone can read.
        </p>
        <TryIt>
          <button className="btn small" onClick={() => { go('console'); openTab('terminal') }}>Open the terminal</button> Press <b>Check keys</b>. It shows, for each client, the TK and GTK the AP and the client both installed. Only the first and last characters are shown.
        </TryIt>
      </>
    ),
  },
  {
    title: 'Connecting: the 4-way handshake',
    body: () => (
      <>
        <p>
          When a client joins a WPA2 network it first does two simple steps (authentication and association, which carry no secrets), then the <b>4-way handshake</b> to create the PTK. The four messages travel in frames called <b>EAPOL</b> (EAP over LAN).
        </p>
        <Sequence
          lanes={['Client', 'Access point']}
          msgs={[
            { from: 0, to: 1, label: 'Authentication (open)', note: 'no keys yet', color: '#64748b' },
            { from: 0, to: 1, label: 'Association request', note: 'says which security it wants', color: '#64748b' },
            { from: 1, to: 0, label: 'EAPOL message 1', note: 'sends ANonce (a random number)', color: '#d97706' },
            { from: 0, to: 1, label: 'EAPOL message 2', note: 'sends SNonce; client can now calculate the PTK; MIC proves it knows the PMK', color: '#d97706' },
            { from: 1, to: 0, label: 'EAPOL message 3', note: 'AP calculated the same PTK; delivers the GTK, wrapped with the KEK', color: '#d97706' },
            { from: 0, to: 1, label: 'EAPOL message 4', note: 'confirms; both install the TK and start encrypting', color: '#d97706' },
          ]}
        />
        <p>
          Why four? Each side contributes a random number so the PTK is fresh. Each side proves it knows the PMK without revealing it (the MIC). The AP delivers the GTK. And both sides must switch to the new key at the same moment. That takes a round trip each way, twice.
        </p>
        <TryIt>
          <button className="btn small" onClick={() => showFilter('eapol')}>Show only EAPOL in the capture</button> You will see messages 1 to 4 right after the association. Click each one to see the nonce and MIC fields in the details.
        </TryIt>
      </>
    ),
  },
  {
    title: 'Why roaming hurts without FT',
    body: () => (
      <>
        <p>
          Walk with your phone from one AP to another AP of the same network. Same SSID, same password, so the <b>PMK is the same</b>. But the PTK is tied to one client <i>and one AP</i> (their MAC addresses go into the calculation), and it is fresh for every connection. The new AP has no PTK for you.
        </p>
        <p>So the client has to join the new AP from scratch, including the whole 4-way handshake:</p>
        <Sequence
          lanes={['Client', 'New AP']}
          msgs={[
            { from: 0, to: 1, label: 'Authentication', color: '#64748b' },
            { from: 1, to: 0, label: 'Authentication response', color: '#64748b' },
            { from: 0, to: 1, label: 'Reassociation request', color: '#64748b' },
            { from: 1, to: 0, label: 'Reassociation response', color: '#64748b' },
            { from: 1, to: 0, label: 'EAPOL 1', color: '#d97706' },
            { from: 0, to: 1, label: 'EAPOL 2', color: '#d97706' },
            { from: 1, to: 0, label: 'EAPOL 3', color: '#d97706' },
            { from: 0, to: 1, label: 'EAPOL 4', color: '#d97706' },
          ]}
        />
        <p>
          Eight frames, and no user data can flow until the last one. In a lab with no real radio contention this takes a few milliseconds. On a busy real network each frame can be delayed or lost and resent, which is why a roam can stall a video call for a noticeable moment.
        </p>
        <p>
          In a company network (WPA2-Enterprise, 802.1X) it is much worse: before the 4-way handshake the client also has to log in again through a RADIUS server, which can add hundreds of milliseconds or seconds. That is what fast roaming was invented to avoid.
        </p>
        <Measured />
      </>
    ),
  },
  {
    title: 'The idea of Fast Transition (802.11r)',
    body: () => (
      <>
        <p>
          Fast Transition (FT, 802.11r) removes the separate handshake. Two ideas:
        </p>
        <ol>
          <li>
            <b>Do the key negotiation inside the frames you must send anyway.</b> The nonces travel in the Authentication frames, and the proof (the MIC) in the Reassociation frames. The 4 EAPOL messages disappear.
          </li>
          <li>
            <b>Let the new AP get its key before the client arrives.</b> A key hierarchy with two levels (next chapters) lets the new AP have, or work out, a key tied to this client without asking a RADIUS server or running a login again.
          </li>
        </ol>
        <Sequence
          lanes={['Client', 'New AP']}
          msgs={[
            { from: 0, to: 1, label: 'FT Authentication request', note: 'SNonce, which key holder it knew, name of the key it wants', color: '#059669' },
            { from: 1, to: 0, label: 'FT Authentication response', note: 'ANonce, its own key-holder ID. Both can now calculate the PTK', color: '#059669' },
            { from: 0, to: 1, label: 'Reassociation request', note: 'signed with the new KCK (MIC): proves the client has the key', color: '#2563eb' },
            { from: 1, to: 0, label: 'Reassociation response', note: 'signed, and carries the GTK wrapped with the KEK. Done', color: '#2563eb' },
          ]}
        />
        <p>
          Four frames instead of eight, no EAPOL at all, and in an enterprise network no RADIUS round trip. Data flows as soon as the Reassociation response arrives.
        </p>
        <Measured />
        <TryIt>
          <button className="btn small" onClick={() => showFilter('wlan.fixed.auth.alg == 2 || wlan.fc.type_subtype in {2,3}')}>Show the FT frames in the capture</button> After a roam you will find the FT Authentication pair and the Reassociation pair, and <b>no EAPOL</b> after them.
        </TryIt>
      </>
    ),
  },
  {
    title: 'FT keys and the R0KH, R1KH, S0KH, S1KH names',
    body: function Body() {
      return <KeyHolders />
    },
  },
  {
    title: 'How does the new AP get the key? Pull, push or local',
    body: () => (
      <>
        <p>
          The new AP needs a PMK-R1 for this client. Where does it come from? Three designs, and they differ in what the APs say to each other. All of that talk travels over the <b>wired side</b> (the distribution system), never over the air.
        </p>
        <div className="three">
          <div>
            <b>Pull</b>
            <span>
              The new AP (R1KH) is asked about a client it has no key for. It sends a <b>PMK-R1 request</b> to the R0KH named in the client&apos;s frame, and the R0KH answers with the key. Nothing is prepared in advance; the request happens in the middle of the roam.
            </span>
          </div>
          <div>
            <b>Push</b>
            <span>
              As soon as a client joins, its R0KH <b>pre-sends</b> a PMK-R1 to every AP that could be a roam target. When the client arrives, the key is already there. Faster roam, but keys are spread to APs the client may never visit.
            </span>
          </div>
          <div>
            <b>Local generation (FT-PSK)</b>
            <span>
              Every AP knows the passphrase, so every AP can compute PMK-R0 and PMK-R1 itself. <b>No messages between APs at all.</b> Simple, but only possible with a shared password, not with 802.1X.
            </span>
          </div>
        </div>
        <p>
          <b>The lab default is local generation</b> (<Term>ft_psk_generate_local=1</Term>), so you see no push or pull unless you choose it. In pull and push modes each AP is configured with <Term>r0kh=</Term> and <Term>r1kh=</Term> lines naming the other APs and a shared secret that protects their messages. You can switch between all three in the setup section and compare the logs and the roam time.
        </p>
        <p>
          <b>Over the air or over the DS?</b> A separate choice, covered in the next chapter.
        </p>
        <TryIt>
          <button className="btn small" onClick={() => go('setup')}>Choose pull or push</button> then walk the client and
          {' '}<button className="btn small" onClick={() => openTab('roam')}>open the logs of the roam</button>. The tab answers &quot;are the key holders shared?&quot; from the real configuration and logs and shows the pull request, the push, or the line <Term>FT: Generated PMK-R1 for FT-PSK locally</Term>.
        </TryIt>
      </>
    ),
  },
  {
    title: 'Over the air or over the DS',
    body: () => (
      <>
        <p>
          The second FT choice is <b>who the client talks to</b> when it starts a move. Both end with the same Reassociation to the new AP.
        </p>
        <div className="three two">
          <div>
            <b>Over the air</b>
            <span>The client sends the FT Authentication straight to the new AP, on the new AP&apos;s channel. Simple. It needs the client to hear the new AP well enough to talk to it before it has left the old one.</span>
          </div>
          <div>
            <b>Over the DS (distribution system)</b>
            <span>The client keeps talking to its current AP on the channel it is already on. That AP forwards the request over the wired network to the new AP and returns the answer. Useful when the new AP is on another channel or hard to reach, because the client does not leave the old AP until the keys are ready.</span>
          </div>
        </div>
        <Sequence
          lanes={['Client', 'Old AP', 'New AP']}
          msgs={[
            { from: 0, to: 1, label: 'FT Action request', note: 'on the air: names the target AP, carries SNonce and key names', color: '#059669' },
            { from: 1, to: 2, label: 'relayed over the wired network (RRB)', note: 'not on the air', color: '#64748b' },
            { from: 2, to: 1, label: 'answer: ANonce, R1KH-ID', note: 'the new AP derives or fetches PMK-R1 here', color: '#64748b' },
            { from: 1, to: 0, label: 'FT Action response', note: 'on the air: the client can now calculate the PTK', color: '#059669' },
            { from: 0, to: 2, label: 'Reassociation request (MIC)', note: 'only now does the client move', color: '#2563eb' },
            { from: 2, to: 0, label: 'Reassociation response (MIC, GTK)', color: '#2563eb' },
          ]}
        />
        <p>
          Same keys, same result, two fewer frames to the new AP over the air, but one more hop on the wire. In this lab it can even take a little longer, because the extra relay and the client&apos;s own handling add time. What you gain in the real world is reach and a smoother handover, not necessarily speed.
        </p>
        <p>
          <b>A detail of this lab:</b> wpa_supplicant never chooses over-the-DS on its own, it only does it when told with the <Term>FT_DS</Term> command. So in over-the-DS mode the lab plays the client driver: when the signal falls below the roam trigger it scans and, like bgscan, moves only to an AP at least 5 dB stronger, by sending <Term>FT_DS</Term>. The frames and keys are the real ones.
        </p>
        <TryIt>
          <button className="btn small" onClick={() => go('setup')}>Choose over the DS</button> then walk the client. In the capture the roam now contains <b>FT Action</b> frames to the old AP and no Authentication to the new AP;
          {' '}<button className="btn small" onClick={() => showFilter('wlan.fixed.category_code == 6')}>show the FT Action frames</button>.
        </TryIt>
      </>
    ),
  },
  {
    title: 'End to end: one FT roam, step by step',
    body: () => (
      <>
        <p>Follow one roam from the first sign of trouble to encrypted data again. Each step names the keys that exist at that moment.</p>
        <ol className="steps">
          <li>
            <b>Signal drops.</b> The client (wpa_supplicant) measures its signal. Below the roam trigger it scans for other APs of the same SSID. It moves only if another AP is clearly stronger (5 dB or more), to avoid bouncing. <em>Keys: it still has its PTK for the old AP.</em>
          </li>
          <li>
            <b>Client picks the new AP</b> and sees the same mobility domain in its beacon. It still holds PMK-R0 from its first join. <em>The mobility domain is what says &quot;FT is allowed between these APs&quot;.</em>
          </li>
          <li>
            <b>FT Authentication request.</b> The client sends a fresh SNonce, the R0KH-ID it learned (the old AP&apos;s name) and the PMKR0Name, the label of the key it wants used.
          </li>
          <li>
            <b>New AP gets PMK-R1.</b> In this lab it computes PMK-R0 from the passphrase and the details the client quoted, then PMK-R1 for its own R1KH-ID. The name it gets equals the PMKR0Name the client asked for, which proves it holds the right key. <em>No message to any other AP.</em>
          </li>
          <li>
            <b>Both sides calculate the PTK</b> from PMK-R1, SNonce, the new AP&apos;s ANonce, the AP address and the client address. KCK, KEK and TK come out.
          </li>
          <li>
            <b>FT Authentication response</b> carries the ANonce and the AP&apos;s R1KH-ID. The client now calculates the same PMK-R1 and PTK.
          </li>
          <li>
            <b>Reassociation request and response.</b> Each carries a MIC made with the KCK. This is the mutual proof that replaces EAPOL messages 2 to 4. The response also delivers the GTK wrapped with the KEK.
          </li>
          <li>
            <b>Keys installed.</b> Both sides give the TK and GTK to the radio driver and open the port. Encrypted data flows again, a handful of milliseconds after the first frame.
          </li>
        </ol>
        <TryIt>
          <button className="btn small" onClick={() => openTab('roam')}>Open the logs of a roam</button> The same eight steps, with the real hostapd and wpa_supplicant lines for each, so you can match this list to what the daemons logged.{' '}
          <button className="btn small" onClick={() => go('roams')}>Open the frame ladder</button>
        </TryIt>
      </>
    ),
  },
  {
    title: 'Cheat sheet',
    body: () => (
      <table className="glossary">
        <tbody>
          {[
            ['PSK / passphrase', 'The shared Wi-Fi password.'],
            ['SSID', 'The network name. Goes into the PMK calculation.'],
            ['PMK', 'Master key, the same on both sides, calculated from the password and SSID. Never sent.'],
            ['PTK', 'Session key for one client on one AP, fresh for each connection. KCK + KEK + TK.'],
            ['KCK / KEK / TK', 'Signs handshake messages / wraps delivered keys / encrypts data.'],
            ['GTK', 'Group key. One per AP, shared by all its clients, for broadcast and multicast.'],
            ['ANonce / SNonce', 'Random numbers from the AP and from the client (supplicant), mixed into the PTK.'],
            ['MIC', 'Message integrity code: a signature made with the KCK. Proves the sender knows the key.'],
            ['EAPOL', 'The frames that carry the 4-way handshake.'],
            ['Mobility domain (MDID)', 'The group of APs between which FT is allowed. Same SSID plus same 2-byte ID.'],
            ['PMK-R0', 'First-level FT key, derived from the master key, the SSID, the mobility domain, the R0KH-ID and the client address.'],
            ['PMK-R1', 'Second-level FT key, one per AP, derived from PMK-R0, the R1KH-ID and the client address.'],
            ['R0KH / R0KH-ID', 'The key holder of PMK-R0 on the network side. Its ID is a name (here the NAS identifier, e.g. ap1.lab).'],
            ['R1KH / R1KH-ID', 'The key holder of PMK-R1, one per AP. Its ID is the AP MAC address.'],
            ['S0KH / S1KH', 'The client-side holders of PMK-R0 and PMK-R1. Their ID is the client MAC address.'],
            ['PMKR0Name / PMKR1Name', 'Public labels of the keys. They let two sides agree on which key they mean without showing it.'],
            ['Pull / push', 'The two ways an AP can obtain PMK-R1 from the R0KH. Not needed with local generation.'],
            ['r0kh= / r1kh=', 'hostapd settings that list the other APs as key holders, with the shared secret that protects the pull and push messages.'],
            ['RRB', 'Remote request broker: the AP-to-AP messages over the wired network that carry pull, push and over-the-DS relays.'],
            ['Over the air / over the DS', 'Whether the client sends its FT request straight to the new AP, or to its current AP, which relays it over the wired network.'],
            ['FT Action frame', 'The management frame (category 6) a client uses to start an over-the-DS transition.'],
            ['FTE / MDE', 'The information elements in FT frames: FT element (nonces, key-holder IDs, MIC) and mobility domain element.'],
          ].map(([term, text]) => (
            <tr key={term}>
              <th>{term}</th>
              <td>{text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
  },
]

function KeyHolders() {
  const runDir = useStore((s) => s.lab.runDir)
  const run = runDir?.split('/').pop() ?? null
  const [ft, setFt] = useState<FtConfig | null>(null)
  useEffect(() => {
    if (run) api.ftConfig(run).then(setFt).catch(() => setFt(null))
  }, [run])
  return (
    <>
      <p>
        FT adds two levels under the master key. Think of a hotel: the <b>front desk</b> keeps a master card, and gives each floor a card that only works on that floor. Losing a floor card exposes one floor, not the building.
      </p>
      <Chain
        items={[
          { name: 'Master key (the PMK, or XXKey)', detail: 'From the password in FT-PSK; from the RADIUS login in enterprise networks.', holder: 'Client and the network' },
          {
            name: 'PMK-R0',
            how: 'KDF of master key + SSID + mobility domain + R0KH-ID + S0KH-ID',
            detail: 'Created once, when the client first joins the mobility domain. It does not leave its holder.',
            holder: 'Network side: the R0KH. Client side: the S0KH',
          },
          {
            name: 'PMK-R1 (one per AP)',
            how: 'KDF of PMK-R0 + R1KH-ID + S1KH-ID',
            detail: 'A different key for every AP the client visits. A compromised AP exposes only its own PMK-R1.',
            holder: 'Network side: the R1KH, one per AP. Client side: the S1KH',
          },
          { name: 'PTK', how: 'KDF of PMK-R1 + ANonce + SNonce + AP address + client address', detail: 'The session key, split into KCK, KEK and TK, as in chapter 2.', holder: 'This client and this AP' },
        ]}
      />
      <table className="glossary">
        <thead>
          <tr>
            <th>Name</th>
            <th>What it is</th>
            <th>Its ID</th>
            <th>In this lab</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>R0KH</th>
            <td>Holds PMK-R0 on the network side.</td>
            <td>A name (the NAS identifier)</td>
            <td>ap1.lab, ap2.lab ...</td>
          </tr>
          <tr>
            <th>R1KH</th>
            <td>Holds PMK-R1. One per AP; the AP that serves the client.</td>
            <td>The AP&apos;s MAC address</td>
            <td>02:00:00:00:00:00 ...</td>
          </tr>
          <tr>
            <th>S0KH</th>
            <td>The client&apos;s own copy and role for PMK-R0.</td>
            <td>The client&apos;s MAC address</td>
            <td>sta1&apos;s MAC</td>
          </tr>
          <tr>
            <th>S1KH</th>
            <td>The client&apos;s own copy and role for PMK-R1.</td>
            <td>The client&apos;s MAC address</td>
            <td>sta1&apos;s MAC</td>
          </tr>
        </tbody>
      </table>
      <p>
        The &quot;S&quot; ones are the <b>supplicant</b> (client) side; the &quot;R&quot; ones the <b>authenticator</b> (network) side. Their IDs go into the calculation, which is why a PMK-R1 made for one AP is useless on another. The <b>mobility domain</b> (a 2-byte ID, 4f57 here) is the label that says these APs belong together.
      </p>
      <p>
        When the client roams it quotes the R0KH-ID it knows. The new AP does not need to <i>be</i> that holder: it only needs to be able to get PMK-R1 for it (chapter 7).
      </p>
      {ft?.ft && (
        <>
          <b>The key-holder settings of your lab</b>
          <FtTable ft={ft} />
        </>
      )}
      <TryIt>
        <button className="btn small" onClick={() => openTab('roam')}>Open the logs of a roam</button> Step 4 lists <Term>R0KH-ID</Term>, <Term>R1KH-ID</Term>, <Term>S0KH-ID</Term> and <Term>S1KH-ID</Term> as hostapd logged them while deriving the keys.
      </TryIt>
    </>
  )
}

// ---- the section ------------------------------------------------------------------------------------------------

export function Learn() {
  return <Chapters chapters={CHAPTERS} storageKey="wifilab.learn" finish={{ label: 'Now build a network', target: 'build' }} />
}

export function Chapters({ chapters, storageKey, finish }: { chapters: Chapter[]; storageKey: string; finish: { label: string; target: string } }) {
  const CHAPTERS = chapters
  const [idx, setIdx] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return Number.isInteger(saved) && saved >= 0 && saved < CHAPTERS.length ? saved : 0
  })
  useEffect(() => {
    localStorage.setItem(storageKey, String(idx))
  }, [idx, storageKey])
  const chapter = CHAPTERS[idx]
  const Body = chapter.body

  return (
    <div className="learn">
      <ol className="learn-nav">
        {CHAPTERS.map((c, i) => (
          <li key={c.title}>
            <button className={i === idx ? 'on' : i < idx ? 'done' : ''} onClick={() => setIdx(i)}>
              <b>{i + 1}</b>
              <span>{c.title}</span>
            </button>
          </li>
        ))}
      </ol>
      <article className="learn-body">
        <h3>
          <span>Chapter {idx + 1} of {CHAPTERS.length}</span>
          {chapter.title}
        </h3>
        <Body />
        <div className="learn-foot">
          <button className="btn" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>
            ← Previous
          </button>
          {idx < CHAPTERS.length - 1 ? (
            <button className="btn primary" onClick={() => setIdx(idx + 1)}>
              Next: {CHAPTERS[idx + 1].title} →
            </button>
          ) : (
            <button className="btn primary" onClick={() => go(finish.target)}>
              {finish.label} →
            </button>
          )}
        </div>
      </article>
    </div>
  )
}
