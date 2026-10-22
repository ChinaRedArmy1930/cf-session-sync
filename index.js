/**
 * Cloudflare session sync — Host half.
 *
 * Copies every local Session log to the user's own Cloudflare Worker:
 * - `syncOnStart`: one full pass shortly after the plugin activates.
 * - `autoSync`: incremental pass for one Session after each of its turns closes.
 * - `POST /cf-sync/run`: manual pass, used by the Settings page button.
 *
 * The plugin keeps no local sync state. The Worker is the source of truth for
 * what it already holds (`GET /api/cursors`), so a reinstall, a second machine,
 * or a wiped profile simply resumes from the remote cursors.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

export const inject = ['sessionQuery', 'timer']

const VERSION = '1.0.0'
const STATUS_PATH = '/cf-sync/status'
const RUN_PATH = '/cf-sync/run'
const TOKEN_PATH = '/cf-sync/token'

function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  let device = text(raw.device)
  if (!device) {
    try {
      device = hostname() || 'dsh'
    } catch {
      device = 'dsh'
    }
  }
  // `CF_SYNC_ENDPOINT` lets a machine be configured purely from the environment:
  // together with the credential service's own CF_SESSION_SYNC_TOKEN fallback,
  // a synced dotfile is enough to bring a fresh machine online.
  const endpoint = text(raw.endpoint) || text(process.env.CF_SYNC_ENDPOINT)
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    token: text(raw.token),
    tokenRef: text(raw.tokenRef) || 'CF_SESSION_SYNC_TOKEN',
    // Optional file holding the secret (one trimmed line). Point it at an iCloud
    // Drive or dotfiles path and a new machine needs no paste at all.
    tokenFile: text(raw.tokenFile) || text(process.env.CF_SYNC_TOKEN_FILE),
    device,
    syncOnStart: raw.syncOnStart !== false,
    autoSync: raw.autoSync !== false,
    includeSubagents: raw.includeSubagents !== false,
    debounceMs: clampInt(raw.debounceMs, 500, 600000, 4000),
    maxEventsPerRequest: clampInt(raw.maxEventsPerRequest, 1, 2000, 300),
    requestTimeoutMs: clampInt(raw.requestTimeoutMs, 1000, 300000, 25000),
  }
}

/** Stable SHA-256 over the ordered raw event log. */
function digestOf(events) {
  const hash = createHash('sha256')
  for (const event of events) {
    hash.update(JSON.stringify(event))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/** Display-safe endpoint: no credentials, no query string. */
function safeEndpoint(endpoint) {
  if (!endpoint) return ''
  try {
    const url = new URL(endpoint)
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return endpoint
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const state = {
    running: false,
    lastRunAt: null,
    lastReason: null,
    lastError: null,
    lastResult: null,
    localCount: null,
    remote: null,
    routeError: null,
    tokenSource: null,
  }
  const timers = new Map()
  let listCache = { at: 0, records: [] }

  const tokenRef = cfg.tokenRef
  const hasEndpoint = () => Boolean(cfg.endpoint)

  /**
   * Resolve the shared secret at the start of every operation.
   *
   * Credential references name an environment-style key: the provider-managed
   * store wins, then ambient fallbacks (process environment, .env files). The
   * plugin's own `token` config stays as a last resort so an existing patch
   * keeps working, but the store is the intended home for it.
   */
  async function currentAuth() {
    const credentials = ctx.get('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(tokenRef)
        if (resolved && typeof resolved.value === 'string' && resolved.value) {
          return { token: resolved.value, source: resolved.source || 'credentials' }
        }
      } catch {
        // An absent or unreadable store falls through to the configured value.
      }
    }
    if (cfg.tokenFile) {
      try {
        const fromFile = readFileSync(cfg.tokenFile, 'utf8').trim()
        if (fromFile) return { token: fromFile, source: 'token-file' }
      } catch {
        // A missing or unreadable file behaves like an unset one.
      }
    }
    if (cfg.token) return { token: cfg.token, source: 'config' }
    return { token: '', source: 'none' }
  }

  function credentialStore() {
    const credentials = ctx.get('credentials')
    return credentials && typeof credentials.set === 'function' ? credentials : null
  }

  function configuredDevice() {
    return cfg.device
  }

  function readRequestBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) {
          reject(new Error('body too large'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      request.on('error', reject)
    })
  }

  function later(owner, delay, callback) {
    if (owner && typeof owner.timeout === 'function') return owner.timeout(callback, delay)
    const handle = setTimeout(callback, delay)
    return () => clearTimeout(handle)
  }

  async function workerFetch(token, path, options = {}) {
    const init = {
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    }
    let requestBytes = 0
    if (options.body !== undefined) {
      const serialized = JSON.stringify(options.body)
      requestBytes = Buffer.byteLength(serialized)
      init.headers['content-type'] = 'application/json'
      init.body = serialized
    }
    const response = await fetch(cfg.endpoint + path, init)
    const raw = await response.text()
    let data
    try {
      data = raw ? JSON.parse(raw) : {}
    } catch {
      data = { ok: false, error: raw.slice(0, 300) }
    }
    if (!response.ok || data.ok === false) {
      const reason = typeof data.error === 'string' ? data.error : `HTTP ${response.status}`
      throw new Error(`Worker ${path} 失败：${reason}`)
    }
    return { data, requestBytes, responseBytes: Buffer.byteLength(raw) }
  }

  async function readCursors(token) {
    const { data } = await workerFetch(token, '/api/cursors')
    const cursors = data && typeof data.cursors === 'object' && data.cursors ? data.cursors : {}
    return cursors
  }

  async function listLocalRecords(force = false) {
    if (!force && listCache.records.length && Date.now() - listCache.at < 5000) {
      return listCache.records
    }
    const records = await ctx.sessionQuery.listSessions()
    const filtered = cfg.includeSubagents
      ? records
      : records.filter((record) => record.header && record.header.origin !== 'subagent')
    listCache = { at: Date.now(), records: filtered }
    state.localCount = filtered.length
    return filtered
  }

  async function readTitles(ids) {
    const titles = new Map()
    if (!ids.length) return titles
    try {
      const results = await ctx.sessionQuery.readTitleSnapshots(ids)
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        const title = result.value && result.value.title
        if (title && typeof title.title === 'string' && title.title) {
          titles.set(result.sessionId, title.title)
        }
      }
    } catch {
      // Titles are decoration; a failure here must not block the upload.
    }
    return titles
  }

  function describe(snapshot, title) {
    const events = Array.isArray(snapshot.events) ? snapshot.events : []
    const header = snapshot.session || {}
    const last = events.length ? events[events.length - 1] : undefined
    const lifetime = typeof header.createdAt === 'number' ? header.createdAt : Date.now()
    return {
      id: String(header.id),
      header,
      title: title || null,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      createdAt: lifetime,
      updatedAt: last && typeof last.time === 'number' ? last.time : lifetime,
      lastSeq: last && typeof last.seq === 'number' ? last.seq : -1,
      digest: digestOf(events),
      events,
    }
  }

  async function uploadSession(session, remote, sink, token) {
    const canAppend = remote && typeof remote.lastSeq === 'number' && remote.lastSeq <= session.lastSeq
    let mode = canAppend ? 'append' : 'full'
    let pending = canAppend ? session.events.filter((event) => event.seq > remote.lastSeq) : session.events.slice()
    if (pending.length === 0) {
      if (canAppend && remote.digest && remote.digest === session.digest) {
        sink.skipped += 1
        return
      }
      if (session.events.length === 0 && canAppend) {
        sink.skipped += 1
        return
      }
      mode = 'full'
      pending = session.events.slice()
    }
    for (let offset = 0; offset < pending.length; offset += cfg.maxEventsPerRequest) {
      const chunk = pending.slice(offset, offset + cfg.maxEventsPerRequest)
      const body = {
        device: configuredDevice(),
        sessions: [
          {
            id: session.id,
            header: session.header,
            title: session.title,
            cwd: session.cwd,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            digest: session.digest,
            mode: offset === 0 ? mode : 'append',
            events: chunk,
          },
        ],
      }
      const { data, requestBytes } = await workerFetch(token, '/api/sync', { method: 'POST', body })
      sink.bytes += requestBytes
      sink.uploaded += chunk.length
      const failure = Array.isArray(data.errors)
        ? data.errors.find((entry) => entry && entry.id === session.id)
        : undefined
      if (failure) throw new Error(`${session.id} 被 Worker 拒绝：${failure.message || 'unknown'}`)
      sink.sessions.add(session.id)
    }
  }

  async function syncRecords(records, reason, sink, token) {
    const cursors = await readCursors(token)
    const titles = await readTitles(records.map((record) => record.header.id))
    for (const record of records) {
      const id = record.header.id
      try {
        const snapshot = await ctx.sessionQuery.readSession(id)
        const session = describe(snapshot, titles.get(id))
        if (!session.events.length) {
          sink.skipped += 1
          continue
        }
        await uploadSession(session, cursors[id], sink, token)
      } catch (error) {
        sink.failed += 1
        if (sink.errors.length < 8) sink.errors.push({ id, message: messageOf(error) })
      }
    }
  }

  async function run(reason, onlyId) {
    if (!hasEndpoint()) return { ok: false, error: 'not-configured' }
    if (state.running) return { ok: false, error: 'running' }
    const auth = await currentAuth()
    state.tokenSource = auth.source
    if (!auth.token) {
      state.lastError = `未配置 Token：凭据 ${tokenRef} 为空`
      return { ok: false, error: 'not-configured' }
    }
    state.running = true
    state.lastReason = reason
    const startedAt = Date.now()
    const sink = { sessions: new Set(), uploaded: 0, skipped: 0, failed: 0, bytes: 0, errors: [] }
    try {
      const all = await listLocalRecords(reason === 'start' || reason === 'manual')
      const records = onlyId ? all.filter((record) => record.header.id === onlyId) : all
      if (!records.length && onlyId) return { ok: true, empty: true }
      await syncRecords(records, reason, sink, auth.token)
      state.lastError = null
      return { ok: true }
    } catch (error) {
      state.lastError = messageOf(error)
      return { ok: false, error: state.lastError }
    } finally {
      state.running = false
      state.lastRunAt = Date.now()
      state.lastResult = {
        at: state.lastRunAt,
        reason,
        durationMs: state.lastRunAt - startedAt,
        scope: onlyId || 'all',
        sessions: sink.sessions.size,
        uploaded: sink.uploaded,
        skipped: sink.skipped,
        failed: sink.failed,
        bytes: sink.bytes,
        errors: sink.errors,
      }
    }
  }

  async function refreshRemote() {
    const auth = await currentAuth()
    if (!auth.token) throw new Error('未配置 Token')
    const [health, cursors] = await Promise.all([
      workerFetch(auth.token, '/api/health'),
      workerFetch(auth.token, '/api/cursors'),
    ])
    const records = await listLocalRecords(true)
    const known = cursors.data && cursors.data.cursors ? cursors.data.cursors : {}
    const missing = records.filter((record) => !(record.header.id in known)).length
    state.remote = {
      sessions: typeof health.data.sessions === 'number' ? health.data.sessions : null,
      events: typeof health.data.events === 'number' ? health.data.events : null,
      missing,
      checkedAt: Date.now(),
    }
    return state.remote
  }

  async function statusPayload() {
    const auth = await currentAuth()
    state.tokenSource = auth.source
    return {
      ok: true,
      version: VERSION,
      configured: Boolean(cfg.endpoint && auth.token),
      tokenSource: auth.source,
      tokenRef,
      credentialStore: Boolean(credentialStore()),
      endpoint: safeEndpoint(cfg.endpoint),
      device: configuredDevice(),
      autoSync: cfg.autoSync,
      syncOnStart: cfg.syncOnStart,
      includeSubagents: cfg.includeSubagents,
      running: state.running,
      lastRunAt: state.lastRunAt,
      lastReason: state.lastReason,
      lastError: state.lastError,
      lastResult: state.lastResult,
      local: { sessions: state.localCount },
      remote: state.remote,
      routeError: state.routeError || null,
    }
  }

  ctx.effect(() => {
    const disposers = []
    if (cfg.syncOnStart) {
      disposers.push(later(ctx, 1500, () => void run('start')))
    }
    if (cfg.autoSync) {
      disposers.push(
        ctx.on('session/event', (session, event) => {
          if (!hasEndpoint()) return
          if (!event || event.type !== 'turn/end') return
          const id = session && session.id
          if (!id) return
          const previous = timers.get(id)
          if (previous) previous()
          const dispose = later(ctx, cfg.debounceMs, () => {
            timers.delete(id)
            void run('auto', id)
          })
          timers.set(id, dispose)
        }),
      )
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A disposer that already ran is not an error.
        }
      }
      for (const dispose of timers.values()) {
        try {
          dispose()
        } catch {
          // Same.
        }
      }
      timers.clear()
    }
  })

  async function handleStatus(request, response) {
    if (request.method !== 'GET') {
      sendJson(response, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const url = new URL(request.url || STATUS_PATH, 'http://localhost')
    let payload = await statusPayload()
    try {
      await listLocalRecords()
      payload.local = { sessions: state.localCount }
    } catch (error) {
      payload.localError = messageOf(error)
    }
    if (url.searchParams.get('refresh') === '1' && payload.configured) {
      try {
        payload = { ...payload, remote: await refreshRemote() }
        payload.local = { sessions: state.localCount }
        payload.lastError = state.lastError
      } catch (error) {
        payload.remoteError = messageOf(error)
      }
    }
    sendJson(response, 200, payload)
  }

  async function handleRun(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method not allowed' })
      return
    }
    // Same-origin only: a custom header forces a CORS preflight elsewhere.
    if (request.headers['x-cf-sync'] !== '1') {
      sendJson(response, 403, { ok: false, error: 'forbidden' })
      return
    }
    const auth = await currentAuth()
    if (!hasEndpoint() || !auth.token) {
      sendJson(response, 400, { ok: false, error: 'not-configured' })
      return
    }
    if (state.running) {
      sendJson(response, 409, { ok: false, error: 'running' })
      return
    }
    void run('manual')
    sendJson(response, 202, { ok: true, started: true })
  }

  /**
   * Store or clear the shared secret in the profile's credential service.
   * The value is never echoed back; the reply only says where it now lives.
   */
  async function handleToken(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (request.headers['x-cf-sync'] !== '1') {
      sendJson(response, 403, { ok: false, error: 'forbidden' })
      return
    }
    const credentials = credentialStore()
    if (!credentials) {
      sendJson(response, 501, { ok: false, error: 'credential-store-unavailable' })
      return
    }
    let parsed
    try {
      parsed = JSON.parse((await readRequestBody(request)) || '{}')
    } catch {
      sendJson(response, 400, { ok: false, error: 'bad request' })
      return
    }
    const next = text(parsed && parsed.token)
    try {
      if (next) await credentials.set(tokenRef, next)
      else await credentials.unset(tokenRef)
    } catch (error) {
      sendJson(response, 500, { ok: false, error: messageOf(error) })
      return
    }
    const auth = await currentAuth()
    state.tokenSource = auth.source
    sendJson(response, 200, {
      ok: true,
      configured: Boolean(cfg.endpoint && auth.token),
      tokenSource: auth.source,
      tokenRef,
    })
  }

  // `webServer` is optional (a headless profile has no carrier), so it is read
  // with ctx.get instead of as a hard dependency of the whole plugin.
  let routed = false
  function mountRoutes() {
    if (routed) return
    const server = ctx.get('webServer')
    if (!server || typeof server.register !== 'function') return
    const failures = []
    for (const [path, handler] of [
      [STATUS_PATH, handleStatus],
      [RUN_PATH, handleRun],
      [TOKEN_PATH, handleToken],
    ]) {
      try {
        ctx.effect(() => server.register({ kind: 'exact', path, handler }))
      } catch (error) {
        failures.push(`${path}: ${messageOf(error)}`)
      }
    }
    routed = true
    state.routeError = failures.length ? failures.join('; ') : null
  }
  mountRoutes()
  // The carrier may come up after this plugin; the index render is the first
  // moment a late route can be attached.
  if (!routed) ctx.on('webserver/index-inject', () => mountRoutes())
}
