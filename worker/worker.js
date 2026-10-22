/**
 * Cloudflare Worker: receive DeepSeek Harness session logs and serve a read-only viewer.
 *
 * Bindings
 *   DB          D1 database (see schema.sql)
 *   SYNC_TOKEN  secret shared with the Harness plugin (wrangler secret put SYNC_TOKEN)
 *
 * API (all require `Authorization: Bearer <SYNC_TOKEN>`)
 *   GET  /api/health    counts
 *   GET  /api/cursors   per-session high-water marks, used for incremental sync
 *   POST /api/sync      upsert sessions + events
 */

import { esc, renderDetail, renderList, renderLogin, renderMissing } from './render.js'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const EVENT_RENDER_LIMIT = 2000
const LIST_LIMIT = 500
const BATCH_STATEMENTS = 90

function json(value, status = 200) {
  return new Response(`${JSON.stringify(value)}\n`, { status, headers: JSON_HEADERS })
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function numberOr(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return 0
}

function authorized(request, env) {
  const header = request.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return Boolean(env.SYNC_TOKEN) && Boolean(match) && match[1].trim() === env.SYNC_TOKEN
}

function cookieToken(request) {
  const cookie = request.headers.get('cookie') || ''
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === 'cf_sync') return decodeURIComponent(part.slice(index + 1).trim())
  }
  return ''
}

function viewerAuthorized(request, url, env) {
  if (!env.SYNC_TOKEN) return false
  const query = url.searchParams.get('t')
  if (query && query === env.SYNC_TOKEN) return true
  if (cookieToken(request) === env.SYNC_TOKEN) return true
  const header = request.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (match && match[1].trim() === env.SYNC_TOKEN) return true
  return false
}

async function health(env) {
  const sessions = await env.DB.prepare('SELECT COUNT(*) AS count FROM sessions').first()
  const events = await env.DB.prepare('SELECT COUNT(*) AS count FROM events').first()
  return json({
    ok: true,
    version: '1',
    sessions: sessions ? Number(sessions.count) || 0 : 0,
    events: events ? Number(events.count) || 0 : 0,
  })
}

async function cursors(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, last_seq, event_count, digest, synced_at FROM sessions',
  ).all()
  const output = {}
  for (const row of results || []) {
    output[row.id] = {
      lastSeq: Number(row.last_seq),
      eventCount: Number(row.event_count),
      syncedAt: Number(row.synced_at),
      digest: row.digest === null || row.digest === undefined ? null : String(row.digest),
    }
  }
  return json({ ok: true, cursors: output })
}

async function applySession(env, device, incoming, now) {
  const id = String(incoming && incoming.id ? incoming.id : '').trim()
  if (!id) throw new Error('missing session id')
  const header = incoming.header && typeof incoming.header === 'object' ? incoming.header : {}
  const events = Array.isArray(incoming.events)
    ? incoming.events.filter((event) => event && Number.isInteger(event.seq))
    : []
  const mode = incoming.mode === 'append' ? 'append' : 'full'
  const createdAt = numberOr(incoming.createdAt, header.createdAt, now)
  const updatedAt = numberOr(incoming.updatedAt, createdAt)
  const title = typeof incoming.title === 'string' ? incoming.title : null
  const cwd = typeof incoming.cwd === 'string' ? incoming.cwd : typeof header.cwd === 'string' ? header.cwd : null
  const parentId = typeof header.parentSession === 'string' ? header.parentSession : null
  const agentPreset = typeof header.agentPreset === 'string' ? header.agentPreset : null
  const digest = typeof incoming.digest === 'string' ? incoming.digest : null

  const statements = []
  if (mode === 'full') {
    statements.push(env.DB.prepare('DELETE FROM events WHERE session_id = ?').bind(id))
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO sessions (id, device, title, cwd, parent_id, created_at, updated_at, agent_preset,
         event_count, last_seq, digest, header_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, -1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         device = excluded.device,
         title = COALESCE(excluded.title, sessions.title),
         cwd = COALESCE(excluded.cwd, sessions.cwd),
         parent_id = COALESCE(excluded.parent_id, sessions.parent_id),
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         agent_preset = COALESCE(excluded.agent_preset, sessions.agent_preset),
         digest = excluded.digest,
         header_json = excluded.header_json,
         synced_at = excluded.synced_at`,
    ).bind(
      id,
      device,
      title,
      cwd,
      parentId,
      createdAt,
      updatedAt,
      agentPreset,
      digest,
      JSON.stringify(header),
      now,
    ),
  )
  for (const event of events) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO events (session_id, seq, type, time, payload) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, seq) DO UPDATE SET
           type = excluded.type, time = excluded.time, payload = excluded.payload`,
      ).bind(id, event.seq, String(event.type || 'unknown'), numberOr(event.time, now), JSON.stringify(event)),
    )
  }
  statements.push(
    env.DB.prepare(
      `UPDATE sessions SET
         event_count = (SELECT COUNT(*) FROM events WHERE session_id = ?1),
         last_seq = COALESCE((SELECT MAX(seq) FROM events WHERE session_id = ?1), -1),
         synced_at = ?2
       WHERE id = ?1`,
    ).bind(id, now),
  )

  for (let offset = 0; offset < statements.length; offset += BATCH_STATEMENTS) {
    await env.DB.batch(statements.slice(offset, offset + BATCH_STATEMENTS))
  }

  const row = await env.DB.prepare('SELECT event_count, last_seq FROM sessions WHERE id = ?').bind(id).first()
  return {
    id,
    lastSeq: row ? Number(row.last_seq) : -1,
    eventCount: row ? Number(row.event_count) : 0,
    imported: events.length,
  }
}

async function sync(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)
  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'bad request' }, 400)
  }
  if (!body || !Array.isArray(body.sessions)) return json({ ok: false, error: 'bad request' }, 400)
  const device = typeof body.device === 'string' && body.device ? body.device.slice(0, 120) : 'unknown'
  const now = Date.now()
  const results = []
  const errors = []
  for (const incoming of body.sessions) {
    try {
      results.push(await applySession(env, device, incoming, now))
    } catch (error) {
      errors.push({
        id: String(incoming && incoming.id ? incoming.id : ''),
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return json(errors.length ? { ok: true, results, errors } : { ok: true, results })
}

async function listSessions(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, cwd, device, created_at, updated_at, event_count, last_seq
     FROM sessions ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(LIST_LIMIT)
    .all()
  return results || []
}

async function loadSession(env, id) {
  const session = await env.DB.prepare(
    `SELECT id, title, cwd, device, created_at, updated_at, event_count, last_seq, agent_preset, header_json
     FROM sessions WHERE id = ?`,
  )
    .bind(id)
    .first()
  if (!session) return { session: null, events: [] }
  const { results } = await env.DB.prepare(
    'SELECT seq, type, time, payload FROM events WHERE session_id = ? ORDER BY seq LIMIT ?',
  )
    .bind(id, EVENT_RENDER_LIMIT)
    .all()
  const events = (results || []).map((row) => {
    try {
      return JSON.parse(row.payload)
    } catch {
      return { type: row.type, seq: row.seq, time: row.time, data: { raw: String(row.payload).slice(0, 400) } }
    }
  })
  return { session, events }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/healthz') return new Response('ok\n', { headers: { 'content-type': 'text/plain' } })

    if (path === '/api/health' || path === '/api/cursors' || path === '/api/sync') {
      if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401)
      try {
        if (path === '/api/health') return await health(env)
        if (path === '/api/cursors') return await cursors(env)
        return await sync(request, env)
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
      }
    }

    if (!viewerAuthorized(request, url, env)) return html(renderLogin(), 401)

    // A token in the query string mints the cookie once, then leaves a clean URL.
    if (url.searchParams.get('t')) {
      const clean = new URL(url.toString())
      clean.searchParams.delete('t')
      return new Response(null, {
        status: 302,
        headers: {
          location: `${clean.pathname}${clean.search}`,
          'set-cookie': `cf_sync=${encodeURIComponent(env.SYNC_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
          'cache-control': 'no-store',
        },
      })
    }

    try {
      if (path === '/') return html(renderList(await listSessions(env)))
      if (path.startsWith('/s/')) {
        const id = decodeURIComponent(path.slice(3))
        const { session, events } = await loadSession(env, id)
        if (!session) return html(renderMissing(id), 404)
        return html(renderDetail(session, events, Number(session.event_count) > events.length))
      }
      return html(renderMissing(path), 404)
    } catch (error) {
      return html(
        `<!doctype html><meta charset="utf-8"><title>Error</title><pre>${esc(
          error instanceof Error ? error.message : String(error),
        )}</pre>`,
        500,
      )
    }
  },
}
