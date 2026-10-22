// Checks that the shared secret can come from a file, which is what makes a
// fresh machine work from an iCloud or dotfiles path with no paste at all.
//
//   node test/token-file.mjs

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('../index.js')

const directory = mkdtempSync(join(tmpdir(), 'cf-sync-'))
const tokenFile = join(directory, 'cf-sync-token')
writeFileSync(tokenFile, '  token-from-a-synced-file\n', 'utf8')

const routes = new Map()
const services = {
  sessionQuery: {
    async listSessions() {
      return []
    },
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
}

const ctx = {
  get: (name) => services[name],
  on: () => () => {},
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  timeout: (callback, delay) => {
    const handle = setTimeout(callback, delay)
    return () => clearTimeout(handle)
  },
}

apply(ctx, { endpoint: 'https://example.test', tokenFile, syncOnStart: false, autoSync: false })

const status = routes.get('/cf-sync/status')
const response = await new Promise((resolve) => {
  status.handler(
    { method: 'GET', url: '/cf-sync/status', headers: {} },
    {
      writeHead() {},
      end(body) {
        resolve(JSON.parse(body || '{}'))
      },
    },
  )
})

const checks = [
  ['token read from tokenFile', response.tokenSource === 'token-file'],
  ['whitespace trimmed into a usable secret', response.configured === true],
  ['endpoint still from config', response.endpoint === 'https://example.test'],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failed += 1
}
console.log('\npayload:', JSON.stringify({ configured: response.configured, tokenSource: response.tokenSource }))
process.exit(failed ? 1 : 0)
