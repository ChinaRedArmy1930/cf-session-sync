/**
 * Shared HTML rendering for the Cloudflare Worker and its local mock.
 * Every dynamic string goes through `esc`; nothing else is interpolated raw.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (character) => ESCAPES[character])
}

function truncate(value, max) {
  const text = String(value === null || value === undefined ? '' : value)
  return text.length > max ? `${text.slice(0, max)}\u2026` : text
}

function contentText(node, depth = 0) {
  if (node === null || node === undefined || depth > 6) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) {
    return node
      .map((child) => contentText(child, depth + 1))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof node !== 'object') return ''
  if (typeof node.text === 'string') return node.text
  if (Array.isArray(node.content)) return contentText(node.content, depth + 1)
  if (Array.isArray(node.parts)) return contentText(node.parts, depth + 1)
  if (node.message) return contentText(node.message, depth + 1)
  return ''
}

function reasoningText(node, depth = 0) {
  if (node === null || node === undefined || depth > 6) return ''
  if (Array.isArray(node)) {
    return node
      .map((child) => reasoningText(child, depth + 1))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof node !== 'object') return ''
  if (node.type === 'reasoning' && typeof node.text === 'string') return node.text
  if (Array.isArray(node.content)) return reasoningText(node.content, depth + 1)
  if (Array.isArray(node.parts)) return reasoningText(node.parts, depth + 1)
  if (node.message) return reasoningText(node.message, depth + 1)
  return ''
}

function stamp(value) {
  const time = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(time)) return ''
  try {
    return new Date(time).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
  } catch {
    return ''
  }
}

function pre(text) {
  return `<pre class="body">${esc(text)}</pre>`
}

/** One event as a readable block. */
export function renderEvent(event) {
  const type = event && typeof event.type === 'string' ? event.type : 'unknown'
  const data = event && typeof event.data === 'object' && event.data ? event.data : {}
  switch (type) {
    case 'user/message': {
      const body = contentText(data.content ?? data) || contentText(data)
      return block('user', 'You', body, event.time)
    }
    case 'assistant/message': {
      const message = data.message ?? data
      const body = contentText(message ?? data)
      const reasoning = reasoningText(message ?? data)
      if (!body && !reasoning) return muted(type, event)
      const parts = []
      if (reasoning) parts.push(`<details class="reasoning"><summary>reasoning</summary>${pre(reasoning)}</details>`)
      if (body) parts.push(pre(body))
      return block('assistant', 'Assistant', parts.join(''), event.time, true)
    }
    case 'tool/call': {
      const name = typeof data.name === 'string' ? data.name : 'tool'
      const args = typeof data.arguments === 'string' ? data.arguments : contentText(data.arguments) || ''
      return block('tool', `Call \u00b7 ${truncate(name, 60)}`, pre(truncate(args, 4000)), event.time, true)
    }
    case 'tool/result': {
      const message = data.message ?? data
      const body = contentText(message)
      const error = data.error ? `ERROR ${data.error.name || ''} ${data.error.code || ''} ${data.error.reason || ''}` : ''
      return block('tool', 'Result', pre(truncate(`${error}${error && body ? '\n' : ''}${body || '(no text content)'}`, 4000)), event.time, true)
    }
    case 'system/message':
    case 'developer/message': {
      const body = contentText(data.message ?? data)
      return block('system', type === 'developer/message' ? 'Developer' : 'System', pre(truncate(body, 4000)), event.time, true)
    }
    case 'turn/end': {
      const reason = data.reason && typeof data.reason === 'object' ? data.reason.kind : data.reason
      return muted(`turn ${data.turn} ended${reason ? ` \u00b7 ${reason}` : ''}`, event)
    }
    case 'turn/start':
      return muted(`turn ${data.turn} started`, event)
    default:
      return muted(type, event)
  }
}

function block(role, label, body, time, trusted = false) {
  return `<div class="row ${esc(role)}"><div class="meta"><span class="role">${esc(label)}</span><span class="time">${esc(stamp(time))}</span></div>${trusted ? body : pre(body || '(empty)')}</div>`
}

function muted(label, event) {
  const data = event && event.data ? JSON.stringify(event.data) : ''
  return `<div class="row muted"><div class="meta"><span class="role">${esc(label)}</span><span class="time">${esc(stamp(event && event.time))}</span></div><pre class="body dim">${esc(truncate(data, 600))}</pre></div>`
}

function shell(title, content, extra = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --bg:#f7f7f8; --fg:#17181a; --muted:#6b6f76; --line:#e3e4e8; --card:#ffffff; --accent:#2f6fed; --code:#f2f3f5; }
@media (prefers-color-scheme: dark) { :root { --bg:#141517; --fg:#ececf0; --muted:#9a9ea6; --line:#2b2d31; --card:#1b1c20; --accent:#7aa2ff; --code:#212227; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
main { max-width:900px; margin:0 auto; padding:28px 20px 64px; }
h1 { font-size:19px; margin:0 0 6px; letter-spacing:.2px; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
.sub { color:var(--muted); font-size:13px; margin:0 0 22px; }
.list { display:flex; flex-direction:column; gap:8px; }
.item { display:block; padding:12px 14px; background:var(--card); border:1px solid var(--line); border-radius:10px; }
.item .t { font-weight:600; color:var(--fg); }
.item .m { color:var(--muted); font-size:12px; margin-top:4px; display:flex; gap:12px; flex-wrap:wrap; }
.row { padding:10px 0; border-top:1px solid var(--line); }
.row:first-child { border-top:0; }
.row .meta { display:flex; gap:10px; align-items:baseline; margin-bottom:4px; }
.row .role { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); }
.row .time { font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums; }
.row.user .role { color:var(--accent); }
.row.muted { opacity:.75; }
pre.body { margin:0; white-space:pre-wrap; word-break:break-word; font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--code); border-radius:8px; padding:10px 12px; }
pre.body.dim { color:var(--muted); }
details.reasoning { margin-bottom:8px; }
details.reasoning summary { cursor:pointer; color:var(--muted); font-size:12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
.note { color:var(--muted); font-size:13px; }
${extra}
</style>
</head>
<body><main>${content}</main></body>
</html>`
}

export function renderLogin() {
  return shell(
    'Session viewer \u00b7 authentication required',
    `<h1>Session viewer</h1>
<p class="sub">This endpoint requires the sync token.</p>
<div class="card note">Append <code>?t=&lt;SYNC_TOKEN&gt;</code> to the URL once; the page then stores it in a cookie and redirects to a clean URL.</div>`,
  )
}

export function renderList(rows) {
  const items = rows.length
    ? rows
        .map(
          (row) => `<a class="item" href="/s/${esc(row.id)}">
<span class="t">${esc(row.title || row.id)}</span>
<span class="m"><span>${esc(row.id)}</span><span>${esc(stamp(row.created_at))}</span><span>${esc(row.event_count)} events</span>${row.cwd ? `<span>${esc(row.cwd)}</span>` : ''}${row.device ? `<span>${esc(row.device)}</span>` : ''}</span>
</a>`,
        )
        .join('')
    : '<p class="note">No sessions stored yet. Run a sync from the Harness plugin.</p>'
  return shell(
    'Sessions',
    `<h1>Sessions</h1><p class="sub">${rows.length} session(s), newest first.</p><div class="list">${items}</div>`,
  )
}

export function renderDetail(session, events, truncated) {
  const body = events.map((event) => renderEvent(event)).join('')
  const facts = [
    ['id', session.id],
    ['title', session.title || '(untitled)'],
    ['created', stamp(session.created_at)],
    ['updated', stamp(session.updated_at)],
    ['events', String(session.event_count)],
    ['cwd', session.cwd || ''],
    ['device', session.device || ''],
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `<div class="m"><span>${esc(key)}</span><span>${esc(value)}</span></div>`)
    .join('')
  return shell(
    session.title || session.id,
    `<p class="sub"><a href="/">&larr; all sessions</a></p>
<h1>${esc(session.title || session.id)}</h1>
<div class="card">${facts}</div>
${truncated ? '<p class="note">Rendering capped at 2000 events; open the API for the rest.</p>' : ''}
<div>${body}</div>`,
  )
}

export function renderMissing(id) {
  return shell('Not found', `<h1>Session not found</h1><p class="sub">${esc(id)}</p><p class="note"><a href="/">&larr; all sessions</a></p>`)
}
