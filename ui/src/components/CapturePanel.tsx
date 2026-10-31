import { useEffect, useMemo, useRef, useState } from 'react'
import { api, pcapUrl } from '../api'
import { setState, toast, useStore } from '../store'
import type { Frame, FrameDetail, RunInfo, TreeNode } from '../types'
import { HexView } from './HexView'
import { allBranches, defaultOpen, nodeAt, PacketDetails, pathForByte, pathKey } from './PacketDetails'
import { PacketList, type TimeFormat } from './PacketList'
import { Splitter, useStoredNumber } from './panes'

const FILTERS: [string, string][] = [
  ['Hide beacons and probes', '!(wlan.fc.type_subtype == 0x0008 || wlan.fc.type_subtype == 0x0004 || wlan.fc.type_subtype == 0x0005)'],
  ['Hide acknowledgements', 'wlan.fc.type_subtype != 0x001d'],
  ['Management frames', 'wlan.fc.type == 0'],
  ['Authentication and (re)association', 'wlan.fc.type_subtype in {0,1,2,3,11}'],
  ['Deauthentication and disassociation', 'wlan.fc.type_subtype in {10,12}'],
  ['Fast BSS Transition (802.11r)', 'wlan.fixed.auth.alg == 2'],
  ['EAPOL (4-way handshake)', 'eapol'],
  ['Decrypted data', 'ip || arp || icmpv6'],
  ['Ping', 'icmp'],
]

// Same cap as the live list.
const MAX_VIEW = 20000

const SIMPLE_VALUE = /^(0x[0-9a-f]+|-?\d+|(\d{1,3}\.){3}\d{1,3}|([0-9a-f]{2}:){5}[0-9a-f]{2})$/i
const filterFor = (n: TreeNode) => (SIMPLE_VALUE.test(n.v) ? `${n.f} == ${n.v}` : n.f)

// Run ids look like 20261031-122758-ft-psk.
const runLabel = (r: RunInfo) => {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(r.id)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} · ${r.mode}` : r.id
}

export function CapturePanel() {
  const frames = useStore((s) => s.frames)
  const src = useStore((s) => s.captureSrc)
  const macs = useStore((s) => s.macs)
  const topo = useStore((s) => s.topo)
  const selectedFrame = useStore((s) => s.selectedFrame)
  const labState = useStore((s) => s.lab.state)
  const runDir = useStore((s) => s.lab.runDir)
  const viewRun = useStore((s) => s.viewRun)
  const focusTick = useStore((s) => s.focusTick)
  const pendingFilter = useStore((s) => s.pendingFilter)
  const captureStopped = useStore((s) => s.captureStopped)
  const capturePaused = useStore((s) => s.capturePaused)
  const rootRef = useRef<HTMLDivElement>(null)

  const [panelH, setPanelH] = useStoredNumber('panelH', 700)
  const [listH, setListH] = useStoredNumber('listH', 280)
  const [hexW, setHexW] = useStoredNumber('hexW', 400)
  const [timeFormat, setTimeFormat] = useState<TimeFormat>('rel')
  const [resolve, setResolve] = useState(true)
  const [follow, setFollow] = useState(true)
  const [paused, setPaused] = useState(false)
  const [frozen, setFrozen] = useState<Frame[]>([])

  const [expr, setExpr] = useState('')
  const [applied, setApplied] = useState('')
  const [join, setJoin] = useState<'replace' | 'and' | 'or' | 'andnot'>('replace')
  const [matches, setMatches] = useState<{ key: string; set: Set<number> } | null>(null)
  const [filterError, setFilterError] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [past, setPast] = useState<Frame[]>([])
  const [pastLoading, setPastLoading] = useState(false)

  const [decrypted, setDecrypted] = useState(true)
  const [detail, setDetail] = useState<FrameDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [selPath, setSelPath] = useState<number[] | null>(null)

  const currentId = runDir ? (runDir.split('/').pop() ?? null) : null
  const viewed = viewRun ? runs.find((r) => r.id === viewRun) : undefined
  const sources = viewRun ? (viewed?.sources ?? ['global']) : ['global', ...topo.nodes.filter((n) => n.kind === 'sniffer').map((n) => n.id)]
  const live = viewRun ? past : (frames[src] ?? [])
  const hasCurrent = labState !== 'stopped' || (frames[src] ?? []).length > 0
  const list = paused ? frozen : live
  const liveCount = live.length
  const countRef = useRef(liveCount)
  countRef.current = liveCount

  // The key ties a filter result to the run, source and expression it was computed for.
  const filterKey = `${viewRun ?? runDir ?? ''}|${src}|${applied}`
  const rows = useMemo(() => {
    if (!applied || filterError) return list
    return matches?.key === filterKey ? list.filter((f) => matches.set.has(f.n)) : []
  }, [list, matches, applied, filterError, filterKey])
  const hasSignal = useMemo(() => src !== 'global' && list.some((f) => f.rssi !== null), [src, list])

  useEffect(() => {
    api
      .runs()
      .then(setRuns)
      .catch(() => undefined)
  }, [labState, runDir])

  useEffect(() => {
    if (!viewRun) {
      setPast([])
      return
    }
    let alive = true
    setPastLoading(true)
    api
      .runFrames(viewRun, src)
      .then((f) => alive && setPast(f.length > MAX_VIEW ? f.slice(-MAX_VIEW) : f))
      .catch((e: Error) => {
        if (!alive) return
        setPast([])
        toast(e.message)
      })
      .finally(() => alive && setPastLoading(false))
    return () => {
      alive = false
    }
  }, [viewRun, src])

  // A real Wireshark display filter, evaluated by tshark over the whole decrypted capture.
  useEffect(() => {
    setFilterError(null)
    if (!applied) {
      setMatches(null)
      return
    }
    let alive = true
    let seen = -1
    const run = () => {
      seen = countRef.current
      api
        .filter(src, applied, viewRun)
        .then((r) => {
          if (!alive) return
          setFilterError(r.error)
          setMatches(r.error ? null : { key: filterKey, set: new Set(r.numbers) })
        })
        .catch((e: Error) => {
          if (!alive) return
          setFilterError(e.message)
          setMatches(null)
        })
    }
    run()
    const timer = viewRun ? undefined : setInterval(() => !paused && countRef.current !== seen && run(), 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // filterKey already covers run, source and expression.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, paused, viewRun])

  // A frame picked in the roam ladder: stop auto-scrolling, and bring its packet details into view.
  useEffect(() => {
    if (focusTick === 0) return
    setFollow(false)
    rootRef.current?.querySelector('.wsp-pane.details')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusTick])

  // The Learn section can ask for a filter, for example to show only the EAPOL frames.
  useEffect(() => {
    if (!pendingFilter) return
    setExpr(pendingFilter.expr)
    setApplied(pendingFilter.expr.trim())
    setState({ selectedFrame: null })
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // Only a new request should apply a filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFilter])

  // Picking a frame elsewhere (the roam ladder) brings its capture source into view.
  useEffect(() => {
    if (selectedFrame && selectedFrame.src !== src) setState({ captureSrc: selectedFrame.src })
    // Only a change of selection should switch the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFrame])

  useEffect(() => {
    if (!selectedFrame) {
      setDetail(null)
      return
    }
    let alive = true
    setDetailError(null)
    api
      .frameDetail(selectedFrame.src, selectedFrame.n, decrypted, viewRun)
      .then((d) => {
        if (!alive) return
        setDetail(d)
        setOpen(defaultOpen(d.tree))
        setSelPath(null)
      })
      .catch((e: Error) => {
        if (!alive) return
        setDetail(null)
        setDetailError(e.message)
      })
    return () => {
      alive = false
    }
  }, [selectedFrame, decrypted, viewRun])

  const nodeMacs = useMemo(() => {
    const byName = new Map<string, string[]>()
    for (const [mac, name] of Object.entries(macs)) if (!name.endsWith('-br')) byName.set(name, [...(byName.get(name) ?? []), mac])
    return [...byName].map(([name, list]) => ({ name, expr: list.map((m) => `wlan.addr == ${m}`).join(' || ') }))
  }, [macs])
  const selNode = detail && selPath ? nodeAt(detail.tree, selPath) : null
  const selFrame: Frame | undefined = selectedFrame ? live.find((f) => f.n === selectedFrame.n) : undefined
  const decryptedCount = useMemo(() => live.reduce((a, f) => a + (f.dec ? 1 : 0), 0), [live])
  const hasRun = labState !== 'stopped' || liveCount > 0
  const pickRun = (id: string) => {
    setPaused(false)
    setState({ viewRun: id || null, selectedFrame: null, captureSrc: 'global' })
  }
  const applyExpr = (e: string) => {
    setExpr(e)
    setApplied(e.trim())
  }

  // Adds a preset or a field to the current filter instead of replacing it.
  const addExpr = (e: string) => {
    const cur = expr.trim()
    if (join === 'replace' || !cur || !e) return applyExpr(e)
    const op = join === 'or' ? '||' : '&&'
    applyExpr(`(${cur}) ${op} ${join === 'andnot' ? '!' : ''}(${e})`)
  }

  const togglePause = () => {
    setFrozen(live)
    setPaused(!paused)
  }

  const pick = (path: number[]) => {
    setSelPath(path)
    // Reveal a field picked from the hex pane.
    setOpen((o) => {
      const next = new Set(o)
      for (let i = 1; i < path.length; i++) next.add(pathKey(path.slice(0, i)))
      return next
    })
  }

  const downloadKeys = async () => {
    try {
      const keys = await api.keys()
      const url = URL.createObjectURL(new Blob([JSON.stringify(keys, null, 1)], { type: 'application/json' }))
      Object.assign(document.createElement('a'), { href: url, download: 'wifilab-keys.json' }).click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast((e as Error).message)
    }
  }

  const filterState = !applied ? '' : filterError ? ' bad' : ' ok'

  return (
    <div className="wsp" ref={rootRef} style={{ height: panelH, scrollMarginTop: 72 }}>
      <div className="wsp-bar">
        <select value={viewRun ?? ''} onChange={(e) => pickRun(e.target.value)} title="Each lab start creates a new capture; earlier ones stay available here" aria-label="Capture run">
          <option value="">{labState === 'running' ? 'Current run (live)' : hasCurrent ? 'Current run (stopped)' : 'Select a saved run'}</option>
          {runs
            .filter((r) => !(r.id === currentId && hasCurrent))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {runLabel(r)}
              </option>
            ))}
        </select>
        <div className="tabs">
          {sources.map((s) => (
            <button key={s} className={s === src ? 'on' : ''} onClick={() => setState({ captureSrc: s, selectedFrame: null })}>
              {s === 'global' ? 'All frames (hwsim0)' : `${s} · ch ${topo.nodes.find((n) => n.id === s)?.channel}`}
            </button>
          ))}
        </div>
        <select value={timeFormat} onChange={(e) => setTimeFormat(e.target.value as TimeFormat)} title="Time display format">
          <option value="rel">Seconds since beginning of capture</option>
          <option value="tod">Time of day</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} /> Resolve names
        </label>
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Auto-scroll
        </label>
        <button className="btn small" onClick={togglePause}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <a className={`btn small${hasRun ? '' : ' disabled'}`} href={hasRun ? pcapUrl(src, false, viewRun) : undefined} download title="The frames exactly as the radio heard them">
          Save .pcap
        </a>
        <a className={`btn small${hasRun ? '' : ' disabled'}`} href={hasRun ? pcapUrl(src, true, viewRun) : undefined} download title="Same frames with the CCMP payload decrypted, opens in Wireshark with no keys needed">
          Save decrypted .pcap
        </a>
        <button className="btn small ghost" disabled={!hasRun || !!viewRun} onClick={() => void downloadKeys()} title="PTK/TK and GTK taken from the daemons' debug logs (current run only)">
          Keys
        </button>
      </div>

      <form
        className={`wsp-filter${filterState}`}
        onSubmit={(e) => {
          e.preventDefault()
          applyExpr(expr)
        }}
      >
        <input spellCheck={false} autoComplete="off" placeholder="Apply a display filter ... for example  eapol  or  wlan.addr == 02:00:00:00:02:00  or  icmp" value={expr} onChange={(e) => setExpr(e.target.value)} aria-label="Display filter" />
        {expr && (
          <button type="button" className="clear" onClick={() => applyExpr('')} title="Clear filter">
            ×
          </button>
        )}
        <button type="submit" className="apply" title="Apply filter">
          →
        </button>
        <select value={join} onChange={(e) => setJoin(e.target.value as typeof join)} className="join" aria-label="How a chosen filter is combined with the current one" title="How a filter chosen from the list, or Apply as filter, is combined with the one in the box">
          <option value="replace">Replace</option>
          <option value="and">and</option>
          <option value="or">or</option>
          <option value="andnot">and not</option>
        </select>
        <select value="" onChange={(e) => e.target.value && addExpr(e.target.value)} aria-label="Saved filters">
          <option value="">Filters</option>
          {FILTERS.map(([label, f]) => (
            <option key={label} value={f}>
              {label}
            </option>
          ))}
          {nodeMacs.map(({ name, expr: e }) => (
            <option key={name} value={e}>
              Frames to or from {name}
            </option>
          ))}
        </select>
      </form>
      {filterError && <div className="wsp-error">{filterError}</div>}

      <div className="wsp-body">
        <div className="wsp-left">
          <div className="wsp-pane" style={{ height: listH, flex: 'none' }}>
            <PacketList
              rows={rows}
              selected={selectedFrame?.src === src ? selectedFrame.n : null}
              onSelect={(n) => {
                setFollow(false)
                setState({ selectedFrame: { src, n } })
              }}
              follow={follow}
              onFollow={setFollow}
              timeFormat={timeFormat}
              showSignal={hasSignal}
              resolve={resolve}
              macs={macs}
              emptyText={pastLoading ? 'Loading the saved capture...' : applied && !filterError ? (matches?.key === filterKey ? 'No packet matches the display filter.' : 'Applying the display filter...') : hasRun ? 'Waiting for frames...' : 'Start the lab to capture real 802.11 frames from the virtual radios.'}
            />
          </div>
          <Splitter axis="y" value={listH} onChange={setListH} min={80} max={Math.max(120, panelH - 220)} />
          <div className="wsp-lower">
          <div className="wsp-pane details">
            <div className="wsp-title">
              Packet details
              {detail && (
                <span className="tools">
                  <button onClick={() => setOpen(allBranches(detail.tree))}>Expand all</button>
                  <button onClick={() => setOpen(new Set())}>Collapse all</button>
                </span>
              )}
            </div>
            <div className="wsp-scroll">
              {detail ? (
                <PacketDetails
                  tree={detail.tree}
                  open={open}
                  selected={selPath ? pathKey(selPath) : null}
                  onToggle={(k) =>
                    setOpen((o) => {
                      const next = new Set(o)
                      if (!next.delete(k)) next.add(k)
                      return next
                    })
                  }
                  onSelect={setSelPath}
                />
              ) : (
                <div className="wsp-hint">{detailError ?? (selectedFrame ? 'Dissecting...' : 'Select a packet to see its protocol tree, the same one Wireshark shows.')}</div>
              )}
            </div>
          </div>
          <Splitter axis="x" value={hexW} onChange={setHexW} min={230} max={1000} invert />
          <div className="wsp-pane hex" style={{ width: hexW }}>
          <div className="wsp-title">
            Packet bytes
            {detail && (
              <span className="tools">
                <span className="segmented small">
                  <button className={decrypted ? 'on' : ''} onClick={() => setDecrypted(true)}>
                    Decrypted
                  </button>
                  <button className={!decrypted ? 'on' : ''} onClick={() => setDecrypted(false)} title="The bytes exactly as they were on the air">
                    As heard
                  </button>
                </span>
              </span>
            )}
          </div>
          <div className="wsp-scroll">
            {detail ? (
              <HexView
                hex={detail.hex}
                radiotapLen={detail.radiotap_len}
                sel={selNode ? { p: selNode.p, s: selNode.s } : null}
                onPick={(b) => {
                  const path = pathForByte(detail.tree, b)
                  if (path) pick(path)
                }}
              />
            ) : (
              <div className="wsp-hint">Click a field to highlight its bytes, or click a byte to find its field.</div>
            )}
          </div>
          {detail && selFrame && !selFrame.dec && <div className="wsp-explain muted">This frame was not encrypted, so both views are the same.</div>}
          </div>
          </div>
        </div>
      </div>

      <div className="wsp-status">
        <span>Packets: {liveCount}</span>
        <span>
          Displayed: {rows.length} ({liveCount ? ((rows.length / liveCount) * 100).toFixed(1) : '0.0'}%)
        </span>
        <span>Decrypted: {decryptedCount}</span>
        {paused && <span className="warn">Display paused</span>}
        {viewRun ? <span>Saved capture</span> : labState === 'running' ? captureStopped ? <span className="warn">Capture stopped: the client finished roaming</span> : capturePaused ? (
          <span className="warn">
            Recording paused: the client is connected, so no more beacons are stored.{' '}
            <button className="link" onClick={() => void api.captureResume().catch((e: Error) => toast(e.message))}>
              Resume recording
            </button>
          </span>
        ) : <span>Capturing</span> : liveCount > 0 && <span className="warn">Capture stopped</span>}
        <span className="grow">
          {selNode ? (
            <>
              {selNode.l.length > 80 ? `${selNode.l.slice(0, 80)}…` : selNode.l}
              {selNode.f && ` (${selNode.f})`}, {selNode.s} byte{selNode.s === 1 ? '' : 's'}
              {selNode.f && (
                <button className="link" onClick={() => addExpr(filterFor(selNode))}>
                  Apply as filter
                </button>
              )}
            </>
          ) : selectedFrame ? (
            `Frame ${selectedFrame.n}`
          ) : (
            ''
          )}
        </span>
      </div>
      <Splitter axis="y" value={panelH} onChange={setPanelH} min={420} max={1600} />
    </div>
  )
}
