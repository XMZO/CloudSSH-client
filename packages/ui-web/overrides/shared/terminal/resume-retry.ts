/**
 * 普通会话断线后，在服务器的 60 秒保持期内持续尝试秒级恢复（接上原来那个 Shell：目录、环境变量、nano / vim、
 * 正在跑的命令都还在），确定恢复不了才完整重连（新 Shell 从头开始）。
 *
 * 网页版只在第一次重连时立刻试一次恢复，那一刻网络还没回来（切换 Wi-Fi / 流量、地铁里断几秒）就直接完整重连，
 * 而服务器其实还替你留着原来的 Shell。构建钩子（vite.config.ts）在网页版排定重连时先问这里（分享会话不经过这里）：
 * - 第一次：与网页版一样立刻试；之后每次没接上，先请求一次 /api/health 看网络通不通
 * - 网络不通：按 1、2、3、5、8 秒、之后每 10 秒等着再试，带实时倒计时，可按任意键立即重试；
 *   系统报告网络恢复（online）或回到前台时也立即重试
 * - 健康检查通了恢复却失败：可能是会话过期、权限拒绝或 WebSocket 链路异常，不能据此断言会话已关闭。
 *   先马上再试一次，连续两次失败后回退新连接；具体握手状态由桌面端网络日志记录
 * - 保持期（与服务端 SESSION_GRACE_PERIOD_MS 对齐，留 2 秒余量）用完或原会话没了：说明原因，清掉恢复凭据，
 *   交回网页版的完整重连（从第 1 次开始算，不占用恢复期间的次数）
 * 恢复尝试不计入网页版完整重连的 5 次上限（否则重试几次后网页版就不再重连了）。恢复成功（session_resumed）时
 * 构建钩子清掉这一轮的状态；锚点失效时这项增强自动失效，行为与网页版一致。
 */
import type { IMarker, Terminal } from '@xterm/xterm';
import { t } from '../../../upstream/frontend/src/i18n';
import { ht } from './i18n';
import { startReconnectCountdown, type ReconnectCountdown } from './reconnect-countdown';
import { connectionDiagnostic } from './connection-diagnostics';

/** 服务端保持 60 秒（SESSION_GRACE_PERIOD_MS），留 2 秒余量，与分享会话的 SHARE_RESUME_RETRY_WINDOW_MS 相同 */
const RESUME_WINDOW_MS = 58_000;
/** 剩余不到这么久就不再试（来不及完成一次握手），与网页版分享会话的末次尝试余量相同 */
const FINAL_MARGIN_MS = 3_000;
/** 网络不通时每次等多久：1、2、3、5、8 秒，之后每 10 秒（网络恢复的系统事件、回到前台、按键都会提前） */
const RETRY_DELAYS_MS = [1000, 2000, 3000, 5000, 8000, 10_000];
/** 健康检查成功、恢复却连续失败这么多次后回退；不代表服务端确认会话已关闭。 */
const MAX_ONLINE_FAILURES = 2;
const PROBE_TIMEOUT_MS = 4000;

/** 一轮断线（从断开到恢复成功或放弃） */
interface ResumeCycle {
  deadline: number;
  attempts: number;
  onlineFailures: number;
  /** 上一次等待的倒计时那一行：下一次等待时把它和之后的“连接错误 / 连接已关闭”收起来，只留一行 */
  line?: IMarker;
}

/** 网页版 SSHTerminal 里用到的成员（TypeScript 的 private，运行时照常可用） */
interface SessionTerminal {
  terminal: Terminal;
  sessionReady: boolean;
  activeSessionId: string | null;
  activeResumeToken: string | null;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  reconnectTimeout: ReturnType<typeof setTimeout> | null;
  tryResumeSession(): Promise<boolean>;
  scheduleFallbackReconnect(): void;
  /** 构建钩子：刚关闭的那条连接是否就绪过（就绪过的断开是新一轮） */
  __cloudsshWasReady?: boolean;
  /** 构建钩子：Shell 未就绪时的键盘输入先调用它（立即执行排定的重连） */
  __cloudsshReconnectNow?: () => boolean;
  __cloudsshResumeCycle?: ResumeCycle;
}

/** 正在倒计时等下一次恢复的终端：网络恢复、回到前台时让它们立即重试 */
const waiting = new Set<SessionTerminal>();

/** 这一轮还在、终端没被断开（关标签时网页版会清掉恢复凭据）、也没有别的连接接上 */
function stillWaiting(term: SessionTerminal, cycle: ResumeCycle): boolean {
  return (
    term.__cloudsshResumeCycle === cycle &&
    !term.sessionReady &&
    !!term.activeSessionId &&
    !!term.activeResumeToken &&
    term.reconnectAttempts < term.maxReconnectAttempts
  );
}

/** 网络通不通：/api/health 返回 200 才算（客户端的本地代理连不上 Worker 时回 5xx，不能当成通了） */
async function networkReachable(term: SessionTerminal): Promise<boolean> {
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/health?_=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
    connectionDiagnostic(term, 'resume-probe', { reachable: response.ok, httpStatus: response.status, durationMs: Math.round(performance.now() - started) });
    return response.ok;
  } catch (error) {
    connectionDiagnostic(term, 'resume-probe', { reachable: false, durationMs: Math.round(performance.now() - started), errorName: error instanceof Error ? error.name : 'UnknownError' });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 试一次恢复；announce：写一行“正在重新连接…”（倒计时那一行到点时已经说明了，不再重复） */
function attempt(term: SessionTerminal, cycle: ResumeCycle, announce = true): void {
  connectionDiagnostic(term, 'resume-attempt', { attempt: cycle.attempts, onlineFailures: cycle.onlineFailures, remainingMs: Math.max(0, cycle.deadline - Date.now()) });
  if (announce) term.terminal.writeln(`\x1b[32m[+] ${t('terminal.reconnecting')}\x1b[0m`);
  void term.tryResumeSession().then((created) => {
    // 连 WebSocket 都没建起来（网页版已清掉凭据）：只能完整重连；建起来之后的失败由网页版的 onclose 再交回这里
    if (!created && term.__cloudsshResumeCycle === cycle) giveUp(term, ht('resumeGone'), 'resume-setup-failed');
  });
}

/**
 * 上一次等待以来写的都是状态行（倒计时、“[!] 连接错误”、“[*] 连接已关闭”……，可能还有单独一行的按键提示）、
 * 光标停在它们下面的行首、那一行还在可见区域里时，返回把它们清掉的控制序列；否则（有别的输出、已滚出屏幕）返回空串、不动。
 * 在 xterm 的写入回调里调用（读的是已解析的缓冲区）
 */
function collapseSequence(xterm: Terminal, line: IMarker | undefined): string {
  if (!line || line.isDisposed) return '';
  const buffer = xterm.buffer.active;
  if (buffer.type !== 'normal' || buffer.cursorX !== 0) return '';
  const cursor = buffer.baseY + buffer.cursorY;
  const up = cursor - line.line;
  if (up < 1 || up > buffer.cursorY) return '';
  const hint = ht('reconnectNow');
  for (let row = line.line; row < cursor; row++) {
    const current = buffer.getLine(row);
    const text = current?.translateToString(true) ?? '';
    if (!text || current?.isWrapped) continue;
    if (!/^\[[*!+]\] /.test(text) && text !== hint) return '';
  }
  return `\x1b[${up}A\r\x1b[J`;
}

/** 等 delay 毫秒再试：沿用网页版“正在尝试恢复会话（x 秒后第 n 次重试）”那一行，换成实时倒计时，可按任意键提前 */
function wait(term: SessionTerminal, cycle: ResumeCycle, delay: number): void {
  connectionDiagnostic(term, 'resume-wait', { attempt: cycle.attempts, delayMs: delay, remainingMs: Math.max(0, cycle.deadline - Date.now()) });
  const retry = cycle.attempts;
  const text = `\x1b[33m[*] ${t('terminal.resumingSession', { seconds: Math.max(1, Math.round(delay / 1000)), attempt: retry })}\x1b[0m`;
  const xterm = term.terminal;
  let countdown: ReconnectCountdown | undefined;
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    waiting.delete(term);
    // 倒计时定格写好之后才真正去试，之后的输出排在定格的那一行后面
    const run = () => {
      if (term.reconnectTimeout !== id) return;
      term.reconnectTimeout = null;
      if (stillWaiting(term, cycle)) attempt(term, cycle, false);
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
  waiting.add(term);
  // 等前面的输出解析完再看能不能收起上一次的那几行；按键已经提前开始了就不再写这一行
  xterm.write('', () => {
    if (term.reconnectTimeout !== id) return;
    const collapse = collapseSequence(xterm, cycle.line);
    cycle.line?.dispose();
    cycle.line = undefined;
    xterm.write(`${collapse}${text}\r\n`, () => {
      if (term.__cloudsshResumeCycle === cycle) cycle.line = xterm.registerMarker(-1);
    });
    countdown = startReconnectCountdown(xterm, {
      ms: Math.max(0, delay - (Date.now() - startedAt)),
      format: (seconds) => t('terminal.resumingSession', { seconds, attempt: retry }),
      isActive: () => term.reconnectTimeout === id,
    });
  });
}

/** 不再恢复：说明原因，清掉恢复凭据，交回网页版完整重连（从第 1 次算起） */
function giveUp(term: SessionTerminal, reason: string, cause: string): void {
  connectionDiagnostic(term, 'resume-give-up', { cause, attempt: term.__cloudsshResumeCycle?.attempts, onlineFailures: term.__cloudsshResumeCycle?.onlineFailures });
  term.__cloudsshResumeCycle?.line?.dispose();
  term.__cloudsshResumeCycle = undefined;
  waiting.delete(term);
  if (term.reconnectAttempts >= term.maxReconnectAttempts) return;
  term.terminal.writeln(`\x1b[33m[!] ${reason}\x1b[0m`);
  term.activeSessionId = null;
  term.activeResumeToken = null;
  term.reconnectAttempts = 1;
  term.scheduleFallbackReconnect();
}

/** 网页版排定重连时先调用；返回 true 表示这次由这里处理（网页版不再排定） */
function resumeRetry(term: SessionTerminal): boolean {
  if (!term.activeSessionId || !term.activeResumeToken) {
    term.__cloudsshResumeCycle = undefined;
    return false;
  }
  let cycle = term.__cloudsshResumeCycle;
  if (!cycle || term.__cloudsshWasReady === true) {
    cycle?.line?.dispose();
    cycle = { deadline: Date.now() + RESUME_WINDOW_MS, attempts: 0, onlineFailures: 0 };
    term.__cloudsshResumeCycle = cycle;
  }
  // 用过就清：这一轮后面每次没接上的连接都没就绪过
  term.__cloudsshWasReady = false;
  // 恢复尝试不占网页版完整重连的次数
  term.reconnectAttempts = 0;
  cycle.attempts++;
  if (cycle.attempts === 1) {
    attempt(term, cycle);
    return true;
  }
  const current = cycle;
  void networkReachable(term).then((online) => {
    if (!stillWaiting(term, current)) return;
    current.onlineFailures = online ? current.onlineFailures + 1 : 0;
    if (current.onlineFailures >= MAX_ONLINE_FAILURES) return giveUp(term, ht('resumeGone'), 'repeated-resume-failure-while-health-ok');
    const remaining = current.deadline - Date.now();
    if (remaining <= FINAL_MARGIN_MS) return giveUp(term, ht('resumeTimeout'), 'resume-window-exhausted');
    // 网络已经通了：马上再试一次；还没通：按递增间隔等（不超过保持期剩下的时间）
    if (online) return attempt(term, current);
    const step = RETRY_DELAYS_MS[Math.min(current.attempts - 2, RETRY_DELAYS_MS.length - 1)];
    wait(term, current, Math.min(step, remaining - FINAL_MARGIN_MS));
  });
  return true;
}

/** 网络恢复、回到前台：正在倒计时的立即重试 */
function retryWaitingNow(): void {
  for (const term of [...waiting]) term.__cloudsshReconnectNow?.();
}

let installed = false;

export function installResumeRetry(): void {
  if (installed) return;
  installed = true;
  (globalThis as { __cloudsshResumeRetry?: typeof resumeRetry }).__cloudsshResumeRetry = resumeRetry;
  window.addEventListener('online', retryWaitingNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retryWaitingNow();
  });
}
