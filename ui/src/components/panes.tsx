import { useEffect, useState } from 'react'

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function useStoredNumber(key: string, initial: number): [number, (v: number) => void] {
  const [value, setValue] = useState(() => {
    const saved = Number(localStorage.getItem(`wifilab.${key}`))
    return Number.isFinite(saved) && saved > 0 ? saved : initial
  })
  useEffect(() => {
    localStorage.setItem(`wifilab.${key}`, String(Math.round(value)))
  }, [key, value])
  return [value, setValue]
}

interface SplitterProps {
  axis: 'x' | 'y'
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  /** The pane being sized sits after the handle, so dragging towards the start grows it. */
  invert?: boolean
}

export function Splitter({ axis, value, onChange, min, max, invert }: SplitterProps) {
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const start = axis === 'x' ? e.clientX : e.clientY
    const base = value
    const move = (ev: PointerEvent) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start
      onChange(clamp(base + (invert ? -d : d), min, max))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  return <div className={`splitter ${axis}`} role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} onPointerDown={onDown} />
}
