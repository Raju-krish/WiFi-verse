import { REASON_CODES, STATUS_CODES } from './dot11Codes'
import { REASON_GROUPS, REASON_NOTES, STATUS_GROUPS, STATUS_NOTES, groupOf } from './dot11Notes'
import type { Note } from './dot11Notes'

export type CodeKind = 'status' | 'reason'

export interface CodeRow {
  kind: CodeKind
  code: number
  name: string
  reserved: boolean
  group: string
  note?: Note
}

const rows = (kind: CodeKind): CodeRow[] =>
  (kind === 'status' ? STATUS_CODES : REASON_CODES).map(([code, name]) => ({
    kind,
    code,
    name,
    reserved: name === 'Reserved',
    group: groupOf(kind === 'status' ? STATUS_GROUPS : REASON_GROUPS, code),
    note: (kind === 'status' ? STATUS_NOTES : REASON_NOTES)[code],
  }))

export const STATUS_ROWS = rows('status')
export const REASON_ROWS = rows('reason')

const statusMap = new Map(STATUS_ROWS.map((r) => [r.code, r]))
const reasonMap = new Map(REASON_ROWS.map((r) => [r.code, r]))

export const lookup = (kind: CodeKind, code: number): CodeRow | undefined => (kind === 'status' ? statusMap : reasonMap).get(code)

/** A short label such as "status 1: Unspecified failure". */
export function codeLabel(kind: CodeKind, code: number): string {
  const r = lookup(kind, code)
  const name = r ? (r.name.length > 70 ? `${r.name.slice(0, 68)}…` : r.name) : 'not defined by the standard'
  return `${kind} ${code}: ${name}`
}
