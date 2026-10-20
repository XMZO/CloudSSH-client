import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const upstreamFrontend = path.join(packageDir, 'upstream', 'frontend');
const sourceInfoPath = path.join(packageDir, 'upstream', 'SOURCE.json');

/**
 * 构建目标：
 *   desktop（默认）——Electron 内置 UI：overrides/index.ts（左侧节点侧栏等）
 *   mobile（--mode mobile）——Tauri 移动端：
 *     overrides/mobile/early.ts 最先执行（网络垫片：/api 与 WebSocket 改由 Rust 发出；
 *       网页版入口一加载就会请求，所以必须排在它前面）
 *     overrides/mobile/index.ts 在网页版之后执行（节点分组首页、保活、下载、设置……）
 */
type Target = 'desktop' | 'mobile';

interface Injection {
  id: string;
  file: string;
  injectTo: 'head-prepend' | 'body';
}

function injectionsFor(target: Target): Injection[] {
  if (target === 'mobile') {
    return [
      {
        id: '/@cloudssh/mobile-early.ts',
        file: path.join(packageDir, 'overrides', 'mobile', 'early.ts'),
        injectTo: 'head-prepend',
      },
      {
        id: '/@cloudssh/mobile.ts',
        file: path.join(packageDir, 'overrides', 'mobile', 'index.ts'),
        injectTo: 'body',
      },
    ];
  }
  return [
    { id: '/@cloudssh/overrides.ts', file: path.join(packageDir, 'overrides', 'index.ts'), injectTo: 'body' },
  ];
}

/**
 * 在不修改 upstream 源码的前提下注入定制脚本。
 * 想改样式/行为时优先在 overrides 里做，upstream 保持与 CloudSSH 主仓库逐字节一致。
 */
/**
 * 图标字体本地化：把 index.html 里在线加载 Material Symbols 的 <link> 原地换成内联 <style>
 * （overrides/fonts/ 下的子集字体以 data URI 内嵌，由 scripts/update-icon-font.mjs 生成）。
 * 原地替换保证层叠顺序不变：网页版大量用 text-[18px] 这类工具类控制图标大小，依赖图标 CSS 排在 style.css 之前。
 */
const ICON_FONT_LINK = /<link\s+href="https:\/\/fonts\.googleapis\.com\/css2\?family=Material\+Symbols\+Outlined[^"]*"\s+rel="stylesheet"\s*\/?>/;

function localIconFont(html: string, warn: (message: string) => void): string {
  const dir = path.join(packageDir, 'overrides', 'fonts');
  const cssPath = path.join(dir, 'material-symbols.css');
  const fontPath = path.join(dir, 'material-symbols-outlined.woff2');
  if (!fs.existsSync(cssPath) || !fs.existsSync(fontPath)) {
    warn('缺少内置图标字体（运行 pnpm update:icon-font 生成），继续使用在线字体');
    return html;
  }
  if (!ICON_FONT_LINK.test(html)) {
    warn('index.html 里没找到 Material Symbols 的在线字体链接（上游可能已变化），内置图标字体未生效');
    return html;
  }
  const dataUri = `data:font/woff2;base64,${fs.readFileSync(fontPath).toString('base64')}`;
  const css = fs
    .readFileSync(cssPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace("url('./material-symbols-outlined.woff2')", `url(${dataUri})`)
    .trim();
  return html.replace(ICON_FONT_LINK, () => `<style data-cloudssh-icons>\n${css}\n</style>`);
}

/**
 * 终端字体随客户端内置（overrides/shared/terminal/terminal.css），去掉 index.html 里在线加载 JetBrains Mono 的 <link>：
 * 国内常常加载不到，只会白白等待，还会和内置的同名字体抢着生效
 */
const TERMINAL_FONT_LINK = /<link\s+href="https:\/\/fonts\.googleapis\.com\/css2\?family=JetBrains\+Mono[^"]*"\s+rel="stylesheet"\s*\/?>\s*/;

function localTerminalFont(html: string, warn: (message: string) => void): string {
  if (!TERMINAL_FONT_LINK.test(html)) {
    warn('index.html 里没找到 JetBrains Mono 的在线字体链接（上游可能已变化）');
    return html;
  }
  return html.replace(TERMINAL_FONT_LINK, '');
}

function overrides(target: Target): Plugin {
  const injections = injectionsFor(target);
  return {
    name: 'cloudssh-overrides',
    resolveId(id) {
      return injections.find((item) => item.id === id)?.file ?? null;
    },
    transformIndexHtml: {
      // pre：让注入的脚本与上游入口一样参与打包（同一个入口里按文档顺序执行）
      order: 'pre',
      handler(html) {
        const tags = injections
          .filter((item) => fs.existsSync(item.file))
          .map((item) => ({
            tag: 'script',
            attrs: { type: 'module', src: item.id },
            injectTo: item.injectTo,
          }));
        const warn = (message: string) => console.warn(`[cloudssh] ${message}`);
        return { html: localTerminalFont(localIconFont(html, warn), warn), tags };
      },
    },
  };
}

interface Hook {
  file: string;
  anchor: string;
  inject: string;
}

/**
 * 扩展钩子：构建时（不改 upstream 文件）在两处构造函数里登记实例，
 * 供 overrides（桌面侧栏、移动端节点首页）调用网页版自身的连接/编辑/切换标签逻辑。
 *   globalThis.__cloudsshServerList  —— ServerList（connectServer / showModal / servers）
 *   globalThis.__cloudsshTabManager  —— TabManager（tabs / switchTab / getActiveTab）
 * 锚点找不到时只告警不失败：相关功能会自动降级。
 */
const COMMON_HOOKS: Hook[] = [
  {
    file: '/upstream/frontend/src/server-list.ts',
    anchor: '    this.onConnect = onConnect;\n',
    inject:
      "    (globalThis as any).__cloudsshServerList = this;\n    globalThis.dispatchEvent?.(new CustomEvent('cloudssh:server-list'));\n",
  },
  {
    file: '/upstream/frontend/src/tab-manager.ts',
    anchor: '  constructor(tabBarId: string, terminalAreaId: string) {\n',
    inject: '    (globalThis as any).__cloudsshTabManager = this;\n',
  },
  {
    // 回到前台时不再往终端写“页面已回到前台，正在检查 SSH 连接…”：客户端切后台不会断线
    // （手机有前台服务保活，桌面关闭了后台节流）。紧随其后的心跳校验照常静默进行，
    // 真的失去响应时网页版仍会提示并重连。注入一个条件，让下一行的 writeln 默认不执行。
    file: '/upstream/frontend/src/terminal.ts',
    anchor: '      if (returnedFromBackground) {\n',
    inject: '        if ((globalThis as any).__cloudsshAnnounceResume === true)\n',
  },
  {
    // 终端增强（overrides/shared/terminal）：每创建一个终端就交给它设置内置字体、挂上关键词高亮
    file: '/upstream/frontend/src/terminal.ts',
    anchor: '    this.fitAddon = new FitAddon();\n',
    inject: '    (globalThis as any).__cloudsshTerminalCreated?.(this.terminal);\n',
  },
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: '  dispose(): void {\n    this.disconnect();\n',
    inject: '    (globalThis as any).__cloudsshTerminalDisposed?.(this.terminal);\n',
  },
  {
    // WebGL 上下文丢失（安卓切到后台、显存紧张时常见）后网页版只释放渲染器，终端就一直退回慢得多的 DOM 渲染
    // （每格一个元素，小字号时尤其卡）。交给 overrides/shared/terminal 在页面可见时重新挂上 WebGL 渲染器
    file: '/upstream/frontend/src/terminal.ts',
    anchor: '        this.webglAddon.dispose();\n',
    inject: '        (globalThis as any).__cloudsshWebglLost?.(this.terminal);\n',
  },
  // 等待自动重连时：“x 秒后重连”换成精确到毫秒的实时倒计时（overrides/shared/terminal/reconnect-countdown.ts），
  // 并可按任意键立即重连。两处排定重连的方法里用一个同名的局部 setTimeout 照常排定，同时记下“立即执行”的入口
  // （键盘输入在 Shell 未就绪时调用它），再把网页版刚写的那一行交给倒计时，文案参数与网页版那一行相同。
  // 到点或按键时先让倒计时定格（终端写入是异步的，定格写好才执行原回调，“正在重新连接…”才会排在它后面）。
  // 只在本方法作用域内遮蔽 setTimeout，计时与回调不变；锚点失效时这项增强自动失效
  ...[
    {
      anchor: '  private scheduleFallbackReconnect(): void {\n    this.clearReconnectTimeout();\n',
      format: "t('terminal.reconnectWait', { seconds, attempt, max: this.maxReconnectAttempts })",
    },
    {
      anchor: '  private scheduleShareResume(): void {\n',
      format: "t('terminal.resumingSession', { seconds, attempt })",
    },
  ].map(
    ({ anchor, format }): Hook => ({
      file: '/upstream/frontend/src/terminal.ts',
      anchor,
      inject: [
        '    const setTimeout = (callback: () => void, ms = 0) => {',
        '      let countdown: { finish(next: () => void): void } | undefined;',
        '      let fired = false;',
        '      const fire = () => {',
        '        if (fired) return;',
        '        fired = true;',
        // 倒计时定格写好之后才真正重连；这期间被取消（标签关闭、新连接）就不再执行
        '        const run = () => {',
        '          if ((this as any).reconnectTimeout === id) callback();',
        '        };',
        '        if (countdown) countdown.finish(run);',
        '        else run();',
        '      };',
        '      const id = globalThis.setTimeout(fire, ms);',
        '      (this as any).__cloudsshReconnectNow = () => {',
        '        if ((this as any).reconnectTimeout !== id) return false;',
        '        globalThis.clearTimeout(id);',
        '        fire();',
        '        return true;',
        '      };',
        '      const attempt = this.reconnectAttempts;',
        '      countdown = (globalThis as any).__cloudsshReconnectCountdown?.(this.terminal, {',
        '        ms,',
        `        format: (seconds: string) => ${format},`,
        '        isActive: () => (this as any).reconnectTimeout === id,',
        '      });',
        '      if (!countdown) {',
        '        const hint = (globalThis as any).__cloudsshReconnectHint?.();',
        '        if (hint) this.terminal.writeln(`\\x1b[2m${hint}\\x1b[0m`);',
        '      }',
        '      return id;',
        '    };',
        '',
      ].join('\n'),
    })
  ),
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: "  private processTerminalInput(\n    data: string,\n    source: 'keyboard' | 'focus-report' = 'keyboard'\n  ): void {\n",
    inject: "    if (!this.sessionReady && source === 'keyboard' && (this as any).__cloudsshReconnectNow?.() === true) return;\n",
  },
  // 会话正常结束（exit、空闲超时断开、本机没确认输出……服务端以 1000 关闭）后网页版不重连，终端就停在那里。
  // 会话曾经就绪过的才提示“按任意键重新连接”，按键后立即重连（复用上面的输入入口）：
  // 已保存的服务器重新申请一次性令牌，匿名连接用内存里这次的配置，与网页版自动重连同一套路径。
  // 从没连上（认证失败、主机指纹变化待确认）、分享会话（只允许秒级恢复）不提示。
  // 关闭前是否就绪用实例属性传过去：任一锚点失效时条件不成立，行为与网页版一致。
  // 在这之前先问 overrides/shared/session-end.ts：开了“服务器端断开时自动关闭标签”且 Worker 关闭前报的原因确定是
  // 服务器那头结束（exit、远程主机断开或无响应）时，它安排关闭标签并返回 true，这里直接结束，不再排定重连、不提示按键重连。
  // 原因靠下面记下的“这条连接最后一个带 event 的 status / error 消息”：关闭码本身分不清——本机省电冻结没确认输出、
  // 待机太久空闲超时，Worker 同样以 1000 关闭。没记到原因（锚点失效、Worker 没报）时一律不关
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: "          if (msg.type === 'agent_frame') {\n            this.onAgentFrameHandler?.(msg);\n            return;\n          }\n",
    inject:
      "          if ((msg.type === 'status' || msg.type === 'error') && typeof msg.event === 'string') (this as any).__cloudsshLastEvent = msg.event;\n",
  },
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: '    this.ws.onclose = (event) => {\n      if (socket !== this.ws) return;\n',
    inject: [
      '      (this as any).__cloudsshWasReady = this.sessionReady;',
      '      (this as any).__cloudsshClosingEvent = (this as any).__cloudsshLastEvent;',
      '      (this as any).__cloudsshLastEvent = undefined;',
      '',
    ].join('\n'),
  },
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: '      const willReconnect = event.code !== 1000 && this.hasReconnectStrategy();\n      this.onSessionClosed?.(event, willReconnect);\n',
    inject: [
      '      if ((globalThis as any).__cloudsshServerEnded?.(this, event) === true) return;',
      '      const manualHint =',
      '        !willReconnect &&',
      '        (this as any).__cloudsshWasReady === true &&',
      '        !this.resumeOnlyMode &&',
      '        !this.pendingHostKeyChangeSocket &&',
      '        (this.lastConfig || this.reconnectWebSocketFactory)',
      "          ? (globalThis as any).__cloudsshReconnectHint?.('manual')",
      '          : undefined;',
      '      if (manualHint) {',
      '        let busy = false;',
      '        this.terminal.writeln(`\\x1b[2m${manualHint}\\x1b[0m`);',
      '        (this as any).__cloudsshReconnectNow = () => {',
      '          if (this.ws !== socket || this.sessionReady) return false;',
      '          if (busy) return true;',
      '          busy = true;',
      '          this.reconnectAttempts = 0;',
      '          this.terminal.writeln(`\\x1b[32m[+] ${t(\'terminal.reconnecting\')}\\x1b[0m`);',
      '          const failed = () => {',
      '            busy = false;',
      '            this.terminal.writeln(`\\x1b[31m[!] ${t(\'terminal.reconnectFailed\')}\\x1b[0m`);',
      '            if (this.ws === socket) this.terminal.writeln(`\\x1b[2m${manualHint}\\x1b[0m`);',
      '          };',
      '          const config = this.lastConfig;',
      '          const factory = this.reconnectWebSocketFactory;',
      '          if (config) {',
      '            this.connect(config, { resetDisplay: false }).catch(failed);',
      '          } else if (factory) {',
      '            factory().then((next) => {',
      '              if (this.ws !== socket || this.reconnectWebSocketFactory !== factory) {',
      '                next.close(1000);',
      '                return;',
      '              }',
      '              this.connectWithWebSocket(next, this.lastHostInfo ?? undefined, { resetDisplay: false, reconnectFactory: factory });',
      '            }, failed);',
      '          }',
      '          return true;',
      '        };',
      '      }',
      '',
    ].join('\n'),
  },
  {
    // 填入命令片段后网页版会收起面板；桌面工作台主题下面板停靠在终端旁边时保留（判断由 overrides/desktop 提供），
    // 方便连续填入多条。注入一个条件让紧随其后的 this.close() 按需跳过
    file: '/upstream/frontend/src/snippet-manager.ts',
    anchor: "      notify(t('snippets.insertFailed'), { variant: 'warning' });\n      return;\n    }\n",
    inject: '    if ((globalThis as any).__cloudsshKeepSnippetPanel?.() === true) return;\n',
  },
  // AI 消息附加内容（overrides/shared/agent-output）：网页版组 agent_start 请求时，在 message 后面展开一个同名字段换掉它，
  // 发给 AI 的内容 = 用户原话 + 服务器名称与标签 + 风格提示（网页版发送终端选区时也是这样扩展发出的内容，对话里仍显示原话）。
  // 同时传入面板实例（据它的 serverId 找服务器）与来源（send / edit：编辑更早的消息时之前附过的内容可能已不在，要重新附上）。
  // 新消息与“编辑后重发”两处；返回 undefined（没有可附加的或钩子未装）时不改动
  ...[
    { field: 'message: outboundMessage', kind: 'send' },
    { field: 'message: newText', kind: 'edit' },
  ].map(
    ({ field, kind }): Hook => ({
      file: '/upstream/frontend/src/agent/agent-panel.ts',
      anchor: `      type: 'agent_start',\n      ${field},\n`,
      inject: `      ...((globalThis as any).__cloudsshAgentOutbound?.(${field.split(': ')[1]}, this, '${kind}') ?? {}),\n`,
    })
  ),
  {
    // AI 面板渲染完（事件已绑定）交给 overrides/shared/agent-output/full-access.ts：在“交互 / 自动”旁加“完全”模式按钮，
    // 并恢复上次选的完全模式（网页版只认交互与自动）
    file: '/upstream/frontend/src/agent/agent-panel.ts',
    anchor: '    this.bindEvents();\n',
    inject: '    (globalThis as any).__cloudsshAgentPanelReady?.(this);\n',
  },
  {
    // AI 会话上下文出错时由客户端接着做（overrides/shared/agent-output/recovery.ts）：面板处理每一帧前先交给它，
    // 遇到“结构化输出校验失败”“上下文超过预算”“该编辑位置不可用”时它重置会话、带上前文回顾重发，并返回 true 让网页版跳过这一帧
    file: '/upstream/frontend/src/agent/agent-panel.ts',
    anchor: '  handleAgentFrame(msg: any): void {\n',
    inject: '    if ((globalThis as any).__cloudsshAgentFrame?.(this, msg) === true) return;\n',
  },
  {
    // 命令面板（overrides/desktop/palette.ts）搜索命令片段、填入终端时复用网页版自己的列表与插入流程（含 {{参数}} 录入）
    file: '/upstream/frontend/src/snippet-manager.ts',
    anchor: '  constructor(private readonly deps: SnippetManagerDeps) {\n',
    inject: '    (globalThis as any).__cloudsshSnippetManager = this;\n',
  },
  {
    // 连接后识别出系统：网页版只改自己的列表，这里同时通知侧栏、服务器表格、手机节点页立即换上系统图标
    file: '/upstream/frontend/src/server-list.ts',
    anchor: '  updateServerOS(serverId: number, os: string | null): void {\n',
    inject: "    globalThis.dispatchEvent?.(new CustomEvent('cloudssh:os-detected', { detail: { serverId, os } }));\n",
  },
  {
    // AI 面板的 hide() 无论原来开没开都会在下一帧重新适配终端；回到服务器列表时网页版对每个标签都调一次，
    // 白白重排所有终端（手机上一次要几十毫秒，页面切换因此卡一下）。面板原本就没开时布局没变，跳过适配。
    // 两段注入用实例属性传值：任一锚点失效时条件不成立，行为与网页版一致
    file: '/upstream/frontend/src/agent/agent-panel.ts',
    anchor: '  hide(): void {\n    this.rejectPendingConfirmation(false);\n',
    inject: '    (this as any).__cloudsshWasVisible = this.isVisible;\n',
  },
  {
    file: '/upstream/frontend/src/agent/agent-panel.ts',
    anchor: "      }, 320);\n    }\n    document.body.classList.remove('agent-panel-open');\n",
    inject: '    if ((this as any).__cloudsshWasVisible === false) return;\n',
  },
  {
    // 网页版拉取服务器列表失败时会把列表清空，断网一次后，客户端节点页/侧栏（显示的是另一份缓存）
    // 点节点就找不到服务器、什么也不发生。网络失败（fetch 抛 TypeError）时保留已有列表；
    // 服务端明确返回错误（未登录等）时仍按网页版原样清空
    file: '/upstream/frontend/src/server-list.ts',
    anchor: "      console.error('Failed to fetch servers:', e);\n",
    inject: '      if (e instanceof TypeError && this.servers.length) return;\n',
  },
  {
    // 语言按钮显示当前语言（网页版显示的是下一个语言）：网页版每次刷新按钮后交给
    // overrides/shared/language-picker.ts 改写文字，点击后弹出语言列表
    file: '/upstream/frontend/src/i18n/index.ts',
    anchor: '    if (label) label.textContent = targetName;\n',
    inject: '    (globalThis as any).__cloudsshLanguageLabel?.(button);\n',
  },
];

/**
 * 移动端额外钩子：页面运行在 tauri.localhost，网页版 validateWsUrl 只认页面同源，
 * 这里让它同时认可当前实例的 WebSocket 地址（判断函数由 overrides/mobile/early.ts 提供）。
 */
const MOBILE_HOOKS: Hook[] = [
  {
    file: '/upstream/frontend/src/main.ts',
    anchor: '      url.origin === window.location.origin ||\n',
    inject: '      (globalThis as any).__cloudsshIsInstanceWs?.(url) === true ||\n',
  },
  {
    // 黑曜主题的终端字号设置：有覆盖值时优先使用（经典主题不设置该全局，行为不变）
    file: '/upstream/frontend/src/terminal-layout.ts',
    anchor: 'export function resolveTerminalFontSize(viewportWidth: number, coarsePointer: boolean): number {\n',
    inject:
      "  const override = (globalThis as any).__cloudsshTerminalFontSize;\n  if (typeof override === 'number' && override >= 8 && override <= 24) return override;\n",
  },
  {
    // 半屏面板模式下打开命令面板不自动聚焦搜索框（手机上会立刻弹出键盘挡住面板）。注入一个条件让下一行的 focus 按需跳过
    file: '/upstream/frontend/src/snippet-manager.ts',
    anchor:
      "    window.addEventListener('keydown', this.keydownHandler);\n\n    const searchInput = document.getElementById('snippet-search-input') as HTMLInputElement | null;\n",
    inject: '    if ((globalThis as any).__cloudsshNoSnippetAutofocus !== true)\n',
  },
  {
    // 同理，半屏面板模式下打开 AI 助手不自动聚焦输入框，点输入框时才弹键盘
    file: '/upstream/frontend/src/agent/agent-panel.ts',
    anchor: "    document.body.classList.add('agent-panel-open');\n",
    inject: '    if ((globalThis as any).__cloudsshNoAgentAutofocus !== true)\n',
  },
];

function extensionHooks(target: Target): Plugin {
  const hooks = target === 'mobile' ? [...COMMON_HOOKS, ...MOBILE_HOOKS] : COMMON_HOOKS;
  return {
    name: 'cloudssh-extension-hooks',
    enforce: 'pre',
    transform(code, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      const matched = hooks.filter((item) => normalized.endsWith(item.file));
      if (!matched.length) return null;
      let source = code.replace(/\r\n/g, '\n');
      for (const hook of matched) {
        if (!source.includes(hook.anchor)) {
          this.warn(`扩展钩子锚点未找到（上游代码可能已变化）：${hook.file}`);
          continue;
        }
        source = source.replace(hook.anchor, hook.anchor + hook.inject);
      }
      return { code: source, map: null };
    },
  };
}

/** 构建产物附带 UI 清单，客户端据此展示内置 UI 的来源版本 */
function uiManifest(target: Target): Plugin {
  return {
    name: 'cloudssh-ui-manifest',
    apply: 'build',
    generateBundle() {
      const source = fs.existsSync(sourceInfoPath)
        ? JSON.parse(fs.readFileSync(sourceInfoPath, 'utf8'))
        : null;
      this.emitFile({
        type: 'asset',
        fileName: 'cloudssh-ui.json',
        source: JSON.stringify(
          {
            id: 'web',
            name: 'CloudSSH Web UI',
            target,
            entry: 'index.html',
            upstreamVersion: source?.version ?? null,
            upstreamCommit: source?.commit ?? null,
            // 桌面构建自己画标题栏（overrides/desktop/titlebar），客户端据此去掉系统边框
            ...(target === 'desktop' ? { desktopChrome: 1 } : {}),
            builtAt: new Date().toISOString(),
          },
          null,
          2
        ),
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const target: Target = mode === 'mobile' ? 'mobile' : 'desktop';
  const port = target === 'mobile' ? 5174 : 5173;
  return {
    root: upstreamFrontend,
    // 与上游 vite.config.ts 保持一致：xterm 6 预压缩 ESM 再做语法压缩会破坏 DECRQM 处理
    // https://github.com/xtermjs/xterm.js/issues/5800
    esbuild: {
      minifySyntax: false,
    },
    plugins: [extensionHooks(target), overrides(target), uiManifest(target)],
    server: {
      // 显式用 IPv4 回环：部分 Windows 环境 localhost 只解析/监听到 ::1
      host: '127.0.0.1',
      port,
      strictPort: true,
      fs: {
        // tools/reasoning-proxy：思考深度代理的代码内置在 AI 面板里供复制（agent-output/bar.ts）
        allow: [packageDir, path.resolve(packageDir, '..', '..', 'node_modules'), path.resolve(packageDir, '..', '..', 'tools')],
      },
      // 桌面端页面运行在 Worker origin 下（由 origin bridge 转发到本服务），
      // HMR WebSocket 必须显式指回本地开发服务器，否则会连到 Worker。
      hmr: {
        protocol: 'ws',
        host: '127.0.0.1',
        port,
        clientPort: port,
      },
    },
    build: {
      outDir: path.join(packageDir, target === 'mobile' ? 'dist-mobile' : 'dist'),
      emptyOutDir: true,
      modulePreload: {
        polyfill: false,
      },
      // 客户端本地读取文件，无需像 Worker 那样内联；保留多文件产物便于缓存与调试
      sourcemap: command === 'build' ? false : true,
    },
  };
});
