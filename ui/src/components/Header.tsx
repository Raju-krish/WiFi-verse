import { Link } from '../router'
import type { Route } from '../router'
import { setSecurity, startLab, stopLab, useStore } from '../store'

const STATE_TEXT = { stopped: 'Lab stopped', starting: 'Starting radios...', running: 'Lab running', stopping: 'Stopping...' } as const

const NAV: Record<Route, [string, string][]> = {
  '/': [],
  '/connect': [['learn', '1 Learn'], ['setup', '2 Setup'], ['build', '3 Build'], ['connection', '4 Connection'], ['capture', '5 Capture'], ['console', '6 Terminal'], ['compare', '7 Compare']],
  '/errors': [['guide', '1 Why it fails'], ['setup', '2 Scenario'], ['build', '3 Build'], ['attempts', '4 Attempts'], ['kick', '5 Deauth'], ['capture', '6 Capture'], ['console', '7 Logs'], ['codes', '8 Codes']],
  '/ft': [['learn', '1 Learn'], ['setup', '2 Setup'], ['build', '3 Build'], ['signal', '4 Signal'], ['roams', '5 Roams'], ['capture', '6 Capture'], ['console', '7 Terminal'], ['compare', '8 FT vs not']],
  '/playground': [['build', '1 Build'], ['network', '2 Devices'], ['signal', '3 Signal'], ['capture', '4 Sniff'], ['console', '5 Terminal']],
}
const TITLE: Record<Route, string> = { '/': 'Dashboard', '/ft': '802.11r Fast Transition', '/connect': '802.11 client connection', '/errors': '802.11 connection errors', '/playground': 'Playground' }

export function Header({ route }: { route: Route }) {
  const lab = useStore((s) => s.lab)
  const security = useStore((s) => s.topo.security)
  const ws = useStore((s) => s.ws)
  const busy = lab.state === 'starting' || lab.state === 'stopping'
  const onLab = route !== '/'
  const showToggle = route === '/ft'

  return (
    <header className="top">
      <Link to="/" className="brand" title="Back to the dashboard">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.2" strokeLinecap="round">
          <path d="M3 9a13 13 0 0 1 18 0" />
          <path d="M6 12.5a8.5 8.5 0 0 1 12 0" />
          <path d="M9 16a4 4 0 0 1 6 0" />
          <circle cx="12" cy="19.5" r="1.3" fill="#2563eb" stroke="none" />
        </svg>
        <div>
          <b>Wi-Fi Verse</b>
          <small>{onLab ? `Dashboard › ${TITLE[route]}` : 'real hostapd, wpa_supplicant and mac80211_hwsim'}</small>
        </div>
      </Link>
      <nav>
        {NAV[route].map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>
      <div className="top-right">
        {showToggle && (
          <div className="segmented small" title="Security mode for the next start">
            <button className={security === 'ft-psk' ? 'on ft' : ''} disabled={lab.state !== 'stopped'} onClick={() => setSecurity('ft-psk')}>
              FT on
            </button>
            <button className={security === 'wpa2-psk' ? 'on psk' : ''} disabled={lab.state !== 'stopped'} onClick={() => setSecurity('wpa2-psk')}>
              FT off
            </button>
          </div>
        )}
        {(onLab || lab.state !== 'stopped') && (
          <span className={`pill-state ${lab.state}`}>
            <i /> {STATE_TEXT[lab.state]}
          </span>
        )}
        {lab.state === 'running' || lab.state === 'stopping' ? (
          <button className="btn danger" disabled={busy} onClick={() => void stopLab()}>
            Stop lab
          </button>
        ) : (
          onLab && (
            <button className="btn primary" disabled={busy} onClick={() => void startLab()}>
              {lab.state === 'starting' ? 'Starting...' : 'Start lab'}
            </button>
          )
        )}
        <span className={`ws ${ws}`} title={`API connection: ${ws}`} />
      </div>
    </header>
  )
}
