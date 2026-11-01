import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = resolve(import.meta.dirname, '..')
// The proxy adds the API token, so the browser never sees it and foreign pages cannot use it.
const token = readFileSync(resolve(root, '.token'), 'utf8').trim()

// Ports: UI_PORT here and scripts/labd.sh must agree, and API_PORT must match the API's port.
const uiPort = Number(process.env.UI_PORT ?? 5173)
const apiPort = Number(process.env.API_PORT ?? 8787)

// The API only accepts its own UI origins; the proxy presents the loopback one to LAN visitors.
const API_ORIGIN = `http://127.0.0.1:${uiPort}`

// Listens on every address of the machine so the UI works from any of its IPs. The proxy below attaches the API
// token and there is no login, so use a trusted network, or UI_HOST=127.0.0.1 to keep it local.
const host = process.env.UI_HOST ?? '0.0.0.0'
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.warn(`Wi-Fi Verse UI listens on ${host}:${uiPort} with no login: anyone who can reach it controls the lab. Use UI_HOST=127.0.0.1 to restrict it.`)
}

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port: uiPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        ws: true,
        changeOrigin: true,
        headers: { Authorization: `Bearer ${token}` },
        configure(proxy) {
          // A page served from this dev server is trusted; any other origin is passed on untouched and refused.
          const own = (req: IncomingMessage) => req.headers.origin === `http://${req.headers.host}`
          proxy.on('proxyReq', (proxyReq, req) => own(req) && proxyReq.setHeader('Origin', API_ORIGIN))
          proxy.on('proxyReqWs', (proxyReq, req) => own(req) && proxyReq.setHeader('Origin', API_ORIGIN))
        },
      },
    },
  },
})
