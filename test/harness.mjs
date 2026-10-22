// Offline harness for the cf-session-sync Host half: stub Cordis services,
// a real HTTP route table, and worker/mock.mjs, so the sync engine can be
// exercised without installing anything.
//
//   node worker/mock.mjs &        # 127.0.0.1:8787, token "test"
//   node test/harness.mjs

import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'

const WORKER = process.env.WORKER || 'http://127.0.0.1:8787'
const TOKEN = process.env.SYNC_TOKEN || 'test'
const ROUTE_PORT = Number(process.env.ROUTE_PORT || 8899)

function eventsFor(id, count) {
  const events = []
  for (let seq = 0; seq < count; seq += 1) {
    const type = seq % 3 === 0 ? 'user/message' : seq % 3 === 1 ? 'assistant/message' : 'tool/result'
    const data =
      type === 'user/message'
        ? { role: 'user', message: { role: 'user', content: [{ type: 'text', text: `hello ${seq}` }] } }
        : type === 'assistant/message'
          ? { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `reply ${seq}` }] }, stream: [] }
          : { turn: 1, step: 1, message: { role: 'tool', toolCallId: `call-${seq}`, content: [{ type: 'text', text: `ok ${seq}` }] } }
    events.push({ type, seq, time: 1700000000000 + seq * 1000, data })
  }
  return events
}

const SESSIONS = new Map()
function addSession(id, count, extra = {}) {
  const events = eventsFor(id, count)
  SESSIONS.set(id, {
    session: { version: 4, id, createdAt: 1700000000000, cwd: '/work/demo', ...extra },
    inheritedEventCount: 0,
    events,
  })
}
addSession('session-11111111-1111-4111-8111-111111111111', 6)
addSession('session-22222222-2222-4222-8222-222222222222', 800)

const listeners = new Map()
const routes = new Map()

function makeContext(services) {
  const disposers = []
  const ctx = {
    ...services,
    get: (name) => services[name],
    on: (name, listener) => {
      const list = listeners.get(name) || []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep])) return undefined
      return callback(makeContext(services))
    },
    timeout: (callback, delay) => {
      const handle = setTimeout(callback, delay)
      return () => clearTimeout(handle)
    },
    disposeAll: () => disposers.forEach((dispose) => dispose()),
  }
  return ctx
}

const sessionQuery = {
  async listSessions() {
    return [...SESSIONS.entries()].map(([id, snapshot]) => ({
      header: snapshot.session,
      live: false,
      persisted: true,
    }))
  },
  async readSession(id) {
    const snapshot = SESSIONS.get(id)
    if (!snapshot) throw new Error(`missing session ${id}`)
    return structuredClone(snapshot)
  },
  async readTitleSnapshots(ids) {
    return ids.map((sessionId) => ({
      sessionId,
      status: 'fulfilled',
      value: { session: SESSIONS.get(sessionId).session, title: { title: `Demo ${sessionId.slice(8, 16)}` } },
    }))
  },
}

async function serveRoutes(routes) {
  const server = createServer(async (request, response) => {
    const path = (request.url || '/').split('?')[0]
    const route = routes.get(path)
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    await route.handler(request, response)
  })
  await new Promise((resolve) => server.listen(ROUTE_PORT, '127.0.0.1', resolve))
  return server
}

const vault = new Map([['CF_SESSION_SYNC_TOKEN', TOKEN]])
const credentials = {
  async resolve(ref) {
    const value = vault.get(ref)
    return value ? { value, source: 'credential-store' } : undefined
  },
  async set(ref, value) {
    vault.set(ref, value)
  },
  async unset(ref) {
    vault.delete(ref)
  },
}

const webServer = {
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}

const ctx = makeContext({ sessionQuery, webServer, credentials })
apply(ctx, {
  endpoint: WORKER,
  token: '',
  device: 'harness',
  syncOnStart: false,
  autoSync: true,
  debounceMs: 150,
  maxEventsPerRequest: 300,
})

const server = await serveRoutes(routes)

async function get(path) {
  const response = await fetch(`http://127.0.0.1:${ROUTE_PORT}${path}`)
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function postJson(path, body) {
  const response = await fetch(`http://127.0.0.1:${ROUTE_PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cf-sync': '1' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function post(path, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${ROUTE_PORT}${path}`, { method: 'POST', headers })
  return { status: response.status, body: await response.json().catch(() => null) }
}

function report(step, value) {
  console.log(`\n== ${step} ==`)
  console.log(JSON.stringify(value, null, 2))
}

report('1. status before any sync', await get('/cf-sync/status'))

report('2. POST /cf-sync/run without the guard header', await post('/cf-sync/run'))

const start = await post('/cf-sync/run', { 'x-cf-sync': '1' })
report('3. POST /cf-sync/run', start)

async function waitRun(previous, label) {
  for (let tick = 0; tick < 200; tick += 1) {
    const status = await get('/cf-sync/status?refresh=1')
    if (!status.body.running && status.body.lastRunAt && status.body.lastRunAt !== previous) {
      report(label, status.body)
      return status.body
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${label}: timed out`)
}

const first = await waitRun(null, '4. status after full sync')

// Second pass must be a no-op (digest match), proving incremental behaviour.
await post('/cf-sync/run', { 'x-cf-sync': '1' })
const second = await waitRun(first.lastRunAt, '5. status after a second (no-op) pass')
report('5b. second pass result only', second.lastResult)

// Append a turn to one session and let the turn/end listener pick it up.
const target = 'session-11111111-1111-4111-8111-111111111111'
const snapshot = SESSIONS.get(target)
snapshot.events.push(
  { type: 'user/message', seq: 6, time: 1700000006000, data: { role: 'user', message: { role: 'user', content: [{ type: 'text', text: 'second turn' }] } } },
  { type: 'turn/end', seq: 7, time: 1700000007000, data: { turn: 2, reason: { kind: 'completed' } } },
)

console.log('\n== 6. emitting session/event turn/end ==')
for (const listener of listeners.get('session/event') || []) {
  listener({ id: target }, { type: 'turn/end', seq: 7, time: 1700000007000, data: { turn: 2 } })
}

for (let tick = 0; tick < 120; tick += 1) {
  const status = await get('/cf-sync/status')
  if (!status.body.running && status.body.lastResult && status.body.lastResult.reason === 'auto') {
    report('7. status after automatic incremental sync', status.body.lastResult)
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}

const cursors = await fetch(`${WORKER}/api/cursors`, { headers: { authorization: `Bearer ${TOKEN}` } })
report('8. worker cursors', await cursors.json())

// --- credential-store path -------------------------------------------------
report('9. token source before touching the store', await get('/cf-sync/status'))

report(
  '10. POST /cf-sync/token (store a new token)',
  await postJson('/cf-sync/token', { token: 'rotated-token' }),
)
report('11. status after storing', await get('/cf-sync/status'))
console.log('vault now holds:', [...vault.keys()], 'value is rotated:', vault.get('CF_SESSION_SYNC_TOKEN') === 'rotated-token')

report(
  '12. POST /cf-sync/token (clear)',
  await postJson('/cf-sync/token', { token: '' }),
)
report('13. status after clearing', await get('/cf-sync/status'))
report('14. POST /cf-sync/run while unconfigured', await post('/cf-sync/run', { 'x-cf-sync': '1' }))

server.close()
ctx.disposeAll()
