import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { apColor } from '../model'
import { toast, useStore } from '../store'
import { ConnectLogs } from './ConnectLogs'
import { MergedLogs } from './MergedLogs'
import { RoamLogs } from './RoamLogs'

type Kind = 'ap' | 'sta'
const TOOL: Record<Kind, string> = { ap: 'hostapd_cli', sta: 'wpa_cli' }
// Answered by the lab from the daemon logs, not passed to hostapd_cli or wpa_cli.
const LAB_COMMANDS = new Set(['ft_cache'])
const LOG_FILTERS = ['EAPOL', 'PTK', 'GTK', 'FT', 'key', 'authenticat', 'associat', 'WPA:', 'roam']
const PMKSA_EMPTY: Record<string, string> = {
  open: 'Empty is expected: an open network has no keys, so there is nothing to cache.',
  'wpa2-psk': 'Empty is expected: WPA2-Personal derives the key from the password at every connection, so there is no PMKSA to cache. Choose WPA3 or OWE in the setup to see an entry here.',
  'ft-psk': 'Empty is expected: FT-PSK derives its keys from the password (PMK-R0 and PMK-R1 are not PMKSA entries). Try ft_cache instead.',
  'wpa3-sae': 'No entry yet: the client has not completed a connection, or the lab was just started.',
  owe: 'No entry yet: the client has not completed a connection, or the lab was just started.',
}
const PTK_STATE: Record<string, string> = { '3': 'AUTHENTICATION', '7': 'PTKSTART', '8': 'PTKCALCNEGOTIATING', '10': 'PTKINITNEGOTIATING', '11': 'PTKINITDONE (keys installed)' }

interface Entry {
  id: number
  node: string
  cmd: string
  out: string
  failed: boolean
}

interface KeyRow {
  sta: string
  ap: string | null
  state: string
  keyMgmt: string
  cipher: string
  apView: string
  tk: string
  gtk: string
}

const kv = (text: string) => Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const short = (hex: string) => `${hex.slice(0, 8)}\u2026${hex.slice(-4)}`

export function DaemonConsole() {
  const topo = useStore((s) => s.topo)
  const macs = useStore((s) => s.macs)
  const labState = useStore((s) => s.lab.state)
  const runDir = useStore((s) => s.lab.runDir)
  const viewRun = useStore((s) => s.viewRun)
  const pendingTab = useStore((s) => s.pendingTab)
  const topoKind = useStore((s) => s.topoKind)
  const running = labState === 'running'
  const daemons = topo.nodes.filter((n) => n.kind !== 'sniffer')
  const [tab, setTab] = useState<'terminal' | 'logs' | 'roam'>('terminal')
  const [nodeId, setNodeId] = useState<string>('')
  const node = daemons.find((n) => n.id === nodeId) ?? daemons[0]
  const kind = (node?.kind ?? 'ap') as Kind

  const [catalog, setCatalog] = useState<Record<Kind, { usage: string; help: string }[]>>({ ap: [], sta: [] })
  const [allEntries, setAllEntries] = useState<Record<string, Entry[]>>({})
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [histories, setHistories] = useState<Record<string, string[]>>({})
  const [histPos, setHistPos] = useState<Record<string, number>>({})
  // Each device has its own terminal: its own screen, input line and command history.
  const id = node?.id ?? ''
  const entries = allEntries[id] ?? []
  const input = inputs[id] ?? ''
  const busy = busyIds.has(id)
  const history = histories[id] ?? []
  const pos = histPos[id] ?? -1
  const setInput = (v: string | ((p: string) => string)) => setInputs((m) => ({ ...m, [id]: typeof v === 'function' ? v(m[id] ?? '') : v }))
  const clearScreen = () => setAllEntries((m) => ({ ...m, [id]: [] }))
  const [keyRows, setKeyRows] = useState<KeyRow[] | null>(null)
  const [checking, setChecking] = useState(false)
  const screen = useRef<HTMLDivElement>(null)
  const nextId = useRef(1)

  const [match, setMatch] = useState('')
  const [lines, setLines] = useState(300)
  const [auto, setAuto] = useState(true)
  const [log, setLog] = useState<{ lines: string[]; matches: number; size: number } | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const logBox = useRef<HTMLDivElement>(null)
  const run = viewRun ?? runDir?.split('/').pop() ?? null

  useEffect(() => {
    api.cliCatalog().then(setCatalog).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!pendingTab) return
    setTab(pendingTab.tab)
    document.getElementById('console')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [pendingTab])

  useEffect(() => {
    screen.current?.scrollTo({ top: screen.current.scrollHeight })
  }, [allEntries, id])

  useEffect(() => {
    if (tab !== 'logs' || !node || !run) return
    let alive = true
    const load = () =>
      api
        .nodeLog(node.id, { lines, match: match.trim(), run })
        .then((r) => {
          if (!alive) return
          setLog(r)
          setLogError(null)
        })
        .catch((e: Error) => {
          if (!alive) return
          setLog(null)
          setLogError(e.message)
        })
    const t = setTimeout(load, match ? 250 : 0)
    const timer = auto && running && !viewRun ? setInterval(load, 1500) : undefined
    return () => {
      alive = false
      clearTimeout(t)
      clearInterval(timer)
    }
  }, [tab, node?.id, run, match, lines, auto, running, viewRun])

  useEffect(() => {
    if (auto && logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight
  }, [log, auto])

  const push = (e: Omit<Entry, 'id'>) => setAllEntries((m) => ({ ...m, [e.node]: [...(m[e.node] ?? []), { ...e, id: nextId.current++ }].slice(-60) }))

  const exec = async (cmd: string) => {
    const c = cmd.trim()
    if (!c || !node) return
    const nid = node.id
    setInputs((m) => ({ ...m, [nid]: '' }))
    setHistPos((m) => ({ ...m, [nid]: -1 }))
    setHistories((m) => ({ ...m, [nid]: [...(m[nid] ?? []).filter((x) => x !== c), c] }))
    if (c === 'clear') return setAllEntries((m) => ({ ...m, [nid]: [] }))
    if (c === 'help') {
      return push({ node: nid, cmd: c, failed: false, out: catalog[kind].map((x) => `${x.usage.padEnd(28)} ${x.help}`).join('\n') })
    }
    setBusyIds((s) => new Set(s).add(nid))
    try {
      const r = await api.cli(nid, c)
      let out = r.output || '(no output)'
      if (c === 'pmksa' && out.trim().split('\n').length <= 1) out += `\n\n${PMKSA_EMPTY[topo.security]}`
      push({ node: nid, cmd: c, out, failed: false })
    } catch (e) {
      push({ node: nid, cmd: c, out: (e as Error).message, failed: true })
    } finally {
      setBusyIds((s) => {
        const next = new Set(s)
        next.delete(nid)
        return next
      })
    }
  }

  const keyCheck = async () => {
    setChecking(true)
    try {
      const [keys, ...results] = await Promise.all([api.keys(), ...daemons.map((n) => api.cli(n.id, n.kind === 'ap' ? 'all_sta' : 'status'))])
      const out = Object.fromEntries(daemons.map((n, i) => [n.id, results[i].output]))
      const rows: KeyRow[] = daemons
        .filter((n) => n.kind === 'sta')
        .map((sta) => {
          const st = kv(out[sta.id])
          const ap = macs[st.bssid ?? ''] ?? null
          let apView = 'AP not found'
          if (ap && out[ap] !== undefined) {
            const block = out[ap].split(/\n(?=[0-9a-f]{2}(?::[0-9a-f]{2}){5}\n)/i).find((b) => b.toLowerCase().startsWith((st.address ?? '-').toLowerCase()))
            if (block) {
              const b = kv(block)
              const authorized = (b.flags ?? '').includes('[AUTHORIZED]')
              apView = `${authorized ? 'AUTHORIZED' : 'not authorized'}, PTK state ${PTK_STATE[b.hostapdWPAPTKState] ?? b.hostapdWPAPTKState ?? '?'}`
            } else apView = 'station not listed by the AP'
          }
          const same = (k: 'tk' | 'gtk') => {
            const mine = keys.filter((x) => x.kind === k && x.nodes.includes(sta.id)).at(-1)
            if (!mine) return 'no key logged yet'
            const peers = mine.nodes.filter((n) => n !== sta.id)
            return peers.length ? `${short(mine.key)} shared with ${peers.join(', ')}` : `${short(mine.key)} not seen on any AP`
          }
          return { sta: sta.id, ap, state: st.wpa_state ?? 'unknown', keyMgmt: st.key_mgmt ?? '-', cipher: st.pairwise_cipher ?? '-', apView, tk: same('tk'), gtk: same('gtk') }
        })
      setKeyRows(rows)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const macChips = useMemo(
    () => Object.entries(macs).filter(([, name]) => !name.endsWith('-br') && name !== 'gw').map(([mac, name]) => ({ mac, name })),
    [macs],
  )
  const needsMac = (usage: string) => usage.includes('<mac>')

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault()
      const p = Math.min(pos + 1, history.length - 1)
      setHistPos((m) => ({ ...m, [id]: p }))
      setInput(history[history.length - 1 - p])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const p = pos - 1
      setHistPos((m) => ({ ...m, [id]: p }))
      setInput(p < 0 ? '' : history[history.length - 1 - p])
    }
  }

  if (daemons.length === 0) return <div className="empty">Add an access point or a client to the floor plan to talk to its daemon.</div>

  return (
    <div className="console">
      <div className="console-bar">
        <div className="tabs">
          <button className={tab === 'terminal' ? 'on' : ''} onClick={() => setTab('terminal')}>
            Terminal
          </button>
          <button className={tab === 'logs' ? 'on' : ''} onClick={() => setTab('logs')}>
            Logs
          </button>
          <button className={tab === 'roam' ? 'on' : ''} onClick={() => setTab('roam')}>
            {topoKind === 'connect' ? 'Connection logs' : topoKind === 'playground' || topoKind === 'errors' ? 'Merged logs' : 'Roam and FT keys'}
          </button>
        </div>
        {tab !== 'roam' && (
          <div className="console-nodes">
          {daemons.map((n) => (
            <button key={n.id} className={`chipbtn${node?.id === n.id ? ' on' : ''}`} onClick={() => setNodeId(n.id)} style={node?.id === n.id && n.kind === 'ap' ? { borderColor: apColor(topo.nodes, n.id) } : undefined}>
              {n.kind === 'ap' && <i style={{ background: apColor(topo.nodes, n.id) }} />}
              {n.id}
              <small>{TOOL[n.kind as Kind]}</small>
            </button>
          ))}
          </div>
        )}
        {tab === 'terminal' && (
          <button className="btn small" disabled={!running || checking} onClick={() => void keyCheck()} title="Reads every client and AP and compares the keys the daemons logged">
            {checking ? 'Checking...' : 'Check keys'}
          </button>
        )}
      </div>

      {tab === 'roam' ? (
        topoKind === 'connect' ? <ConnectLogs /> : topoKind === 'playground' || topoKind === 'errors' ? <MergedLogs /> : <RoamLogs />
      ) : tab === 'terminal' ? (
        <>
          {!running && <div className="console-note">Start the lab to talk to the daemons. The Logs tab stays readable after the lab stops.</div>}
          {keyRows && (
            <div className="keycheck">
              <table>
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Connected to</th>
                    <th>Client state</th>
                    <th>AP view</th>
                    <th>Pairwise key (TK)</th>
                    <th>Group key (GTK)</th>
                  </tr>
                </thead>
                <tbody>
                  {keyRows.map((r) => (
                    <tr key={r.sta}>
                      <td>{r.sta}</td>
                      <td>{r.ap ?? '-'}</td>
                      <td className={r.state === 'COMPLETED' ? 'good' : 'warn'}>
                        {r.state} <small>{r.keyMgmt}, {r.cipher}</small>
                      </td>
                      <td className={r.apView.startsWith('AUTHORIZED') ? 'good' : 'warn'}>{r.apView}</td>
                      <td className={r.tk.includes('shared') ? 'good' : 'warn'}>{r.tk}</td>
                      <td className={r.gtk.includes('shared') ? 'good' : 'warn'}>{r.gtk}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <small className="muted">Keys come from the daemons' own debug logs, so a key listed on both sides really was installed on both. Only the first and last characters are shown.</small>
            </div>
          )}
          <div className="term" ref={screen} onClick={() => document.getElementById('term-input')?.focus()}>
            {entries.length === 0 && <div className="term-dim">This is the terminal of {node?.id} ({TOOL[kind]}). Click a command below or type one; type help to list them. Each device keeps its own screen.</div>}
            {entries.map((e) => (
              <div key={e.id}>
                <div className="term-cmd">
                  <span className="term-prompt">{e.node}$</span> {LAB_COMMANDS.has(e.cmd) ? e.cmd : `${TOOL[(topo.nodes.find((n) => n.id === e.node)?.kind ?? 'ap') as Kind]} ${e.cmd}`}
                </div>
                <pre className={e.failed ? 'term-err' : ''}>{e.out}</pre>
              </div>
            ))}
            <div className="term-line">
              <span className="term-prompt">
                {node?.id}$ {TOOL[kind]}
              </span>
              <input
                id="term-input"
                spellCheck={false}
                autoComplete="off"
                disabled={!running || busy}
                value={input}
                placeholder={running ? 'status' : 'lab is stopped'}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => (e.key === 'Enter' ? void exec(input) : onKey(e))}
                aria-label="Command"
              />
            </div>
          </div>
          <div className="term-cmds">
            {catalog[kind].map((c) => (
              <button key={c.usage} className="chipbtn" title={c.help} disabled={!running || busy} onClick={() => (needsMac(c.usage) ? setInput(`${c.usage.split(' ')[0]} `) : void exec(c.usage))}>
                {c.usage}
              </button>
            ))}
            <button className="chipbtn ghost" onClick={() => void exec('help')}>
              help
            </button>
            <button className="chipbtn ghost" onClick={clearScreen}>
              clear
            </button>
          </div>
          {macChips.length > 0 && (
            <div className="term-cmds">
              <small className="muted">Insert an address:</small>
              {macChips.map((m) => (
                <button key={m.mac} className="chipbtn ghost" title={m.mac} onClick={() => setInput((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}${m.mac}`)}>
                  {m.name}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="log-tools">
            <input type="search" placeholder="Filter lines, for example EAPOL or PTK" value={match} onChange={(e) => setMatch(e.target.value)} aria-label="Filter log lines" />
            <select value={lines} onChange={(e) => setLines(Number(e.target.value))} aria-label="Lines to show">
              {[100, 300, 1000, 3000].map((n) => (
                <option key={n} value={n}>
                  last {n} lines
                </option>
              ))}
            </select>
            <label className="check">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Live, follow the end
            </label>
          </div>
          <div className="term-cmds">
            {LOG_FILTERS.map((f) => (
              <button key={f} className={`chipbtn${match === f ? ' on' : ''}`} onClick={() => setMatch(match === f ? '' : f)}>
                {f}
              </button>
            ))}
          </div>
          <div className="logbox" ref={logBox}>
            {!run ? (
              <div className="term-dim">Start the lab, or pick a saved run in the capture panel, to read a daemon log.</div>
            ) : logError ? (
              <div className="term-dim">{logError}</div>
            ) : (
              log?.lines.map((l, i) => (
                <div key={i} className="logline">
                  {match && l.toLowerCase().includes(match.toLowerCase()) ? highlight(l, match) : l}
                </div>
              ))
            )}
          </div>
          <div className="log-foot">
            {log && (
              <>
                {node?.id}.log of the {viewRun ? 'selected saved run' : 'current run'}: {log.matches} matching lines, showing the last {log.lines.length}. The file is {(log.size / 1024).toFixed(0)} KB and holds the daemon's own debug output, including key material.
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function highlight(line: string, needle: string) {
  const i = line.toLowerCase().indexOf(needle.toLowerCase())
  return (
    <>
      {line.slice(0, i)}
      <mark>{line.slice(i, i + needle.length)}</mark>
      {line.slice(i + needle.length)}
    </>
  )
}
