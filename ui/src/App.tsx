import { useEffect } from 'react'
import { CapturePanel } from './components/CapturePanel'
import { Compare } from './components/Compare'
import { ConnectCompare } from './components/ConnectCompare'
import { ConnectLearn } from './components/ConnectLearn'
import { ConnectSetup } from './components/ConnectSetup'
import { ConnectionPanel } from './components/ConnectionPanel'
import { AttemptsPanel } from './components/AttemptsPanel'
import { ErrorCatalog } from './components/ErrorCatalog'
import { ErrorsGuide } from './components/ErrorsGuide'
import { ErrorsSetup } from './components/ErrorsSetup'
import { KickPanel } from './components/KickPanel'
import { DaemonConsole } from './components/DaemonConsole'
import { Dashboard } from './components/Dashboard'
import { FloorPlan } from './components/FloorPlan'
import { FtSetup } from './components/FtSetup'
import { Header } from './components/Header'
import { Inspector } from './components/Inspector'
import { Learn } from './components/Learn'
import { NetworkOverview } from './components/NetworkOverview'
import { RoamPanel } from './components/RoamPanel'
import { SignalChart } from './components/SignalChart'
import { Link, useRoute } from './router'
import { connect, getState, loadLab, refresh, stopLab, toast as showToast, useStore } from './store'
import type { LabKind } from './store'

function Section({ id, n, title, lead, children }: { id: string; n: number; title: string; lead: string; children: React.ReactNode }) {
  return (
    <section id={id} className="section">
      <h2>
        <span className="num">{n}</span> {title}
      </h2>
      <p className="lead">{lead}</p>
      {children}
    </section>
  )
}

const BUILD_LEAD = {
  ft: 'The lab is predesigned: two access points and one client. You can still drag them to change distances, set transmit power and the roam trigger, and see the signal each one hears.',
  connect: 'The lab is predesigned: one access point and one client. Drag the client to change the signal it hears, and set the access point transmit power.',
  errors: 'The lab is predesigned: one access point and one client. The mistake you chose in the scenario is built into the configuration of one of them.',
  playground: 'Drag access points, clients and sniffers onto the floor. Every device becomes a real Linux radio, so positions are in metres and decide the signal each one hears.',
} as const

function Shared({ kind, first }: { kind: LabKind; first: number }) {
  return (
    <>
      <Section id="build" n={first} title="Build the network" lead={BUILD_LEAD[kind]}>
        <div className="build">
          <div className="card flush">
            <FloorPlan />
          </div>
          <aside className="card inspector">
            <Inspector />
          </aside>
        </div>
      </Section>

      <Section id="signal" n={first + 1} title="Watch the signal" lead="The client decides when to roam. It waits until its AP falls below the roam trigger, scans, and moves only if another AP is stronger. Walk the client away from its AP and watch the lines cross.">
        <div className="card">
          <SignalChart />
        </div>
      </Section>

      <Section id="roams" n={first + 2} title="What happened at each roam" lead="Every roam is measured from the frames on the air. Pick one to see the exchange between the client and the new AP, and click a frame to decode it.">
        <div className="card">
          <RoamPanel />
        </div>
      </Section>

      <Section id="capture" n={first + 3} title="Capture every frame" lead="Real 802.11 frames from the virtual medium, shown live. Unicast data is decrypted on the fly with the keys the daemons log, so you can read the pings and ARP, and export a PCAP that opens in Wireshark.">
        <div className="card">
          <CapturePanel />
        </div>
      </Section>

      <Section id="console" n={first + 4} title="Talk to the daemons" lead="Run read-only hostapd_cli and wpa_cli commands on the running access points and clients, check whether the pairwise and group keys really are shared, and read each daemon's debug log.">
        <div className="card">
          <DaemonConsole />
        </div>
      </Section>

      <Section id="compare" n={first + 5} title="Roaming with and without 802.11r" lead="Run the same walk with Fast BSS Transition on and off. Compare how long the client is cut off and how many frames the roam costs.">
        <div className="card">
          <Compare />
        </div>
      </Section>
    </>
  )
}

function FtLab() {
  return (
    <main>
      <Section id="learn" n={1} title="Start here: how Wi-Fi security and fast roaming work" lead="No background needed. Ten short chapters explain why keys exist, how a client connects, why roaming is slow, and how 802.11r fixes it, including what R0KH, R1KH, S0KH and S1KH are. Every chapter ends with a button that shows the same thing in your own lab below.">
        <div className="card">
          <Learn />
        </div>
      </Section>
      <Section id="setup" n={2} title="Set up the experiment" lead="Choose how the keys reach the new access point and how the client starts the move. The same walk then shows the difference in the frames, the logs and the roam time.">
        <div className="card">
          <FtSetup />
        </div>
      </Section>
      <Shared kind="ft" first={3} />
    </main>
  )
}

function ConnectLab() {
  return (
    <main>
      <Section id="learn" n={1} title="Start here: how a client joins a Wi-Fi network" lead="Short chapters on scanning, authentication, association and the four security modes: open, OWE, WPA2 and WPA3. Each ends with a button that shows the same thing in your own lab below.">
        <div className="card">
          <ConnectLearn />
        </div>
      </Section>
      <Section id="setup" n={2} title="Choose the security" lead="Pick how the network protects its clients, then start the lab. The client connects by itself and the exchange is measured from the capture.">
        <div className="card">
          <ConnectSetup />
        </div>
      </Section>
      <Section id="build" n={3} title="Build the network" lead={BUILD_LEAD.connect}>
        <div className="build">
          <div className="card flush">
            <FloorPlan />
          </div>
          <aside className="card inspector">
            <Inspector />
          </aside>
        </div>
      </Section>
      <Section id="connection" n={4} title="What happened when the client connected" lead="Every connection attempt is measured from the frames on the air. Pick one to see the exchange between the client and the access point, and click a frame to decode it.">
        <div className="card">
          <ConnectionPanel />
        </div>
      </Section>
      <Section id="capture" n={5} title="Capture every frame" lead="Real 802.11 frames from the virtual medium, shown live. With a protected network the data frames are decrypted on the fly with the keys the daemons log; with an open network there is nothing to decrypt.">
        <div className="card">
          <CapturePanel />
        </div>
      </Section>
      <Section id="console" n={6} title="Talk to the daemons" lead="Run read-only hostapd_cli and wpa_cli commands, read each daemon's debug log, or open Connection logs to see the lines of the access point and the client merged in time, grouped into the steps of the connection for the security mode you chose.">
        <div className="card">
          <DaemonConsole />
        </div>
      </Section>
      <Section id="compare" n={7} title="Compare the four security modes" lead="Run the same connection under each mode and compare time, frames and key exchange, for the first connection and for a reconnection.">
        <div className="card">
          <ConnectCompare />
        </div>
      </Section>
    </main>
  )
}

function ErrorsLab() {
  return (
    <main>
      <Section id="guide" n={1} title="Why a connection fails" lead="A connection is a chain of steps and each one fails in its own way, leaving a different trace: a status code, a reason code, or nothing at all.">
        <div className="card">
          <ErrorsGuide />
        </div>
      </Section>
      <Section id="setup" n={2} title="Choose what goes wrong" lead="Pick a deliberate mistake, start the lab, and the client keeps trying. Every attempt is measured from the capture.">
        <div className="card">
          <ErrorsSetup />
        </div>
      </Section>
      <Section id="build" n={3} title="Build the network" lead={BUILD_LEAD.errors}>
        <div className="build">
          <div className="card flush">
            <FloorPlan />
          </div>
          <aside className="card inspector">
            <Inspector />
          </aside>
        </div>
      </Section>
      <Section id="attempts" n={4} title="What happened at each attempt" lead="How far each attempt got, which code it ended with and what that code means. Click a frame to decode it.">
        <div className="card">
          <AttemptsPanel />
        </div>
      </Section>
      <Section id="kick" n={5} title="Make the access point send a deauthentication" lead="The other half of the story: connections that worked and are ended on purpose. Send any reason code and see how the client reacts.">
        <div className="card">
          <KickPanel />
        </div>
      </Section>
      <Section id="capture" n={6} title="Capture every frame" lead="The real frames, including the refused Authentication and Association Responses and the Deauthentication frames. Filter for them with wlan.fixed.status_code != 0 or wlan.fc.type_subtype == 0x000c.">
        <div className="card">
          <CapturePanel />
        </div>
      </Section>
      <Section id="console" n={7} title="Read the logs of both sides" lead="hostapd and wpa_supplicant explain their own decisions: why the AP refused, and why the client did not even try. Merge them by time and search.">
        <div className="card">
          <DaemonConsole />
        </div>
      </Section>
      <Section id="codes" n={8} title="Every status code and reason code" lead="The full catalogue of 802.11 status codes and reason codes, with the standard’s names, plain explanations for the ones you meet, and a way to reproduce many of them here.">
        <div className="card">
          <ErrorCatalog />
        </div>
      </Section>
    </main>
  )
}

function Playground() {
  return (
    <main>
      <Section id="build" n={1} title="Build the network" lead={BUILD_LEAD.playground}>
        <div className="build">
          <div className="card flush">
            <FloorPlan />
          </div>
          <aside className="card inspector">
            <Inspector />
          </aside>
        </div>
      </Section>

      <Section id="network" n={2} title="Devices and who is connected" lead="Every device with its channel, position and power, and live status once the lab runs: which client is on which access point, its address and signal. Ping from a client to put some traffic on the air.">
        <div className="card">
          <NetworkOverview />
        </div>
      </Section>

      <Section id="signal" n={3} title="Watch the signal" lead="The signal each client measures from its access point, and what the model predicts for each one. Walk a client around and watch the lines move.">
        <div className="card">
          <SignalChart />
        </div>
      </Section>

      <Section id="capture" n={4} title="Sniff and analyse" lead="All frames from the virtual medium, plus one capture for every sniffer you place: it sits on its own channel and position and records the signal strength it heard. Filter with real Wireshark display filters, decode any frame and export a PCAP.">
        <div className="card">
          <CapturePanel />
        </div>
      </Section>

      <Section id="console" n={5} title="Talk to the daemons" lead="Run read-only hostapd_cli and wpa_cli commands on any device, read each daemon's debug log, or merge the logs of several devices by time to follow an exchange from both sides.">
        <div className="card">
          <DaemonConsole />
        </div>
      </Section>
    </main>
  )
}

export default function App() {
  const route = useRoute()
  const toast = useStore((s) => s.toast)
  const ws = useStore((s) => s.ws)
  const labState = useStore((s) => s.lab.state)
  const topoKind = useStore((s) => s.topoKind)
  const kind: LabKind | null = route === '/ft' ? 'ft' : route === '/connect' ? 'connect' : route === '/errors' ? 'errors' : route === '/playground' ? 'playground' : null

  useEffect(() => {
    connect()
    void refresh()
  }, [])

  // Opening a lab page loads its setup, as soon as no lab is running.
  useEffect(() => {
    if (kind && labState === 'stopped') loadLab(kind)
  }, [kind, labState, topoKind])

  // Closing or reloading the browser tab stops the lab; merely switching to another browser tab does not.
  useEffect(() => {
    const onPageHide = () => {
      if (getState().lab.state === 'running') navigator.sendBeacon('/api/lab/stop')
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [])

  // Switching to another page of the app stops the lab.
  useEffect(() => {
    return () => {
      if (getState().lab.state === 'running') {
        showToast('Lab stopped: you left the page')
        void stopLab()
      }
    }
  }, [route])

  const wrongSetup = kind !== null && topoKind !== kind

  return (
    <>
      <Header route={route} />
      {ws === 'closed' && <div className="banner">Cannot reach the lab API on 127.0.0.1:8787. Start it with <code>scripts/labd.sh</code>.</div>}
      {wrongSetup && (
        <div className="banner info">
          A lab from the {topoKind === 'ft' ? '802.11r' : topoKind === 'connect' ? 'client connection' : topoKind === 'errors' ? 'connection errors' : 'playground'} setup is still {labState}. Stop it to load this page&apos;s setup, or <Link to={topoKind === 'ft' ? '/ft' : topoKind === 'connect' ? '/connect' : topoKind === 'errors' ? '/errors' : '/playground'}>go back to it</Link>.
        </div>
      )}
      {route === '/' ? <Dashboard /> : route === '/ft' ? <FtLab /> : route === '/connect' ? <ConnectLab /> : route === '/errors' ? <ErrorsLab /> : <Playground />}
      <footer>Wi-Fi Verse. Everything on this page is a real Linux wireless stack running on mac80211_hwsim with a wmediumd path-loss model.</footer>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  )
}
