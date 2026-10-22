# CF 端：Cloudflare Worker + D1 + 只读浏览页

零依赖，只用 Worker 的 Web API 与 D1 绑定。

| 文件 | 说明 |
| --- | --- |
| `worker.js` | Worker 入口：`/api/*` 收同步数据，`/` 与 `/s/<id>` 渲染只读浏览页 |
| `render.js` | 浏览页 HTML（与本地 mock 共用，所有动态串都做 HTML 转义） |
| `schema.sql` | D1 建表 |
| `wrangler.toml` | Worker 配置（D1 绑定 `DB`） |
| `mock.mjs` | 本地 Node 版同协议服务，用于上线前联调 |

## 1. 建库与建表

```bash
cd worker
npx wrangler login
npx wrangler d1 create dsh-sessions
```

把输出里的 `database_id` 填进 **`wrangler.local.toml`**（仓库里只有带占位符的 `wrangler.toml`；`wrangler.local.toml` 已被 `.gitignore` 忽略，放你自己的 id 和域名），然后：

```bash
npx wrangler d1 execute dsh-sessions --remote --file=./schema.sql
```

不想建本地文件也行：直接改 `wrangler.toml` 再 deploy，只是别把改好的那份提交上去。

## 2. 设置共享 Token

```bash
openssl rand -hex 32          # 生成一串，记下来
npx wrangler secret put SYNC_TOKEN
```

这个值不写进任何文件：在 Harness 里 设置 → Cloudflare 同步 → 粘进 Token 输入框，由凭据服务托管（见插件 README 第三节）。

## 3. 部署

```bash
npx wrangler deploy --config wrangler.local.toml
```

默认得到 `https://dsh-session-sync.<你的子域>.workers.dev`。

### 自定义域名（公司网络通常必须）

`workers.dev` 在不少公司网络被 DNS 投毒 + SNI 阻断，连 `--resolve` 到真实 CF IP 都不通。如果你有域名托管在**同一个 CF 账号**，在 `wrangler.local.toml` 里加上：

```toml
routes = [
  { pattern = "sync.example.com", custom_domain = true }
]
```

`wrangler deploy` 会顺便建 DNS 记录和证书，之后用 `https://sync.example.com`。

**坑**：`routes` 必须写在第一个 `[[表头]]` 之前。写在 `[[d1_databases]]` 后面的话，TOML 会把它当成 D1 的字段，`wrangler` 只打一行 `Unexpected fields found in d1_databases[0] field: "routes"` 就继续部署——结果就是自定义域名根本没绑上。

## 4. 验证

```bash
curl https://<worker>/healthz
curl -H "Authorization: Bearer <SYNC_TOKEN>" https://<worker>/api/health
open "https://<worker>/?t=<SYNC_TOKEN>"
```

`/api/health` 返回 `{"ok":true,"sessions":0,"events":0}` 即为通。之后在 Harness 里点「立即同步」，刷新浏览页就能看到会话。

## 接口

所有 `/api/*` 需要 `Authorization: Bearer <SYNC_TOKEN>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ok, version, sessions, events}` |
| GET | `/api/cursors` | `{ok, cursors:{<sessionId>:{lastSeq,eventCount,syncedAt,digest}}}`，插件据此做增量 |
| POST | `/api/sync` | body `{device, sessions:[{id, header, title, cwd, createdAt, updatedAt, digest, mode:"full"\|"append", events:[...]}]}` → `{ok, results:[{id,lastSeq,eventCount,imported}], errors?}` |
| GET | `/` | 会话列表（`?t=<token>` 首次换取 cookie） |
| GET | `/s/<id>` | 单个会话的只读事件流 |
| GET | `/healthz` | 明文 `ok`，不需要鉴权 |

`mode: "full"` 会先删掉该会话已有事件再写入；`"append"` 只 upsert 收到的那几条。写完后 `last_seq` / `event_count` 用聚合重算，所以两种模式都能保持行数一致。

## 本地联调（不部署也能测）

```bash
node mock.mjs                      # http://127.0.0.1:8787，token = test
```

然后在 Harness 里把插件指向 `endpoint: 'http://127.0.0.1:8787'`、`token: 'test'`，点「立即同步」。
终端会逐条打印请求；浏览页开 `http://127.0.0.1:8787/?t=test`。

## 成本与限额

- D1 免费额度足够个人使用；每条事件一行，payload 是原始事件 JSON。
- 插件按 `maxEventsPerRequest`（默认 300 条）分批 POST，单请求不会顶到 Worker 的 body 限制。
- 浏览页单会话最多渲染 2000 条事件，超出会提示；数据本身都在 D1 里。
