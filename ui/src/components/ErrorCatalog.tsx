import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { REASON_ROWS, STATUS_ROWS } from '../data/dot11'
import type { CodeKind, CodeRow } from '../data/dot11'
import { FIELD_GUIDE, REASON_GROUPS, STATUS_GROUPS } from '../data/dot11Notes'
import type { LabHint } from '../data/dot11Notes'
import { editTopo, getState, setState, toast, useStore } from '../store'

const hex = (n: number) => `0x${n.toString(16).padStart(2, '0')}`

export function ErrorCatalog() {
  const focus = useStore((s) => s.codeFocus)
  const seen = useStore((s) => s.seenCodes)
  const running = useStore((s) => s.lab.state === 'running')
  const topo = useStore((s) => s.topo)
  const [kind, setKind] = useState<CodeKind>('status')
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<string | null>(null)
  const [reserved, setReserved] = useState(false)
  const [explained, setExplained] = useState(false)
  const [onlySeen, setOnlySeen] = useState(false)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map())
  const rows = kind === 'status' ? STATUS_ROWS : REASON_ROWS
  const groups = (kind === 'status' ? STATUS_GROUPS : REASON_GROUPS).map((g) => g.name)
  const seenList = seen[kind]

  // An attempt or a deauthentication can point at one code.
  useEffect(() => {
    if (!focus) return
    setKind(focus.kind)
    setQuery('')
    setGroup(null)
    setReserved(false)
    setExplained(false)
    setOnlySeen(false)
    setOpen(new Set([focus.code]))
    const t = setTimeout(() => rowRefs.current.get(`${focus.kind}${focus.code}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80)
    return () => clearTimeout(t)
  }, [focus])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (r.reserved && !reserved) return false
      if (group && r.group !== group) return false
      if (explained && !r.note) return false
      if (onlySeen && !seenList.includes(r.code)) return false
      if (!q) return true
      return String(r.code) === q || hex(r.code) === q || r.name.toLowerCase().includes(q) || (r.note?.plain.toLowerCase().includes(q) ?? false) || r.group.toLowerCase().includes(q)
    })
  }, [rows, query, group, reserved, explained, onlySeen, seenList])

  const tryHint = (h: LabHint) => {
    if (getState().lab.state !== 'stopped') return toast('Stop the lab to choose another scenario')
    editTopo((t) => ({ ...t, fault: h.fault, security: h.security }))
    document.getElementById('setup')?.scrollIntoView({ behavior: 'smooth' })
  }

  const send = async (r: CodeRow) => {
    const ap = topo.nodes.find((n) => n.kind === 'ap')
    const sta = topo.nodes.find((n) => n.kind === 'sta')
    if (!ap || !sta) return
    try {
      await api.deauth(ap.id, sta.id, 'deauth', r.code)
      toast(`Deauthentication with reason ${r.code} sent`)
      setState((s) => ({ connectTick: s.connectTick + 1 }))
    } catch (e) {
      toast((e as Error).message)
    }
  }

  const toggle = (code: number) =>
    setOpen((o) => {
      const n = new Set(o)
      if (!n.delete(code)) n.add(code)
      return n
    })

  return (
    <div className="catalog">
      <details className="field-guide">
        <summary>The causes met most often, and the code each one leaves</summary>
        <table className="cmp-table">
          <thead>
            <tr>
              <th>What happened</th>
              <th>What you see</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {FIELD_GUIDE.map((f) => (
              <tr key={f.symptom}>
                <td>
                  <b>{f.symptom}</b>
                </td>
                <td>{f.codes}</td>
                <td>{f.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <div className="log-tools">
        <div className="segmented small">
          <button className={kind === 'status' ? 'on' : ''} onClick={() => { setKind('status'); setGroup(null) }}>
            Status codes ({STATUS_ROWS.filter((r) => !r.reserved).length})
          </button>
          <button className={kind === 'reason' ? 'on' : ''} onClick={() => { setKind('reason'); setGroup(null) }}>
            Reason codes ({REASON_ROWS.filter((r) => !r.reserved).length})
          </button>
        </div>
        <input type="search" spellCheck={false} placeholder="Search by number, name or meaning, for example 15, handshake or PMF" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the codes" />
        <label className="check">
          <input type="checkbox" checked={explained} onChange={(e) => setExplained(e.target.checked)} /> Only with a plain explanation
        </label>
        <label className="check">
          <input type="checkbox" checked={onlySeen} onChange={(e) => setOnlySeen(e.target.checked)} /> Only seen in this run
        </label>
        {kind === 'status' && (
          <label className="check">
            <input type="checkbox" checked={reserved} onChange={(e) => setReserved(e.target.checked)} /> Show reserved
          </label>
        )}
      </div>
      <p className="muted">
        {kind === 'status'
          ? 'A status code is the access point’s answer inside an Authentication or (Re)Association Response frame. 0 means success; anything else is a refusal.'
          : 'A reason code is carried by a Deauthentication or Disassociation frame, from either side. It says why the relationship is ending; it is not an answer to a request.'}
      </p>
      <div className="term-cmds">
        <button className={`chipbtn${group === null ? ' on' : ''}`} onClick={() => setGroup(null)}>
          All groups
        </button>
        {groups.map((g) => (
          <button key={g} className={`chipbtn${group === g ? ' on' : ''}`} onClick={() => setGroup(group === g ? null : g)}>
            {g}
          </button>
        ))}
      </div>

      <div className="catalog-scroll">
        <table className="cmp-table catalog-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name in the standard</th>
              <th>Group</th>
              <th>From</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const isOpen = open.has(r.code)
              const wasSeen = seenList.includes(r.code)
              return (
                <tr
                  key={`${r.kind}${r.code}`}
                  ref={(el) => {
                    if (el) rowRefs.current.set(`${r.kind}${r.code}`, el)
                  }}
                  className={`${isOpen ? 'on' : ''}${wasSeen ? ' seen' : ''}${r.reserved ? ' reserved' : ''}`}
                  onClick={() => toggle(r.code)}
                >
                  <td className="code-n">
                    <b>{r.code}</b>
                    <small>{hex(r.code)}</small>
                  </td>
                  <td>
                    {r.name}
                    {wasSeen && <span className="badge out-bad seen-badge">seen in this run</span>}
                    {isOpen && (
                      <div className="code-more">
                        <p>{r.note?.plain ?? 'Defined by the standard. It has no plain-language note here; the name above is the standard’s wording.'}</p>
                        <div className="btnrow">
                          {r.note?.labs?.map((h) => (
                            <button key={h.label} className="btn small" onClick={(e) => { e.stopPropagation(); tryHint(h) }}>
                              Reproduce: {h.label}
                            </button>
                          ))}
                          {r.kind === 'reason' && !r.reserved && (
                            <button className="btn small" disabled={!running} onClick={(e) => { e.stopPropagation(); void send(r) }} title="The AP sends a Deauthentication with this reason to the client">
                              Send it from the AP
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </td>
                  <td>{r.group}</td>
                  <td>{r.note?.from ?? ''}</td>
                  <td className="chev">{isOpen ? '▾' : '▸'}</td>
                </tr>
              )
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No code matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Names are the standard’s own wording, read from Wireshark’s dissector tables. Plain explanations are written for the codes you meet in practice; the rest are listed so the catalogue is complete. Codes added by later amendments (Wi-Fi 6 and 7) appear at the end.
      </p>
    </div>
  )
}
