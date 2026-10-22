/**
 * Local stand-in for the Worker, so the Harness plugin can be exercised before
 * anything is deployed. Same HTTP API, same viewer, in-memory store.
 *
 *   node mock.mjs            # http://127.0.0.1:8787, token "test"
 *   PORT=9000 SYNC_TOKEN=abc node mock.mjs
 *
 * Point the plugin at      endpoint: 'http://127.0.0.1:8787'
 *                          token: 'test'
 * then open http://127.0.0.1:8787/?t=test
 */

import { createServer } from 'node:http'
import { renderDetail, renderList, renderLogin, renderMissing } from './render.js'

const PORT = Number(process.env.PORT || process.argv[2] || 8787)
const TOKEN = process.env.SYNC_TOKEN || 'test'

const sessions = new Map()
const events = new Map()

const key = (id, seq) => `${id}\u0000${seq}`

function json(response, status, value) {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function html(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body)
}

function authorized(request) {
  const header = request.headers.authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return Boolean(match) && match[1].trim() === TOKEN
}

function cookieToken(request) {
  const cookie = request.headers.cookie || ''
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === 'cf_sync') return decodeURIComponent(part.slice(index + 1).trim())
  }
  return ''
}

function numberOr(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return 0
}

function applySession(device, incoming, now) {
  const id = String((incoming && incoming.id) || '').trim()
  if (!id) throw new Error('missing session id')
  const header = incoming.header && typeof incoming.header === 'object' ? incoming.header : {}
  const list = Array.isArray(incoming.events) ? incoming.events.filter((event) => event && Number.isInteger(event.seq)) : []
  const mode = incoming.mode === 'append' ? 'append' : 'full'
  const previous = sessions.get(id)
  if (mode === 'full') {
    for (const stored of [...events.keys()]) {
      if (stored.startsWith(`${id}\u0000`)) events.delete(stored)
    }
  }
  for (const event of list) {
    events.set(key(id, event.seq), {
      seq: event.seq,
      type: String(event.type || 'unknown'),
      time: numberOr(event.time, now),
      payload: JSON.stringify(event),
    })
  }
  const stored = [...events.entries()].filter(([storedKey]) => storedKey.startsWith(`${id}\u0000`))
  const lastSeq = stored.length ? Math.max(...stored.map(([, value]) => value.seq)) : -1
  sessions.set(id, {
    id,
    device,
    title: typeof incoming.title === 'string' ? incoming.title : (previous && previous.title) || null,
    cwd: typeof incoming.cwd === 'string' ? incoming.cwd : (previous && previous.cwd) || null,
    parent_id: typeof header.parentSession === 'string' ? header.parentSession : null,
    created_at: numberOr(incoming.createdAt, header.createdAt, now),
    updated_at: numberOr(incoming.updatedAt, numberOr(incoming.createdAt, now)),
    agent_preset: typeof header.agentPreset === 'string' ? header.agentPreset : null,
    event_count: stored.length,
    last_seq: lastSeq,
    digest: typeof incoming.digest === 'string' ? incoming.digest : null,
    header_json: JSON.stringify(header),
    synced_at: now,
  })
  return { id, lastSeq, eventCount: stored.length, imported: list.length }
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const started = Date.now()
  let note = ''

  try {
    if (path === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok\n')
      return
    }

    if (path === '/api/health') {
      if (!authorized(request)) return json(response, 401, { ok: false, error: 'unauthorized' })
      note = `sessions=${sessions.size} events=${events.size}`
      return json(response, 200, { ok: true, version: '1', sessions: sessions.size, events: events.size })
    }

    if (path === '/api/cursors') {
      if (!authorized(request)) return json(response, 401, { ok: false, error: 'unauthorized' })
      const cursors = {}
      for (const session of sessions.values()) {
        cursors[session.id] = {
          lastSeq: session.last_seq,
          eventCount: session.event_count,
          syncedAt: session.synced_at,
          digest: session.digest,
        }
      }
      return json(response, 200, { ok: true, cursors })
    }

    if (path === '/api/sync') {
      if (!authorized(request)) return json(response, 401, { ok: false, error: 'unauthorized' })
      if (request.method !== 'POST') return json(response, 405, { ok: false, error: 'method not allowed' })
      const raw = await readBody(request)
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        return json(response, 400, { ok: false, error: 'bad request' })
      }
      if (!body || !Array.isArray(body.sessions)) return json(response, 400, { ok: false, error: 'bad request' })
      const device = typeof body.device === 'string' && body.device ? body.device : 'unknown'
      const now = Date.now()
      const results = []
      const errors = []
      for (const incoming of body.sessions) {
        try {
          results.push(applySession(device, incoming, now))
        } catch (error) {
          errors.push({ id: String((incoming && incoming.id) || ''), message: String(error && error.message) })
        }
      }
      note = `bytes=${Buffer.byteLength(raw)} imported=${results.reduce((sum, item) => sum + item.imported, 0)} device=${device}`
      return json(response, 200, errors.length ? { ok: true, results, errors } : { ok: true, results })
    }

    // --- viewer ---
    const queryToken = url.searchParams.get('t')
    const allowed = (queryToken && queryToken === TOKEN) || cookieToken(request) === TOKEN || authorized(request)
    if (!allowed) return html(response, 401, renderLogin())
    if (queryToken) {
      const clean = new URL(url.toString())
      clean.searchParams.delete('t')
      note = 'token accepted, redirecting'
      return html(response, 302, '', {
        location: `${clean.pathname}${clean.search}`,
        'set-cookie': `cf_sync=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      })
    }

    if (path === '/') {
      const rows = [...sessions.values()].sort((a, b) => b.created_at - a.created_at).slice(0, 500)
      note = `list=${rows.length}`
      return html(response, 200, renderList(rows))
    }

    if (path.startsWith('/s/')) {
      const id = decodeURIComponent(path.slice(3))
      const session = sessions.get(id)
      if (!session) return html(response, 404, renderMissing(id))
      const stored = [...events.entries()]
        .filter(([storedKey]) => storedKey.startsWith(`${id}\u0000`))
        .map(([, value]) => value)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, 2000)
      const parsed = stored.map((row) => {
        try {
          return JSON.parse(row.payload)
        } catch {
          return { type: row.type, seq: row.seq, time: row.time, data: {} }
        }
      })
      note = `detail=${id} events=${parsed.length}`
      return html(response, 200, renderDetail(session, parsed, session.event_count > parsed.length))
    }

    return html(response, 404, renderMissing(path))
  } finally {
    console.log(
      `${new Date().toISOString()} ${request.method} ${path} ${response.statusCode} ${Date.now() - started}ms ${note}`,
    )
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cf-session-sync mock worker on http://127.0.0.1:${PORT}`)
  console.log(`token: ${TOKEN}`)
  console.log(`viewer: http://127.0.0.1:${PORT}/?t=${TOKEN}`)
})
