import type { Channel, NodeCfg, Security } from './types'

export const SECURITY_INFO: Record<Security, { label: string; data: string; pmf: string }> = {
  open: { label: 'Open', data: 'not encrypted', pmf: 'no' },
  owe: { label: 'OWE (Enhanced Open)', data: 'encrypted (CCMP)', pmf: 'yes, required' },
  'wpa2-psk': { label: 'WPA2-Personal', data: 'encrypted (CCMP)', pmf: 'no (optional)' },
  'wpa3-sae': { label: 'WPA3-Personal (SAE)', data: 'encrypted (CCMP)', pmf: 'yes, required' },
  'ft-psk': { label: 'FT-PSK (802.11r)', data: 'encrypted (CCMP)', pmf: 'no (optional)' },
}

// wmediumd: RSSI = tx + 2 x 5 dBi antenna gain - (free-space loss at 1 m + 10 n log10(distance))
const PL0_DB = 40.2
const GAIN_DB = 10

export const CHANNEL_COLOR: Record<Channel, string> = { 1: '#2563eb', 6: '#16a34a', 11: '#d97706' }

// One colour per access point, so two APs on the same channel stay apart.
const AP_COLORS = ['#2563eb', '#db2777', '#0d9488', '#8b5e34', '#ea580c', '#0891b2']
export function apColor(nodes: NodeCfg[], id: string): string {
  const i = nodes.filter((n) => n.kind === 'ap').findIndex((n) => n.id === id)
  return AP_COLORS[Math.max(i, 0) % AP_COLORS.length]
}
export const ROAM_COLORS = { ft: '#059669', psk: '#d97706' }

export function modelRssi(txDbm: number, distanceM: number, exponent: number): number {
  const d = Math.max(distanceM, 1)
  return txDbm + GAIN_DB - PL0_DB - 10 * exponent * Math.log10(d)
}

export function rangeFor(rssiDbm: number, txDbm: number, exponent: number): number {
  return Math.pow(10, (txDbm + GAIN_DB - PL0_DB - rssiDbm) / (10 * exponent))
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function signalColor(rssi: number | null): string {
  if (rssi === null) return '#94a3b8'
  if (rssi >= -60) return '#16a34a'
  if (rssi >= -70) return '#65a30d'
  if (rssi >= -78) return '#d97706'
  return '#dc2626'
}

export function nextId(nodes: NodeCfg[], kind: NodeCfg['kind']): string {
  const prefix = { ap: 'ap', sta: 'sta', sniffer: 'snf' }[kind]
  for (let i = 1; ; i++) if (!nodes.some((n) => n.id === `${prefix}${i}`)) return `${prefix}${i}`
}

export const LIMITS = { ap: 6, sta: 6, sniffer: 4 } as const

export function fmtMs(v: number | undefined): string {
  return v === undefined ? '-' : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`
}

export function modeLabel(mode: string): string {
  return mode === 'ft-psk' ? 'FT (802.11r)' : (SECURITY_INFO[mode as Security]?.label ?? mode)
}
