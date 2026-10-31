import { useEffect, useRef } from 'react'

const hexByte = (h: string, i: number) => h.slice(i * 2, i * 2 + 2)
const ascii = (h: string, i: number) => {
  const c = parseInt(hexByte(h, i), 16)
  return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'
}

interface Props {
  hex: string
  radiotapLen: number
  /** Byte range of the selected field in the details tree. */
  sel: { p: number; s: number } | null
  onPick: (byte: number) => void
}

// Wireshark's "Packet bytes": offset, 16 hex bytes in two groups of eight, then the ASCII rendering.
export function HexView({ hex, radiotapLen, sel, onPick }: Props) {
  const total = hex.length / 2
  const rows = Math.ceil(total / 16)
  const first = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    first.current?.scrollIntoView({ block: 'nearest' })
  }, [sel?.p, sel?.s])

  const on = (i: number) => sel !== null && sel.s > 0 && i >= sel.p && i < sel.p + sel.s

  return (
    <div className="hexview" aria-label="Packet bytes">
      {Array.from({ length: rows }, (_, r) => {
        const n = Math.min(16, total - r * 16)
        return (
          <div key={r} className="hx-row">
            <span className="hx-off">{(r * 16).toString(16).padStart(4, '0')}</span>
            <span className="hx-bytes">
              {Array.from({ length: n }, (_, c) => {
                const i = r * 16 + c
                return (
                  <span key={c} ref={i === sel?.p ? first : undefined} className={`hb${c === 8 ? ' gap' : ''}${i < radiotapLen ? ' rt' : ''}${on(i) ? ' hl' : ''}`} onClick={() => onPick(i)}>
                    {hexByte(hex, i)}
                  </span>
                )
              })}
            </span>
            <span className="hx-ascii">
              {Array.from({ length: n }, (_, c) => {
                const i = r * 16 + c
                return (
                  <span key={c} className={on(i) ? 'hl' : ''} onClick={() => onPick(i)}>
                    {ascii(hex, i)}
                  </span>
                )
              })}
            </span>
          </div>
        )
      })}
    </div>
  )
}
