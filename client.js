/**
 * Cloudflare session sync — Client half.
 *
 * One Settings page: sync status plus a manual "立即同步" button. The page talks
 * to the Host half over two same-origin routes (`/cf-sync/status`,
 * `/cf-sync/run`) registered on this profile's Web server.
 */

window.__ModuleLoader__.load({
  id: '@local/cf-session-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'cf-session-sync'
    const DICTS = {
      en: {
        nav: 'Cloudflare Sync',
        title: 'Cloudflare session sync',
        subtitle: 'Uploads every local session log to the Cloudflare Worker in this plugin\u2019s config.',
        endpoint: 'Worker',
        device: 'Device',
        autoSync: 'Auto sync on turn end',
        syncedSessions: 'Sessions in the cloud',
        syncedEvents: 'Events in the cloud',
        localSessions: 'Sessions on this machine',
        missing: 'Not uploaded yet',
        lastRun: 'Last sync',
        lastResult: 'Result',
        never: 'never',
        runNow: 'Sync now',
        running: 'Syncing\u2026',
        refresh: 'Refresh status',
        on: 'on',
        off: 'off',
        notConfigured: 'Not configured yet. Put the Worker URL and token into this plugin\u2019s config, then reload the plugin.',
        routeMissing: 'This profile\u2019s Web server does not expose the sync routes (is the Web UI running?).',
        sessions: 'session(s)',
        uploaded: 'events uploaded',
        skipped: 'up to date',
        failed: 'failed',
        seconds: 's',
        token: 'Sync token',
        tokenRef: 'Credential key',
        tokenStored: 'Stored in the credential service',
        tokenConfig: 'From the plugin config (plaintext) — move it to the credential store',
        tokenMissing: 'Not configured',
        tokenPlaceholder: 'Paste the Worker’s SYNC_TOKEN',
        tokenSave: 'Save token',
        tokenClear: 'Clear',
        tokenSaved: 'Token stored in the credential service.',
        tokenCleared: 'Token removed from the credential service.',
        tokenNoStore: 'This profile exposes no credential service, so the token can only live in the plugin config.',
      },
      zh: {
        nav: 'Cloudflare 同步',
        title: 'Cloudflare 会话同步',
        subtitle: '把本机全部会话日志上传到插件配置里的 Cloudflare Worker。',
        endpoint: 'Worker 地址',
        device: '设备',
        autoSync: '回合结束后自动同步',
        syncedSessions: '云端会话数',
        syncedEvents: '云端事件数',
        localSessions: '本机会话数',
        missing: '尚未上传',
        lastRun: '上次同步',
        lastResult: '同步结果',
        never: '从未',
        runNow: '立即同步',
        running: '同步中\u2026',
        refresh: '刷新状态',
        on: '开启',
        off: '关闭',
        notConfigured: '尚未配置：请把 Worker 地址和 Token 填到本插件配置里，然后重新加载插件。',
        routeMissing: '当前 profile 的 Web 服务没有注册同步路由（Web UI 未运行？）。',
        sessions: '个会话',
        uploaded: '条事件已上传',
        skipped: '已是最新',
        failed: '失败',
        seconds: '秒',
        token: '同步 Token',
        tokenRef: '凭据键',
        tokenStored: '由凭据服务托管',
        tokenConfig: '来自插件配置（明文）— 建议迁到凭据服务',
        tokenMissing: '未配置',
        tokenPlaceholder: '粘贴 Worker 的 SYNC_TOKEN',
        tokenSave: '保存 Token',
        tokenClear: '清除',
        tokenSaved: '已保存到凭据服务。',
        tokenCleared: '已从凭据服务移除。',
        tokenNoStore: '当前 profile 没有凭据服务，Token 只能留在插件配置里。',
      },
    }

    const CSS = `
.cfss { display: flex; flex-direction: column; gap: 18px; max-width: 640px; padding: 4px 2px 24px; }
.cfss h1 { margin: 0; font-size: 17px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.cfss p { margin: 0; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.cfss-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.cfss-row { display: flex; align-items: baseline; gap: 12px; padding: 10px 14px; font-size: 13px; border-top: 1px solid var(--dsw-alias-border-l1); }
.cfss-row:first-child { border-top: 0; }
.cfss-key { flex: 0 0 40%; color: var(--dsw-alias-label-secondary); }
.cfss-val { flex: 1 1 auto; color: var(--dsw-alias-label-primary); word-break: break-all; font-variant-numeric: tabular-nums; }
.cfss-val.mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
.cfss-actions { display: flex; align-items: center; gap: 10px; }
.cfss-btn { font: inherit; font-size: 13px; height: 30px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; }
.cfss-btn:disabled { cursor: default; opacity: 0.55; }
.cfss-btn.primary { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 500; }
.cfss-btn.ghost { background: transparent; border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.cfss-btn.ghost:hover:enabled { background: var(--dsw-alias-bg-layer-2); }
.cfss-input { width: 100%; font: inherit; font-size: 12.5px; height: 28px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.cfss-input:disabled { opacity: 0.55; }
.cfss-actions-row { justify-content: flex-end; gap: 8px; }
.cfss-note { font-size: 12px; line-height: 1.5; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.cfss-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.cfss-warn { color: var(--dsw-alias-state-warn-primary); }
.cfss-ok { color: var(--dsw-alias-state-success-primary); }
.cfss-muted { color: var(--dsw-alias-label-secondary); }
`

    function formatTime(value) {
      if (!value) return null
      try {
        const date = new Date(value)
        const pad = (number) => String(number).padStart(2, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      } catch {
        return String(value)
      }
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || bytes <= 0) return null
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    }

    function Row(props) {
      return h(
        'div',
        { className: 'cfss-row' },
        h('div', { className: 'cfss-key' }, props.label),
        h('div', { className: `cfss-val${props.mono ? ' mono' : ''}${props.tone ? ` ${props.tone}` : ''}` }, props.children),
      )
    }

    function createPage(locale, t) {
      return function CloudflareSyncPage() {
        const [, force] = React.useState(0)
        const [status, setStatus] = React.useState(null)
        const [problem, setProblem] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)
        const [draft, setDraft] = React.useState('')
        const [tokenBusy, setTokenBusy] = React.useState(false)

        React.useEffect(() => {
          if (!locale || typeof locale.subscribe !== 'function') return undefined
          return locale.subscribe(() => force((value) => value + 1))
        }, [])

        const load = React.useCallback(async (refresh) => {
          try {
            const response = await fetch(`/cf-sync/status${refresh ? '?refresh=1' : ''}`, {
              headers: { accept: 'application/json' },
            })
            if (response.status === 404) {
              setProblem('route-missing')
              return
            }
            const payload = await response.json()
            setStatus(payload)
            setProblem(null)
          } catch (error) {
            setProblem(error && error.message ? error.message : String(error))
          }
        }, [])

        React.useEffect(() => {
          void load(true)
        }, [load])

        const running = Boolean(status && status.running)
        React.useEffect(() => {
          const delay = running ? 1500 : 8000
          const timer = setInterval(() => void load(false), delay)
          return () => clearInterval(timer)
        }, [load, running])

        const start = React.useCallback(async () => {
          setBusy(true)
          setNotice(null)
          try {
            const response = await fetch('/cf-sync/run', {
              method: 'POST',
              headers: { accept: 'application/json', 'x-cf-sync': '1' },
            })
            const payload = await response.json().catch(() => ({}))
            if (!response.ok || payload.ok === false) {
              setNotice(payload.error === 'not-configured' ? 'not-configured' : (payload.error || `HTTP ${response.status}`))
            }
          } catch (error) {
            setNotice(error && error.message ? error.message : String(error))
          } finally {
            setBusy(false)
            void load(true)
          }
        }, [load])

        const saveToken = React.useCallback(async (value) => {
          setTokenBusy(true)
          setNotice(null)
          try {
            const response = await fetch('/cf-sync/token', {
              method: 'POST',
              headers: { accept: 'application/json', 'x-cf-sync': '1', 'content-type': 'application/json' },
              body: JSON.stringify({ token: value }),
            })
            const payload = await response.json().catch(() => ({}))
            if (!response.ok || payload.ok === false) {
              setNotice(payload.error || `HTTP ${response.status}`)
            } else {
              setDraft('')
              setNotice(value ? 'token-saved' : 'token-cleared')
            }
          } catch (error) {
            setNotice(error && error.message ? error.message : String(error))
          } finally {
            setTokenBusy(false)
            void load(true)
          }
        }, [load])

        const rows = []
        if (status) {
          rows.push(
            h(Row, { key: 'endpoint', label: t('endpoint'), mono: true },
              status.endpoint || h('span', { className: 'cfss-muted' }, '—')),
            h(Row, { key: 'device', label: t('device'), mono: true }, status.device || '—'),
            h(Row, { key: 'token-kind', label: t('token') },
              !status.tokenSource || status.tokenSource === 'none'
                ? h('span', { className: 'cfss-warn' }, t('tokenMissing'))
                : h('span', { className: status.tokenSource === 'config' ? 'cfss-warn' : 'cfss-ok' },
                    status.tokenSource === 'config' ? t('tokenConfig') : t('tokenStored'))),
            h(Row, { key: 'local', label: t('localSessions') },
              typeof status.local?.sessions === 'number' ? status.local.sessions : '—'),
            h(Row, { key: 'remote', label: t('syncedSessions') },
              status.remote && typeof status.remote.sessions === 'number' ? status.remote.sessions : '—'),
            h(Row, { key: 'events', label: t('syncedEvents') },
              status.remote && typeof status.remote.events === 'number' ? status.remote.events : '—'),
          )
          if (status.remote && typeof status.remote.missing === 'number') {
            rows.push(
              h(Row, { key: 'missing', label: t('missing') },
                h('span', { className: status.remote.missing > 0 ? 'cfss-warn' : 'cfss-ok' }, String(status.remote.missing))),
            )
          }
          rows.push(h(Row, { key: 'auto', label: t('autoSync') }, status.autoSync ? t('on') : t('off')))
          rows.push(
            h(Row, { key: 'last', label: t('lastRun') },
              formatTime(status.lastRunAt) || h('span', { className: 'cfss-muted' }, t('never'))),
          )
          const result = status.lastResult
          if (result) {
            const parts = []
            if (result.sessions) parts.push(`${result.sessions} ${t('sessions')}`)
            if (result.uploaded) parts.push(`${result.uploaded} ${t('uploaded')}`)
            if (result.skipped) parts.push(`${result.skipped} ${t('skipped')}`)
            if (result.failed) parts.push(`${result.failed} ${t('failed')}`)
            const size = formatBytes(result.bytes)
            if (size) parts.push(size)
            if (result.durationMs) parts.push(`${(result.durationMs / 1000).toFixed(1)}${t('seconds')}`)
            rows.push(
              h(Row, { key: 'result', label: t('lastResult') },
                parts.length ? parts.join(' · ') : h('span', { className: 'cfss-muted' }, '—')),
            )
          }
        }

        const blocks = [
          h('h1', { key: 'title' }, t('title')),
          h('p', { key: 'subtitle' }, t('subtitle')),
        ]

        if (problem === 'route-missing') {
          blocks.push(h('div', { key: 'route', className: 'cfss-note cfss-warn' }, t('routeMissing')))
        } else if (problem) {
          blocks.push(h('div', { key: 'problem', className: 'cfss-note cfss-error' }, problem))
        }

        if (status && !status.configured) {
          blocks.push(h('div', { key: 'config', className: 'cfss-note cfss-warn' }, t('notConfigured')))
        }

        if (rows.length) {
          blocks.push(h('div', { key: 'rows', className: 'cfss-card' }, rows))
        }

        if (status) {
          const canStore = Boolean(status.credentialStore)
          const hasToken = Boolean(status.tokenSource) && status.tokenSource !== 'none'
          blocks.push(
            h('div', { key: 'token-form', className: 'cfss-card' },
              h('div', { className: 'cfss-row' },
                h('div', { className: 'cfss-key' }, t('token')),
                h('div', { className: 'cfss-val' },
                  h('input', {
                    type: 'password',
                    className: 'cfss-input',
                    value: draft,
                    placeholder: hasToken ? t('tokenStored') : t('tokenPlaceholder'),
                    disabled: !canStore || tokenBusy,
                    autoComplete: 'off',
                    spellCheck: false,
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && draft.trim()) void saveToken(draft.trim())
                    },
                  })),
              ),
              h('div', { className: 'cfss-row' },
                h('div', { className: 'cfss-key' }, t('tokenRef')),
                h('div', { className: 'cfss-val mono' }, status.tokenRef || '—'),
              ),
              h('div', { className: 'cfss-row cfss-actions-row' },
                h('button', {
                  type: 'button',
                  className: 'cfss-btn primary',
                  disabled: !canStore || tokenBusy || !draft.trim(),
                  onClick: () => void saveToken(draft.trim()),
                }, t('tokenSave')),
                h('button', {
                  type: 'button',
                  className: 'cfss-btn ghost',
                  disabled: !canStore || tokenBusy || !hasToken,
                  onClick: () => void saveToken(''),
                }, t('tokenClear')),
              ),
            ),
          )
          if (!canStore) blocks.push(h('div', { key: 'no-store', className: 'cfss-note' }, t('tokenNoStore')))
        }

        const flash = notice === 'token-saved' ? t('tokenSaved') : notice === 'token-cleared' ? t('tokenCleared') : null
        if (flash) blocks.push(h('div', { key: 'flash', className: 'cfss-note cfss-ok' }, flash))

        const errorLine = (status && (status.remoteError || status.lastError)) || (typeof notice === 'string' && !flash ? notice : null)
        if (errorLine) {
          blocks.push(h('div', { key: 'error', className: 'cfss-note cfss-error' }, String(errorLine)))
        }

        blocks.push(
          h('div', { key: 'actions', className: 'cfss-actions' },
            h('button', {
              type: 'button',
              className: 'cfss-btn primary',
              disabled: busy || running || !status || !status.configured,
              onClick: start,
            }, running ? t('running') : t('runNow')),
            h('button', {
              type: 'button',
              className: 'cfss-btn ghost',
              disabled: busy,
              onClick: () => void load(true),
            }, t('refresh')),
          ),
        )

        return h('section', { className: 'cfss' }, [
          h('style', { key: 'style' }, CSS),
          ...blocks,
        ])
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        const owned = new Set()
        const ensureDict = (id, dict) => {
          const key = `${id}`
          if (owned.has(key)) return
          owned.add(key)
          ctx.effect(() => locale.register(NS, id, dict))
        }
        if (locale && typeof locale.register === 'function') {
          let active = 'en'
          try {
            const snapshot = locale.getLocale()
            if (snapshot && typeof snapshot.active === 'string') active = snapshot.active
          } catch {
            active = 'en'
          }
          const chinese = /^zh/i.test(active)
          // Register every id the fallback chain may consult, so the page is
          // translated without knowing this build's exact locale tags.
          ensureDict('en', DICTS.en)
          ensureDict('zh', DICTS.zh)
          ensureDict('zh-CN', DICTS.zh)
          ensureDict('zh-Hans', DICTS.zh)
          if (active && !chinese && active !== 'en') ensureDict(active, DICTS.en)
          if (active && chinese) ensureDict(active, DICTS.zh)
        }

        let t = (key) => key
        if (locale && typeof locale.bind === 'function') {
          try {
            t = locale.bind(NS)
          } catch {
            t = (key) => key
          }
        }

        const Page = createPage(locale, t)
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'cf-session-sync',
              order: 60,
              label: () => t('nav'),
            },
            Page,
          ),
        )
      },
    }
  },
})
