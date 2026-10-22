import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { CONNECTION_DIAGNOSTIC_HOOKS } from './connection-diagnostic-hooks';

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
    // 启动首屏（overrides/shared/boot-core.ts）：要在网页版脚本之前装上
    { id: '/@cloudssh/desktop-early.ts', file: path.join(packageDir, 'overrides', 'desktop', 'early.ts'), injectTo: 'head-prepend' },
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
  ...CONNECTION_DIAGNOSTIC_HOOKS,
  // 心跳判断更稳（overrides/shared/terminal/heartbeat-guard.ts）：记下最后一次收到消息的时间；
  // pong 超时、网页版要判定卡死并以 1000 关闭（关闭帧送到 Worker 会直接销毁会话）之前先问它，最近 20 秒内收到过消息就先不判定
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: '    this.ws.onmessage = (event) => {\n      if (socket !== this.ws) return;\n',
    inject: '      (this as any).__cloudsshLastInboundAt = performance.now();\n',
  },
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: "      this.lastPingTime = null;\n      if (document.visibilityState === 'hidden') return;\n",
    inject: '      if ((globalThis as any).__cloudsshHeartbeatStall?.(this, socket) === true) return;\n',
  },
  // 打开着时跟上别处的改动（overrides/shared/live-sync.ts）：把网页版只在启动时做一次的两个同步交出来，内容变了时再调用。
  // 主题只取“云端有主题 → 更新并应用”那一段：云端没有主题时网页版会把本机的主题回填上去，别处刚删掉的会被加回来，这里不做；
  // 本机选的是内置主题时只更新主题库、不切换（与网页版启动时一致）
  {
    file: '/upstream/frontend/src/main.ts',
    anchor: '\ninit();\n',
    inject: [
      '(globalThis as any).__cloudsshCloudSync = {',
      '  async theme(): Promise<void> {',
      '    if (!(await customThemeStore.fetchFromCloud())) return;',
      '    const active = customThemeStore.getActiveTheme();',
      '    if (!active) return;',
      "    localStorage.setItem('cloudssh_imported_theme', JSON.stringify(active.data));",
      '    ensureCustomOption();',
      "    if (localStorage.getItem('cloudssh_theme_selection') !== CUSTOM_THEME_VALUE) return;",
      '    applyImportedTheme(active.data);',
      '    syncThemeSelectors(CUSTOM_THEME_VALUE);',
      '  },',
      '  mobileShortcuts: () => mobileShortcutsManager.syncFromCloud(),',
      '};',
      '',
    ].join('\n'),
  },
  // 启动首屏（overrides/shared/boot-core.ts）：网页版决定显示什么时告诉它——登录检查通过显示列表页（user，等列表到了
  // 再完成启动）、匿名连接页（auth）、分享链接落地页（share）、独立终端标签页（terminal）
  ...[
    { anchor: '  deactivateTerminalView();\n  isLoggedIn = true;\n', kind: 'user' },
    { anchor: 'function showAuthSection(): void {\n  deactivateTerminalView();\n', kind: 'auth' },
    { anchor: '  if (shareToken) {\n', kind: 'share' },
    { anchor: '  if (isTerminalTab()) {\n    initTerminalTab();\n', kind: 'terminal' },
  ].map(
    ({ anchor, kind }): Hook => ({
      file: '/upstream/frontend/src/main.ts',
      anchor,
      inject: `  (globalThis as any).__cloudsshBootDone?.('${kind}');\n`,
    })
  ),
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
  // 最后一次（第 5 次）自动重连：已保存的服务器申请到一次性令牌、建好新连接之后，网页版要确认这次重连没被取消，
  // 其中“次数已到上限”本意是认出等令牌期间标签被关了（disconnect() 会把次数设成上限），可最后一次重连时次数本来就等于上限，
  // 新连接被当成已取消直接关掉、什么也不写，标签就一直停在“正在重新连接…”，按键也没反应。标签关了、换了连接时
  // reconnectWebSocketFactory 已经变了（disconnect() 会清掉它），这里次数正好等于上限、别的都没变就照常连上
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor:
      '          const socket = await reconnectFactory();\n          // 用户可能在令牌请求期间主动关闭标签或发起另一条连接。\n          // 这时丢弃迟到的 socket，避免页面被已经取消的重连重新拉起。\n',
    inject: [
      '          if (',
      '            this.reconnectWebSocketFactory === reconnectFactory &&',
      '            this.canReconnect &&',
      '            this.reconnectAttempts === this.maxReconnectAttempts',
      '          ) {',
      '            this.connectWithWebSocket(socket, this.lastHostInfo ?? undefined, { resetDisplay: false, reconnectFactory });',
      '            return;',
      '          }',
      '',
    ].join('\n'),
  },
  // 最后一次自动重连也没连上：网页版就停在那里（没有提示，按键也没反应），只能关掉标签重开。交给
  // overrides/shared/terminal/reboot-wait.ts 接着每隔几秒试（最多 5 分钟，按任意键立即试）。两处：最后一次的连接被关闭
  // （连接关闭处理里的钩子）；最后一次申请连接令牌就失败了，没有关闭事件（这里）
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor:
      "          this.terminal.writeln(`\\x1b[31m[!] ${t('terminal.reconnectFailed')}\\x1b[0m`);\n          if (this.hasReconnectStrategy()) this.scheduleReconnect();\n",
    inject:
      '          else if (this.canReconnect && this.reconnectWebSocketFactory === reconnectFactory) (globalThis as any).__cloudsshReconnectsExhausted?.(this);\n',
  },
  // 普通会话断线后：网页版只在第一次重连时立刻试一次秒级恢复，没接上就完整重连（新 Shell）。改为先问
  // overrides/shared/terminal/resume-retry.ts：在服务器的 60 秒保持期内持续尝试恢复，确定恢复不了才交回这里完整重连。
  // 分享会话（resumeOnlyMode）照旧走网页版自己的恢复循环
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: '    if (this.resumeOnlyMode) {\n      this.scheduleShareResume();\n      return;\n    }\n',
    inject: '    if ((globalThis as any).__cloudsshResumeRetry?.(this) === true) return;\n',
  },
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: "  private processTerminalInput(\n    data: string,\n    source: 'keyboard' | 'focus-report' = 'keyboard'\n  ): void {\n",
    inject: "    if (!this.sessionReady && source === 'keyboard' && (this as any).__cloudsshReconnectNow?.() === true) return;\n",
  },
  // 断线后秒级恢复（session_resumed）接上的是断线前那个 Shell：它早把提示符打印过了、不会再打印，而网页版在后面写了
  // “连接已关闭 / 正在重新连接 / 已成功恢复会话”，光标停在新的空行上，要按一下键才出现提示符。恢复后让远端终端尺寸
  // 变一下（窄一列再改回去）：bash / zsh / fish 收到窗口变化信号（SIGWINCH）在当前行重画提示符和没打完的命令，vim、top
  // 这类全屏程序整屏重画（顺带盖掉写在它们画面上的断线提示）。两次改动要分开发——挨着到达时 bash 合成一次、尺寸没变
  // 就不重画；分开的时机由 overrides/shared/terminal/resume-redraw.ts 掌握（等补发的输出停下、等第一次重画）。
  // 它没装上时退回挨着发
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: '            this.onSessionReady?.();\n            this.startHeartbeat();\n',
    inject: [
      // 恢复成功：结束 overrides/shared/terminal/resume-retry.ts 的这一轮重试
      '            (this as any).__cloudsshResumeCycle?.line?.dispose?.();',
      '            (this as any).__cloudsshResumeCycle = undefined;',
      '            if ((globalThis as any).__cloudsshRedrawAfterResume?.(this) !== true) {',
      '              const size = this.getTerminalSize();',
      '              if (size.cols > 2) {',
      '                this.sendResize({ ...size, cols: size.cols - 1 });',
      '                this.sendResize(size);',
      '              }',
      '            }',
      '',
    ].join('\n'),
  },
  // 会话正常结束（exit、空闲超时断开、本机没确认输出……服务端以 1000 关闭）后网页版不重连，终端就停在那里。
  // 会话曾经就绪过的才提示“按任意键重新连接”，按键后立即重连（复用上面的输入入口）：
  // 已保存的服务器重新申请一次性令牌，匿名连接用内存里这次的配置，与网页版自动重连同一套路径。
  // 从没连上（认证失败、主机指纹变化待确认）、分享会话（只允许秒级恢复）不提示。
  // 关闭前是否就绪用实例属性传过去：任一锚点失效时条件不成立，行为与网页版一致。
  // 在这之前先问 overrides/shared/session-end.ts：Worker 关闭前报的原因是会话结束或远程主机断开、你刚在这个标签里操作过，
  // 且对应的开关（“退出会话时”或“服务器重启或关机时”自动关闭标签）开着时，它安排关闭标签并返回 true，这里直接结束，不再排定重连、不提示按键重连。
  // 原因靠下面记下的“这条连接最后一个带 event 的 status / error 消息”：关闭码本身分不清——本机省电冻结没确认输出、
  // 待机太久空闲超时，Worker 同样以 1000 关闭。没记到原因（锚点失效、Worker 没报）时一律不关。
  // 同一处把事件名交给 __cloudsshServerEvent：快空闲断开（session_idle_warning）时 overrides/shared/terminal/idle-reminder.ts 弹提醒
  // 用户最后一次往这个会话里输入的时间（键盘、粘贴、手机快捷键栏都经过 sendToServer；xterm 在获得 / 失去焦点时
  // 自动发的焦点报告不算）：session-end.ts 只在“刚操作过、随后会话结束”时才当成你自己结束的，长时间没操作被断开的不关标签。
  // 同时交给 session-end.ts 记下回车执行的命令（exit 还是 reboot，决定归“退出会话”还是“服务器重启或关机”）
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: '      sendToServer: (data: string | Uint8Array) => {\n        if (this.sessionReady && this.ws?.readyState === WebSocket.OPEN) {\n',
    inject: [
      "          if (data !== '\\x1b[I' && data !== '\\x1b[O') {",
      '            (this as any).__cloudsshLastInputAt = Date.now();',
      '            (globalThis as any).__cloudsshNoteInput?.(this, data);',
      '          }',
      '',
    ].join('\n'),
  },
  {
    file: '/upstream/frontend/src/terminal.ts',
    anchor: "          if (msg.type === 'agent_frame') {\n            this.onAgentFrameHandler?.(msg);\n            return;\n          }\n",
    inject:
      "          if ((msg.type === 'status' || msg.type === 'error') && typeof msg.event === 'string') { (this as any).__cloudsshLastEvent = msg.event; (globalThis as any).__cloudsshServerEvent?.(this, msg.event); }\n",
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
      // 自动重连的次数用完（本来还会重连，只是次数到了）：接着每隔几秒试，见上面“最后一次自动重连”那两项
      '      if (',
      '        !willReconnect &&',
      '        event.code !== 1000 &&',
      '        this.canReconnect &&',
      '        this.reconnectAttempts >= this.maxReconnectAttempts &&',
      '        !this.resumeOnlyMode &&',
      '        !this.pendingHostKeyChangeSocket &&',
      '        (this.lastConfig || this.reconnectWebSocketFactory) &&',
      '        (globalThis as any).__cloudsshReconnectsExhausted?.(this) === true',
      '      )',
      '        return;',
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
    // 电脑偏好设置“保持面板”（overrides/desktop/drawer-follow.ts）：网页版收起全部面板（新建连接、离开终端页）与切换标签之前
    // 先告诉它，这时面板的开合不算用户自己的操作；切换后它在 cloudssh:active-terminal-change 里为新会话重新打开
    file: '/upstream/frontend/src/main.ts',
    anchor: 'function closeAllDrawers(): void {\n',
    inject: '  (globalThis as any).__cloudsshDrawerProgrammatic?.();\n',
  },
  {
    file: '/upstream/frontend/src/tab-manager.ts',
    anchor: '  switchTab(tabId: string): void {\n    const tab = this.tabs.get(tabId);\n    if (!tab) return;\n    if (this.activeTabId === tabId) return;\n',
    inject: '    (globalThis as any).__cloudsshDrawerProgrammatic?.();\n',
  },
  {
    // 命令片段的手动顺序（overrides/shared/snippet-sort.ts，存在本地、不改 Worker）：网页版每次画列表前按它排好片段数组
    file: '/upstream/frontend/src/snippet-manager.ts',
    anchor: "    listEl.textContent = '';\n    listEl.removeAttribute('aria-busy');\n",
    inject:
      '    this.snippets = (globalThis as any).__cloudsshSortSnippets?.(this.snippets, this.deps.isAuthenticated()) ?? this.snippets;\n',
  },
  {
    // 同上：画好每张片段卡片时补上拖动排序的标记（手机上还有拖动手柄）
    file: '/upstream/frontend/src/snippet-manager.ts',
    anchor: "    codeBlock.style.whiteSpace = 'pre-wrap';\n",
    inject: '    (globalThis as any).__cloudsshSnippetCard?.(card, codeBlock, actions);\n',
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
    // 手机上的提示条由 overrides/mobile/toasts.ts 接管计时（显示时长、进度条、滑动关闭）：把调用方要的显示时长记在提示条上
    file: '/upstream/frontend/src/ui-feedback.ts',
    anchor: "  const toast = document.createElement('div');\n  toast.className = 'app-toast';\n",
    inject: '  toast.dataset.duration = String(duration);\n',
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
