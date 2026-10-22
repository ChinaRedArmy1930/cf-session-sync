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
| `tokenFile` | `''` | 从文件读 Token（一行，自动 trim）。指向 iCloud/dotfiles 路径即可跨机器零粘贴 |
| `token` | `''` | **遗留兜底**，仅当前两者都没有时才用；建议留空 |
| `device` | 主机名 | 写入 D1 的设备标签，多机同步时用来区分 |
| `syncOnStart` | `true` | 插件激活后约 1.5s 跑一次全量 |
| `autoSync` | `true` | 每个回合结束（`turn/end`）后对**那一个**会话做增量 |
| `includeSubagents` | `true` | 是否包含 `origin: subagent` 的子会话 |
| `debounceMs` | `4000` | 自动同步的合并窗口 |
| `maxEventsPerRequest` | `300` | 每次 POST 携带的事件条数，大会话会被切成多批 |
| `requestTimeoutMs` | `25000` | 单次 HTTP 超时 |

## 三、换机器（怎样最省事）

先纠正一个常见误解：**macOS 上从 Dock/Finder 启动的 app 不读 `.zshrc`**（GUI 进程拿到的是 launchd 环境）。所以把 `export` 写进 shell 配置，对桌面版 DSH **无效**——那些变量只有从终端启动 `dsh` 时才会传进去。

真正可行的三种，按代价排序：

| 方案 | 新机器要做什么 | 代价 |
| --- | --- | --- |
| **A. 粘一次** | 设置页粘一次 Token（20 秒） | 每次换机一次手工动作 |
| **B. Token 文件** | 什么都不用做 | 密钥进同步盘（iCloud 加密存储） |
| **C. launchctl** | 装 LaunchAgent | 要给每台机器装 plist，不推荐 |

**推荐 B（追求零粘贴）**：把 Token 写到一个会被同步的文件里，插件每次同步前读它。

```bash
# 这台机器上，一次性
mkdir -p ~/Library/Mobile\ Documents/com~apple~CloudDocs/dsh
printf '%s\n' '<SYNC_TOKEN>' > ~/Library/Mobile\ Documents/com~apple~CloudDocs/dsh/cf-sync-token
chmod 600 ~/Library/Mobile\ Documents/com~apple~CloudDocs/dsh/cf-sync-token
```

然后在 profile 的 `cordis.patch.yml` 里指过去（路径两台机器一样，因为 iCloud 的路径是固定的）：

```yaml
- id: cf-session-sync
  name: '@local/cf-session-sync'
  config:
    endpoint: 'https://sync.<你的域名>'
    tokenFile: '~/Library/Mobile Documents/com~apple~CloudDocs/dsh/cf-sync-token'
```

解析优先级：**凭据服务 → `tokenFile` → `config.token`**。设置页里存的 Token 依然优先，所以两种方式不冲突。

新机器：iCloud 同步到位 → 装插件 → 打开 DSH，直接就是已配置。token 全程不用手打。

**推荐 A（更保守）**：不把密钥放到任何同步服务里，每台机器在设置页粘一次。20 秒，且密钥只存在那台机器上。

`CF_SYNC_ENDPOINT` / `CF_SESSION_SYNC_TOKEN` / `CF_SYNC_TOKEN_FILE` 三个环境变量仍然支持，但只对**从终端启动**的 DSH 有意义。

## 四、Token 存在哪（凭据服务）

插件不再把 Token 写在 YAML 里。每次同步前按这个顺序解析，**每次操作都重新读，不缓存**：

```
凭据服务（ctx.credentials.resolve('CF_SESSION_SYNC_TOKEN')）
  └ 内部还有一层：进程环境变量 CF_SESSION_SYNC_TOKEN → .env 文件
→ config.tokenFile（文件内容 trim）
→ config.token（遗留兜底）
```

**设置页填写**：设置 → Cloudflare 同步 → 「Sync token」输入框 → 保存。
值落到 `~/.dsh/.credentials.yaml` 的 `refs.CF_SESSION_SYNC_TOKEN`，页面只显示来源（凭据服务 / 配置文件 / 未配置），从不回显明文。

**换机器时**：两条路，见第三节——设置页粘一次（A），或 `tokenFile` 指向 iCloud 里的一行文本（B，零粘贴）。

环境变量那条只在**从终端启动** DSH 时有效，桌面版从 Dock 启动读不到 `.zshrc`。

几点行为：

- **每次操作重新解析**，不跨操作缓存 —— 换 Token 后下一次同步立即生效，不用重启插件。
- 空值视为"不存在"（凭据服务的约定），所以「清除」是 `unset` 而不是写入空串。
- 当前 profile 没有 `credentials` 服务时，设置页会提示，`config.token` 兜底仍然可用。

## 五、用起来

- **手动**：设置 → **Cloudflare 同步** → 「立即同步」。
- **自动**：回合结束后 4 秒自动增量同步该会话。
- **浏览**：打开 `https://<worker>/?t=<SYNC_TOKEN>`，首次访问写 cookie 后跳转干净 URL。

## 发版流程（顺序不能变）

索引本身也在仓库里，所以"给索引打 tag"这件事有严格的先后顺序：

1. 改代码 → commit（记为 `C`）；
2. 把 `market/index.json` 的 `version` 和 `source.commit` 改成新版本和 `C` → commit；
3. **在索引这个 commit 上**打 tag，且只推一次：`git tag vX.Y.Z && git push origin vX.Y.Z`。

**tag 一旦推送就不要移动**。jsDelivr 会把 `tag → commit` 的映射缓存下来，之后 `git tag -f` + 强推也不会刷新，`purge.jsdelivr.net` 也清不掉——我这次就踩了：`v1.0.1` 指到了代码 commit，索引读出来还是 1.0.0。

两种索引地址的取舍：

| 地址 | 新鲜度 | 适合 |
| --- | --- | --- |
| `raw.githubusercontent.com/<owner>/<repo>/main/market/index.json` | 约 5 分钟 | 自己用，发版即刻可见 |
| `cdn.jsdelivr.net/gh/<owner>/<repo>@vX.Y.Z/market/index.json` | 永久不可变 | 给别人用，前提是 tag 永不移动 |

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
