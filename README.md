# CloudSSH 客户端（桌面 + Android）

CloudSSH 的 Windows 桌面客户端（Electron）和 Android 客户端（Tauri 2 + Rust）。两者都直接对接已部署的 [CloudSSH](https://github.com/XMZO/CloudSSH) Worker（默认 `https://bash.al`，即路由到 Worker 的自定义域名），**无需修改 Worker**。

第一版界面“照搬”网页版：GitHub 登录、服务器列表、SSH 终端、SFTP、Agent、分享、主题等功能与网页版一致。架构上把连接配置、平台适配和 UI 拆成独立的层，之后可以换成自研 UI。Android 版见下文“[Android 客户端](#android-客户端)”。

---

## 快速开始

需要 Node.js 22+ 和 pnpm 11（版本见 `packageManager` 字段）。

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会先构建内置 UI（`packages/ui-web`），再启动客户端。首次启动后：

1. 主窗口显示“此 CloudSSH 实例需要 GitHub 登录”，点击 **使用 GitHub 登录**
2. 弹出独立的登录窗口，在里面登录 GitHub 并授权
3. 授权完成后登录窗口自动关闭，主窗口刷新为已登录状态，此时可以连接服务器、打开 SFTP

> Electron 44 没有安装脚本，**第一次运行**时才会自动下载约 100MB 的二进制，所以首次 `pnpm dev` 会稍慢。网络不通时可设置代理：
> `ELECTRON_GET_USE_PROXY=1 GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:7890 pnpm dev`

### 打包 Windows 安装包

```bash
pnpm dist:win
```

产物在 `apps/desktop/release/`：

- `CloudSSH-Setup-<版本>-x64.exe`：NSIS 安装包，可选安装目录，并创建桌面和开始菜单快捷方式
- `CloudSSH-<版本>-win-x64.zip`：免安装版

安装包未签名，首次运行时 Windows SmartScreen 可能提示“未知发布者”。

### 构建 Android APK

需要 Rust（`rustup target add aarch64-linux-android x86_64-linux-android`）和 Android Studio（自带 JDK 与 SDK，另在 SDK Manager 里装 NDK）。脚本会自动找到它们，并把 `HTTPS_PROXY` 转成 Gradle 能用的代理：

```bash
pnpm android:build         # 正式版（arm64，手机用）：apps/mobile/release/CloudSSH-<版本>-release.apk
pnpm android:build:debug   # 调试版（arm64 + x86_64，可装模拟器）
```

把 APK 传到手机上安装即可，系统会提示允许安装未知来源的应用。打开后点“使用 GitHub 登录”，在应用内完成授权。

---

## 架构分层

```
CloudSSH-client/
├── packages/
│   ├── core/              @cloudssh/core  —— 平台无关核心（桌面/移动/自研 UI 共用）
│   │   └── src/
│   │       ├── instance.ts    实例模型、Worker 地址规范化、UI 来源类型
│   │       ├── routes.ts      接口路由、同源规则、WebSocket 地址与握手头
│   │       ├── oauth.ts       GitHub OAuth 流程规则、session Cookie 常量
│   │       ├── types.ts       Worker 协议类型（/api/config、用户、服务器……）
│   │       ├── transport.ts   可注入的传输接口（fetch / WebSocket / 会话存储）
│   │       └── api-client.ts  CloudSSHApiClient
│   └── ui-web/            @cloudssh/ui-web —— 内置 UI 包（网页版前端）
│       ├── upstream/          从 CloudSSH 主仓库同步的源码（逐字节一致，勿手改）
│       ├── overrides/         定制入口（构建时注入，不改 upstream）：桌面侧栏 + mobile/ 移动端
│       └── vite.config.ts
├── apps/
│   ├── mobile/            @cloudssh/mobile —— Android 客户端（Tauri 2 + Rust）
│   │   └── src-tauri/
│   │       ├── src/
│   │       │   ├── settings.rs    连接与配置层：实例、当前实例、代理（规则与 core/instance.ts 一致）
│   │       │   ├── net.rs         网络层：代理 /api 与 SSH/SFTP WebSocket，按实例保存 Cookie、补同源 Origin
│   │       │   ├── oauth.rs       GitHub 登录：拦截 OAuth 回调，session 只存在 Rust 侧
│   │       │   ├── native.rs      平台能力（调用下面的 Kotlin 插件）
│   │       │   └── lib.rs         命令注册与装配
│   │       └── gen/android/       Android 工程（Tauri 生成，含少量 Kotlin）
│   │           └── app/src/main/java/com/xmzo/cloudssh/
│   │               ├── NativePlugin.kt      保活、下载、剪贴板、外链、系统栏、电池优化
│   │               ├── KeepAliveService.kt  前台服务 + 唤醒锁
│   │               └── MainActivity.kt      全面屏、键盘避让
│   └── desktop/           @cloudssh/desktop —— Electron 应用
│       └── src/
│           ├── main/
│           │   ├── config/store.ts        连接与配置层：实例、默认实例、偏好、窗口状态
│           │   ├── ui/providers.ts        UI 层解析：bundled / remote / directory / dev-server
│           │   └── platform/              平台适配层
│           │       ├── origin-bridge.ts     本地 UI 挂到 Worker origin（核心机制）
│           │       ├── session.ts           每实例独立会话分区、权限、下载
│           │       ├── oauth.ts             独立 GitHub 登录窗口 + Cookie 迁移
│           │       ├── windows.ts           实例窗口、导航守卫、外链处理
│           │       ├── menus.ts             应用菜单与托盘
│           │       ├── manager-window.ts    实例管理窗口
│           │       ├── ipc.ts               IPC（校验发送方）
│           │       └── updater.ts           自动更新预留接口
│           ├── preload/                   app.ts（实例页面）/ manager.ts（实例管理）
│           └── manager/                   实例管理页面（本地 HTML）
└── scripts/
    ├── sync-web-ui.mjs    从 CloudSSH 主仓库同步网页版前端
    ├── dev-ui.mjs         UI 热更新开发（Vite + 客户端）
    └── mobile.mjs         Android 构建（定位 JDK/SDK/NDK、Gradle 代理、复制 APK）
```

各层之间的依赖是单向的：

```
UI 层（任意静态站点，跑在 Worker origin 下）
   ↑ 由 ui/providers 解析来源、origin-bridge 提供文件
平台适配层（Electron：窗口 / 托盘 / 会话 / Cookie / Origin / 更新）
   ↑ 读取实例配置
连接与配置层（config/store + @cloudssh/core）
```

`@cloudssh/core` 不依赖 DOM、Node 或 Electron，以后的移动 App、自研 UI 或命令行工具都可以直接引用。

---

## 不改 Worker 是怎么做到的

服务端有几条约束（见 CloudSSH 仓库 `src/worker/index.ts`、`src/worker/auth.ts`）：

| 约束 | 客户端的处理 |
|---|---|
| `/api/ssh`、`/api/ssh/sftp` 的 WebSocket 必须带 `Origin`，且与请求 URL 同源，否则返回 403 | 页面本身就在 Worker origin 下。WebSocket 不经过协议拦截，由 Chromium 直接发出，`Origin` 天然正确 |
| 部分写接口（密码登录、AI 配置、移动端快捷键）校验同源 `Origin` | origin bridge 透传请求时，对 Worker 的非 GET 请求补上 `Origin: <Worker origin>`（被拦截的请求里看不到浏览器后补的 Origin） |
| 登录依赖 OAuth 回调写入的 HttpOnly `session` Cookie，回调地址为 `BASE_URL`，未设置时用请求 origin | 在独立登录窗口里直接访问 Worker 完成 OAuth，再把 `session` Cookie 原样迁移到实例分区 |
| 前端的 `/api` 与 WebSocket 都用相对同源路径；`main.ts` 校验 wsUrl 同源；`auth-form.ts` 用 `location.origin` 派生本地加密密钥 | 本地 UI 通过 `protocol.handle('https')` 直接挂在 `https://<worker>/` 下，前端代码一行不用改 |

**origin bridge 的工作方式**（`apps/desktop/src/main/platform/origin-bridge.ts`）：

- 对实例会话里的 https 请求，如果目标是 Worker origin、路径不在 `/api/*` 下、方法为 GET 或 HEAD，就返回本地 UI 文件（找不到时按 SPA 规则回退到 `index.html`）
- 其余请求（`/api/*`、GitHub 头像、Google Fonts、Turnstile 等）用同一个会话原样发到网络，Cookie 由该会话的 Cookie 罐自动带上和更新
- remote 模式不挂 bridge，所有请求走原生路径

已对真实 Worker 验证以下行为：透传请求能带上 Cookie，也能写入和删除 Cookie；POST 请求体正常转发；WebSocket 握手在未登录时返回 401 而不是 403，说明 Origin 已被接受；GitHub 登录窗口和 Cookie 迁移正常；登出后 Cookie 被清除。

---

## 配置 Worker 地址与多实例

一个“实例”由三部分组成：一个 Worker 地址、一种 UI 来源、一个独立的会话分区（Cookie 和本地存储互相隔离）。同一个 Worker 可以配成两个实例，分别登录两个 GitHub 账号。

### 用界面配置

托盘菜单或快捷键 `Ctrl+Shift+M` 打开 **实例管理**，可以：

- 新增、编辑、删除实例，测试连接（显示延迟、认证模式、是否开启分享）
- 设置默认实例；在当前窗口打开实例，或在新窗口打开（多个实例可以同时开）
- 发起 GitHub 登录，或清除某个实例的登录数据
- 偏好设置：关闭窗口时最小化到托盘、显示菜单栏

切换实例时会先确认，因为切换会关闭当前窗口里的终端会话。也可以选择在新窗口打开，保留当前会话。

### 配置文件

位于 `%APPDATA%\CloudSSH\config.json`，写入是原子的；文件损坏时会自动备份，并回退到默认配置：

```json
{
  "version": 1,
  "instances": [
    {
      "id": "default",
      "name": "CloudSSH",
      "baseUrl": "https://bash.al",
      "ui": { "kind": "bundled", "id": "web" }
    }
  ],
  "defaultInstanceId": "default",
  "preferences": { "closeToTray": false, "showMenuBar": false }
}
```

- `baseUrl` 必须是 **GitHub OAuth App 登记回调地址的那个域名**（Worker 设置了 `BASE_URL` 时即该地址）。Worker 未设 `BASE_URL` 时，回调地址取自请求 origin；如果改用 `*.workers.dev` 访问，GitHub 授权页会提示 “redirect_uri is not associated with this application”。实例管理里点“测试连接”会显示服务端实际使用的回调地址
- `baseUrl` 只能填根地址，必须是 https；只有 `localhost` / `127.0.0.1` / `[::1]` 允许 http，方便对接 `wrangler dev`
- `id` 决定会话分区名（`persist:instance-<id>`），改了会丢失登录状态

### 环境变量与命令行

| 方式 | 作用 |
|---|---|
| `CLOUDSSH_WORKER_URL=https://xxx.workers.dev` | **首次运行**时使用的默认 Worker 地址 |
| `--instance=<id>` | 启动时打开指定实例（已在运行时会转发给正在运行的进程） |
| `CLOUDSSH_DEBUG=1` | 打开调试日志，包括 WebSocket 握手状态码 |
| `CLOUDSSH_UI_DIR=<目录>` | 临时让所有非 remote 实例使用该目录下的 UI |
| `CLOUDSSH_UI_DEV_SERVER=http://127.0.0.1:5173` | 临时让所有非 remote 实例使用 UI 开发服务器 |
| `CLOUDSSH_DOWNLOAD_DIR=<目录>` | 下载直接保存到该目录，不弹保存对话框（自动化测试、批量下载用） |
| `CLOUDSSH_USER_DATA_DIR=<目录>` | 使用独立的配置与登录数据目录，可以和正在运行的客户端同时开（调试用） |

日志位于 `%APPDATA%\CloudSSH\logs\main.log`。

---

## 如何换 UI

UI 层的约定只有一条：**UI 是一个以 `index.html` 为入口的静态站点，用相对路径 `/api/...` 访问后端，用 `wss://<当前 host>/api/ssh` 建立终端连接**。客户端负责把它放到 Worker origin 下运行。

每个实例可以单独选择 UI 来源：

| 来源 | 说明 | 适合 |
|---|---|---|
| `bundled` | 客户端内置的 UI 包，默认是 `web`，即网页版前端副本 | 默认；定制网页版 |
| `remote` | 直接使用 Worker 返回的页面，完全原生，没有任何拦截 | 想让界面始终与服务端同版本 |
| `directory` | 任意本地目录，例如自研 UI 的构建产物 | 接入自研 UI |
| `dev-server` | UI 开发服务器，例如 Vite | 开发 UI 时热更新 |

### 方式一：在网页版基础上定制（推荐起步）

不要修改 `packages/ui-web/upstream/`，改动请放在 `packages/ui-web/overrides/`：

- `overrides/desktop.css`：样式覆盖。选择器建议加 `html[data-cloudssh-client='desktop']` 前缀
- `overrides/index.ts`：脚本增强。可以读取 `window.cloudsshDesktop.info()` 拿到实例信息

开发时运行：

```bash
pnpm dev:ui     # 同时启动 Vite 和客户端，改 upstream/overrides 即可热更新
pnpm build:ui   # 构建内置 UI，打包时会带进安装包
```

### 已有的桌面定制：左侧节点侧栏

内置 UI 的左侧有一栏 Termius 风格的节点列表（代码在 `packages/ui-web/overrides/sidebar/`），只在桌面端的内置 UI 中提供。登录后才显示；分享页面和窄窗口（宽度小于 760px）下自动隐藏。

- **分组**：按服务器标签分组（例如“中国 🇨🇳”），显示每组节点数，可以折叠，折叠状态会记住。没有标签的节点排在最后。一台服务器有多个标签时，会出现在每个对应的组里
- **拖动排序**：按住分组标题或节点右侧的 ⋮⋮ 拖动，可以调整分组顺序和组内节点顺序；拖动后排序方式自动切到“手动排序”，排序菜单里可以切回按名称/节点数/最近连接。顺序保存在本地，每个实例单独记忆（代码在 `overrides/shared/`，与移动端共用）
- **搜索**：匹配名称、主机、用户名和标签，多个关键词之间是“且”的关系。输入框里按 ↓ 进入列表，按 Enter 连接第一个结果，按 Esc 清空
- **连接**：双击节点、选中后按 Enter，或点击悬停时出现的 ▶ 按钮，都会新开一个终端标签。走的是网页版自己的连接流程（一次性 token、跳板机、隧道都支持）
- **会话指示**：已打开会话的节点右侧显示圆点，多于一个会话时显示数量；点击圆点切换到该会话，多个会话之间轮换。当前活动的会话左侧有高亮条
- **右键菜单**：连接、切换到已打开的会话、编辑、克隆、复制主机地址（编辑和克隆打开网页版自带的对话框）
- **排序**：按名称（默认）、按节点数、按最近连接
- **布局**：拖动右边缘调整宽度（双击恢复默认），可以收起成窄栏。宽度变化后终端会自动重新适配列数
- 颜色、字体全部使用网页版的主题变量，切换主题后自动跟随

实现方式（不改 upstream 源码）：

- **数据来源**：旁听网页版自己的 `/api/servers` 请求，不额外加请求
- **动作**：构建时由 `vite.config.ts` 的 `desktopHooks` 插件，在 `ServerList` 和 `TabManager` 的构造函数里各注入一行登记代码，侧栏通过它们调用网页版自己的连接、编辑和切换标签逻辑
- **上游升级时**：如果注入锚点变了，构建会打印“桌面钩子锚点未找到”的告警。此时侧栏会降级：只能浏览，连接时会提示到服务器列表中操作
- 分组和搜索逻辑放在 `@cloudssh/core` 的 `server-groups.ts` 里，移动端也可以复用

### 方式二：完全自研 UI

1. 新建 `packages/ui-<id>/`，构建产物放在 `packages/ui-<id>/dist/`，入口为 `index.html`。可以再输出一个 `cloudssh-ui.json` 清单
2. 用 `@cloudssh/core` 处理接口和协议类型：

   ```ts
   import { CloudSSHApiClient } from '@cloudssh/core';
   // 页面在 Worker origin 下，直接用浏览器 fetch，Cookie/Origin 由浏览器处理
   const api = new CloudSSHApiClient({ baseUrl: location.origin, transport: { fetch: (u, i) => fetch(u, i) } });
   const user = await api.me();
   const servers = await api.listServers();
   ```

3. 在实例管理里把 UI 来源选为“内置 UI → `<id>`”（开发模式会自动扫描 `packages/ui-*`），或者选“本地目录”并指向构建产物
4. 打包时在 `apps/desktop/electron-builder.yml` 的 `extraResources` 里加一项 `from: ../../packages/ui-<id>/dist`、`to: ui/<id>`

调试时可以把 UI 来源设为“开发服务器”。开发服务器需要把 HMR WebSocket 显式指回本地，写法参考 `packages/ui-web/vite.config.ts` 里的 `server.hmr`。

### 同步上游网页版

CloudSSH 主仓库的前端更新后，运行：

```bash
pnpm sync:web-ui                             # 默认源仓库 ../CloudSSH
pnpm sync:web-ui -- --source D:/path/CloudSSH
pnpm install && pnpm build:ui
```

脚本**只读**源仓库，同步内容包括：

- `frontend/`
- frontend 引用的共享 Schema（`src/*.ts`，递归解析）
- 按源仓库 `pnpm-lock.yaml` 改写的确切依赖版本

同步后会写入 `upstream/SOURCE.json`，记录提交和版本。实例管理里也会显示内置 UI 的上游版本。

> **版本漂移提醒**：Worker 每天自动同步上游并重新部署。如果上游改了前后端协议（例如 WebSocket 消息格式），旧的内置 UI 可能和新 Worker 不兼容。此时运行 `pnpm sync:web-ui && pnpm build:ui`，或者先把实例切到 `remote`（跟随 Worker）即可恢复。

---

## 快捷键

为避免和终端程序（vim、mc、htop 等）冲突，客户端只用组合键。Electron 只在网页没有处理该按键时才触发菜单快捷键，终端获得焦点时按键优先交给终端。

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Shift+M` | 实例管理 |
| `Ctrl+Shift+R` | 重新加载当前窗口 |
| `Ctrl+Shift+I` | 开发者工具 |
| `Ctrl+0` / `Ctrl+=` / `Ctrl+-` | 重置、放大、缩小 |
| `F11` | 全屏 |

菜单栏默认隐藏，因为单按 Alt 会把焦点从终端抢走；可以在实例管理里打开。托盘菜单提供相同的功能。

---

## 安全设计

- 所有窗口启用 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`，并禁止 `<webview>`
- 主窗口只停留在 Worker origin。外部链接交给系统浏览器；GitHub 登录在独立窗口中进行，不挂任何拦截
- IPC 按调用方拆成两组：实例页面只能读取只读信息，管理接口只接受实例管理窗口调用。每个 handler 都会校验发送方
- 权限只放行剪贴板（终端粘贴需要）、通知和全屏，而且请求必须来自实例 origin
- 本地 UI 响应带上与 Worker 相同的安全头（`nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`）
- origin bridge 读取本地文件时做了路径穿越防护

---

## Android 客户端

代码在 `apps/mobile/`（Tauri 2 + Rust，界面在 `packages/ui-web/overrides/mobile/`）。它不是“套个 WebView 打开网站”：

- **界面打包在 APK 里**：用的是 `packages/ui-web` 的移动端构建，即网页版全部功能（终端、SFTP、Agent、分享、主题、移动端快捷键栏……）加上移动端专属的节点首页和设置
- **网络全部走 Rust**：页面的 `/api` 请求和 SSH/SFTP WebSocket 都交给 Rust（reqwest + tokio-tungstenite + rustls），由 Rust 保存 Cookie、补 Origin；HttpOnly 的 `session` 只存在 Rust 侧，页面脚本拿不到
- **少量 Kotlin 只做 Rust 做不了的事**：前台服务保活、写入系统“下载”目录、剪贴板、系统栏配色

### 不改 Worker 是怎么做到的

页面运行在 `https://tauri.localhost`，和 Worker 不同源，所以由 Rust 代为请求：

| 约束 | 移动端的处理 |
|---|---|
| WebSocket 必须带同源 `Origin` | `early.ts` 把 `/api/ssh*` 的 `WebSocket` 换成走 Rust 的实现，Rust 握手时带 `Origin: <Worker origin>` 和 Cookie |
| 写接口校验同源 `Origin` | `fetch('/api/...')` 由 Rust 转发，统一补 `Origin`；只允许 `/api` 路径，不跟随重定向 |
| HttpOnly `session` Cookie | Rust 按实例保存 Cookie 罐（应用私有目录），响应里的 `Set-Cookie` 不交给页面 |
| OAuth 回调地址是 Worker 域名 | 点击登录时 Rust 先请求 `/api/auth/github`（`oauth_state` 进 Rust 的 Cookie 罐），WebView 打开 GitHub 授权页；跳回 `<Worker>/api/auth/callback` 时被拦下，由 Rust 带着 `oauth_state` 完成回调，再回到应用首页 |
| 网页版校验 wsUrl 必须同源 | 构建时给 `validateWsUrl` 加一个扩展判断，放行当前实例的 `/api/ssh*`（只影响移动端构建） |

### 功能

| 功能 | 说明 |
|---|---|
| 节点首页 | 代替网页版每页 3 张卡片的分页：搜索（名称、地址、标签），“最近连接”置顶，按标签分组并可折叠，显示系统图标与在线会话数；按住右侧 ⋮⋮ 拖动可调整分组顺序和组内服务器顺序（本地保存，按实例区分） |
| 多会话终端 | 网页版的标签页；节点页顶部显示“N 个会话进行中”一键回终端。点节点时已有会话就切过去，长按可“新建连接 / 切换会话 / 编辑 / 克隆 / 复制地址” |
| SFTP | 上传走系统文件选择器；下载与日志导出写入系统“下载”目录（Android 10+ 不需要存储权限），重名自动改名 |
| 后台保活 | 有会话时启动前台服务（通知栏显示会话数），持有 CPU 与 Wi-Fi 唤醒锁，WebView 渲染进程保持重要优先级；设置里可一键申请“不受电池优化限制”。全部会话关闭后自动停止 |
| 返回键 | 先关最上层的浮层（设置、对话框、抽屉、更多菜单）；在终端时回到节点页（会话保留）；在节点页时退到后台而不是退出 |
| 多实例与代理 | 设置里新增/编辑/删除/切换实例（“测试连接”显示延迟、登录方式与 OAuth 回调地址），每个实例独立 Cookie；可设 HTTP 代理 |
| 剪贴板 | `navigator.clipboard` 由原生剪贴板实现，终端粘贴可用 |
| 全面屏与键盘 | 系统栏和键盘的空间由原生让出，键盘弹出时终端行数自动变化；系统栏颜色跟随网页主题 |

### 体积

| 项目 | 大小 | 做法 |
|---|---|---|
| 安装包（release，arm64） | 约 7.5MB | 其中 Rust 动态库约 5.7MB（含打包的界面，Brotli 压缩），其余主要是 Tauri 运行时依赖的 Jackson 等 Java 库 |
| 安装后本体 | 与安装包相当 | 动态库在 APK 里不压缩、按 16KB 页对齐，系统直接映射，不再解压出第二份 |
| 应用数据 | 通常 2～5MB | 主要是 WebView 的数据目录；关闭 WebView 统计埋点，并阻止它生成约 4MB 的 `BrowserMetrics-spare.pma` 预分配文件 |
| 缓存 | 上限 16MB | 界面在 APK 里，不靠 HTTP 缓存。超过 16MB 时下次启动自动清空；“设置 → 存储”显示占用，也可以手动清除 |

Rust 侧的压缩手段：`opt-level="z"`、LTO、`codegen-units=1`、`panic=abort`、strip；TLS 用 rustls + ring（不带 aws-lc）；reqwest 只用 HTTP/1.1；Tauri 关掉默认特性（dynamic-acl 与桌面平台专用部分）；Cookie 罐不带公共后缀表；链接时用 RELR 压缩动态重定位表（`build.rs`）。Kotlin 侧 R8 压缩、去掉 Kotlin 元数据与许可证文本、只保留中英文资源。

### 开发与调试

- `pnpm mobile:dev`：在电脑上以窗口形式运行移动端（Tauri dev + Vite 热更新），网络层、登录流程与手机上相同，适合迭代界面
- `pnpm android:dev`：在已连接的手机或模拟器上热更新运行
- Windows 调试构建可设 `CLOUDSSH_WEBVIEW_DEBUG_PORT=9555` 打开 WebView2 远程调试端口，便于自动化测试
- 模拟器联网需要代理时，在应用“设置 → 网络代理”填 `http://10.0.2.2:7890`（`10.0.2.2` 是模拟器访问宿主机的固定地址）
- 调试版 APK 可用 `chrome://inspect` 或 `adb forward tcp:9556 localabstract:webview_devtools_remote_<pid>` 连接 WebView 调试

**正式签名**：在 `apps/mobile/src-tauri/gen/android/` 下新建 `keystore.properties`（已加入 .gitignore）：

```properties
storeFile=release.jks
storePassword=******
keyAlias=cloudssh
keyPassword=******
```

没有这个文件时，release 包使用 debug 证书签名，可以直接安装自用，但不能上架应用商店。

**已知限制**：

- 需要 Android 10 及以上，并建议保持“Android System WebView”为最新版本
- 地址必须是 GitHub OAuth App 登记回调的域名（默认 `https://bash.al`）
- 从最近任务里划掉应用会结束全部会话；Worker 的空闲超时（默认 30 分钟无操作）照常生效
- iOS 未做：Tauri 支持 iOS，`overrides/mobile` 与 Rust 网络层可直接复用，只需补 Swift 侧的保活与下载

---

## 自动更新（预留）

`apps/desktop/src/main/platform/updater.ts` 定义了 `UpdateProvider` 接口，当前是空实现。接入步骤：

1. `pnpm --filter @cloudssh/desktop add electron-updater`
2. 在 `electron-builder.yml` 配置 `publish`，GitHub Releases 或 generic 服务器都可以
3. 实现 `UpdateProvider`，在 `main/index.ts` 里调用 `setUpdater()` 替换空实现

---

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 构建内置 UI，然后启动客户端 |
| `pnpm dev:ui` | UI 热更新开发（Vite 与客户端同时启动） |
| `pnpm build` | 构建内置 UI 和桌面端 |
| `pnpm dist:win` | 打包 Windows 安装包和 zip |
| `pnpm sync:web-ui` | 从 CloudSSH 主仓库同步网页版前端 |
| `pnpm android:build` | 构建 Android 正式版 APK（arm64） |
| `pnpm android:build:debug` | 构建 Android 调试版 APK（arm64 + x86_64） |
| `pnpm android:install` | 把最近构建的 APK 安装到已连接的设备或模拟器 |
| `pnpm android:dev` | 在手机/模拟器上热更新运行 |
| `pnpm mobile:dev` | 在电脑窗口里运行移动端（界面迭代） |
| `pnpm typecheck` | 类型检查（core / ui-web / desktop） |
| `pnpm test` | 单元测试（core） |

## 故障排查

- **一直显示未登录**：在实例管理里点“GitHub 登录”重新登录，或者“清除登录数据”后再登录。检查 Worker 的 `GITHUB_ALLOWED_USER_IDS` 是否包含你的账号
- **GitHub 授权页提示 redirect_uri is not associated with this application**：实例地址和 OAuth App 登记的回调域名不一致，把实例地址改成回调域名（本项目即 `https://bash.al`）
- **终端连不上**：用 `CLOUDSSH_DEBUG=1 pnpm dev` 启动，看日志里的 WebSocket 握手状态码。401 表示未登录或会话已过期；403 表示 Origin 被拒（不应出现，请反馈）
- **界面和服务端行为不一致**：可能是版本漂移，参考上文“同步上游网页版”，或者把实例切到 `remote`
- **依赖安装报 `ERR_PNPM_TRUST_DOWNGRADE` 或 `minimumReleaseAge`**：`pnpm-workspace.yaml` 沿用了主仓库的供应链策略，详见文件注释

## 许可

Apache-2.0。内置 UI 来自 CloudSSH（Apache-2.0）。
