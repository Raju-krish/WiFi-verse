import { useSyncExternalStore } from 'react'
import type { MouseEvent, ReactNode } from 'react'

export type Route = '/' | '/ft' | '/connect' | '/errors' | '/playground'
const KNOWN: Route[] = ['/', '/ft', '/connect', '/errors', '/playground']

function current(): Route {
  const path = location.pathname.replace(/\/+$/, '') || '/'
  return (KNOWN as string[]).includes(path) ? (path as Route) : '/'
}

const listeners = new Set<() => void>()
window.addEventListener('popstate', () => listeners.forEach((l) => l()))

export function navigate(path: Route): void {
  if (path !== current()) {
    history.pushState(null, '', path)
    listeners.forEach((l) => l())
  }
  window.scrollTo(0, 0)
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    current,
  )
}

export function Link({ to, className, children, title }: { to: Route; className?: string; children: ReactNode; title?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(to)
  }
  return (
    <a href={to} className={className} title={title} onClick={onClick}>
      {children}
    </a>
  )
}
