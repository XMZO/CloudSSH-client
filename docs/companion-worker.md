# 伴侣 Worker 设计（草案）

> 状态：只有设计，没有实现。前提是不改 CloudSSH Worker，`E:\gayhub\CloudSSH` 只作为参考。
> 依据：客户端 v0.3.25 的代码；CloudSSH Worker 以 v2.6.8 的行为为准；Cloudflare 的额度与限制为 2026-10 查阅官方文档所得。

伴侣 Worker 是用户自己部署的一个独立 Cloudflare Worker，部署方式与 `tools/reasoning-proxy` 类似。它在 CloudSSH 外面补上 CloudSSH 没有的服务端能力：定时任务、告警、Webhook 触发执行，以及给自动化用的长期令牌。

---

## 0. 结论速览

**可以做，CloudSSH 不用改。** 伴侣持有一条专用的 CloudSSH 会话，在服务器上执行命令的方式和命令行 `cloudssh exec` 相同：先换 connect 令牌，再连 `/api/ssh` WebSocket，等到 `shell_ready`，然后发送用标记包裹的命令。SSH 协议、凭据、跳板链和 CF 隧道仍然全部由 CloudSSH 处理。

**有三条硬约束，决定了方案的形状：**

1. **会话固定 7 天，过期前不能续。** Worker 建会话时就写死了 `expires_at = 创建时间 + 7 天`，校验时也不会延长。伴侣自己没法登录，因为 GitHub 授权只能在浏览器里完成。所以要靠桌面端每隔几天静默签发一条新会话推给它。如果桌面端连续 7 天都没开，自动化就会停下（停之前会提前提醒）。
2. **这条会话等于整个账号的权限。** CloudSSH 没有更小权限的凭据，网页版能做的事伴侣都能做。所以伴侣一旦被攻破，所有已保存的服务器都可以被连接，直到这条会话过期。本文的安全措施都只能在伴侣这一侧收窄权限，CloudSSH 那一侧收窄不了。
3. **两边都有额度。** 一边是伴侣：免费套餐每次调用只有 10ms CPU。另一边是 CloudSSH：伴侣跑的每个 SSH 会话都会用掉 CloudSSH 那边的 Durable Object 时长额度。小规模（十来台服务器、每 5 分钟检查一次）在两边的免费额度内都够，前提是 Phase 0 实测单个会话只用几毫秒 CPU。CI 部署这类长时间流式输出的场景，建议升级 Workers Paid（$5/月）。

**主要决定：**

| 问题 | 决定 |
|---|---|
| 推给伴侣的会话 | 为伴侣**单独签发一条**，不复制桌面端的 Cookie（§3.2） |
| 管理请求怎么认证 | HMAC 签名；推送会话时再加一层信封加密，加密用的公钥在部署时就固定在桌面端（§3.3、§3.4） |
| 在哪执行 | 在 Cron 和 HTTP 调用里执行（只按 CPU 计费）；MVP **不用 Durable Object**（§4.4） |
| 怎么连 CloudSSH | 同一 Cloudflare 账号时用**服务绑定**，避开同区域 1042 错误和按 IP 限流；不同账号时走公网（§4.6） |
| 存储 | **D1**：控制台里就能创建和绑定，不需要 wrangler 迁移；KV 不做主存储（§6） |
| 配置界面 | 桌面端实例管理窗口里新增「伴侣 Worker」页，和「命令行与 AI」并列；伴侣本身只提供签名接口（§7） |
| 危险命令 | 沿用 `safety.ts`：拦截级永远拒绝；需确认级**在保存任务时由人确认**（运行时没人可问）；自动化令牌临时传入的命令默认不允许需确认级（§8.3） |

**工作量粗估：** Phase 0 验证 1–2 天；Phase 1 MVP（会话、定时命令、运行记录、Telegram/Webhook 通知、桌面设置页）约 1.5–2 周；告警、Webhook 触发与令牌各约 1 周（§11）。

---

## 1. 背景与范围

不改 Worker 的前提下，现有的几个插入点各有边界：

| 插入点 | 位置 | 能做什么 | 做不了什么 |
|---|---|---|---|
| 客户端界面与本地功能 | `apps/desktop`、`apps/mobile`、`packages/ui-web/overrides` | 界面、本地存储、后台会话 | 客户端一关，什么都不会发生 |
| AI 增强代理 | `tools/reasoning-proxy` | 改写 Worker 发给模型的请求 | 只能被动等 Worker 来调用 |
| 命令行与 skill | `packages/cli` | 外部 AI 或脚本直接操作服务器 | 依赖本机，以及本机上的会话文件 |

CloudSSH Worker 自己缺四样东西：

- 没有定时任务（没有 Cron）
- 没有告警
- 没有长期 API 令牌：只有 7 天的 session Cookie 和 60 秒的一次性连接令牌
- 不会主动推送

伴侣在 Worker 外面补上这四样。

**目标：**

1. **定时任务**：按 Cron 表达式触发，在指定服务器（主机 ID 或标签）上执行命令，并保存结果
2. **告警**：检查磁盘、服务状态和自定义项目，推送到 Telegram、邮件或 Webhook；带去抖、恢复通知和重复提醒
3. **Webhook 触发执行**：例如 CI 部署完成后，让伴侣在服务器上执行 `systemctl restart app`
4. **长期令牌**：发给自动化使用，在伴侣内部换成 CloudSSH 会话

**非目标：**

- 不改 CloudSSH Worker，也不依赖它的内部路由 `/internal/*`
- 不做交互式终端和 SFTP 浏览（上传部署包放到 Phase 4，可选）
- 不保存任何服务器密码或私钥：认证仍由 CloudSSH 用它保存的凭据完成
- 不支持需要键盘交互认证（验证码、二次验证）的服务器，也不支持要输入 sudo 密码的命令

---

## 2. 总体架构

```
            ┌─ 用户的 Cloudflare 账号（可与 CloudSSH 同一账号，也可以是另一个）─────────────┐
桌面客户端 ──签名的管理请求──▶ 伴侣 Worker ──服务绑定 / 公网 HTTPS──▶ CloudSSH Worker ──TCP──▶ 服务器
（配置、推送会话、               │  fetch：     管理接口 /admin/*、Webhook /v1/hooks/*、令牌接口 /v1/*
  静默续签）                    │  scheduled：每分钟一次：到期的任务和检查、排队的运行、过期提醒
CI / 脚本 ──伴侣令牌───────────▶│  D1：        配置、加密的会话、任务、告警状态、令牌哈希、运行记录、审计
                               └──▶ Telegram / Webhook / 邮件
```

- 伴侣只负责三件事：调度、当协议客户端、发通知。SSH 协议、加密、跳板链和 CF 隧道仍由 CloudSSH 处理。`ai-remote/session.ts` 的注释已经说明了这一点：客户端不经手任何密码或私钥。
- 每次运行都用短会话：建立连接，跑完这台服务器本次所有的命令和检查，然后关闭。不保持长连接，原因见 §4.5。

---

## 3. 会话：怎么拿到、怎么保持

### 3.1 Worker 侧的事实（代码依据）

| 事实 | 依据（CloudSSH 仓库） |
|---|---|
| session Cookie 的 `Max-Age=604800`，即 7 天 | `src/worker/auth.ts:420`（GitHub 回调）、`:618`（密码登录） |
| 服务端会话行写入 `expires_at = 创建时间 + 7 天`；校验时只看 `expires_at > now`。**没有滑动续期**，也没有刷新会话的接口 | `src/worker/user-db.ts:783-791`、`:802-809` |
| 每次登录都新建一行会话，旧会话不受影响；登出只删除请求里带的那一条 | `user-db.ts` 的 session/create、session/delete；`auth.ts` 的 `handleLogout` |
| 没有"列出全部会话"或"吊销全部会话"的功能；密码模式下更换 `ADMIN_PASSWORD_HASH` 会让所有会话失效，因为会话令牌里带有密码代际指纹 | AGENTS.md #39 |
| `POST /api/servers/:id/connect` 返回 `wss://<请求的 host>/api/ssh?token=…`。令牌存在 UserDBDO 的内存里，60 秒有效，只能用一次，最多同时存在 1000 个 | `index.ts:629-643`、`user-db.ts:1909-1936` |
| `/api/ssh` 升级时必须带 `Origin`，而且要和请求 URL 同源，否则返回 403 | `index.ts:1178-1180`、`:1436` |
| 设置 `REQUIRE_GITHUB_AUTH=true` 后，WebSocket 升级还必须带有效会话，并且会话用户就是令牌的主人 | `index.ts:1440-1479` |
| `/api/ssh` 按 `CF-Connecting-IP` 限流：每个 isolate 在内存里计数，每分钟 10 次；请求没有这个头时不限流 | `index.ts:34-35`、`:51-52`、`:287-295` |

> 注：服务端的 `expires_at > datetime('now')` 实际上是拿 ISO 字符串和 SQLite 的时间格式做字符串比较，有效期可能比 7 天多出不到一天。本设计一律按"签发后 7 天"计算，不依赖这段余量。
>
> 另外，`cli-sync.ts` 的注释里写着"客户端隔几天打开一次，命令行就一直能用"。按上面的服务端逻辑，这句不成立：打开客户端并不会延长会话，7 天后桌面端自己也要重新登录，命令行才能跟着拿到新会话。§3.5 的静默续签做好以后，也可以用来解决命令行的这个问题。

由此得到两条推论：

- **伴侣不能自己登录。** GitHub 授权需要浏览器里的 GitHub 登录状态和用户点击授权；命令行的 `login --callback` 也要人手动复制网址。会话只能由有浏览器环境的一端（桌面端）签发，再交给伴侣。
- **伴侣不能延长会话。** 它只能在过期前换一条新的。

### 3.2 推给伴侣哪条会话：专用会话，而不是复制桌面端的 Cookie

现有的"同步登录给命令行"（`apps/desktop/src/main/platform/cli-sync.ts`）是把实例分区里的 session Cookie 原样写进 `~/.cloudssh/credentials.json`。伴侣如果照搬这个做法，会有三个问题：

- 桌面端一登出，伴侣就跟着失效
- 反过来，伴侣想吊销自己的会话（调用 `/api/auth/logout`）时，会把桌面端也登出
- 同一个令牌出现在两个地方，泄露后既分不清是从哪边漏的，也没法只吊销其中一处

所以伴侣使用**专用会话**：桌面端为伴侣单独走一次登录，拿到一条只给伴侣用的新会话。因为每次登录都会新建一行会话（§3.1），这一步不需要改 Worker。

**GitHub 模式下怎么签发：** 复用 `oauth.ts` 的登录流程，只是结果不迁入实例分区。

1. 在 `persist:oauth-<实例 id>` 分区里用**隐藏窗口**打开 `/api/auth/github`。这个分区是持久化的，保存着上次登录 GitHub 的状态。
2. 对已经授权过的 OAuth App，GitHub 会直接带上 code 跳回 Worker 的回调地址。回调写入新的 session Cookie，再 302 回首页。落地页沿用现有的 `isPostLoginLanding` 拦截。
3. 从 oauth 分区取出这条 Cookie 后立即删除（与现在 `finish()` 的做法相同），把它交给伴侣，不写入实例分区。
4. 如果 20 秒内没有落地，说明需要人来操作，比如 GitHub 登录过期、要求重新输入密码或 2FA、或者授权已被撤销。这时不再静默等待，而是发一条系统通知"伴侣 Worker 需要重新授权"；用户点通知后显示窗口，完成授权。

**单管理员密码模式下怎么签发：** 使用 `POST /api/auth/password/login`，做法同命令行的 `login.ts`。每次登录都需要密码，有两种处理方式：

- **默认**：每次续签时弹窗，让用户输入管理员密码（7 天一次）。
- **可选**：把浏览器端预拉伸后的 key（`stretchAdminPassword` 的结果，作用等同于这个实例的密码）用 `safeStorage` 存在**桌面端**，用来静默续签。这个 key 不存进伴侣。

开了 Turnstile 的实例只能弹窗，因为登录需要人机验证组件。

**不建议**让伴侣自己保存预拉伸 key 去登录：这等于把管理员密码长期放在一个对公网开放的 Worker 里，而且登录还会被 Turnstile 挡住。

### 3.3 配对：部署时生成的两个密钥

伴侣部署时需要两个 Worker 机密（Secret）。两个都由桌面端的部署向导生成，用户复制到 Cloudflare 控制台：

| 机密 | 内容 | 谁持有 |
|---|---|---|
| `COMPANION_ADMIN_KEY` | 32 字节随机数，作为管理请求的 HMAC 密钥 | 伴侣（Secret）和桌面端（`safeStorage`） |
| `COMPANION_PRIVATE_KEY` | P-256 私钥（JWK），有两个用途：① 解开桌面端推来的信封；② 经 HKDF 派生出加密 D1 字段用的密钥 | 只在伴侣（Secret）。桌面端生成后只保留公钥（固定下来用于校验），私钥只显示一次就丢弃 |

为什么加密根密钥放在 Worker 机密里，而不是放在 D1 里：CloudSSH 自己是把根密钥和数据放在同一个 SQLite 里的，AGENTS.md #40 写明了这只能防止"凭据列直接是明文"。伴侣保存的是整个账号的会话，至少要做到"只拿到 D1 导出还不够，还得拿到 Worker 机密"。

但这个边界也有限：能部署或修改伴侣代码的人仍然能读到一切。设置页的说明里要写清楚这一点。

### 3.4 推送协议

```
桌面端                                                       伴侣
  │ 1. 签发专用会话（§3.2），记下签发时间 issuedAt
  │ 2. 打包信封：ECDH(临时 P-256 密钥, 固定的伴侣公钥) → HKDF → AES-256-GCM
  │    明文 = {session, issuedAt, instanceOrigin, githubId}
  │    AAD  = "cloudssh-companion/session/v1" | instanceOrigin | 时间戳 | nonce
  │ 3. PUT /admin/session，请求头带 X-CS-Timestamp、X-CS-Nonce，以及
  │    X-CS-Signature = HMAC-SHA256(ADMIN_KEY, 方法 \n 路径 \n 时间戳 \n nonce \n SHA-256(body))
  │─────────────────────────────────────────────────────────▶│ 4. 校验签名；时间戳必须在 ±5 分钟内；
  │                                                          │    nonce 没用过（D1 里保留 10 分钟）
  │                                                          │ 5. 解开信封
  │                                                          │ 6. 用新会话请求 GET /api/auth/me：必须返回 200，
  │                                                          │    且 github_id 与配对时登记的一致（防止推错账号）
  │                                                          │ 7. 用派生密钥做 AES-GCM 加密后写入 D1
  │                                                          │    （AAD = 实例源 | github_id）
  │                                                          │ 8. 如果有旧会话，调 /api/auth/logout 吊销（尽力而为）
  │◀── {expiresAt, user} ────────────────────────────────────│
```

- 会话明文只出现在伴侣的内存里，不写进日志。伴侣日志只记录 `session: present / expired` 这类状态。
- 用签名，而不是把管理密钥当 Bearer 令牌发出去：管理密钥本身不在网络上传输。即使请求被代理或抓包看到，也无法重放，更拿不到管理权限。
- 信封加密用的公钥是部署时固定在桌面端的，不从网络获取。所以即使本机的代理（企业代理、调试代理）解开了 TLS，请求体里也不会出现会话明文。
- 第 8 步的顺序很重要：新会话验证并保存成功之后，才吊销旧会话。吊销失败只记日志，旧会话最多 7 天后自然过期。

### 3.5 保持：续签节奏

- 伴侣记录 `expiresAt = issuedAt + 7 天`。`/api/auth/me` 不返回到期时间，只能按签发时间推算。
- 桌面端运行期间每小时检查一次：剩余不足 3 天就静默续签（§3.2），成功后推送（§3.4）。用户只要每 4 天内打开一次客户端，自动化就不会断。
- 设置页里可以手动"立即续签"。
- 手机端（Tauri，会话只存在 Rust 侧，见 `apps/mobile/src-tauri/src/oauth.rs`）以后也可以用同样的方式续签，放在 Phase 4。

### 3.6 过期提醒

伴侣每次 Cron 运行时检查会话的剩余时间，在**剩 48 小时、24 小时、6 小时**时各发一次提醒到告警渠道。每档只发一次，发过的档位记在 D1 里。提醒内容为：

> 伴侣 Worker 的 CloudSSH 会话将在 X 小时后过期，请打开桌面客户端（会自动续签）。

除此之外：

- 桌面端设置页显示倒计时
- `GET /v1/status`（任何有效令牌都可以读）也返回剩余时间，CI 可以据此提前报警

### 3.7 失效时的行为

会话状态有三种：`ok`、`expiring`（剩余不足 48 小时）、`invalid`。

| 情况 | 怎么判定 | 怎么处理 |
|---|---|---|
| 到期 | `now ≥ expiresAt` | 置为 `invalid`，不再发请求 |
| CloudSSH 返回 401 | `/api/servers*`、`/connect` 或 WebSocket 升级，任一处返回 401 | 置为 `invalid`。会话被登出、密码模式换了哈希、GitHub 白名单改了等情况，都会表现为 401 |
| CloudSSH 返回 403 | 例如 GitHub 账号不在白名单、令牌不属于该账号 | 置为 `invalid`，通知里带上原因 |
| 连不上 CloudSSH | 网络错误、5xx、1042/522、429 | **不算会话问题**：按任务记为 `upstream_unreachable`，指数退避；连续 3 个周期都失败才告警一次 |

进入 `invalid` 后：

- **暂停所有定时任务和检查。** 运行记录写成 `skipped(session_invalid)`，**不触发**各个检查自己的告警，避免一次会话失效刷出几十条"磁盘检查失败"。
- **只发一条"会话失效"通知**（带原因），之后每 24 小时提醒一次。
- **Webhook 和令牌接口返回** `503 {"error":"companion_session_invalid"}`：CI 会立刻失败，原因也清楚，不会一直挂到超时。
- **收到新会话（§3.4）后自动恢复**，并补发一条"已恢复"。暂停期间错过的定时任务**不补跑**，这和 Cron 的常规语义一致；需要的话可以在单个任务上打开"恢复后补跑一次"。

### 3.8 吊销

- **正常吊销**：在桌面端设置页点「吊销伴侣会话」，桌面端调用伴侣的 `DELETE /admin/session`；伴侣用这条会话调用 `/api/auth/logout`，再删除本地密文。
- **伴侣连不上时**：桌面端用自己保存的副本直接调用 `/api/auth/logout`。为此，桌面端要用 `safeStorage` 保留一份当前的伴侣会话。这份副本只用于紧急吊销，不发其他任何请求。
- **两条路都走不通时**：比如会话已经泄露、伴侣联系不上、桌面端的副本也丢了。CloudSSH 没有"吊销全部会话"的功能，只能用配置层面的应急办法：
  - **GitHub 模式**：每次校验会话都会重新检查 `GITHUB_ALLOWED_USER_IDS`（AGENTS.md #21）。可以临时把这个变量设成不含自己的 ID，该账号的全部会话会立即失效；改回来以后重新登录即可。在 GitHub 上撤销 OAuth App 授权**没有用**，因为已签发的 CloudSSH 会话校验时不会再去问 GitHub。
  - **密码模式**：更换 `ADMIN_PASSWORD_HASH`，所有会话立即作废。

  这些办法要写进设置页的风险说明。

---

## 4. 在 Worker 里跑 SSH 命令

### 4.1 协议（与 `ai-remote/session.ts` 一致）

1. **申请连接令牌。** 请求 `POST https://<实例>/api/servers/:id/connect`，请求头带 `Cookie: session=…`、`Origin: https://<实例>` 和 `User-Agent: cloudssh-companion/<版本>`，拿到 `{ wsUrl }`。
2. **升级 WebSocket。** 60 秒内调用 `fetch(<wsUrl 换成 https://>, { headers: { Upgrade: 'websocket', Origin, Cookie } })`。返回 `101` 后执行 `resp.webSocket.accept()`，并设置 `binaryType = 'arraybuffer'`。
3. **初始交互。** 立刻发送 `{"type":"resize","cols":200,"rows":50}`，之后每 20 秒发一次 `ping`。
4. **回执输出。** 收到 `terminal_output_flow` 时记下其中的 id；之后每收到二进制输出就累计字节数，每 16ms 合并发一次 `terminal_output_ack`。不回执的话，Worker 在未确认输出达到 4MiB、或者 60 秒没有 ACK 进展时会断开连接（AGENTS.md #30）。
5. **等待 `status/shell_ready`**，超时 30 秒。期间：
   - 收到 `auth_challenge`：回 `auth_cancel`，本次失败（服务器需要交互认证）
   - 收到 `host_key_changed`：失败。伴侣**不能**确认新指纹
   - 收到 `host_key_first_seen` 或 `host_key_not_saved`：伴侣额外要求这两种情况也失败（`src/worker/ssh-session.ts` 的 `finalizeHostKeyTrust`）。它们表示这台服务器从没在客户端里连过，没有已知指纹，此时提示"请先在客户端里连接一次"。首次信任（TOFU）交给人来做，不交给自动化
   - 收到 `error`：失败
6. **初始化 Shell。** 关回显、清空提示符、禁用分页器，探测 bash 与 `timeout`，然后等待输出 `__CSRDY<id>`。
7. **逐条执行命令。** 每条命令的形式为 `printf BEG; { cs_run <秒> '<命令>' </dev/null 2>&1; printf RC; } | tail -c 65536; printf END`。标记用八进制转义写，所以命令回显出来时不会被误认为标记。
8. **关闭。** 这台服务器本次的命令全部跑完后，`close(1000)`。

### 4.2 Worker 运行时的适配点

| 浏览器或 Node 里的写法 | Worker 里的写法 |
|---|---|
| 相对路径 `fetch('/api/…')`，Cookie 由浏览器自动带 | 用绝对地址，手动加 `Cookie` 和 `Origin` 头（同 `packages/cli/src/net.ts` 的做法） |
| `new WebSocket(url)` | Workers 的 `new WebSocket(url)` 不能带自定义头（Cookie、Origin），必须改用 `fetch` 加 `Upgrade` 头，地址写成 `https://` |
| `Math.random()` 生成标记 id | 改用 `crypto.randomUUID()`。标记不是安全边界，但没有理由用弱随机 |
| 每来一块输出，就对**整段**缓冲做一次 `replace(ANSI)` 和正则匹配（`session.ts` 的 `waitFor`） | 输出大时 CPU 开销是 O(n²) 的，在 10ms 预算下很危险。改成增量扫描：只扫新到的块，加上上一块末尾与标记等长的重叠部分；ANSI 控制符只在取结果时清一次 |

**复用方式：** 把 `session.ts` 里与平台无关的部分抽到 `packages/core/src/remote-exec/`，包括标记、初始化脚本、命令包裹、结果解析和 ACK/ping 规则；传输层（fetch 和 WebSocket 工厂）做成可注入的。这样 ui-web 的 AI 跨服务器操作、命令行、伴侣三处共用一份代码，协议有变化时只改一处，增量解析也能顺带用到另外两处。

### 4.3 CPU、时长、连接数

Cloudflare 官方限制（developers.cloudflare.com/workers/platform/limits）：

| 项目 | Workers Free | Workers Paid |
|---|---|---|
| 每天请求数 | 10 万 | 不限（每月含 1000 万） |
| 每次 HTTP 调用的 CPU | 10 ms | 默认 30 秒，最多 5 分钟 |
| 每次 Cron 调用的 CPU | 10 ms | 30 秒（间隔小于 1 小时时） |
| 墙钟时长 | HTTP 不限；Cron 15 分钟 | 同左 |
| 每次调用的子请求（fetch、D1、KV 都算） | 50 | 10,000 |
| 每次调用的 D1 查询 | 50 | 1,000 |
| 同时等待响应头的连接 | 6 | 6 |
| 每个账号的 Cron Trigger 数 | 5 | 250 |
| `waitUntil` 最多延长 | 30 秒 | 30 秒 |

对伴侣的影响：

- **CPU 只算真正计算的时间。** 等远端命令输出、等 WebSocket 消息都不算 CPU。伴侣自己不做 SSH 加密（那是 CloudSSH 的事），每个会话的 CPU 主要花在 JSON 解析、UTF-8 解码和标记扫描上。估计输出较小时每个会话 1–3 ms，**需要 Phase 0 实测**（Workers Logs 里有每次调用的 `cpuTime`）。
- **免费套餐下，单次 Cron 调用能跑的会话数有限。** 调度器给每次运行（下称 tick）设一个"会话预算"，默认免费套餐 3 个、付费套餐 20 个。定时任务还要按服务器错峰：例如 `*/5` 的任务按服务器 id 分散到 5 分钟里的不同分钟，而不是整点一起跑。
- **子请求。** 每个会话占 2 个（connect 和升级），D1 查询也计入。每个 tick 用 `db.batch()` 合并写入，留足余量。
- **连接数。** 同时最多 6 个连接在等响应头，所以并发连接数上限设为 5。
- **Cron 墙钟 15 分钟。** 任务超时上限设为 14 分钟；更长的任务只能走 Phase 4 的 Durable Object 方案。
- **`waitUntil` 只能延长 30 秒。** Webhook 的异步执行不能靠 `waitUntil`，要排进 D1，由下一次 Cron 来跑（§5.3）。

### 4.4 要不要 Durable Object

MVP 不需要。

- **放在 Cron 或 HTTP 调用里执行：** Workers 只按 CPU 计费，等输出的几秒到几分钟不花钱。
- **放在 DO 里执行：** DO 按墙钟计时长（128MB × 秒），出站 WebSocket 又不能休眠，跑一个 2 分钟的部署就是 15 GB-s。而且新增 DO 类需要用 wrangler 做迁移，控制台粘贴代码的部署方式做不到。
- **防止同一任务被重复执行：** 用 D1 的条件更新做租约就够了（§5.1）。

Phase 4 可选：如果需要"Webhook 触发后立即开始，并且可能超过 15 分钟"的长任务，再加一个用 alarm 驱动执行的 DO。

### 4.5 为什么不保持长连接

和每台服务器保持一条常驻会话，可以省掉每次的握手，但代价更大：

- **伴侣侧**要一个常驻的 DO。一条会话常驻 24 小时约 10,800 GB-s/天，已经接近免费额度的 13,000。
- **CloudSSH 侧**的 SSHSessionDO 同样会常驻：出站 TCP 会让它无法休眠（见 AGENTS.md「Durable Objects」一节）。
- 常驻会话还会被 CloudSSH 的空闲超时（默认 30 分钟）断开。

相比之下，用短会话、并把这台服务器本次的所有检查在一个会话里跑完，更省。

### 4.6 怎么连到 CloudSSH：同区域限制

Cloudflare 不允许一个 Worker 通过公网地址请求同一区域（zone）里的另一个 Worker，会报错误 1042，在 `workers.dev` 上有时是 522。reasoning-proxy 已经踩过这个坑（`tools/reasoning-proxy/README.md` 的「部署位置」一节）。

但伴侣的情况不一样：

- **reasoning-proxy** 是 CloudSSH 去请求代理。要放宽限制，只能改 CloudSSH 的配置。
- **伴侣**是伴侣去请求 CloudSSH。需要放宽的配置在伴侣自己身上，可以自己改。

| 部署方式 | 怎么连 | 说明 |
|---|---|---|
| A. 与 CloudSSH 同一账号（推荐） | **服务绑定**：在伴侣上配置绑定 `CLOUDSSH → cloudssh`（测试环境为 `cloudssh-test`），然后调用 `env.CLOUDSSH.fetch(new Request('https://bash.al/api/…'))` | 不走公网，所以没有 1042。请求 URL 的 host 仍然写实例域名，CloudSSH 的同源检查和 `wsUrl` 都照常工作。伴侣构造的请求不带 `CF-Connecting-IP`，所以不受 `/api/ssh` 每分钟 10 次的按 IP 限流（Phase 0 要确认运行时不会自动补上这个头）。服务绑定不额外收请求费。**待验证**：通过服务绑定的 fetch 能否完成 WebSocket 升级。官方文档没有写明，预期可以，Phase 0 实测 |
| B. 另一个 Cloudflare 账号 | 公网 `https://bash.al` | 稳妥，也是 reasoning-proxy 推荐的做法。缺点是会受 `/api/ssh` 的按 IP 限流：伴侣的出站 IP 是 Cloudflare 的，可能和其他人共享。对策：伴侣把每分钟新建的会话数自限在 8 个以内，遇到 429 按 `Retry-After` 退避 |
| C. 同一账号，但走公网（`workers.dev` 或另一个域名） | 公网 | 可能遇到 1042 或 522。伴侣可以自己打开兼容标志 `global_fetch_strictly_public`，但官方文档只说明了它对"请求自己所在区域"的作用，**没有说明**能否解决 1042，需要 Phase 0 验证。不作为推荐方案 |

部署向导里的「测试连接」会依次检查：

1. 伴侣用会话请求 `GET /api/auth/me`，确认 HTTP 链路通、会话有效
2. 用一个不存在的连接令牌（`<github_id>:test`）发起一次 `/api/ssh` 升级。预期得到 403 `Invalid or expired connection token`，说明请求到达了 CloudSSH，`Origin` 也被接受了；如果得到 1042、522 或网络错误，就说明连不上
3. 在用户选定的服务器上跑一次 `true`

### 4.7 能力边界

- 只支持 POSIX Shell。初始化脚本依赖 `stty`、`printf` 和 `tail`；Windows OpenSSH 默认的 cmd 或 PowerShell 不行。
- 需要 sudo 的命令，必须配置 NOPASSWD。
- 输出只保留最后 64KB（与命令行一致），告警和日志里再截得更短。
- 断线时执行状态未知。与 `cloudssh exec` 一样，**不自动重试**有副作用的命令；只有标记为"可重试"的检查类任务会重试。

---

## 5. 功能设计

### 5.1 定时任务

任务定义示例：

```jsonc
{
  "id": "job_backup",
  "name": "每日备份",
  "targets": ["srv-12", "tag:db"],      // 运行时用 GET /api/servers 解析（列表缓存 10 分钟）
  "commands": ["/opt/backup/run.sh"],    // 在一台服务器上按顺序执行，共用一个会话
  "schedule": "30 3 * * *",              // 5 段 cron
  "timezone": "Asia/Shanghai",
  "timeoutSec": 600,                     // 每条命令的超时，≤ 840（Cron 墙钟 15 分钟）
  "concurrency": 3,                      // 目标有多台时，同时连几台（≤ 5）
  "overlap": "skip",                     // 上一次还没跑完时：skip | queue
  "notify": { "on": "failure", "channels": ["tg_main"] },  // always | failure | change | never
  "keepOutput": "tail-4k",               // none | tail-4k | tail-64k
  "dangerAck": null                      // 需确认级命令在保存时由人确认（§8.3）
}
```

**调度：** 只用一个 Cron Trigger `* * * * *`，占免费账号 5 个名额中的 1 个。每分钟按顺序做这几件事：

1. 找出到期的任务（`next_run_at <= now`），按 §4.3 的预算取一批。
2. 用 D1 的条件更新抢租约：`UPDATE jobs SET lease_until=?, next_run_at=? WHERE id=? AND (lease_until IS NULL OR lease_until < ?)`。只有 `changes = 1` 时才执行。这样即使 Cron 偶尔重复触发、或者上一个 tick 还没结束，也不会重复执行。
3. 执行任务，写入运行记录，再按 `notify` 设置发通知。
4. 处理排队中的 Webhook 异步运行（§5.3）和会话过期提醒（§3.6）。

**运行记录：** 每次运行记一行，每台服务器再各记一行，内容包括退出码、耗时、是否超时或截断，以及加密后的输出尾部。保留期限为 30 天或每个任务最近 200 次，以先到者为准。

### 5.2 告警

检查就是"带判定规则的任务"。同一台服务器在本周期要做的所有检查，合并成一个会话里的多条命令。

| 类型 | 远端命令 | 判定规则 |
|---|---|---|
| 磁盘 | `df -PkT -x tmpfs -x devtmpfs -x overlay -x squashfs` | 任一挂载点使用率 ≥ 阈值（默认 90%），可以只看指定的挂载点 |
| inode | `df -Pi …` | 同上 |
| 服务 | `systemctl is-active <unit…>`（没有 systemd 的机器改用自定义检查） | 状态不是 `active` |
| 内存 / 负载 | `cat /proc/meminfo /proc/loadavg` | 可用内存低于阈值，或 load 除以核数高于阈值 |
| 自定义 | 任意命令 | 三种方式任选：退出码不为 0；输出匹配（或不匹配）某个正则；把输出里的第一个数字和阈值比较。证书剩余天数这类检查也可以用这种方式在服务器上做，例如 `openssl s_client`、`openssl x509 -enddate` |
| HTTP 可达性（由伴侣直接请求，不走 SSH） | 伴侣 `fetch` 一个 URL | 状态码、耗时 |

**告警状态机**（每个"检查 × 服务器"组合各一条）：

```
ok ──失败──▶ pending（累计连续失败次数）──达到 N 次（默认 2）──▶ firing：发「告警」
firing ──仍然失败──▶ 每隔 repeat（默认 6 小时）再提醒一次
firing ──连续成功 M 次（默认 1）──▶ ok：发「已恢复」
```

- **执行出错和判定失败分开处理。** 连不上服务器、会话失效、CloudSSH 不可达，都记为 `error`，归入"服务器不可达"这一类单独告警。这样一台机器断网时，不会把它所有检查的告警都刷一遍。
- **静默**：可以按检查、按服务器、按时间窗口（维护窗口）静默。
- **通知内容**：标题、服务器（主机 ID 和名称）、当前值与阈值、首次发生时间。默认**不带**命令输出，可以选择附上最后 1KB。因为输出里可能有敏感信息，而 Telegram 这类渠道属于第三方。

**通知渠道：**

| 渠道 | 实现 | 说明 |
|---|---|---|
| Telegram | Bot API 的 `sendMessage`（需要 bot token 和 chat id） | bot token 加密后存在 D1。出站请求从 Cloudflare 发出 |
| Webhook | `POST` 一段 JSON，可选带 HMAC 签名头。内置几种模板：通用 JSON、Slack/Discord、飞书、企业微信、钉钉、Bark、ntfy | 能覆盖大多数 IM |
| 邮件 | 二选一：Cloudflare Email Service 的 `send_email` 绑定（发件域名要先接入 Cloudflare）；或第三方 HTTP 接口（Resend、Mailgun 等，API key 加密存储） | Workers 不能直接发 SMTP（用 TCP sockets 可以实现，但不值得）。放在 Phase 3 |

每个渠道都有「发送测试消息」按钮。发送失败会记在运行记录里，连续失败的渠道在桌面端设置页标红。不做跨渠道自动降级，需要冗余时配置多个渠道即可。

### 5.3 Webhook 触发执行

```
POST /v1/hooks/<hookId>
Authorization: Bearer csc_<令牌>        （或 GitHub 风格的 X-Hub-Signature-256，见下）
Idempotency-Key: <CI 的 run id>           （可选）
Content-Type: application/json

{"params": {"ref": "v1.2.3"}, "wait": true}
```

- **调用方只能传参数，不能传命令。** 每个 Hook 绑定一个事先定义好的任务，命令、目标服务器和超时都在任务里定死。
- **参数的约束。** 任务里事先声明参数白名单，包括参数名和校验正则（例如 `ref: ^[A-Za-z0-9._/-]{1,100}$`），命令里用 `{{ref}}` 引用。替换时一律加 Shell 单引号转义；替换完成后，**最终命令**还要再过一遍 `safety.ts`。
- **同步模式 `wait: true`（CI 推荐）。** 伴侣立刻返回 200，并以 `text/event-stream` 推送进度：每台服务器的开始和结束、输出尾部。最后一帧带每台服务器的退出码和总结果；期间每 15 秒发一次心跳。CI 用 `curl -N` 一直等到结束，再按结果判断成败。HTTP 调用的墙钟不限，但免费套餐的 CPU 仍然只有 10ms，输出很长的部署建议用 Paid。
- **异步模式 `wait: false`。** 伴侣返回 `202 {runId}`，把运行排进 D1，由下一分钟的 Cron 执行（最多延迟 1 分钟，并受 15 分钟墙钟限制）。结果用 `GET /v1/runs/<runId>` 查询。
- **幂等。** 同一个 `Idempotency-Key` 在 24 小时内只执行一次，重复的请求直接返回第一次的 runId 和结果。这样 CI 重试不会导致重复部署。
- **GitHub Webhook。** Hook 可以配置 secret，伴侣校验 `X-Hub-Signature-256`（恒时比较）。还可以限定事件，例如只接受 `workflow_run` 事件中 `completed`、`conclusion=success` 且分支匹配的那些。参数从 payload 的指定字段里取，同样要通过白名单正则。
- **防重放。** Bearer 令牌靠 HTTPS 保护；签名方式另外带时间戳头（±5 分钟内有效），并把签名记录保留 10 分钟。

GitHub Actions 示例：

```yaml
- name: 部署
  run: |
    curl -fsSN -X POST "https://companion.example.com/v1/hooks/deploy-web" \
      -H "Authorization: Bearer ${{ secrets.CLOUDSSH_COMPANION_TOKEN }}" \
      -H "Idempotency-Key: ${{ github.run_id }}-${{ github.run_attempt }}" \
      -H "Content-Type: application/json" \
      -d '{"params":{"ref":"${{ github.sha }}"},"wait":true}' | tee deploy.log
    grep -q '"result":"ok"' deploy.log
```

### 5.4 自动化令牌

- **格式**：`csc_<8 位 id>_<32 字节 base64url>`。D1 里只存 `SHA-256(令牌)`，令牌明文只在创建时显示一次。
- **权限范围**：创建时选择，越小越好。

| scope | 能做什么 |
|---|---|
| `hook:<hookId>` | 只能触发这一个 Hook（推荐给 CI 用） |
| `runs:read` | 读取运行记录和状态 |
| `jobs:run:<jobId>` | 手动触发某个定时任务 |
| `exec` | 在 `servers` 限定的服务器上执行**任意命令**，给外部 AI 或脚本用。需确认级命令默认拒绝，令牌同时有 `exec:dangerous` 才放行；拦截级命令永远拒绝 |

- **附加限制**：
  - 服务器范围（主机 ID 或标签）
  - 过期时间（默认 90 天，最长 1 年）
  - 来源 IP 白名单（可选；CI 出口 IP 不固定时不要用）
  - 每分钟调用次数上限
- **记录与吊销**：记录每个令牌最后一次使用的时间和 IP；在桌面端设置页可以随时吊销。
- **怎么"换成 CloudSSH 会话"**：所有令牌共用伴侣持有的那一条会话，令牌只决定伴侣**允许**做什么。在 CloudSSH 看来，所有操作都来自同一个用户。

---

## 6. 存储

| 方案 | 结论 |
|---|---|
| **D1（选用）** | 控制台里就能创建和绑定；SQL 适合查询任务、运行记录和告警状态；条件 `UPDATE` 可以做租约。免费额度：每天 500 万行读、10 万行写，单库 500MB，账号总共 5GB。伴侣在第一次收到请求时自动建表，schema 版本记在 `meta` 表里，不需要 wrangler 迁移 |
| Durable Object（SQLite） | 一致性更强，自带 alarm；但新增 DO 类要用 wrangler 迁移，而且长时间执行按墙钟计费（§4.4）。Phase 4 可选 |
| KV | 最终一致，跨地点同步最多要 60 秒左右；免费套餐每天只能写 1000 次，不适合做租约和计数。不用 |

表结构草案：

| 表 | 关键字段 |
|---|---|
| `meta` | schema 版本、实例源、配对时登记的 github_id、伴侣公钥指纹 |
| `session` | 只有一行：密文、iv、签发与到期时间、状态、最近一次成功或错误、已发过的提醒档位 |
| `server_cache` | `GET /api/servers` 的结果（只保留 id、名称、标签、系统），缓存 10 分钟 |
| `jobs` | 任务定义 JSON、`next_run_at`、`lease_until`、`danger_ack_hash`、是否启用 |
| `checks` / `alert_state` | 检查定义；每个"检查 × 服务器"的状态、计数、最近值、最近通知时间 |
| `channels` | 渠道类型、名称、配置密文 |
| `hooks` | 关联的任务、参数白名单、GitHub secret 密文、事件过滤条件 |
| `tokens` | 令牌哈希、scope、服务器范围、过期时间、吊销时间、最近使用时间 |
| `runs` / `run_targets` | 每次运行的结果，以及每台服务器的结果（输出尾部为密文） |
| `idempotency` / `nonces` | 幂等键保留 24 小时；管理请求和签名的 nonce 保留 10 分钟 |
| `audit` | 谁做的（desktop / `token:<id>` / cron）、做了什么、什么时候；保留 90 天 |

**加密：** 会话、渠道配置、GitHub secret 和运行输出都用 AES-256-GCM 加密。密钥由 `COMPANION_PRIVATE_KEY` 经 HKDF 按用途分别派生（`session`、`channel`、`output`）；AAD 里带上表名和行 id，防止密文被挪到别的行里使用。

---

## 7. 配置界面

| 方案 | 优点 | 缺点 |
|---|---|---|
| **在桌面端实例管理窗口新增「伴侣 Worker」页（选用）** | 已有 `safeStorage`（`apps/desktop/src/main/platform/vault.ts`）可以放管理密钥和吊销用的会话副本；会话续签本来就离不开桌面端；不用再给伴侣做一套登录；和「命令行与 AI」（`apps/desktop/src/manager/main.ts:418`）在同一个窗口，用同一套样式 | 只能在装了桌面端的电脑上改配置 |
| 伴侣自带网页 | 任何设备都能用 | 伴侣要再做一套登录，等于又多一个长期凭据放在浏览器里；要防 XSS 和 CSRF；代码量翻倍；而且会话续签仍然离不开桌面端 |

**决定：** 配置放在桌面端。

- 伴侣只提供 JSON 管理接口：用 HMAC 签名认证，不开 CORS，浏览器调用不了。
- `GET /` 返回一个不含任何数据的状态页（版本号、是否已配对），用来确认部署成功。
- 手机端以后可以加只读状态页，用同样的签名接口，密钥放在 Android Keystore。

「伴侣 Worker」页的内容：

1. **部署向导**：
   - 复制 `worker.js`
   - 生成并显示两个机密（只显示一次）
   - 逐步说明怎么配置 D1 绑定（变量名 `DB`）、Cron Trigger（`* * * * *`），以及服务绑定或公网地址
   - 填写伴侣地址
   - 「测试连接」依次检查：伴侣可达 → 签名通过 → 公钥匹配 → 伴侣能到达 CloudSSH → 在选定服务器上成功跑一次 `true`
2. **会话**：状态、剩余时间、上次续签时间，以及「立即续签」「吊销」两个按钮。
3. **任务、检查、通知渠道、Webhook 与令牌**：列表加编辑。保存含需确认级命令的任务时，弹出与 AI 面板一致的确认框，并显示命中了哪条规则。
4. **运行记录**：最近的运行、每台服务器的结果、输出尾部，以及「立即运行一次」。
5. **用量**：今天跑了多少会话、估算用掉的 CloudSSH DO 时长（算法见 §9），接近预算时给出提示。

命令行支持放在 Phase 4：`cloudssh companion status|runs|run <job>`。命令行使用自动化令牌（环境变量 `CLOUDSSH_COMPANION_TOKEN`），不使用管理密钥。

---

## 8. 安全边界

### 8.1 威胁与对策

| 威胁 | 后果 | 对策 | 剩余风险 |
|---|---|---|---|
| 伴侣的机密和 D1 都被拿到（Cloudflare 账号被盗，或者有人有部署权限） | 拿到整个账号的会话，可以连接所有已保存的服务器，直到会话过期 | 伴侣单独放在一个 Cloudflare 账号里，或者给账号开 2FA；会话是专用的，可以单独吊销（§3.8）；最长 7 天就会过期 | **CloudSSH 侧无法限制会话权限，这是本方案的固有代价** |
| 只拿到 D1 导出 | 只有密文 | 密钥在 Worker 机密里 | — |
| 伴侣代码有漏洞被利用 | 同上 | 对 CloudSSH 只允许固定的几种请求（§8.2），在发请求的唯一出口按"方法 + 路径"白名单检查；不转发调用方提供的任何 URL 或请求头 | 白名单内的能力（连服务器执行命令）本身就够危险 |
| 自动化令牌泄露 | 视 scope 而定：能触发某个 Hook，或者能在限定的服务器上执行命令 | 最小 scope、过期时间、IP 白名单、限速、吊销、审计；`exec` 默认不允许需确认级命令 | 泄露一个 `exec` 令牌，约等于在限定的服务器上被执行普通命令 |
| 管理请求被抓包或重放 | — | HMAC 签名 + 时间窗 + nonce；推送会话时另有信封加密 | — |
| 推错会话（推成了别的账号的） | 伴侣操作错误的账号 | 推送时 `/api/auth/me` 返回的 github_id 必须等于配对时登记的 | — |
| 主机被中间人替换 | 在假主机上执行命令、输出泄露 | 依赖 CloudSSH 的指纹校验；伴侣遇到 `host_key_changed` 或首次见到的指纹都直接中止 | — |
| 通知内容外泄 | 命令输出被发给第三方 | 默认不带输出；渠道凭据加密存储 | 用户自己选择附带输出时 |
| Webhook 参数注入 | 拼出任意命令 | 只能传参数；参数要过白名单正则；替换时做 Shell 转义；替换后再检查一遍 | — |

### 8.2 发往 CloudSSH 的请求白名单

伴侣代码里只有一个发请求的出口函数，白名单以外的路径直接抛错：

```
GET  /api/auth/me
GET  /api/servers
POST /api/servers/:id/connect
GET  /api/ssh?token=…   （WebSocket 升级）
POST /api/auth/logout   （只在吊销会话或换新会话时使用）
```

如果 Phase 4 要做上传，再加上 `/api/ssh/sftp` 附着。除此之外，伴侣不碰 AI 配置、分享、已知主机、服务器增删改等任何接口。

### 8.3 危险命令

伴侣直接打包 `packages/ui-web/overrides/shared/ai-remote/safety.ts`，它和 CloudSSH 的 `src/worker/agent/safety.ts` 是同一套规则：

| 规则 | 定时任务 / Hook（命令在任务里定死） | `exec` 令牌（命令由调用方传入） |
|---|---|---|
| 命中 `isBlockedCommand`（`rm -rf /`、fork bomb、`mkfs`、`dd` 写块设备） | 保存时拒绝；运行时再查一次，同样拒绝 | 拒绝 |
| 命中 `needsConfirmation`（`rm`、`reboot`、Shell 或解释器包裹、`chmod -R` 等） | 保存时在桌面端弹窗确认，确认后记下 `danger_ack_hash = SHA-256(命令模板)`。运行时如果命令模板的哈希对不上（说明被改过），就拒绝执行 | 默认拒绝；令牌有 `exec:dangerous` 才执行（创建这种令牌时，桌面端会单独警告） |
| 其他命令 | 执行 | 执行 |

说明：

- 这些规则是尽力而为的护栏，不是 Shell 沙箱，`safety.ts` 的文件头也是这么说明的。真正的边界在于：任务由人来定义，令牌的 scope 尽量小。
- Hook 参数替换后，如果最终命令里出现 `bash -c` 之类的写法，同样会命中需确认级规则。所以参数白名单的正则不应允许空格和 Shell 元字符。

### 8.4 日志与数据

- **Worker 日志只记这些**：任务 id、服务器主机 ID、状态、耗时、退出码、错误类别。不记命令输出、会话、令牌和渠道凭据。
- **审计记录**：所有管理操作、令牌的每次使用、会话的推送与失效。

---

## 9. 费用与免费额度

伴侣要算两份账：**伴侣自己的**，和 **CloudSSH 那边的**，因为每次执行都会在 CloudSSH 上开一个 SSH 会话。两者部署在同一个账号时，额度是共用的。

### 9.1 每次执行在 CloudSSH 侧的消耗

每台服务器一次执行对应一个会话，消耗如下：

| 项目 | 每次执行 |
|---|---|
| Worker 请求 | 2 次（connect 和升级）。走服务绑定时不额外收请求费 |
| DO 请求 | 约 4–5 次：校验会话、签发令牌、消费令牌、打开 SSHSessionDO；开了 `REQUIRE_GITHUB_AUTH` 时还要多校验一次 |
| DO 时长 | SSHSessionDO 从升级到关闭一直处于唤醒状态，按 128MB 计，**每秒 0.125 GB-s**。一个 5 秒的检查约 0.6 GB-s；一个 2 分钟的部署约 15 GB-s |

CloudSSH 的 DO 免费额度是每天 10 万次请求、13,000 GB-s（约合 29 小时的会话时长）。这些额度还要留给用户自己开终端：开 8 小时终端大约就要 3,600 GB-s。

### 9.2 示例

**场景：** 10 台服务器每 5 分钟检查一轮（每台 3 项检查合并成一个会话），外加 2 个每日备份，每天 10 次 CI 部署（每次 3 台、约 2 分钟）。

| 项目 | 每天用量 | 免费额度 | 占比 |
|---|---|---|---|
| 会话数 | 2,880 + 2 + 30 ≈ 2,912 | — | — |
| CloudSSH 的 Worker 请求 | ≈ 5,800 | 100,000 | 6% |
| CloudSSH 的 DO 请求 | ≈ 14,600 | 100,000 | 15% |
| CloudSSH 的 DO 时长 | 检查 2,880 × 0.6 + 部署 30 × 15 + 备份 ≈ 2,300 GB-s | 13,000 | 18% |
| 伴侣的 Worker 请求 | Cron 1,440 + Hook 与管理请求 ≈ 1,500 | 100,000 | 2% |
| 伴侣的 CPU | 错峰后每个 tick 不超过 2–3 个会话 | 每次 10 ms | **取决于 Phase 0 实测** |
| 伴侣的 D1 写入 | 每个会话约 2–3 行，≈ 8,000 | 100,000 | 8% |
| 伴侣的 D1 读取 | 每个 tick 几十行，≈ 10 万 | 5,000,000 | 2% |

结论：

- 这个规模下两边都在免费额度内，主要风险是伴侣的 10ms CPU 上限。
- 如果同样 10 台改成**每分钟**检查一轮：会话数变成 14,400/天，CloudSSH 的 DO 时长约 8,600 GB-s（占 66%），DO 请求约占 72%。再加上用户自己开终端，就可能超额度。所以：
  - 设置页按上面的公式估算用量，并给出提示
  - 伴侣默认有每日会话预算（免费套餐默认 3,000，可以改），超出后暂停检查并发通知
- **Workers Paid**（$5/月，按账号计）每月包含：1000 万次请求、3000 万 CPU 毫秒、DO 100 万次请求和 40 万 GB-s、D1 250 亿行读和 5000 万行写。上面的用量远远用不完；CI 的长输出和多台并发也不再受 10ms 的限制。
- 通知方面：Telegram 和 Webhook 免费；邮件的费用看服务商。

---

## 10. 部署

形式参照 `tools/reasoning-proxy`：

- 源码放在 `tools/companion-worker/`，用 TypeScript 写，复用 `packages/core` 的远程执行核心和 `safety.ts`。
- 构建成单文件 `worker.js`（用 esbuild），提交到仓库，并内置进桌面端，向导里可以一键复制。
- 另附一份 `wrangler.toml`，给使用 wrangler 的人。

**控制台部署步骤**（向导里会逐步显示）：

1. 进入「Workers 和 Pages」，创建 Worker，点「编辑代码」，粘贴 `worker.js` 后部署。
2. 进入「存储和数据库 → D1」，创建一个数据库（例如 `cloudssh-companion`）；再到 Worker 的「设置 → 绑定」里添加 D1，变量名填 `DB`。
3. 在「设置 → 变量和机密」里：
   - 添加机密 `COMPANION_ADMIN_KEY` 和 `COMPANION_PRIVATE_KEY`（值由向导生成）
   - 添加变量 `CLOUDSSH_ORIGIN = https://bash.al`
4. 如果伴侣和 CloudSSH 在同一个账号：在「设置 → 绑定」里添加服务绑定，变量名填 `CLOUDSSH`，选择 `cloudssh` 这个 Worker。不同账号时跳过这一步。
5. 在「设置 → 触发事件」里添加 Cron 触发器 `* * * * *`。
6. 回到桌面端，填写伴侣地址，点「测试连接」，然后推送会话。

用 wrangler 部署时要注意：`[vars]` 会覆盖控制台里的同名变量（reasoning-proxy 的 README 也提醒过），机密不受影响。

**更新伴侣：** 重新粘贴新的 `worker.js` 即可。D1 的表结构由伴侣按 schema 版本自动升级，只增不删。桌面端会检测伴侣版本（由 `GET /` 返回），协议不兼容时提示更新。

**一键部署（Phase 4）：** 用户提供一个 Cloudflare API 令牌，只授予 Workers Scripts、D1 和 Cron 的编辑权限。桌面端调用 Cloudflare API 自动完成上面的第 1–5 步，完成后提示用户删除这个令牌。

---

## 11. 分阶段实施

### Phase 0：验证（1–2 天，只写实验代码）

回答 §13 列出的问题，据此决定免费套餐的默认预算。产出一份实测记录：CPU 用量、延迟、各种部署方式能否连通。

### Phase 1：MVP，会话加定时命令（约 1.5–2 周）

- **`packages/core/src/remote-exec/`**：从 `ai-remote/session.ts` 抽出协议核心（增量解析、可注入的传输层）。ui-web 和命令行改用它，行为保持不变，用现有单测和 mock-worker 做回归。
- **`tools/companion-worker`**：
  - D1 自动建表
  - 签名的管理接口
  - 会话的推送、状态查询和吊销
  - 缓存 `GET /api/servers` 的结果
  - 定时命令任务：Cron 调度、租约、错峰、每个 tick 的预算
  - 运行记录
  - Telegram 和 Webhook 通知（失败时发送）
  - 请求白名单
  - `safety` 检查
- **桌面端**：
  - 实例管理窗口的「伴侣 Worker」页：部署向导、测试连接、会话状态、任务列表与编辑、运行记录
  - 专用会话的静默签发与续签
  - 管理密钥和吊销用的会话副本存进 `safeStorage`
- **测试**：
  - 伴侣用 Miniflare 或 `wrangler dev`，配合已有的 `scripts/mock-worker.mjs`（里面有假的 `/connect` 和假 shell）跑端到端
  - 对真实实例只做只读验证（`uptime`、`df`）

**验收标准：**

- 在桌面端配置一个每 5 分钟执行 `uptime` 的任务，关闭桌面端后，伴侣照常运行并记录结果
- 手动吊销会话后，任务暂停，并收到一条通知
- 重新推送会话后，任务恢复

### Phase 2：告警（约 1 周）

- 各类检查：磁盘、inode、服务、内存与负载、自定义、HTTP
- 同一台服务器的检查合并到一个会话里执行
- 告警状态机：去抖、恢复通知、重复提醒、静默与维护窗口
- "服务器不可达"单独归类
- 会话过期提醒
- 每日会话预算和用量页

### Phase 3：Webhook 触发与自动化令牌（约 1 周）

- **令牌**：scope、过期、IP 白名单、限速、审计
- **Hook**：参数白名单、同步 SSE 和异步排队两种模式、幂等键、GitHub 签名校验与事件过滤
- `exec` 令牌
- 邮件渠道
- CI 示例文档

### Phase 4（可选）

- 一键部署（通过 Cloudflare API）
- 用 DO 执行超过 15 分钟的任务
- SFTP 上传类任务（例如上传部署包）
- 手机端的只读状态与会话续签
- 命令行 `cloudssh companion` 子命令
- 多实例：一个伴侣服务多个 CloudSSH 实例

---

## 12. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 会话就是整个账号的权限 | 伴侣失陷 = 所有服务器失陷 | 见 §8.1；在设置页明确告知用户；建议伴侣放在独立的 Cloudflare 账号 |
| 会话固定 7 天过期，续签依赖桌面端 | 桌面端长期不开，或者 GitHub 要求重新登录时，自动化会停 | 提前 3 天续签；在剩 48、24、6 小时时提醒；会话失效时 CI 立刻得到明确的错误；密码模式下可以选择在桌面端保存预拉伸 key |
| 依赖 CloudSSH 的非公开协议（WebSocket 消息、ACK、连接令牌、标记） | CloudSSH 升级后伴侣可能失效 | 协议核心只维护一份（Phase 1）；用 `scripts/sync-web-ui.mjs` 同步上游时跑协议回归；伴侣把协议层面的错误单独归为 `protocol_error` 告警，不当成检查失败 |
| 免费套餐只有 10ms CPU | 超限时本次调用被终止，这个 tick 的结果丢失 | 增量解析、每个 tick 设预算、任务错峰；超限的情况会在下一个 tick 被发现（租约过期）并告警；建议升级付费套餐 |
| 伴侣的用量吃掉 CloudSSH 的 DO 额度 | 用户自己开终端时超出额度 | 每日会话预算、用量估算、默认 5 分钟的检查间隔 |
| 服务绑定能否升级 WebSocket、`global_fetch_strictly_public` 能否解决 1042，都还没验证 | 同账号的部署方式可能不可用 | Phase 0 验证；如果不行，就推荐部署在另一个账号（方案 B，reasoning-proxy 已经证明可行） |
| 走公网时 `/api/ssh` 有按 IP 的限流（每个 isolate 每分钟 10 次） | 多台服务器同时检查时会收到 429 | 伴侣把每分钟新建的会话数自限在 8 个以内，按 `Retry-After` 退避；首选服务绑定 |
| 命令输出的解析依赖启发式（非 POSIX Shell、登录脚本里有交互、sudo 要密码） | 超时或误判 | 初始化失败时给出明确原因；任务编辑页提供「试运行」；文档写清能力边界 |
| 断线时执行状态未知 | 部署可能只执行了一半 | 不自动重试有副作用的任务；运行记录标成"状态未知"，并发通知 |
| Cron 的时区与夏令时 | 任务执行时间偏移 | 存储 IANA 时区，按时区计算下次执行时间（中国没有夏令时） |
| 通知渠道的凭据或命令输出外泄 | 第三方看到敏感信息 | 加密存储；通知默认不带输出 |

---

## 13. Phase 0 要验证的问题

1. **同账号服务绑定**：`env.CLOUDSSH.fetch()` 能否完成 `/api/ssh` 的 WebSocket 升级？CloudSSH 看到的 `request.url` 是否就是伴侣构造的地址（决定同源检查能否通过）？运行时是否会自动补上 `CF-Connecting-IP`？
2. **同账号走公网**（`workers.dev` 或另一个域名），并且伴侣打开了 `global_fetch_strictly_public`：还会不会出现 1042 或 522？
3. **跨账号走公网**：能否连通，延迟多少？
4. **单个会话的伴侣 CPU 时间**：完整走一遍"连接 → 初始化 → `df` / `systemctl is-active` 等三条命令 → 关闭"，看 Workers Logs 里的 `cpuTime`。另外测输出达到 64KB 时的 CPU。
5. **免费套餐下的并发**：一个 Cron tick 并发 3 个、5 个会话时，会不会超出 CPU 限制？
6. **CloudSSH 侧的实际计费**：一个 5 秒的检查，SSHSessionDO 实际被计了多少时长（看 Cloudflare 控制台的 DO 指标）？
7. **隐藏窗口静默签发专用会话**：GitHub 已经授权过时，能否全程无交互完成？GitHub 登录过期时会是什么表现？
8. **从没连过的服务器**（没有已知指纹）：token 路径上实际会收到哪些事件？用来确认 §4.1 第 5 步的判定方式。

---

## 附录 A：伴侣接口草案

**管理接口**（供桌面端使用，需 HMAC 签名）：

```
GET    /admin/status                  版本、配对状态、会话状态、今日用量
PUT    /admin/session                 推送会话（信封加密）
DELETE /admin/session                 吊销会话
GET    /admin/servers                 服务器列表（走缓存），供桌面端选目标
GET|PUT|DELETE  /admin/jobs[/<id>]
POST   /admin/jobs/<id>/run           立即运行
GET|PUT|DELETE  /admin/checks[/<id>]
GET|PUT|DELETE  /admin/channels[/<id>]
POST   /admin/channels/<id>/test      发送测试消息
GET|PUT|DELETE  /admin/hooks[/<id>]
GET|POST|DELETE /admin/tokens[/<id>]  创建时返回一次令牌明文
GET    /admin/runs?job=&limit=        运行记录（含解密后的输出尾部）
GET    /admin/audit
```

**令牌接口**（供自动化使用）：

```
GET  /v1/status                       会话剩余时间（任何有效令牌都可以调用）
POST /v1/hooks/<hookId>               需要 hook:<id>
POST /v1/jobs/<jobId>/run             需要 jobs:run:<id>
GET  /v1/runs/<runId>                 可以查自己触发的运行；要查任意运行需要 runs:read
POST /v1/exec {targets, command, timeoutSec}   需要 exec
```

**错误格式**统一为 `{"error": "<code>", "message": "<中文说明>"}`。code 包括 `companion_session_invalid`、`upstream_unreachable`、`protocol_error`、`command_blocked`、`command_needs_confirmation`、`scope_denied`、`budget_exceeded` 等。

## 附录 B：参考代码

| 主题 | 位置 |
|---|---|
| 后台会话协议 | `packages/ui-web/overrides/shared/ai-remote/session.ts` |
| 危险命令规则 | `packages/ui-web/overrides/shared/ai-remote/safety.ts`（上游为 CloudSSH 的 `src/worker/agent/safety.ts`） |
| 命令行的执行与确认 | `packages/cli/src/exec.ts` |
| Node 里带 Cookie / Origin 的 fetch 与 WebSocket | `packages/cli/src/net.ts` |
| 命令行凭据与 7 天到期推算 | `packages/cli/src/config.ts` |
| 无法接收回调时的 GitHub 登录 | `packages/cli/src/login.ts` |
| 登录同步给命令行 | `apps/desktop/src/main/platform/cli-sync.ts` |
| 登录窗口与持久化的 oauth 分区 | `apps/desktop/src/main/platform/oauth.ts`、`session.ts`（`persist:oauth-<id>`） |
| 机密保管 | `apps/desktop/src/main/platform/vault.ts` |
| 设置页「命令行与 AI」 | `apps/desktop/src/manager/main.ts` |
| 独立 Worker 的部署方式与同区域限制 | `tools/reasoning-proxy/README.md` |
| 假 Worker | `scripts/mock-worker.mjs` |
| CloudSSH：会话 | `src/worker/auth.ts`、`src/worker/user-db.ts` |
| CloudSSH：连接令牌、WebSocket 同源检查、限流 | `src/worker/index.ts` |
| CloudSSH：主机指纹事件 | `src/worker/ssh-session.ts` 中的 `finalizeHostKeyTrust` |
