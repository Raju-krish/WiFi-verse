import type { TreeNode } from '../types'

export const pathKey = (path: number[]) => path.join('.')

export function nodeAt(tree: TreeNode[], path: number[]): TreeNode | null {
  let list = tree
  let node: TreeNode | null = null
  for (const i of path) {
    node = list[i] ?? null
    if (!node) return null
    list = node.c ?? []
  }
  return node
}

/** Deepest field covering a byte, like clicking a byte in Wireshark's hex pane. */
export function pathForByte(tree: TreeNode[], byte: number): number[] | null {
  let best: { path: number[]; size: number } | null = null
  const walk = (list: TreeNode[], prefix: number[]) =>
    list.forEach((n, i) => {
      const path = [...prefix, i]
      if (n.s > 0 && byte >= n.p && byte < n.p + n.s && (!best || n.s <= best.size)) best = { path, size: n.s }
      if (n.c) walk(n.c, path)
    })
  walk(tree, [])
  return (best as { path: number[] } | null)?.path ?? null
}

/** Everything starts collapsed except the 802.11 Wireless Management header, opened one level only. */
export function defaultOpen(tree: TreeNode[]): Set<string> {
  const open = new Set<string>()
  tree.forEach((n, i) => {
    if (n.f === 'wlan.mgt' || n.l.includes('Wireless Management')) open.add(String(i))
  })
  return open
}

export function allBranches(tree: TreeNode[]): Set<string> {
  const open = new Set<string>()
  const walk = (list: TreeNode[], prefix: number[]) =>
    list.forEach((n, i) => {
      if (n.c?.length) {
        open.add(pathKey([...prefix, i]))
        walk(n.c, [...prefix, i])
      }
    })
  walk(tree, [])
  return open
}

interface Props {
  tree: TreeNode[]
  open: Set<string>
  selected: string | null
  onToggle: (key: string) => void
  onSelect: (path: number[]) => void
}

export function PacketDetails({ tree, open, selected, onToggle, onSelect }: Props) {
  const rows: React.ReactNode[] = []
  const walk = (list: TreeNode[], prefix: number[], depth: number) =>
    list.forEach((n, i) => {
      const path = [...prefix, i]
      const key = pathKey(path)
      const branch = !!n.c?.length
      const isOpen = open.has(key)
      rows.push(
        <div
          key={key}
          className={`pd-row${selected === key ? ' sel' : ''}${depth === 0 ? ' pd-top' : ''}${branch ? ' branch' : ''}`}
          style={{ paddingLeft: 6 + depth * 16 }}
          onClick={() => onSelect(path)}
          onDoubleClick={() => branch && onToggle(key)}
        >
          <span
            className={`pd-arrow${branch ? '' : ' leaf'}`}
            onClick={(e) => {
              e.stopPropagation()
              if (branch) onToggle(key)
            }}
          >
            {branch ? (isOpen ? '▾' : '▸') : ''}
          </span>
          <span className="pd-label">{n.l}</span>
        </div>,
      )
      if (branch && isOpen) walk(n.c!, path, depth + 1)
    })
  walk(tree, [], 0)
  return <div className="pd">{rows}</div>
}
