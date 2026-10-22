# Cloudflare 会话同步（DSH 插件）

把本机 **全部** DSH 会话日志同步到你自己的 Cloudflare Worker，并在 CF 上提供一个只读的网页浏览器。

```
本机 ~/.dsh/sessions/*.jsonl.zstd
        │  sessionQuery.listSessions / readSession（含 live 会话）
        ▼
   Host 插件  ──POST /api/sync──▶  Cloudflare Worker ──▶ D1（sessions / events）
        ▲                                │
        │  GET /cf-sync/status           └── GET /  只读浏览页
        │  POST /cf-sync/run
   设置页「Cloudflare 同步」
```

## 目录

| 路径 | 作用 |
| --- | --- |
| `index.js` | Host 插件：同步引擎、本地触发路由、自动增量 |
| `client.js` | 设置页「Cloudflare 同步」：状态 + 立即同步按钮 |
| `cordis.patch.yml` | 插件行与默认配置 |
| `worker/` | Cloudflare Worker 端（`worker.js`、`schema.sql`、`wrangler.toml` 模板、本地 `mock.mjs`、部署说明） |
| `test/harness.mjs` | 离线测试：桩化 Cordis 服务 + 真实路由表 + `worker/mock.mjs`，不装插件也能跑通全量/增量/凭据 |

## 这个仓库里没有什么

- **没有 Token**。它只存在于 DSH 凭据服务（`~/.dsh/.credentials.yaml` 的 `refs.CF_SESSION_SYNC_TOKEN`），或在 `wrangler secret` 里。
- **没有你的 D1 id 和域名**。`worker/wrangler.toml` 是带占位符的模板；真实值放 `worker/wrangler.local.toml`，那个文件在 `.gitignore` 里。

提交前想自查，跑一遍：

```bash
grep -rIn -E "[a-f0-9]{32,}|BEGIN .*PRIVATE KEY" . | grep -v node_modules
```

## 一、先把 CF 端跑起来

见 [`worker/README.md`](worker/README.md)。简述：

```bash
cd worker
wrangler d1 create dsh-sessions                       # 记下 database_id
wrangler d1 execute dsh-sessions --remote --file=./schema.sql
wrangler secret put SYNC_TOKEN                        # 自定义一串长随机串
wrangler deploy
```

拿到 `https://dsh-sync.<你的子域>.workers.dev`。

## 二、配置插件

装好后，在 **profile 的 `cordis.patch.yml`** 里覆盖这一行（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: cf-session-sync
  name: '@local/cf-session-sync'
  config:
    endpoint: 'https://dsh-sync.<你的子域>.workers.dev'
    device: 'my-macbook'
```

改完让插件重新加载（重启 DSH，或在插件页禁用再启用）。没配置时插件保持静默，不会报错。

**Token 不写在这里**，它由 DSH 的凭据服务托管，见下一节。

### 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `endpoint` | `''` | Worker 基地址，末尾斜杠会被去掉 |
| `tokenRef` | `'CF_SESSION_SYNC_TOKEN'` | 凭据键名；插件每次操作都重新解析它 |
| `token` | `''` | **遗留兜底**，仅当凭据服务里没有该键时才用；建议留空 |
| `device` | 主机名 | 写入 D1 的设备标签，多机同步时用来区分 |
| `syncOnStart` | `true` | 插件激活后约 1.5s 跑一次全量 |
| `autoSync` | `true` | 每个回合结束（`turn/end`）后对**那一个**会话做增量 |
| `includeSubagents` | `true` | 是否包含 `origin: subagent` 的子会话 |
| `debounceMs` | `4000` | 自动同步的合并窗口 |
| `maxEventsPerRequest` | `300` | 每次 POST 携带的事件条数，大会话会被切成多批 |
| `requestTimeoutMs` | `25000` | 单次 HTTP 超时 |

## 三、换机器（推荐流程，不用复制粘贴 Token）

把配置交给一个**已经在同步的 dotfile**，新机器只装插件，不用再填任何值。

一次性准备（在任意一台机器上）：

```bash
mkdir -p ~/.config/dsh
cat > ~/.config/dsh/env.sh <<'EOF'
export CF_SYNC_ENDPOINT='https://sync.<你的域名>'
export CF_SESSION_SYNC_TOKEN='<SYNC_TOKEN>'
EOF
echo '[ -f ~/.config/dsh/env.sh ] && . ~/.config/dsh/env.sh' >> ~/.zshrc
```

然后把 `~/.config/dsh/env.sh` 放进 iCloud（`~/Library/Mobile Documents/...`）或你自己的私有 dotfiles 仓库。

新机器上：

1. dotfiles 到位（iCloud 自动同步 / `git clone` + 建软链）；
2. 装插件：设置 → 插件 → Discover → 装；
3. 打开 DSH。`CF_SESSION_SYNC_TOKEN` 由凭据服务的环境变量兜底解析，`CF_SYNC_ENDPOINT` 由插件读取 —— 直接就是已配置状态，`syncOnStart` 立刻全量。

两个变量都可以只给一个：`CF_SYNC_ENDPOINT` 不设时读 `config.endpoint`；`CF_SESSION_SYNC_TOKEN` 不设时读凭据服务里存的同名 ref，再回落到 `config.token`。

## 四、Token 存在哪（凭据服务）

插件不再把 Token 写在 YAML 里。它每次同步前调用 `ctx.credentials.resolve('CF_SESSION_SYNC_TOKEN')`，解析顺序是：

```
凭据服务（profile-managed store）
  → 进程环境变量 CF_SESSION_SYNC_TOKEN
  → .env 文件
  → config.token（遗留兜底）
```

**设置页填写**：设置 → Cloudflare 同步 → 「Sync token」输入框 → 保存。
值落到 `~/.dsh/.credentials.yaml` 的 `refs.CF_SESSION_SYNC_TOKEN`，页面只显示来源（凭据服务 / 配置文件 / 未配置），从不回显明文。

**换机器时**：新机器的 profile patch 只写 `endpoint`（和 `device`），装好插件后在设置页粘一次 Token 即可；或者直接

```bash
export CF_SESSION_SYNC_TOKEN='...'
```

给 DSH 进程用环境变量兜底，连设置页都不用点。

几点行为：

- **每次操作重新解析**，不跨操作缓存 —— 换 Token 后下一次同步立即生效，不用重启插件。
- 空值视为"不存在"（凭据服务的约定），所以「清除」是 `unset` 而不是写入空串。
- 当前 profile 没有 `credentials` 服务时，设置页会提示，`config.token` 兜底仍然可用。

## 五、用起来

- **手动**：设置 → **Cloudflare 同步** → 「立即同步」。
- **自动**：回合结束后 4 秒自动增量同步该会话。
- **浏览**：打开 `https://<worker>/?t=<SYNC_TOKEN>`，首次访问写 cookie 后跳转干净 URL。

## 同步语义

- **不落地本地状态**。云端 `/api/cursors` 就是游标：每台机器、每次重装都从云端已有的 `lastSeq` 继续。
- **增量**：远端有 `lastSeq` 时只发 `seq > lastSeq` 的事件（`mode: "append"`）。
- **对齐/重写**：本地日志与远端不一致（分叉、压缩重写、远端领先）时整段重发（`mode: "full"`），Worker 先删该会话事件再写入。
- **幂等**：会话按 `id` upsert，事件按 `(session_id, seq)` upsert，重复同步不会产生重复行。
- **失败隔离**：单个会话失败只记进本次结果，不影响其余会话；错误显示在设置页。

## 已知边界

- 只同步**文本事件日志**；图片/文件附件只保留引用元数据，二进制不落 CF。
- 浏览页是只读的，不做写入、搜索排名或鉴权体系（单一共享 Token）。
- 本地触发路由 `/cf-sync/status`、`/cf-sync/run`、`/cf-sync/token` 只绑定在回环地址的 DSH Web 服务上；`POST` 要求 `x-cf-sync: 1` 头，跨站表单无法携带。
- Token 由 DSH 凭据服务托管，但浏览页那侧仍是同一个共享 Token（`?t=` 换 cookie），本质上还是一把钥匙。
