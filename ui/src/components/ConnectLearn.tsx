import type { ReactNode } from 'react'
import { setSecurity } from '../store'
import type { Security } from '../types'
import { Chain, Chapters, go, Sequence, showFilter, TryIt } from './Learn'
import type { Chapter } from './Learn'

const pick = (mode: Security) => {
  setSecurity(mode)
  go('setup')
}

const Pick = ({ mode, children }: { mode: Security; children: ReactNode }) => (
  <button className="btn small" onClick={() => pick(mode)}>
    {children}
  </button>
)

const AUTH = '#64748b'
const ASSOC = '#2563eb'
const KEY = '#d97706'
const SAE = '#7c3aed'

const CHAPTERS: Chapter[] = [
  {
    title: 'Finding a network',
    body: () => (
      <>
        <p>
          Before anything is secret, the client has to <b>find</b> an access point. An AP announces itself with a <b>beacon</b> about ten times a second: the network name (<b>SSID</b>), the channel, the speeds it supports and, importantly, the <b>security it requires</b>, written in a block called the <b>RSN element</b>. The AP&apos;s own address is the <b>BSSID</b>.
        </p>
        <p>
          A client can also ask: it sends a <b>probe request</b> on each channel and any AP that matches answers with a <b>probe response</b>. That is called active scanning. Listening to beacons is passive scanning.
        </p>
        <Sequence
          lanes={['Client', 'Access point']}
          msgs={[
            { from: 1, to: 0, label: 'Beacon (every ~100 ms)', note: 'SSID, channel, rates, RSN element: which security, which ciphers', color: AUTH },
            { from: 0, to: 1, label: 'Probe request', note: 'is there a network called LabNet here?', color: AUTH },
            { from: 1, to: 0, label: 'Probe response', note: 'same information as a beacon, sent to this client', color: AUTH },
          ]}
        />
        <p>
          The client chooses an AP whose SSID it knows, whose security it can speak, and whose signal is good. Nothing here is encrypted or authenticated: a beacon can be recorded or even faked by anyone, which is why later chapters matter.
        </p>
        <TryIt>
          <button className="btn small" onClick={() => showFilter('wlan.fc.type_subtype == 0x0008')}>Show the beacons</button> Click one and open <b>RSN</b> in the packet details. The <b>AKM suite</b> says which security this AP uses: 2 = WPA2-PSK, 8 = SAE (WPA3), 18 = OWE, and open networks have no RSN element at all.
        </TryIt>
      </>
    ),
  },
  {
    title: 'Authentication and association',
    body: () => (
      <>
        <p>Joining an AP always starts with two short exchanges, whatever the security:</p>
        <Sequence
          lanes={['Client', 'Access point']}
          msgs={[
            { from: 0, to: 1, label: 'Authentication request', note: '"open system": a formality, no password is checked here', color: AUTH },
            { from: 1, to: 0, label: 'Authentication response', note: 'status 0 = success', color: AUTH },
            { from: 0, to: 1, label: 'Association request', note: 'client capabilities and the security it chooses (the RSN element again)', color: ASSOC },
            { from: 1, to: 0, label: 'Association response', note: 'AP accepts and gives the client an association ID', color: ASSOC },
          ]}
        />
        <p>
          <b>Authentication</b> is a historical step. In plain 802.11 it proves nothing; the real security comes after it (or, in WPA3, replaces it: chapter 6). <b>Association</b> is where the client announces which security it will use, and where the AP agrees.
        </p>
        <p>
          After association the client is <i>associated</i> but not yet <i>allowed</i>: in a secured network the AP keeps a closed &quot;port&quot; and only lets the key-exchange frames through until both sides hold keys. Only then does data flow.
        </p>
        <TryIt>
          <button className="btn small" onClick={() => showFilter('wlan.fc.type_subtype in {0x0b,0,1}')}>Show authentication and association</button> Pick any lab mode below and start it: you will see these frames at the beginning of every connection, with the status code in the details.
        </TryIt>
      </>
    ),
  },
  {
    title: 'Open: no security at all',
    body: () => (
      <>
        <p>
          An <b>open</b> network stops after association. There is no password and no key, so there is nothing to protect the data: every frame is sent as plain text over the air.
        </p>
        <Sequence
          lanes={['Client', 'Access point']}
          msgs={[
            { from: 0, to: 1, label: 'Authentication request', color: AUTH },
            { from: 1, to: 0, label: 'Authentication response', color: AUTH },
            { from: 0, to: 1, label: 'Association request', color: ASSOC },
            { from: 1, to: 0, label: 'Association response', note: 'port open immediately, data flows', color: ASSOC },
          ]}
        />
        <p>
          Four frames and the client is connected, the fastest of all modes. The price: anyone with a receiver reads the traffic, and anyone can pose as the AP. That is what the sniffer in a real attack does, and what you can try below.
        </p>
        <TryIt>
          <Pick mode="open">Choose Open</Pick> and start the lab. In the capture, click a Data frame (or ping from the terminal) and look at the bytes: <b>Decrypted</b> and <b>As heard</b> are identical, because nothing was ever encrypted.
        </TryIt>
      </>
    ),
  },
  {
    title: 'OWE: encryption without a password',
    body: () => (
      <>
        <p>
          <b>OWE</b> (Opportunistic Wireless Encryption, sold as &quot;Enhanced Open&quot;) is for networks that have no password, such as a cafe, but should not be readable by the person at the next table.
        </p>
        <p>
          How can two devices that share no secret create a key while someone listens? With a <b>Diffie-Hellman exchange</b>: each side makes a private number and sends only a public number derived from it. Combining your own private number with the other&apos;s public number gives both the <i>same</i> shared secret, which an eavesdropper cannot compute from the public numbers alone. In OWE the two public numbers ride inside the association frames.
        </p>
        <Sequence
          lanes={['Client', 'Access point']}
          msgs={[
            { from: 0, to: 1, label: 'Authentication (open)', color: AUTH },
            { from: 1, to: 0, label: 'Authentication response', color: AUTH },
            { from: 0, to: 1, label: 'Association request + DH public key', note: 'the client\u2019s half of the Diffie-Hellman exchange', color: SAE },
            { from: 1, to: 0, label: 'Association response + DH public key', note: 'both sides now share a secret = the PMK', color: SAE },
            { from: 1, to: 0, label: 'EAPOL 1', note: 'the same 4-way handshake as WPA2 turns the PMK into the PTK', color: KEY },
            { from: 0, to: 1, label: 'EAPOL 2', color: KEY },
            { from: 1, to: 0, label: 'EAPOL 3', color: KEY },
            { from: 0, to: 1, label: 'EAPOL 4', color: KEY },
          ]}
        />
        <p>
          The result: data is encrypted with CCMP, and <b>protected management frames</b> (PMF) are mandatory, so a stranger cannot kick you off with a forged deauthentication. What OWE does <b>not</b> do is prove who the AP is. Anyone can run an AP with the same name and the client will do the same exchange with it, so OWE defends against listening, not against impersonation.
        </p>
        <TryIt>
          <Pick mode="owe">Choose OWE</Pick> and start the lab, then <button className="btn small" onClick={() => showFilter('wlan.ext_tag.number == 32')}>show the frames with the DH key</button>. Open one: the association carries an <b>OWE Diffie-Hellman Parameter</b> element. Data frames are encrypted; the decrypted view works because the lab reads the keys from the daemon logs.
        </TryIt>
      </>
    ),
  },
  {
    title: 'WPA2-Personal: a shared password',
    body: () => (
      <>
        <p>
          <b>WPA2-Personal</b> (WPA2-PSK) uses one password, the <b>pre-shared key</b>, that every user of the network knows. Both sides turn password and SSID into the same <b>PMK</b>, and the <b>4-way handshake</b> (chapter 3 of the 802.11r lessons) creates a fresh session key from it.
        </p>
        <Sequence
          lanes={['Client', 'Access point']}
          msgs={[
            { from: 0, to: 1, label: 'Authentication (open)', color: AUTH },
            { from: 1, to: 0, label: 'Authentication response', color: AUTH },
            { from: 0, to: 1, label: 'Association request', color: ASSOC },
            { from: 1, to: 0, label: 'Association response', note: 'port closed: only EAPOL may pass', color: ASSOC },
            { from: 1, to: 0, label: 'EAPOL 1', note: 'ANonce', color: KEY },
            { from: 0, to: 1, label: 'EAPOL 2', note: 'SNonce + MIC: proves the client knows the PMK', color: KEY },
            { from: 1, to: 0, label: 'EAPOL 3', note: 'GTK, wrapped; install the key', color: KEY },
            { from: 0, to: 1, label: 'EAPOL 4', note: 'done, port opens', color: KEY },
          ]}
        />
        <p>Strengths: simple, universal, encrypted data. Weaknesses worth knowing:</p>
        <ul>
          <li>
            <b>Offline guessing.</b> The handshake contains a MIC made with a key derived from the password. Anyone who records the four frames can try password after password on their own computer until a MIC matches. A weak password falls quickly.
          </li>
          <li>
            <b>No forward secrecy.</b> If the password leaks later, an old recording of a handshake plus traffic can be decrypted.
          </li>
          <li>
            <b>Management frames are not protected</b> unless PMF is switched on, so deauthentication can be forged.
          </li>
        </ul>
        <TryIt>
          <Pick mode="wpa2-psk">Choose WPA2</Pick> and start the lab, then <button className="btn small" onClick={() => showFilter('eapol')}>show the 4 EAPOL frames</button>. Those four frames are all an attacker would need for offline guessing.
        </TryIt>
      </>
    ),
  },
  {
    title: 'WPA3-Personal: SAE',
    body: () => (
      <>
        <p>
          <b>WPA3-Personal</b> keeps the idea of one password but replaces how it is used. The new method is <b>SAE</b> (Simultaneous Authentication of Equals, the &quot;Dragonfly&quot; handshake), and it happens in the <b>Authentication frames</b>, before association.
        </p>
        <p>
          Each side combines the password with its own random number and sends a <b>commit</b> message. Both then calculate the same secret, and a <b>confirm</b> message proves each side got it. A recorded exchange gives an attacker nothing to test password guesses against, so offline guessing is not possible; each guess needs a live exchange with the AP.
        </p>
        <Sequence
          lanes={['Client', 'Access point']}
          msgs={[
            { from: 0, to: 1, label: 'Authentication: SAE commit', note: 'algorithm 3, derived from the password and a random number', color: SAE },
            { from: 1, to: 0, label: 'Authentication: SAE commit', note: 'both commit at the same time: "equals"', color: SAE },
            { from: 0, to: 1, label: 'Authentication: SAE confirm', note: 'proves the client derived the same secret', color: SAE },
            { from: 1, to: 0, label: 'Authentication: SAE confirm', note: 'both sides now hold the PMK', color: SAE },
            { from: 0, to: 1, label: 'Association request', color: ASSOC },
            { from: 1, to: 0, label: 'Association response', color: ASSOC },
            { from: 1, to: 0, label: 'EAPOL 1 to 4', note: 'the 4-way handshake still derives the session key and delivers the GTK', color: KEY },
          ]}
        />
        <ul>
          <li>
            <b>Forward secrecy:</b> every connection uses fresh random numbers, so learning the password later does not decrypt old recordings.
          </li>
          <li>
            <b>PMF is mandatory:</b> forged deauthentication no longer works.
          </li>
          <li>
            <b>Cost:</b> a little more work and four more frames at connection time.
          </li>
        </ul>
        <TryIt>
          <Pick mode="wpa3-sae">Choose WPA3</Pick> and start the lab, then <button className="btn small" onClick={() => showFilter('wlan.fixed.auth.alg == 3')}>show the SAE frames</button>. In the Authentication frame details, the <b>SAE message type</b> and a <b>scalar</b> and <b>finite field element</b> are the commit values.
        </TryIt>
      </>
    ),
  },
  {
    title: 'Reconnecting: the cached key',
    body: () => (
      <>
        <p>
          When a connection succeeds, both sides remember the key they agreed on, together with a short fingerprint of it called the <b>PMKID</b>. This memory is the <b>PMKSA cache</b>. If the client disconnects and comes back, it can offer the PMKID in its association request, and if the AP recognises it, the expensive part is skipped.
        </p>
        <Chain
          items={[
            { name: 'First connection', detail: 'Full exchange: SAE commit and confirm (WPA3), or the Diffie-Hellman exchange (OWE), or just the password-based PMK (WPA2).', holder: 'Client and AP store the PMK and its PMKID' },
            { name: 'Reconnect', how: 'client sends the PMKID in the association request', detail: 'The AP finds it in its cache and reuses the PMK. WPA3 skips the whole SAE exchange: the authentication becomes the plain two-frame open one.', holder: 'No new password exchange' },
          ]}
        />
        <p>
          The 4-way handshake still runs every time, because the session key (PTK) must always be fresh. So the saving is in the part that was expensive: with WPA3 you will see the four SAE frames disappear on the second connection.
        </p>
        <TryIt>
          <Pick mode="wpa3-sae">Choose WPA3</Pick>, start the lab, then press <b>Disconnect and reconnect</b> in the setup section. The connection panel lists both attempts: the first has 4 SAE frames, the second has none.
        </TryIt>
      </>
    ),
  },
  {
    title: 'The four modes side by side',
    body: () => (
      <>
        <table className="glossary">
          <thead>
            <tr>
              <th>Mode</th>
              <th>Password</th>
              <th>Where the key comes from</th>
              <th>Frames to connect</th>
              <th>Management frames protected</th>
              <th>A passive listener</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Open</th>
              <td>none</td>
              <td>no key</td>
              <td>4</td>
              <td>no</td>
              <td>reads everything</td>
            </tr>
            <tr>
              <th>OWE</th>
              <td>none</td>
              <td>Diffie-Hellman in the association</td>
              <td>8 (4 are EAPOL)</td>
              <td>yes</td>
              <td>cannot read data; cannot tell a fake AP</td>
            </tr>
            <tr>
              <th>WPA2-Personal</th>
              <td>shared</td>
              <td>password into PMK, 4-way handshake</td>
              <td>8 (4 are EAPOL)</td>
              <td>only if enabled</td>
              <td>cannot read data, but can guess the password offline from the handshake</td>
            </tr>
            <tr>
              <th>WPA3-Personal</th>
              <td>shared</td>
              <td>SAE, then 4-way handshake</td>
              <td>10 (4 SAE, 4 are EAPOL)</td>
              <td>always</td>
              <td>cannot read data, cannot guess offline, old traffic stays safe</td>
            </tr>
          </tbody>
        </table>
        <p>
          The frame counts are what this lab measures on a first connection. Compare the real times and counts for all four modes in the last section of this page.
        </p>
        <TryIt>
          <button className="btn small" onClick={() => go('compare')}>Run all four modes</button> and read the measured table.
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
            ['SSID / BSSID', 'The network name / the address of one access point.'],
            ['Beacon', 'The AP\u2019s periodic announcement: name, channel, rates, security.'],
            ['Probe request / response', 'The client asking for networks, and an AP answering.'],
            ['RSN element', 'The part of beacons and association frames that lists the security: ciphers and AKM suites.'],
            ['AKM suite', 'The key-management method: 2 = WPA2-PSK, 8 = SAE, 18 = OWE, 4 = FT-PSK.'],
            ['Authentication / Association', 'The two opening exchanges. In WPA3 the authentication carries SAE.'],
            ['PMK', 'The master key both sides agree on: from the password (WPA2), from SAE (WPA3) or from Diffie-Hellman (OWE).'],
            ['PTK / GTK', 'The session key for one client / the group key for broadcast.'],
            ['4-way handshake / EAPOL', 'The four frames that create the PTK and deliver the GTK.'],
            ['PMKID / PMKSA cache', 'A fingerprint of the PMK, and the memory of keys already agreed, used to reconnect faster.'],
            ['PMF (802.11w)', 'Protected management frames: deauthentication and disassociation are signed, so they cannot be forged.'],
            ['Diffie-Hellman', 'A way to agree on a secret over a public channel using public numbers. Used by OWE.'],
            ['SAE', 'Simultaneous Authentication of Equals: the password handshake of WPA3, immune to offline guessing.'],
            ['Forward secrecy', 'A later leak of the password cannot decrypt traffic recorded earlier.'],
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

export function ConnectLearn() {
  return <Chapters chapters={CHAPTERS} storageKey="wifilab.learn.connect" finish={{ label: 'Now try it', target: 'setup' }} />
}
