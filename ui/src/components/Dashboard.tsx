import { Link } from '../router'
import type { Route } from '../router'

interface Feature {
  title: string
  tag: string
  text: string
  points: string[]
  to?: Route
  cta?: string
}

const AVAILABLE: Feature[] = [
  {
    title: '802.11 client connection',
    tag: 'Available',
    text: 'Watch a client join an access point in each security mode: open, OWE, WPA2 and WPA3. See what is exchanged, when keys appear, and what an eavesdropper could read.',
    points: ['Chapters on scanning, authentication, association and the handshakes', 'Ready-made lab: 1 access point, 1 client', 'Open, OWE, WPA2-Personal and WPA3-Personal (SAE)', 'Frame ladder, timing and decrypted capture of every connection', 'Disconnect and reconnect to see PMKSA caching'],
    to: '/connect',
    cta: 'Open client connection',
  },
  {
    title: 'Connection errors and deauthentication',
    tag: 'Available',
    text: 'Make connections fail on purpose and read the real status and reason codes: a wrong password, a blocked client, a security mismatch. Then make the access point kick a client with any reason code.',
    points: ['Every 802.11 status code and reason code, searchable, with plain explanations', 'Ready-made faults: wrong password (WPA2 and WPA3), MAC block, PMF and security mismatch', 'Each failed attempt measured from the capture, with the code and where it stopped', 'Send a deauthentication or disassociation with a reason of your choice'],
    to: '/errors',
    cta: 'Open connection errors',
  },
  {
    title: '802.11r Fast Transition',
    tag: 'Available',
    text: 'Learn why roaming is slow, how fast transition removes the 4-way handshake, and what the R0KH, R1KH, S0KH and S1KH key holders do. Then run it for real.',
    points: ['Chapters that teach it from zero', 'Ready-made lab: 2 access points, 1 client', 'Key distribution: local, pull or push', 'Over the air or over the DS', 'Frames, key checks and daemon logs of every roam'],
    to: '/ft',
    cta: 'Open 802.11r',
  },
  {
    title: 'Playground',
    tag: 'Available',
    text: 'An empty floor. Add as many access points, clients and sniffers as you like, move them around, and watch what the real Wi-Fi stack does.',
    points: ['Up to 6 access points and 6 clients', 'Sniffers with their own captures', 'Walk clients, change power and channels', 'Wireshark-style capture, terminal and merged daemon logs'],
    to: '/playground',
    cta: 'Open the playground',
  },
]

const SOON: Feature[] = [
  { title: '802.11k and 802.11v', tag: 'Coming soon', text: 'Neighbour reports and BSS transition requests: the AP helps the client choose where to roam.', points: [] },
  { title: 'WPA3 and SAE', tag: 'Coming soon', text: 'A password handshake that cannot be cracked offline, and how it differs from WPA2.', points: [] },
  { title: 'Channels and interference', tag: 'Coming soon', text: 'Co-channel and adjacent-channel overlap, and what they do to throughput.', points: [] },
  { title: 'Attacks and protected management frames', tag: 'Coming soon', text: 'Deauthentication floods, evil twins, and how PMF stops them.', points: [] },
  { title: '802.1X and RADIUS', tag: 'Coming soon', text: 'Enterprise login with certificates or passwords, and why it makes roaming slower.', points: [] },
  { title: 'DHCP, VLANs and several SSIDs', tag: 'Coming soon', text: 'What happens above the radio: addresses, segmentation and guest networks.', points: [] },
]

function Card({ f }: { f: Feature }) {
  const body = (
    <>
      <span className={`feature-tag${f.to ? '' : ' soon'}`}>{f.tag}</span>
      <h3>{f.title}</h3>
      <p>{f.text}</p>
      {f.points.length > 0 && (
        <ul>
          {f.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {f.to && <span className="btn primary feature-cta">{f.cta} →</span>}
    </>
  )
  return f.to ? (
    <Link to={f.to} className="feature">
      {body}
    </Link>
  ) : (
    <div className="feature soon">{body}</div>
  )
}

export function Dashboard() {
  return (
    <main className="dash">
      <section className="dash-hero">
        <h1>Learn Wi-Fi by running the real thing</h1>
        <p>
          No hardware needed. Every access point is a real <code>hostapd</code>, every client a real <code>wpa_supplicant</code>, on virtual radios with a signal model, so what you capture and read is what the protocol really does. Pick a topic to start.
        </p>
      </section>
      <section>
        <h2 className="dash-h">Start here</h2>
        <div className="dash-grid">
          {AVAILABLE.map((f) => (
            <Card key={f.title} f={f} />
          ))}
        </div>
      </section>
      <section>
        <h2 className="dash-h">On the way</h2>
        <div className="dash-grid">
          {SOON.map((f) => (
            <Card key={f.title} f={f} />
          ))}
        </div>
      </section>
    </main>
  )
}
