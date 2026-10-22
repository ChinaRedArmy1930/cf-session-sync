// Checks the environment fallbacks that let a fresh machine come online from a
// dotfile alone: CF_SYNC_ENDPOINT for the endpoint, CF_SESSION_SYNC_TOKEN for
// the secret (resolved by the credential service, stubbed here).
//
//   node test/env-fallback.mjs

process.env.CF_SYNC_ENDPOINT = 'https://example.test/base/'

const { apply } = await import('../index.js')

const routes = new Map()
const listeners = new Map()

const ctx = {
  get(name) {
    return services[name]
  },
  on(name, listener) {
    listeners.set(name, listener)
    return () => {}
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  timeout(callback, delay) {
    const handle = setTimeout(callback, delay)
    return () => clearTimeout(handle)
  },
}

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

apply(ctx, { syncOnStart: false, autoSync: false, token: 'from-config' })

function call(route, request) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 0,
      body: '',
      writeHead(status) {
        this.statusCode = status
      },
      end(body) {
        this.body = body || ''
        resolve(this)
      },
    }
    Promise.resolve(route.handler(request, response)).catch(reject)
  })
}

const status = routes.get('/cf-sync/status')
if (!status) throw new Error('status route missing')

const response = await call(status, { method: 'GET', url: '/cf-sync/status', headers: {} })
const payload = JSON.parse(response.body)

const checks = [
  ['endpoint comes from CF_SYNC_ENDPOINT', payload.endpoint === 'https://example.test/base'],
  ['trailing slash trimmed', !String(payload.endpoint).endsWith('/')],
  ['configured from the config token fallback', payload.configured === true],
  ['token source is config', payload.tokenSource === 'config'],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failed += 1
}

console.log('\npayload:', JSON.stringify({ endpoint: payload.endpoint, configured: payload.configured, tokenSource: payload.tokenSource }))
process.exit(failed ? 1 : 0)
