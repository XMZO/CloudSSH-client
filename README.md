# CloudSSH 客户端（桌面 + Android）

CloudSSH 的 Windows 桌面客户端（Electron）和 Android 客户端（Tauri 2 + Rust）。两者都直接对接已部署的 [CloudSSH](https://github.com/XMZO/CloudSSH) Worker（默认 `https://bash.al`，即路由到 Worker 的自定义域名），**无需修改 Worker**。

界面以网页版为基础：GitHub 登录、服务器列表、SSH 终端、SFTP、Agent、分享、主题等功能与网页版一致。架构上把连接配置、平台适配和 UI 拆成独立的层，之后可以换成自研 UI。Android 版另有一套为手机重写布局的深色主题“黑曜”（默认启用），见下文“[Android 客户端](#android-客户端)”。

当前版本见 [`version.json`](version.json)，更新内容见 [CHANGELOG.md](CHANGELOG.md)。

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
pnpm android:build --uncompressed   # 动态库与 dex 不压缩：安装包大一倍，换来安装后占用最小（见下文“体积”）
```

把 APK 传到手机上安装即可，系统会提示允许安装未知来源的应用。打开后点“使用 GitHub 登录”，选择用浏览器登录（支持 passkey）或在应用内登录。

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
│   │       │   ├── oauth.rs       GitHub 登录（应用内 / 浏览器）：重放 OAuth 回调，session 只存在 Rust 侧
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

托盘菜单、标题栏左上角的菜单或快捷键 `Ctrl+Shift+M` 打开 **实例管理**（无边框窗口，配色与实例窗口一致、跟随系统深浅色），可以：

- 新增、编辑、删除实例，测试连接（显示延迟、认证模式、是否开启分享）
- 设置默认实例；在当前窗口打开实例，或在新窗口打开（多个实例可以同时开）
- 发起 GitHub 登录，或清除某个实例的登录数据
- 偏好设置：关闭窗口时最小化到托盘、显示菜单栏（只对“跟随 Worker”的窗口有效）

切换实例也可以直接用标题栏左上角的实例菜单，行尾的按钮在新窗口打开。

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

### 桌面界面主题：工作台（默认）与经典

代码在 `packages/ui-web/overrides/desktop/`。标题栏右侧的齿轮 →“界面”切换，选择保存在本地，切换不用重新加载。

**工作台**按桌面软件的习惯排版：

- **无边框窗口**：标题栏由界面绘制，系统的最小化/最大化/关闭按钮保留（Windows 的贴靠布局照常可用），颜色跟随配色；空白处拖动窗口、双击最大化。左边是应用菜单（重新加载、开发者工具、缩放、全屏、实例管理、配置目录与日志、退出）和实例菜单（切换实例、行尾按钮在新窗口打开、GitHub 登录），两者都是页面里画的菜单、配色跟随主题（`app-menus.ts`）；中间是“服务器”与会话标签（网页版的标签栏原样搬进来，重命名、右键菜单都在），右边是 SFTP、自定义命令、AI 助手、搜索、导出日志、断开和设置。标签多时滚轮左右滚动，“+”固定在右端；窗口窄于 900px 时实例名和“服务器”只留图标
- **服务器表格**：名称、主机、用户、区域、最近连接、添加时间，可按列排序、按标签筛选或分组、搜索，不分页；窗口变窄时依次收起添加时间、区域、用户、最近连接、主机列
  - 双击或 Enter 连接，↑/↓ 选择，Delete 删除，右键或菜单键打开全部操作（连接、切换到会话、编辑、克隆、复制名称、复制主机地址、分享、删除），Ctrl+F 或 / 聚焦搜索
  - 编辑、克隆、分享、删除都走网页版自己的对话框，数据来自侧栏同一个数据源（旁听 `/api/servers`）
- **终端占满窗口**：网页版顶栏、页脚收起，状态栏移到底部一行
- **抽屉停靠**：SFTP、自定义命令、AI 助手停靠在终端右侧，终端让出宽度；剩余宽度不足 420px 时照网页版盖在终端上
- **抽屉调宽**（`drawers.ts/css`）：三个面板都可以拖动左边缘调宽，聚焦后也可用 ←/→；宽度按面板分别记在本地，双击左边缘恢复默认。SFTP 360–960px、AI 助手 320–960px（不超过窗口 60%），命令片段 240–560px（不超过窗口一半）；没调过时 SFTP、AI 助手用网页版的默认宽度，命令片段 300px。AI 助手面板按自己的宽度排版：快捷提问放不下时换行，窄于 460px 时标题只留图标，窄于 360px 时“交互 / Auto”只留图标
- **命令片段库**（`snippets.ts/css`）：片段压成紧凑列表——名称与分类一行、命令最多两行、在空格处换行（悬停提示完整命令）、操作按钮悬停时出现；双击片段填入终端（不回车），面板停靠在终端旁边时填入后不收起，可以连续填入
- **终端里的链接**（`links.ts`）：点击用系统浏览器打开。xterm 的链接插件先 `window.open()` 空白页再设置地址，客户端只放行 http(s) 地址，所以这里让不带地址的 `window.open()` 返回替身、设置地址时再交给系统浏览器
- **命令面板**（`palette.ts/css`）：`Ctrl+Shift+P`（不在终端里输入时 `Ctrl+K` 也行）或标题栏右侧的按钮打开，一个搜索框找服务器（回车新建会话）、已打开的会话、命令片段（回车填入、`Ctrl+回车` 填入并执行，`{{参数}}` 照网页版弹框录入）和常用操作（SFTP / AI / 界面 / 配色 / 语言 / 实例 / 凭据预设 / 缩放……，输入 `>` 只看操作）。名称连续命中排前面，也支持 `hkp` 这样的跳字缩写；地址与服务器列表一样打码显示
- **全局快捷键快速连接**（主进程 `platform/shortcut.ts`）：在任何程序里按 `Ctrl+Alt+T`，窗口回到前台（托盘里隐藏的也恢复）并打开命令面板；窗口已在前台时再按一次关闭面板。“实例管理 → 偏好设置”里点一下再按新组合键即可更换或关闭，被其他程序占用时会提示
- **后台通知**（`notifications.ts`，判断逻辑在 `shared/session-notify.ts`）：窗口不在前台时，长命令结束（回车后超过 10 秒才回到提示符）、终端响铃或程序发的 OSC 9 / OSC 777 通知、会话断开超过 3 秒与重新连上，都发系统通知；点通知回到对应标签。设置面板里有总开关和三个分项（长命令完成、响铃与程序通知、断线与重连）
- **SFTP 拖放**（`sftp-drop.ts/css` + 主进程 `platform/drag-out.ts`）：文件或文件夹拖到终端或 SFTP 面板上传到当前目录（面板没开会自动打开，文件夹按结构建目录）；SFTP 里的文件拖到桌面或文件夹下载——先下载到临时目录再交给系统拖放，准备好时已经松开鼠标的话，十分钟内再拖一次直接开始
- **设置面板**：界面主题、配色、语言、后台通知、AI 设置、关键词高亮、凭据预设、同步到手机、实例管理、退出登录（网页版顶栏收起后这些都在这里）

**经典**是网页版原有的布局，只修正了桌面窗口里放不下的地方（卡片按宽度自动排列）。无边框窗口下经典主题也显示标题栏，网页版顶栏在它下面。

边框由主进程决定：内置 UI 的清单 `cloudssh-ui.json` 带 `desktopChrome: 1`（桌面构建自动写入）或 UI 来源是开发服务器时，窗口用 `titleBarStyle: 'hidden'` + `titleBarOverlay`；“跟随 Worker”的页面不加载这些定制，保持系统边框和菜单栏。在浏览器里调试时，localStorage 设 `cloudssh_desktop_frameless=1` 可以模拟无边框窗口。

### 已有的桌面定制：左侧节点侧栏

内置 UI 的左侧有一栏 Termius 风格的节点列表（代码在 `packages/ui-web/overrides/sidebar/`），只在桌面端的内置 UI 中提供。登录后才显示；分享页面和窄窗口（宽度小于 760px）下自动隐藏。

- **分组**：按服务器标签分组（例如“中国 🇨🇳”），显示每组节点数，可以折叠，折叠状态会记住。没有标签的节点排在最后。一台服务器有多个标签时，会出现在每个对应的组里
- **关键词高亮**：侧栏顶部的 A 形按钮打开规则管理（见下文“终端增强”）
- **拖动排序**：在分组标题或节点行上按住鼠标直接拖（不必对准右侧的 ⋮⋮，移动几像素才开始拖，单击、双击、右键不受影响），可以调整分组顺序和组内节点顺序。被拖的行浮起跟着鼠标，其余行动画让位，松手后滑到新位置；拖分组时各组内容暂时收起，靠近列表上下边缘会自动滚动，拖动中按 Esc 取消。选中节点后按 Alt+↑/↓ 也能上下移动。拖动后排序方式自动切到“手动排序”，排序菜单里可以切回按名称/节点数/最近连接。顺序保存在本地，每个实例单独记忆（拖动引擎在 `overrides/shared/reorder.ts`，与手机的“调整排序”面板共用）
- 触屏电脑上用手指拖动时需按住 ⋮⋮（行上滑动仍是滚动列表）
- **搜索**：匹配名称、主机、用户名和标签，多个关键词之间是“且”的关系。输入框里按 ↓ 进入列表，按 Enter 连接第一个结果，按 Esc 清空
- **连接**：双击节点、选中后按 Enter，或点击悬停时出现的 ▶ 按钮，都会新开一个终端标签。走的是网页版自己的连接流程（一次性 token、跳板机、隧道都支持）
- **会话指示**：已打开会话的节点右侧显示圆点，多于一个会话时显示数量；点击圆点切换到该会话，多个会话之间轮换。当前活动的会话左侧有高亮条
- **右键菜单**：连接、切换到已打开的会话、编辑、克隆、复制名称、复制主机地址、分享（Worker 开启一次性分享时）、删除。编辑、克隆、分享、删除都走网页版自带的对话框与流程，与主界面的服务器卡片一致
- **分组标题的右键菜单**：重命名标签、复制标签名（见下文“标签”）
- **系统图标**：识别出系统的节点显示系统图标（与服务器表格、手机节点页共用 `shared/os-icon.ts`）；连接后识别出系统时立即换上，不用等下次刷新列表
- **排序**：按名称（默认）、按节点数、按最近连接
- **布局**：拖动右边缘调整宽度（双击恢复默认），可以收起成窄栏。宽度变化后终端会自动重新适配列数
- 颜色、字体全部使用网页版的主题变量，切换主题后自动跟随

实现方式（不改 upstream 源码）：

- **数据来源**：旁听网页版自己的 `/api/servers` 请求，不额外加请求
- **动作**：构建时由 `vite.config.ts` 的 `desktopHooks` 插件，在 `ServerList` 和 `TabManager` 的构造函数里各注入一行登记代码，侧栏通过它们调用网页版自己的连接、编辑和切换标签逻辑
- **上游升级时**：如果注入锚点变了，构建会打印“桌面钩子锚点未找到”的告警。此时侧栏会降级：只能浏览，连接时会提示到服务器列表中操作
- 分组和搜索逻辑放在 `@cloudssh/core` 的 `server-groups.ts` 里，移动端也可以复用

### 终端增强：关键词高亮与内置字体（桌面与手机共用）

代码在 `overrides/shared/terminal/`。构建钩子在网页版每创建/销毁一个终端时通知这里，两端行为一致。

**关键词高亮**：日志里的错误、警告、成功、IP、URL、路径、时间、HTTP 状态码、容器状态等自动上色。
- 入口：电脑端侧栏顶部的 A 形按钮；手机端“设置 → 终端 → 关键词高亮”（点文字管理规则，右侧开关整体启停）或终端“更多 → 关键词高亮”
- 内置 23 条规则，可以单条开关、改颜色、改写正则、删除，也可以新建；“效果预览”实时显示改动效果；随时可以恢复默认
- 导入/导出 JSON，格式与常见终端一致：`[{ "enabled": true, "pattern": "…", "note": "…", "color": "#f87171", "flags": "i" }]`（`flags` 可省略，默认不区分大小写，`""` 表示区分大小写）
- 规则按顺序生效，同一处文字只取最先匹配的规则：结构化内容（URL、路径、IP、时间……）排在关键词前面，`/var/log/nginx/error.log` 整体按路径着色；新建或导入的规则排在最前面、优先生效
- 实现：不改写 SSH 输出流（往数据里插颜色转义会破坏 vim、htop 和程序自己的着色），而是用 xterm 的前景色装饰叠加在渲染层。只扫描屏幕上能看到的行（折行会先拼回整行），装饰随滚动重建，看不到的行不占内存；只给没有颜色的文字上色；全屏程序（备用缓冲区）里不生效；隐藏的标签页不扫描；连续输出时最多每 50ms 扫描一次；浅色主题下自动把颜色压暗

**内置字体 JetBrains Mono**（SIL OFL 1.1，常规体与粗体共约 190KB，许可见 `overrides/fonts/jetbrains-mono/OFL.txt`）：网页版原本在线加载这款字体，国内常加载失败、悄悄退回 Consolas/新宋体等系统字体。选它是因为字母高度大、`0O`/`1lI` 区分清楚、小字号下也清晰，并且带完整的制表符与方块字符（htop、mc 的边框）。终端里关闭连字（避免 `->` 等合成一个字形后和字符格错位）；中文按 微软雅黑 UI（Windows，否则浏览器默认用新宋体）→ 苹方 → Noto Sans CJK 回退。

### 对网页版界面的修正（桌面与手机共用）

代码在 `overrides/shared/`，两端的内置 UI 都会加载：

- **语言按钮**（`language-picker.ts`）：显示当前语言（网页版显示的是下一个语言），点开后直接选；电脑端是下拉菜单，手机端是底部面板。按钮文字由 `vite.config.ts` 的扩展钩子在网页版刷新按钮时交给这里改写
- **AI 助手“交互 / 自动”切换的选中态**（`web-fixes.css`）：改为强调色描边；并给网页版用到却从未定义的 `--warning` 补上默认值（“自动”模式和自动确认倒计时进度条依赖它），用 `:where()` 写成零特异性，主题以后自己定义了就以主题为准
- **添加 / 编辑服务器对话框紧凑排版**（`server-form.ts/css`）：宽度不变、不折叠不分页，标题放到输入框左边、端口与主机同一行、固定说明收进输入框的提示、已有标签排一行横向滚动，一屏放下（电脑 591px，原来 1016px）。只用样式排版（网页版字段块用 `display: contents` 排进表单网格），不移动网页版的任何元素
- **标签**（`server-tags.ts`）：添加 / 编辑服务器时，标签输入框下列出已有标签，点一下加入、再点一下去掉；重命名标签对带它的每台服务器发一次只含 tags 的 PUT（Worker 的更新接口支持只改部分字段，不用改 Worker），改成已有名字时合并，侧栏、节点页的折叠状态与手动排序跟着改名；也可以复制标签名
- **等待自动重连：毫秒倒计时、按任意键立即重连**（`vite.config.ts` 扩展钩子 + `shared/terminal/reconnect-countdown.ts`）：网页版排定重连的两个方法里注入同名的局部 `setTimeout`，照常排定的同时记下“立即执行”的入口，并把网页版刚写的“x 秒后重连”那一行原地换成精确到毫秒的实时倒计时（附“按任意键立即重连”）；到点或按键时定格并去掉提示，定格写好后才执行原回调。每次改写都在 xterm 的写入回调里当场读缓冲区、算位置（窗口缩放是同步重排的），光标有动过或这一行被折行就停止 / 暂停，不覆盖别的内容。Shell 未就绪时的键盘输入调用“立即执行”（这个按键不会发给服务器）
- **会话正常结束后按任意键重新连接**（同上）：`exit`、空闲超时等服务端以 1000 关闭时网页版不重连；会话曾经就绪过的，在连接关闭处理里提示“（按任意键重新连接）”，按键后走网页版自动重连同一套路径（已保存的服务器重新申请一次性令牌）。认证失败、主机指纹待确认、分享会话不提示
- **服务器端断开时自动关闭标签**（可开关，默认关；`shared/session-end.ts` + 同一处扩展钩子）：会话曾经连上、且 Worker 主动以 1000（exit、空闲超时……）或 1011（远程主机断开、服务器重启……）关闭 WebSocket 时，直接关闭这个标签并提示原因，不再排定重连；本机网络断开收到的是 1006 或心跳超时，照常自动重连；没连上过的（密码错误、主机指纹待确认）不关。电脑在设置面板“会话”里，手机在“设置 → 终端”
- **服务器列表在断网后被清空**（`vite.config.ts` 扩展钩子 + `sidebar/hooks.ts`）：网页版拉取列表遇到网络失败时保留原列表；连接/编辑/克隆前网页版列表里没有这台服务器就先刷新一次再继续，仍没有则提示，而不是点了没反应
- **关闭会话的确认**（`sidebar/hooks.ts` 的 `sessionIsConnected`、`mobile/close-confirm.ts`）：按 Shell 是否就绪、终端 WebSocket 是否打开判断会话是否真的连着（网页版重连失败时标签会一直停在“连接中”，不能只看标签状态）；手机端再按“关闭会话前确认”设置决定要不要弹确认

### AI 助手回复的可读性（`overrides/shared/agent-output/`，桌面与手机共用）

- **配色**：网页版把回复的正文、标题、表格、加粗全用同一个 AI 主题色。改为正文用普通文字色；标题按字号分级、左侧短竖条点缀；加粗（多是“主机：”“结论：”这类关键标签）和链接保留 AI 主题色；行内代码中性底色；表格表头弱化、数字等宽；引用用次要文字色，中文不用斜体。全部用主题变量，深浅色主题都适配
- **状态高亮**：表格里很短的状态格、列表项开头的加粗状态词按开头的词上色：正常 / 充裕 / 无异常 → 绿，注意 / 偏高 / 警告 → 黄，异常 / 失败 / 不足 / 不正常 → 红（否定词开头的按“有问题”算，英文整词匹配，down 不会匹配 download）；以“异常：”“注意：”（或 ⚠️ ❌）开头的列表项与段落加浅色底
- **回复风格提示**（`style.ts`）：内置一段英文提示——结论在前、篇幅随问题、适合窄面板（表格最多 4 列、一行一条命令）、用文字标状态（Worker 的系统提示禁止 emoji：正常 / 注意 / 异常，英文 OK / Warning / Problem）、给出数值依据、只引用相关输出、区分已验证与推测、改动后列出改了什么与如何回退。完整提示每个会话只发一次，之后每条只附一句提醒；改了提示、会话重置、上下文被压缩或编辑更早的消息后重发完整版。可编辑、关闭、恢复默认，只存在本机。入口：电脑端 AI 面板标题栏的油漆刷按钮或命令面板；手机端“设置 → 终端 → AI 回复风格”（手机上 AI 面板标题栏太挤，不放按钮）
- **发送时附加的内容**（`outbound.ts`）：用户原话 + 这台服务器在 CloudSSH 里的名称与标签（`<server_context>`）+ 需要时的服务器目录与跨服务器操作用法（`<cloudssh_servers>`）+ 提问格式说明（`<cloudssh_ask>`，每个会话一次）+ 回复风格提示（`<reply_style>`）。对话里仍显示原话
- **上下文出错时接着做**（`recovery.ts`）：Worker 按字节估算上下文，超过预算就让模型把前文压缩成严格的 JSON；交回的内容不合规时报“结构化输出校验失败”且之后每条都失败，压缩成功又会清空编辑检查点（编辑旧消息报“该编辑位置不可用”）。遇到这几种错误时重置会话、把面板里看得到的前文整理成回顾（附失败那一轮已开始执行的命令），在新会话里重发；每条请求最多两次
- **“完全”权限模式**（`full-access.ts`）：“交互 / Auto”旁加“完全”按钮，存进网页版同一个模式设置（网页版加载时只认前两种，面板渲染完由构建钩子补上按钮并恢复）。选中后 Worker 发来的确认请求立刻回同意（与自动模式倒数结束后发的内容相同），跨服务器操作也不确认；拦截级命令仍拒绝
- **对话历史**（`history.ts`）：网页版只把被中断的对话暂存 30 分钟，而任何断线都会丢掉 AI 面板、Worker 那边也是新会话。这里按“实例 + 服务器”把对话存进 IndexedDB（每台最近 30 段、每段最近 80 条），面板新建时（重连、切后台回来、重启应用）自动恢复最近一段；这些前文 Worker 不知道，下一条消息前附上回顾（与出错接续同一套）。输入框上方的“历史”列出这台服务器的对话，可以打开（Worker 端清空上下文、下一条带回顾）或删除
- **提问卡片**（`ask.ts`）：AI 在回复末尾写 `cloudssh-ask` 代码块（问题 + 选项，最多 4 个问题），换成可点的卡片：单选点了就作为下一条消息发出，多选或多个问题选好后点“发送”，每个问题都有“其他”+ 补充框。流式输出与恢复历史时都显示成只读卡片，这一轮正常结束后最新的那张才能作答
- 不改 Worker：构建钩子在网页版组 `agent_start` 请求时展开 `__cloudsshAgentOutbound` 的结果换掉 `message`（网页版发送终端选区时也是这样扩展发出的内容），处理每个 AI 帧前先交给 `__cloudsshAgentFrame`（出错接续、完全模式自动同意可以接管这一帧）

### AI 跨服务器操作（`overrides/shared/ai-remote/`，桌面与手机共用）

AI 的工具只能操作当前服务器，其他服务器由客户端代办，不改 Worker：

- **约定**（`protocol.ts`）：需要时把服务器目录（名称、标签、系统、线路，不含地址与凭据）和用法附给 AI；AI 在回复末尾写一个 `cloudssh-action` 代码块，每行一个 JSON 动作（`exec` 执行命令、`copy` 传文件或目录、`list` 列出服务器）。客户端执行后把结果包在 `<cloudssh_action_results>` 里作为新一轮发回，最多 8 轮。按名字找服务器：只有完全一致才直接用；部分匹配或匹配到多台时，在操作卡片里弹出提问卡片让用户选（列出候选，可选“其他”自己填；同一轮同一个名字只问一次；这是确认是哪台，完全模式下也问）。提示词也要求 AI 在名字相近或拿不准时先用提问卡片确认
- **无界面会话**（`session.ts`）：`POST /api/servers/:id/connect` 换一次性令牌连 WebSocket，Worker 用保存的凭据登录、自动走跳板与隧道。初始化时关回显与提示符、禁用分页器，探测 bash 与 `timeout`；每条命令用 `sh -c` 跑在 stdin 为空的子进程里，前后打印标记（命令行里写成八进制转义，回显不会误判）、末尾打印退出码、只留最后 64KB；按 `terminal_output_flow` 回执输出，每 20 秒 ping 一次，空闲 3 分钟关闭
- **传文件**（`transfer.ts`、`sftp.ts`）：同机 `cp -a`；其余先试直连：源服务器经目标的跳板链（源本身在链上就从下一跳开始）直接 ssh 过去，数据不经过本机。每一跳的主机公钥经已验证的通道读出、写进临时 known_hosts 严格校验；在源上生成一次性 ed25519 密钥，临时加进每一跳的 `authorized_keys`——跳板上 `restrict,port-forwarding,permitopen="下一跳:端口"`（只许转发到下一跳），目标上 `restrict`；源上写临时 ssh 配置，后一跳经前一跳的 `ProxyCommand ssh -W '[%h]:%p'`；传完删掉所有临时密钥并清理一小时前遗留的。第一跳是 CF 隧道、或直连任何一步失败时经本机 SFTP 中转（电脑 512MB、手机 128MB 上限），目录先 tar 打包
- **护栏与确认**（`safety.ts`、`runner.ts`）：与 Worker 的 AI 助手同一套命令规则；确认跟随 AI 面板的交互 / 自动 / 完全模式；执行中可停止，正在跑的远程命令随会话关闭被中断
- **界面**（`ui.ts`）：AI 回复里的动作代码块不显示，换成操作卡片（服务器、命令或路径、状态、可展开的输出、确认按钮）

### 扫码同步：电脑 → 手机（`overrides/shared/qr-sync/`）

只同步只存在本机的两类设置（服务器、标签、命令片段本来就随账号同步）：**分组与排序**（分组顺序、组内手动顺序、排序方式、折叠的分组）和**凭据预设**（含密码 / 私钥与服务器关联），可以勾选。不需要同一网络、不改 Worker。

- 电脑：设置面板或命令面板 →“同步到手机”（`desktop/qr-sync.ts`），二维码每 0.3 秒轮播一张，旁边显示 6 位验证码
- 手机：设置 → 连接 →“从电脑同步”（`mobile/qr-sync.ts`），扫齐后输入验证码、确认再导入；系统有 BarcodeDetector 就用，否则用内置 jsQR
- 格式（`protocol.ts`）：内容 JSON → deflate-raw 压缩 → AES-256-GCM 加密 → Base45 → 每 440 字符一张（同一组统一成 11 版二维码，画布尺寸固定），内容为 `CS1:<会话>:<序号>/<总数>:<数据>`，二维码用字母数字模式
- 密钥：PBKDF2-SHA256 60 万轮，口令为“内置固定密钥:验证码”，每次 16 字节随机盐；内置密钥不随版本变化（新旧版本互通），其他扫码工具只能看到乱码，没有验证码也解不开
- 验证码 6 位、不区分大小写，字符集去掉 0 O 1 I L（31 个字符，约 8.9 亿种）；4 位只有约 92 万种，内置密钥又在应用里，拿到二维码就能很快穷举，所以用 6 位
- 手机端只在电脑与手机是同一个实例（Worker 地址）、同一个账号（`/api/auth/me`）时才导入分组排序和预设的服务器关联；导入的密码与私钥用手机的 Keystore 重新加密

### 凭据预设与后台通知（桌面与手机共用）

**凭据预设**（`overrides/shared/credential-presets/`）：一堆服务器共用一套密码或私钥时，把“用户名 + 密码 / 私钥”存成预设。

- 添加 / 编辑服务器的对话框里有“凭据预设”一行：选一个就填好用户名、认证方式和凭据，保存照常走网页版；也可以把当前填写的凭据“存为预设”
- 预设管理（电脑：设置面板或命令面板；手机：设置 → 连接）：新建、编辑、删除；“应用到服务器”勾选多台，逐台调用 Worker 现有的 `PUT /api/servers/:id`，只发 `auth_method`、`credential`（以及预设里的 `username`），不用改 Worker
- 记住哪台服务器用的是哪个预设（按实例分开），改了预设的密码或私钥后提示“同步到这 N 台服务器”。Worker 给每台服务器各存一份凭据，所以改预设后要同步才会写进服务器
- 只保存在本机：电脑存在配置目录的 `credential-presets.json`，密码与私钥用 Electron `safeStorage` 加密（Windows 为 DPAPI，绑定当前 Windows 账户；Linux 没有可用的密钥服务时直接不提供预设，不会退回明文）；手机用 Android Keystore 里不可导出的 AES-GCM 密钥加密后存在 WebView 本地存储。加解密接口只开放给内置 UI 的窗口，“跟随 Worker”的网页拿不到

**后台通知**（`overrides/shared/session-notify.ts`）：人不在窗口前（电脑窗口不在前台 / 手机应用在后台）时提醒——长命令结束、终端响铃、OSC 9 / OSC 777 通知、会话断开超过 3 秒与重新连上。“回到提示符”的判断：回车时在那一行做标记，之后有输出、安静 0.8 秒、光标左边以 `$ # % > ❯ »` 结尾即算结束，再从标记处读出命令（回车那一刻回显可能还没到齐）；不需要在服务器上装 Shell 集成脚本，代价是奇特的提示符可能漏报。电脑用网页 Notification（Electron 转成系统通知），手机走原生通知（`EventNotifications.kt`，单独的“会话提醒”渠道），点通知回到对应标签。除总开关外，长命令完成、响铃与程序通知、断线与重连三类可以分别关掉（存在本地，分项默认都开）。

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

同步后如果网页版用了新的图标，再运行 `pnpm update:icon-font` 重新生成内置图标字体（见下文“内置图标字体”）。

脚本**只读**源仓库，同步内容包括：

- `frontend/`
- frontend 引用的共享 Schema（`src/*.ts`，递归解析）
- 按源仓库 `pnpm-lock.yaml` 改写的确切依赖版本

同步后会写入 `upstream/SOURCE.json`，记录提交和版本。实例管理里也会显示内置 UI 的上游版本。

> **版本漂移提醒**：Worker 每天自动同步上游并重新部署。如果上游改了前后端协议（例如 WebSocket 消息格式），旧的内置 UI 可能和新 Worker 不兼容。此时运行 `pnpm sync:web-ui && pnpm build:ui`，或者先把实例切到 `remote`（跟随 Worker）即可恢复。

### 内置图标字体

网页版从 Google Fonts 在线加载 Material Symbols 图标字体；离线或访问不畅时，图标会退化成 “close”“search” 这样的文字。客户端（桌面与手机）改为内置：

- `scripts/update-icon-font.mjs` 扫描网页版与 `overrides/` 源码里实际用到的图标名（约 160 个），向 Google Fonts 请求只含这些图标的子集，写入 `packages/ui-web/overrides/fonts/`（约 39KB）
- 构建时把 `index.html` 里在线字体的 `<link>` 原地换成内联 `<style>`（字体以 data URI 内嵌）。原地替换保证层叠顺序不变——网页版用 `text-[18px]` 等工具类控制图标大小，依赖图标样式排在 `style.css` 之前
- 网页版新增图标后运行 `pnpm update:icon-font`（需要能访问 Google Fonts，代理用 `HTTPS_PROXY`）；运行时拼出来的图标名扫描不到，可加到脚本里的 `EXTRA_ICONS`

---

## 快捷键

为避免和终端程序（vim、mc、htop 等）冲突，客户端只用组合键。Electron 只在网页没有处理该按键时才触发菜单快捷键，终端获得焦点时按键优先交给终端。

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Alt+T`（全局，可更换） | 在任何程序里叫出窗口并打开命令面板，快速连接 |
| `Ctrl+Shift+P` | 命令面板（服务器、会话、命令片段、操作） |
| `Ctrl+K` | 命令面板（不在终端里输入时；终端里留给 Shell 的“删除到行尾”） |
| `Ctrl+Shift+M` | 实例管理 |
| `Ctrl+Shift+R` | 重新加载当前窗口 |
| `Ctrl+Shift+I` | 开发者工具 |
| `Ctrl+0` / `Ctrl+=` / `Ctrl+-` | 重置、放大、缩小 |
| `F11` | 全屏 |

内置 UI 的窗口没有菜单栏，菜单在标题栏左上角的按钮里，快捷键照常可用。“跟随 Worker”的窗口菜单栏默认隐藏，因为单按 Alt 会把焦点从终端抢走；可以在实例管理里打开。托盘菜单提供相同的功能。

---

## 安全设计

- 所有窗口启用 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`，并禁止 `<webview>`
- 主窗口只停留在 Worker origin。外部链接交给系统浏览器；GitHub 登录在独立窗口中进行，不挂任何拦截
- IPC 按调用方拆成两组：实例页面只能读取只读信息，管理接口只接受实例管理窗口调用。每个 handler 都会校验发送方
- 权限只放行剪贴板（终端粘贴需要）、通知和全屏，而且请求必须来自实例 origin
- 本地 UI 响应带上与 Worker 相同的安全头（`nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`）
- origin bridge 读取本地文件时做了路径穿越防护
- 凭据预设的读写与加解密 IPC 只接受内置 UI 窗口（界面自己画标题栏的窗口）调用，密码与私钥用 `safeStorage` 加密后才写盘
- SFTP 拖出：只认领页面事先登记过文件名的 blob 下载，存进系统临时目录下的 `CloudSSH-drag/<随机标识>/`（文件名去掉 Windows 不允许的字符），十分钟后或退出时删除

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
| OAuth 回调地址是 Worker 域名 | 点击登录时 Rust 先请求 `/api/auth/github`（`oauth_state` 进 Rust 的 Cookie 罐），WebView 打开 GitHub 授权页；跳回 `<Worker>/api/auth/callback` 时被拦下，由 Rust 带着 `oauth_state` 完成回调，再回到应用首页。用浏览器登录时授权页在 Custom Tab 里打开：浏览器没有 `oauth_state`，Worker 先校验 state 就拒绝回调（code 不会被用掉），用户点底部“完成登录”，浏览器把回调地址交回应用，再由 Rust 照样完成 |
| 网页版校验 wsUrl 必须同源 | 构建时给 `validateWsUrl` 加一个扩展判断，放行当前实例的 `/api/ssh*`（只影响移动端构建） |

### 功能

| 功能 | 说明 |
|---|---|
| 节点首页 | 代替网页版每页 3 张卡片的分页：搜索（名称、地址、标签），“最近连接”置顶，按标签分组并可折叠，显示系统图标与在线会话数；长按分组标题可重命名标签、复制标签名；添加 / 编辑服务器时可以点选已有标签 |
| 调整排序 | 节点页顶部的排序按钮（或长按节点 → 调整排序）打开排序面板：拖动分组顺序，点分组拖动组内服务器顺序；按住 ⋮⋮ 立即拖、长按条目也能拖，被拖项浮起跟手、其余项动画让位，拖到边缘自动滚动；可恢复默认排序。面板顶部的“组内排序”可选自定义（手动拖动）、最近连接、最近修改、添加时间、名称，规则与网页版的排序一致；按规则排序时拖动调整会改为自定义顺序。顺序保存在本地，按实例区分 |
| 多会话终端 | 网页版的标签页；节点页顶部显示“N 个会话进行中”一键回终端。点节点时已有会话就切过去，长按可“新建连接 / 切换会话 / 编辑 / 克隆 / 复制名称 / 复制地址 / 分享 / 删除”（分享只在 Worker 开启一次性分享时出现；分享与删除走网页版自带的流程，与网页版的服务器卡片一致） |
| 标签栏（经典主题） | 黑曜主题用“紧凑终端栏”代替，见下文。一屏放 3 个标签，超出横向滚动，“+”固定在右侧；名称中间省略（保留开头和最后一段，如“宁宁云…NoLimit”）；右侧会话按钮打开会话列表，显示完整名称、地址与状态。防误触：只有当前标签显示小号关闭按钮，关闭仍在连接的会话前先确认 |
| SFTP | 上传走系统文件选择器；下载与日志导出写入系统“下载”目录（Android 10+ 不需要存储权限），重名自动改名 |
| 后台保活 | 有会话时启动前台服务（通知栏显示会话数），持有 CPU 与 Wi-Fi 唤醒锁，WebView 渲染进程保持重要优先级；设置里可一键申请“不受电池优化限制”。全部会话关闭后自动停止 |
| 后台提醒 | 应用在后台时，长命令结束、终端响铃、会话断线与重连发通知（单独的“会话提醒”渠道，可在系统设置里调整），点通知回到对应会话；回到应用时收起。“设置 → 连接 → 后台提醒”总开关，下面可分别关掉长命令完成、响铃与程序通知、断线与重连 |
| 凭据预设 | 多台服务器共用的密码或私钥存为预设（Android Keystore 加密），添加 / 编辑服务器时一键填入，或批量写进多台服务器；改了预设可一键同步。“设置 → 连接 → 凭据预设” |
| AI 回复 | 正文、标题、表格分层配色，状态格与开头的状态词（正常 / 注意 / 异常……）上绿黄红，“异常：”“注意：”开头的项加浅色底；“设置 → 终端 → AI 回复风格”可编辑附加给 AI 的回复格式提示 |
| AI 跨服务器与完全权限 | 与电脑一致：说出服务器名，AI 就能在别的服务器上执行命令、在服务器之间传文件（自动登录；直连优先，有跳板也经跳板直连，不行经本机中转，中转上限 128MB）；名字不精确时先弹卡片让你选；AI 面板标题栏的“交互 / Auto / 完全”决定要不要确认，“完全”不再有任何确认提示 |
| AI 对话历史与提问 | 与电脑一致：对话按服务器保存，断线重连、切后台回来、重启应用后自动恢复，接着聊会带上前文回顾；输入框上方“历史”可切换或删除。AI 提问显示成可点的选项卡片（单选 / 多选 / 其他 + 补充） |
| 从电脑同步 | “设置 → 连接 → 从电脑同步”扫电脑上轮播的二维码，输入电脑上的 6 位验证码，确认后导入分组排序与凭据预设（勾选导入哪些）；二维码内容加密，第一次使用请求相机权限 |
| 渲染进程崩溃恢复 | WebView 渲染进程被系统回收或崩溃时应用不再整个闪退：自动重建界面回到节点页（会话会断开），同时停掉保活服务、关闭旧页面留下的连接；1 分钟内反复崩溃则停在“重新加载”页，由你决定何时再试 |
| 返回键 | 先关最上层的浮层（设置、对话框、抽屉、更多菜单）；在终端时回到节点页（会话保留）；在节点页时退到后台而不是退出。页面还没注册返回监听（启动中、页面忙）时原生层也是退到后台——系统默认的结束 Activity 会让 Tauri 的 Rust 端崩溃 |
| 关闭会话的确认 | “设置 → 终端 → 关闭会话前确认”可选：仅已连接的（默认）/ 总是 / 从不。默认只有真正连着的会话关闭前要确认，已断开、正在连接或重连中的直接关闭；关闭标签、会话列表里的 ×、黑曜“更多”里的“断开”都按这个设置 |
| 服务器端断开时自动关闭标签 | “设置 → 终端”里的开关（默认关）：exit、远程主机断开、服务器重启、空闲超时等服务器那边结束的会话直接关闭标签并提示原因；手机网络断开仍自动重连，没连上过的不关 |
| 多实例与代理 | 设置里新增/编辑/切换实例（删除在编辑页里）（“测试连接”显示延迟、登录方式与 OAuth 回调地址），每个实例独立 Cookie；可设 HTTP 代理 |
| 剪贴板 | `navigator.clipboard` 由原生剪贴板实现，终端粘贴可用 |
| 选中与复制 | 终端里**长按**选中手指下的词（中文、路径、网址、IP 都按整词选），不松手继续拖可以扩大选区，靠近上下边缘自动滚动；松手后两端出现拖动柄，上方浮出“复制 / 全选 / 粘贴 / 问 AI”（问 AI 在登录且 AI 可用时出现）。键盘开着时**双击**也能选词。点终端其他地方取消。拦掉了长按的系统行为（xterm 把它当右键：把隐藏输入框挪到手指下并聚焦，只弹出“粘贴”气泡和键盘）和双击时的系统“分享”菜单（安卓的 platform 是 Linux，xterm 会模拟 Linux 主选区把词塞进输入框）。工具栏的“复制”按钮（网页版的选择模式）照常可用（`overrides/mobile/terminal-touch.ts`） |
| 终端字号 | 终端里**双指缩放**调整字号（8～18，黑曜主题），松手后保存，与“更多”里的 A− / A+ 是同一个设置。手指数取系统的触点列表（`TouchEvent.touches`），两根手指要几乎同时按在终端上、间距变化超过一点才算缩放，单指拖动始终是滚动。一键脚本的菜单常是 60～80 列宽，竖屏放不下会折行错乱，缩小到能放下后已经输出的内容也会重新排好；也可以用“更多 → 横屏” |
| GitHub 登录 | 点“使用 GitHub 登录”先选方式（记住上次的选择）。**用浏览器登录**：在系统浏览器的 Custom Tab 里登录与授权，passkey、密码管理器、浏览器里已登录的 GitHub 都能用；授权后页面显示“Invalid state parameter”是正常的，点浏览器里的“完成登录”（底部工具栏、右上角 ✓ 或菜单）回到应用；浏览器没有这个按钮时，复制地址栏里的链接再切回 CloudSSH 也能完成。会优先选用对这些按钮支持完整的浏览器（Chrome、Edge、三星浏览器等）。**在应用内登录**：GitHub 页面在应用的 WebView 里打开，WebView 不支持 passkey。两种方式都不需要改 Worker |
| 设置 | 按使用频率分成五组：实例 → 终端（字号、关键词高亮、关闭确认）→ 连接（代理、凭据预设、后台保活、后台提醒、电池优化）→ 外观（主题、强调色、布局模块）→ 关于（版本、存储）；一项设置一行，左边标题右边控件。顶部的分组导航点一下直达，滚动时高亮当前分组。入口：节点页标题栏、匿名连接页右上角、终端“更多 → 界面设置” |
| 全面屏与键盘 | 系统栏和键盘的空间由原生让出，键盘弹出时终端行数自动变化；系统栏颜色跟随网页主题 |

### 界面主题：黑曜（默认）与经典

在“设置 → 外观 → 界面主题”里切换，即时生效，不用重启：

- **黑曜**：为手机重写的深色主题。它重新安排了布局，不只是换颜色，目标是终端尽量大、面板不盖住终端、常用操作单手可达
- **经典**：网页版原来的移动端布局，配色跟随网页版主题（赛博朋克等）

黑曜由 7 个模块组成，每个都能在设置里单独开关：

| 模块 | 作用 |
|---|---|
| 节点首页 | 大标题和节点/分组统计；搜索、排序、添加集中在底部浮动栏；“回到终端”改为浮动胶囊；识别出系统的节点显示系统图标 |
| 紧凑终端栏 | 顶栏、标签栏、状态栏合成一行，默认字号下终端从 43 行增加到 47 行。左右滑动标题切换会话，点标题打开会话列表；“更多”里有命令、AI 助手、搜索、导出日志、横屏、快捷键、复制名称（服务器原名，不受标签改名影响）、复制地址、新建连接、界面设置、字号与断开 |
| 半屏面板 | SFTP、常用命令、AI 助手从底部弹出半屏。拖把手可以拉到全屏或下滑关闭，点把手在半屏和全屏之间切换；每种面板记住自己的高度（默认都是半屏）；打开时不自动弹键盘，键盘弹出时自动全屏，打字时下拉面板会收起键盘回到半屏 |
| 快捷命令 | 键盘上方一排已保存的命令：点按填入（不回车），长按可“填入并执行 / 复制 / 管理”，带 `{{参数}}` 的命令先弹表单；按键栏最左侧的 ⚡ 显示或收起 |
| 按键栏 | 更大的圆角按键，Ctrl / Alt 等修饰键的状态更醒目 |
| 液态玻璃 | 底部栏、“回到终端”胶囊、底部面板、命令条与按键做成玻璃质感：磨砂（模糊、提饱和、提亮）、半透明底色、顶部高光、渐变描边、内外阴影，按下时液体般回弹；节点页加一层强调色环境光。模糊半径控制在 5～16px，只用在背后真有内容在动的地方（终端上方的栏不模糊）；以前底部栏和胶囊上的“边缘折射”（SVG 位移滤镜）每滚一帧都要重算，是手机上掉帧的主要来源之一，已去掉。系统要求减少透明效果时退回实色。实测比关闭时多占几 MB 内存（WebView 合成层） |
| 流畅动画 | 页面、面板、会话切换的过渡；系统打开“减少动态效果”时自动关闭 |

另外可以选 5 种强调色，调终端字号（10～18，或“自动”沿用网页版按屏幕宽度的规则）。“恢复默认”只重置强调色、模块和字号，不会切走主题。

实现与扩展（代码在 `packages/ui-web/overrides/mobile/skin/`）：

- 所有改动都在 `overrides/` 里，不改 `upstream/`。样式按 `<html>` 上的属性生效：`data-cs-skin="obsidian"`、`data-cs-accent`、`data-cs-mods="hosts chrome …"`（CSS 用 `~=` 判断某个模块是否开启）。关掉一个模块，对应部分就恢复成网页版原样
- 配色只有一个来源 `skin/palette-data.ts`：启动时由 `early.ts` 在网页版脚本之前注入，不会闪屏；运行时通过网页版自己的主题接口（`applyImportedTheme`）应用，终端配色一起变化
- 每个模块实现 `SkinModule { id, mount() }`，`mount()` 返回清理函数。新增模块：写 `skin/modules/<名字>.ts`（和同名 `.css`），登记到 `skin/modules/index.ts` 的 `MODULES` 列表，把 id 加进 `skin/state.ts` 的 `MODULE_IDS`，再在 `skin/i18n.ts` 补上名称和说明（简体、繁体、英文）。删除模块按相反步骤
- 需要改网页版行为时用构建钩子（`vite.config.ts` 的 `MOBILE_HOOKS`）：终端字号覆盖，以及打开命令面板、AI 助手时不自动聚焦输入框，都是在锚点后面注入一行条件。上游代码变化导致锚点找不到时，构建只告警，相应功能退回网页版原样
- 网页版抽屉的开关状态从它们自己的 inline style 判断（`skin/panels.ts`）。关闭面板一律点面板自己的关闭按钮，与点 × 的效果完全相同（例如关闭 SFTP 会中断正在进行的传输）

### 体积

| 项目 | 大小 | 做法 |
|---|---|---|
| 安装包（release，arm64） | 约 4.0MB | Rust 动态库（约 5.9MB，含打包的界面）与 dex 在安装包里压缩存放（约 3.1MB 与 0.6MB）；排除了 Tauri 依赖里没用到的 Material 组件库，资源表从 381KB 降到 90KB |
| 安装后本体 | 约 11MB | 安装时系统解压出动态库（与 dex），占用比安装包多。想要安装后占用最小，用 `pnpm android:build --uncompressed`：动态库与 dex 不压缩、按 16KB 页对齐由系统直接映射，安装包约 7.5MB，安装后与安装包相当 |
| 应用数据 | 通常 2～5MB | 主要是 WebView 的数据目录；关闭 WebView 统计埋点，并阻止它生成约 4MB 的 `BrowserMetrics-spare.pma` 预分配文件 |
| 缓存 | 上限 16MB | 界面在 APK 里，不靠 HTTP 缓存。超过 16MB 时下次启动自动清空；“设置 → 关于 → 存储”显示占用，也可以手动清除 |

Rust 侧的压缩手段：`opt-level="z"`、LTO、`codegen-units=1`、`panic=abort`、strip；TLS 用 rustls + ring（不带 aws-lc）；reqwest 只用 HTTP/1.1；Tauri 关掉默认特性（dynamic-acl 与桌面平台专用部分）；Cookie 罐不带公共后缀表；链接时用 RELR 压缩动态重定位表（`build.rs`）。Kotlin 侧 R8 压缩、去掉 Kotlin 元数据与许可证文本、只保留中英文资源。

### 开发与调试

- `pnpm mobile:dev`：在电脑上以窗口形式运行移动端（Tauri dev + Vite 热更新），网络层、登录流程与手机上相同，适合迭代界面
- `pnpm android:dev`：在已连接的手机或模拟器上热更新运行
- Windows 调试构建可设 `CLOUDSSH_WEBVIEW_DEBUG_PORT=9555` 打开 WebView2 远程调试端口，便于自动化测试
- 模拟器联网需要代理时，在应用“设置 → 连接 → 网络代理”填 `http://10.0.2.2:7890`（`10.0.2.2` 是模拟器访问宿主机的固定地址）
- 调试版 APK 可用 `chrome://inspect` 或 `adb forward tcp:9556 localabstract:webview_devtools_remote_<pid>` 连接 WebView 调试
- `node scripts/mock-worker.mjs [端口] [--anon] [--servers N]`（默认 8788；`--anon` 模拟未登录，显示匿名连接页；`--servers 90` 补足到 90 台，看节点很多时的流畅度）：本地假 Worker，提供 26 台假服务器（含分组和系统类型；其中“Slow-1 卡在认证”连接会一直停在认证，用来测“正在连接”状态）、可以交互的假 shell（输入 `help` 查看命令，`logs` 输出一屏各种常见日志，用来看关键词高亮；`menu` 输出一键脚本式的 60 列框线菜单，`size` 显示客户端报给服务器的行列数，用来看窄屏排版）、SFTP 目录列表和命令片段接口，不需要真实服务器就能调界面。在手机或模拟器上先运行 `adb reverse tcp:8788 tcp:8788`，再在“设置 → 实例”里添加 `http://127.0.0.1:8788`。调电脑端界面（侧栏、拖动排序等）时先 `pnpm build:ui`，再运行 `node scripts/mock-worker.mjs 8788 --ui packages/ui-web/dist`，用浏览器打开 `http://127.0.0.1:8788` 即可
- 模拟器的两个假象，真机上不会出现：一是 WebGL 由软件渲染（SwiftShader），终端字形可能显示残缺，截图检查文字时可以在 WebView 调试里对当前终端执行 `webglAddon.dispose()` 改用 DOM 渲染；二是模拟器报告 `pointer: fine`，横屏宽度超过 767px 时网页版的移动端媒体查询不生效，按键栏会消失

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

## 版本号与版本代号

版本号和代号只在根目录的 [`version.json`](version.json) 里维护，用脚本修改和同步：

```bash
pnpm version:check                   # 查看当前版本，检查各处是否一致
pnpm version:set 0.3.0 牛郎 Altair    # 修改版本号和代号，并同步到各处
pnpm version:set 0.2.1               # 修订版沿用当前代号
node scripts/version.mjs sync        # 手动改过 version.json 之后同步
```

`scripts/version.mjs` 同步的位置：

- 根目录、`apps/desktop`、`apps/mobile`、`packages/core` 的 `package.json`。`packages/ui-web` 的版本跟随上游网页版，不在此列
- `apps/mobile/src-tauri` 下的 `Cargo.toml`、`Cargo.lock`、`tauri.conf.json`
- 生成 `packages/core/src/version.ts`（`CLIENT_VERSION`、`CLIENT_CODENAME`）。桌面端“帮助”菜单、实例管理页、启动日志，以及手机端“设置 → 关于”据此显示代号

Android 的 `versionCode` 由 Tauri 按 主×1000000 + 次×1000 + 修订 推导（0.2.0 → 2000），所以次版本号和修订号要小于 1000；新版本号必须更高才能覆盖安装，脚本默认拒绝降级（确实需要时加 `--force`）。`pnpm test`、`pnpm dist:win` 和 `pnpm android:build` 都会先检查各处版本号是否一致，不一致直接报错。

代号取自夜空中的亮星：0.1 天狼 Sirius，0.2 织女 Vega，0.3 牛郎 Altair。次版本号或主版本号升级时换新代号，修订版沿用原代号。发版时在 [CHANGELOG.md](CHANGELOG.md) 顶部补上这一版的内容。

---

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 构建内置 UI，然后启动客户端 |
| `pnpm dev:ui` | UI 热更新开发（Vite 与客户端同时启动） |
| `pnpm build` | 构建内置 UI 和桌面端 |
| `pnpm dist:win` | 打包 Windows 安装包和 zip |
| `pnpm sync:web-ui` | 从 CloudSSH 主仓库同步网页版前端 |
| `pnpm update:icon-font` | 重新生成内置图标字体（按源码实际用到的图标裁剪） |
| `pnpm android:build` | 构建 Android 正式版 APK（arm64） |
| `pnpm android:build:debug` | 构建 Android 调试版 APK（arm64 + x86_64） |
| `pnpm android:install` | 把最近构建的 APK 安装到已连接的设备或模拟器 |
| `pnpm android:dev` | 在手机/模拟器上热更新运行 |
| `pnpm mobile:dev` | 在电脑窗口里运行移动端（界面迭代） |
| `pnpm typecheck` | 类型检查（core / ui-web / desktop） |
| `pnpm test` | 检查版本号是否一致，然后运行单元测试（core） |
| `pnpm version:check` | 查看版本号与代号，检查各处是否一致 |
| `pnpm version:set <版本> [中文代号 英文代号]` | 修改版本号和代号，并同步到各处 |
| `node scripts/mock-worker.mjs` | 启动本地假 Worker，不连真实服务器调界面 |

## 故障排查

- **一直显示未登录**：在实例管理里点“GitHub 登录”重新登录，或者“清除登录数据”后再登录。检查 Worker 的 `GITHUB_ALLOWED_USER_IDS` 是否包含你的账号
- **GitHub 授权页提示 redirect_uri is not associated with this application**：实例地址和 OAuth App 登记的回调域名不一致，把实例地址改成回调域名（本项目即 `https://bash.al`）
- **终端连不上**：用 `CLOUDSSH_DEBUG=1 pnpm dev` 启动，看日志里的 WebSocket 握手状态码。401 表示未登录或会话已过期；403 表示 Origin 被拒（不应出现，请反馈）
- **界面和服务端行为不一致**：可能是版本漂移，参考上文“同步上游网页版”，或者把实例切到 `remote`
- **依赖安装报 `ERR_PNPM_TRUST_DOWNGRADE` 或 `minimumReleaseAge`**：`pnpm-workspace.yaml` 沿用了主仓库的供应链策略，详见文件注释

## 许可

Apache-2.0。内置 UI 来自 CloudSSH（Apache-2.0）。
