/**
 * 在终端里重启了服务器（reboot、init 6、shutdown -r……）之后，等它回来自动连上（电脑与手机共用）。
 *
 * 原来：Worker 报“远程主机已关闭连接”后，网页版与客户端先花十几秒反复尝试恢复原会话（服务器那头的会话已经没了，
 * Worker 不保留，必定失败），满屏“连接错误 / 正在尝试恢复会话”，再按 2、4、8、16、30 秒完整重连 5 次，服务器回来得慢就放弃了；
 * Shell 先被结束、Worker 报“会话已结束”（关闭码 1000）时则根本不重连。
 * 现在（由 ../session-end.ts 判断：你一分钟内输入过重启命令、随后服务器那头结束了会话，且没开“重启时关闭标签”）：
 * - 写一行“服务器正在重启，等它回来后自动重新连接”，之后每隔几秒试一次新连接，最多等 5 分钟
 * - 每次没连上的那几行状态（正在重新连接、连接失败、连接已关闭……）收起成一行实时倒计时，不刷屏；按任意键立即再试
 * - 连上就是新的 Shell；5 分钟还没回来就停下，按任意键再等一轮
 * 关机（poweroff、halt、init 0、不带 -r 的 shutdown）不会自己回来：只说明一下，开机后按任意键再连（也是等它回来的这一套）。
 */
import type { IMarker, Terminal } from '@xterm/xterm';
import { t } from '../../../upstream/frontend/src/i18n';
import { connectionDiagnostic } from './connection-diagnostics';
import { ht } from './i18n';
import { startReconnectCountdown, type ReconnectCountdown } from './reconnect-countdown';
import { collapseSequence } from './resume-retry';

/** 最多等这么久 */
const WAIT_LIMIT_MS = 5 * 60_000;
/** 重启命令之后先等一会儿（sshd 停了、系统还没真正重启时连上去也会马上断） */
const FIRST_DELAY_MS = 5000;
/** 每次没连上之后隔多久再试（连不上主机的那一次本身就要等一会儿） */
const RETRY_DELAY_MS = 3000;

interface RebootWait {
  since: number;
  deadline: number;
  /** 上一次等待的倒计时那一行：下一次等待时把它和之后的状态行收起来 */
  line?: IMarker;
}

/** 网页版 SSHTerminal 里用到的成员（TypeScript 的 private，运行时照常可用） */
interface RebootTerminal {
  terminal: Terminal;
  canReconnect: boolean;
  activeSessionId: string | null;
  activeResumeToken: string | null;
  reconnectAttempts: number;
  reconnectTimeout: ReturnType<typeof setTimeout> | null;
  lastConfig: unknown;
  lastHostInfo?: { serverId?: number } | null;
  reconnectWebSocketFactory: (() => Promise<WebSocket>) | null;
  pendingHostKeyChangeSocket?: unknown;
  connect(config: unknown, options: { resetDisplay: boolean }): Promise<void>;
  connectWithWebSocket(socket: WebSocket, hostInfo: unknown, options: { resetDisplay: boolean; reconnectFactory: () => Promise<WebSocket> }): void;
  __cloudsshWasReady?: boolean;
  __cloudsshReconnectNow?: () => boolean;
  __cloudsshResumeCycle?: { line?: IMarker };
  __cloudsshRebootWait?: RebootWait;
}

const elapsedSeconds = (state: RebootWait) => Math.floor((Date.now() - state.since) / 1000);

function stop(term: RebootTerminal): void {
  term.__cloudsshRebootWait?.line?.dispose();
  term.__cloudsshRebootWait = undefined;
}

/** 新连接：与网页版完整重连同一条路（已保存的服务器重新申请一次性令牌，匿名连接用内存里这次的配置） */
function connectFresh(term: RebootTerminal, state: RebootWait): void {
  // 不占网页版完整重连的次数（满 5 次它就不再重连了）
  term.reconnectAttempts = 0;
  term.terminal.writeln(`\x1b[32m[+] ${t('terminal.reconnecting')}\x1b[0m`);
  // 连接还没建起来就失败了（申请令牌失败等）：没有关闭事件，自己排下一次
  const failed = () => {
    if (term.__cloudsshRebootWait !== state) return;
    term.terminal.writeln(`\x1b[31m[!] ${t('terminal.reconnectFailed')}\x1b[0m`);
    next(term, state);
  };
  if (term.lastConfig) {
    term.connect(term.lastConfig, { resetDisplay: false }).catch(failed);
    return;
  }
  const factory = term.reconnectWebSocketFactory;
  if (!factory) {
    stop(term);
    return;
  }
  factory().then((socket) => {
    // 等令牌期间关了标签或换了连接：丢掉迟到的这条
    if (term.reconnectWebSocketFactory !== factory || !term.canReconnect || term.__cloudsshRebootWait !== state) {
      socket.close(1000);
      return;
    }
    term.connectWithWebSocket(socket, term.lastHostInfo ?? undefined, { resetDisplay: false, reconnectFactory: factory });
  }, failed);
}

/** 等 delay 毫秒再试：一行实时倒计时（收起上一次的那几行状态），可按任意键提前 */
function wait(term: RebootTerminal, state: RebootWait, delay: number): void {
  const xterm = term.terminal;
  let countdown: ReconnectCountdown | undefined;
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    const run = () => {
      if (term.reconnectTimeout !== id) return;
      term.reconnectTimeout = null;
      if (term.__cloudsshRebootWait === state) connectFresh(term, state);
    };
    if (countdown) countdown.finish(run);
    else run();
  };
  const startedAt = Date.now();
  const id = setTimeout(fire, delay);
  term.reconnectTimeout = id;
  term.__cloudsshReconnectNow = () => {
    if (term.reconnectTimeout !== id) return false;
    clearTimeout(id);
    fire();
    return true;
  };
  const text = (seconds: string) => ht('rebootRetry', { seconds, elapsed: elapsedSeconds(state) });
  xterm.write('', () => {
    if (term.reconnectTimeout !== id) return;
    const collapse = collapseSequence(xterm, state.line);
    state.line?.dispose();
    state.line = undefined;
    xterm.write(`${collapse}\x1b[33m[*] ${text(String(Math.max(1, Math.round(delay / 1000))))}\x1b[0m\r\n`, () => {
      if (term.__cloudsshRebootWait === state) state.line = xterm.registerMarker(-1);
    });
    countdown = startReconnectCountdown(xterm, {
      ms: Math.max(0, delay - (Date.now() - startedAt)),
      format: text,
      isActive: () => term.reconnectTimeout === id,
    });
  });
}

/** 这次没连上：时间还够就等一会儿再试，否则停下、按任意键再等一轮 */
function next(term: RebootTerminal, state: RebootWait): void {
  if (Date.now() < state.deadline) {
    wait(term, state, RETRY_DELAY_MS);
    return;
  }
  connectionDiagnostic(term, 'reboot-wait-give-up', { elapsedMs: Date.now() - state.since });
  stop(term);
  term.terminal.writeln(`\x1b[33m[!] ${ht('rebootGaveUp')}\x1b[0m`);
  manualRestart(term);
}

/** 按任意键：再等一轮（先立即试一次） */
function manualRestart(term: RebootTerminal): void {
  term.terminal.writeln(`\x1b[2m${ht('reconnectManual')}\x1b[0m`);
  let used = false;
  term.__cloudsshReconnectNow = () => {
    if (used) return false;
    used = true;
    begin(term, 0, ht('rebootWaitingAgain'));
    return true;
  };
}

function begin(term: RebootTerminal, firstDelay: number, intro: string): void {
  // 服务器那头的会话已经没了：清掉恢复凭据与恢复的这一轮
  term.__cloudsshResumeCycle?.line?.dispose();
  term.__cloudsshResumeCycle = undefined;
  term.activeSessionId = null;
  term.activeResumeToken = null;
  stop(term);
  const now = Date.now();
  const state: RebootWait = { since: now, deadline: now + WAIT_LIMIT_MS };
  term.__cloudsshRebootWait = state;
  connectionDiagnostic(term, 'reboot-wait-start', { firstDelayMs: firstDelay });
  term.terminal.writeln(`\x1b[33m[*] ${intro}\x1b[0m`);
  // 从说明下面一行起算：第一次没连上的那几行状态也会在下一次等待时收起
  term.terminal.write('', () => {
    if (term.__cloudsshRebootWait === state && !state.line) state.line = term.terminal.registerMarker(0);
  });
  if (firstDelay > 0) wait(term, state, firstDelay);
  else connectFresh(term, state);
}

/** 你刚重启了服务器：等它回来自动重新连接 */
export function startRebootWait(terminal: unknown): void {
  begin(terminal as RebootTerminal, FIRST_DELAY_MS, ht('rebootWaiting'));
}

/** 你刚关了服务器：不会自己回来，说明一下，按任意键再连 */
export function noteServerPoweredOff(terminal: unknown): void {
  const term = terminal as RebootTerminal;
  term.__cloudsshResumeCycle?.line?.dispose();
  term.__cloudsshResumeCycle = undefined;
  term.activeSessionId = null;
  term.activeResumeToken = null;
  stop(term);
  connectionDiagnostic(term, 'server-powered-off');
  term.terminal.writeln(`\x1b[33m[*] ${ht('serverPoweredOff')}\x1b[0m`);
  manualRestart(term);
}

/**
 * 每次连接关闭时先调用（../session-end.ts）：正在等服务器回来、这次又没连上，就接着等，返回 true（网页版不再处理这次关闭）。
 * 连上过（Shell 就绪）之后再断开是新的一次断开；认证被拒、主机指纹变了等不能自动重连的情况交回网页版
 */
export function continueRebootWait(terminal: unknown): boolean {
  const term = terminal as RebootTerminal;
  const state = term.__cloudsshRebootWait;
  if (!state) return false;
  if (term.__cloudsshWasReady === true || !term.canReconnect || term.pendingHostKeyChangeSocket) {
    stop(term);
    return false;
  }
  next(term, state);
  return true;
}
