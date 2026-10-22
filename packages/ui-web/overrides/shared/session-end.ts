/**
 * 服务器那头结束了会话时自动关闭会话标签（电脑与手机共用），分两个开关，都默认关：
 * - 退出会话（exit）：exit、logout、Ctrl+D 等让这个会话的 Shell 结束了，服务器本身还在运行
 * - 服务器重启或关机（reboot）：reboot、init 6、shutdown、poweroff 等，以及 SSH 服务被停止、被踢下线这类服务器端断开连接
 *
 * 归哪一类（classifyEnd）：先看你最近回车执行过的命令——最后一条是 exit / logout 算退出；有重启、关机命令算重启或关机
 * （reboot 时 Shell 常常先被结束，Worker 报的也是“会话已结束”，只看原因会归错）；都没有再看 Worker 报的原因：
 * Shell 通道结束（session_ended）算退出，SSH 服务器关了连接（remote_closed）算重启或关机。
 *
 * 宁可不关、不能误关：拿不准的一律留着标签，交给网页版照常自动重连或提示按任意键重连。全部满足才关：
 * - 会话曾经连上（这条连接 Shell 就绪过），Worker 主动关闭了 WebSocket（1000 / 1011）
 * - Worker 关闭前报的原因（这条连接最后一个带 event 的 status / error 消息）是会话结束或远程主机断开（SERVER_END_EVENTS），
 *   且这一类的开关开着。只看关闭码不够：本机省电冻结没确认终端输出（output_backlog_closed）、太久没操作（session_idle_timeout）
 *   也是 1000；远程主机无响应（keepalive_timeout、idle_timeout）多半是网络问题，重连就好，也不关
 * - 你刚在这个标签里操作过（RECENT_INPUT_MS 内往会话里输入过）：exit、Ctrl+D、reboot 都是刚打的字。
 *   同样是会话结束 / 远程断开，也可能是太久没动静造成的——服务器自动登出（bash 的 TMOUT）、防火墙或 NAT 掐掉闲置的连接；
 *   手机切到后台、电脑睡眠时收到的关闭也要等回来才处理，那时早就过了这个时间
 * - 页面在前台：在后台收到的关闭不关
 * 本机网络断开时浏览器收到的是异常关闭（1006）或心跳超时，本来就不经过这里；从没连上（密码错误、主机指纹待确认……）的也不关。
 *
 * 构建钩子（vite.config.ts）：往会话里输入时调用 __cloudsshNoteInput(终端, 数据)，回车时这里记下那一行（命令）；
 * 网页版处理连接关闭时调用 __cloudsshServerEnded(终端, 关闭事件)，原因放在终端的 __cloudsshClosingEvent 上；
 * 返回 true 时网页版不再排定重连；标签在下一轮事件循环里关闭，并提示原因。
 *
 * 不关标签时（开关关着、页面在后台、刚才没操作过），你刚执行了重启命令的，交给 ./terminal/reboot-wait.ts 等服务器回来自动连上；
 * 关机命令只说明一下，按任意键再连；不是重启命令、但 SSH 服务器关了连接（remote_closed）的，也交给它等服务器回来。
 */
import type { IMarker, Terminal } from '@xterm/xterm';
import { getLocale } from '../../upstream/frontend/src/i18n';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { closeTabById } from '../sidebar/hooks';
import { commandFromLine, logicalLine } from './session-notify';
import { continueRebootWait, noteServerPoweredOff, startRebootWait, startServerDropWait } from './terminal/reboot-wait';

export type EndKind = 'exit' | 'reboot';
export const END_KINDS: readonly EndKind[] = ['exit', 'reboot'];

const STORAGE_KEYS: Record<EndKind, string> = {
  exit: 'cloudssh_close_on_exit',
  reboot: 'cloudssh_close_on_reboot',
};
/** 拆分前的单个开关：新开关没设过时沿用它（原来开着的，两个都开着） */
const LEGACY_KEY = 'cloudssh_close_on_server_end';

interface Words {
  exitTitle: string;
  exitShort: string;
  exitHint: string;
  rebootTitle: string;
  rebootShort: string;
  rebootHint: string;
  /** 两个开关共同的条件，接在各自说明后面 */
  common: string;
  ended: string;
  broken: string;
  rebooting: string;
  closed: string;
}

const TEXT: Record<string, Words> = {
  'zh-CN': {
    exitTitle: '退出会话时自动关闭标签',
    exitShort: '退出会话时',
    exitHint: '在终端里输入 exit、logout 或按 Ctrl+D 等结束会话（服务器仍在运行）后，直接关闭这个标签。',
    rebootTitle: '服务器重启或关机时自动关闭标签',
    rebootShort: '服务器重启或关机时',
    rebootHint: '输入 reboot、init 6、shutdown、poweroff 等重启或关闭服务器，以及 SSH 服务被停止、被踢下线等服务器端断开连接后，直接关闭这个标签。',
    common: '只在你 1 分钟内操作过、页面在前台时才关；闲置太久被断开、远程主机无响应、本机断网或待机时照常重连',
    ended: '会话已结束',
    broken: '服务器端断开了连接',
    rebooting: '服务器正在重启或关机',
    closed: '「{name}」{reason}，已自动关闭标签',
  },
  'zh-TW': {
    exitTitle: '退出會話時自動關閉標籤',
    exitShort: '退出會話時',
    exitHint: '在終端機輸入 exit、logout 或按 Ctrl+D 等結束會話（伺服器仍在執行）後，直接關閉這個標籤。',
    rebootTitle: '伺服器重新開機或關機時自動關閉標籤',
    rebootShort: '伺服器重新開機或關機時',
    rebootHint: '輸入 reboot、init 6、shutdown、poweroff 等重新開機或關閉伺服器，以及 SSH 服務被停止、被踢下線等伺服器端中斷連線後，直接關閉這個標籤。',
    common: '只在你 1 分鐘內操作過、頁面在前景時才關；閒置太久被中斷、遠端主機無回應、本機斷網或待機時照常重新連線',
    ended: '會話已結束',
    broken: '伺服器端中斷了連線',
    rebooting: '伺服器正在重新開機或關機',
    closed: '「{name}」{reason}，已自動關閉標籤',
  },
  'en-US': {
    exitTitle: 'Close the tab when you exit the session',
    exitShort: 'On exit',
    exitHint: 'After exit, logout, Ctrl+D or the like ends the session (the server keeps running), the tab closes right away. ',
    rebootTitle: 'Close the tab when the server reboots or shuts down',
    rebootShort: 'On reboot / shutdown',
    rebootHint: 'After reboot, init 6, shutdown, poweroff and the like, or when the server side drops the connection (SSH service stopped, kicked out), the tab closes right away. ',
    common: 'Only if you used the tab within the last minute and it is in the foreground; drops after long inactivity, an unresponsive remote host, or network loss / sleep on this device reconnect as usual',
    ended: 'session ended',
    broken: 'the server closed the connection',
    rebooting: 'the server is rebooting or shutting down',
    closed: '"{name}": {reason}, tab closed',
  },
};

function text(): Words {
  return TEXT[getLocale()] ?? TEXT['zh-CN'];
}

/** 设置里用的名称、短名（电脑端设置面板）与说明 */
export function serverEndText(kind: EndKind): { title: string; short: string; hint: string } {
  const words = text();
  return kind === 'exit'
    ? { title: words.exitTitle, short: words.exitShort, hint: words.exitHint + words.common }
    : { title: words.rebootTitle, short: words.rebootShort, hint: words.rebootHint + words.common };
}

export function closeOnEnd(kind: EndKind): boolean {
  try {
    return (localStorage.getItem(STORAGE_KEYS[kind]) ?? localStorage.getItem(LEGACY_KEY)) === '1';
  } catch {
    return false;
  }
}

export function setCloseOnEnd(kind: EndKind, on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS[kind], on ? '1' : '0');
  } catch {
    // 忽略
  }
}

// ---------- 归类 ----------

/** Worker（src/worker/ssh-session.ts）关闭前报的、服务器那头结束的原因：Shell 通道结束；SSH 服务器关了 TCP 连接 */
const SERVER_END_EVENTS: ReadonlySet<string> = new Set(['session_ended', 'remote_closed']);

/** 重启、关机的命令：可带 sudo / doas、完整路径，可以在 ; && || | 连起来的命令里 */
const REBOOT_COMMAND =
  /^(?:(?:sudo|doas)(?:\s+-\S+)*\s+)?(?:\S*\/)?(?:reboot|poweroff|halt|shutdown|(?:tel)?init\s+[06]|systemctl\s+(?:-\S+\s+)*(?:reboot|poweroff|halt|kexec|soft-reboot))(?:\s|$)/;
const EXIT_COMMAND = /^(?:exit|logout)(?:\s|$)/;

function segments(command: string): string[] {
  return command
    .split(/;|&&|\|\|?/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface EndClass {
  kind: EndKind;
  /** 提示里用的说法 */
  reason: 'ended' | 'broken' | 'rebooting';
}

/** 按 Worker 报的原因与最近回车执行过的命令（旧的在前）归类；不是服务器那头结束的返回 null */
export function classifyEnd(event: string, commands: readonly string[]): EndClass | null {
  if (!SERVER_END_EVENTS.has(event)) return null;
  const last = commands[commands.length - 1];
  if (last && segments(last).some((part) => EXIT_COMMAND.test(part))) return { kind: 'exit', reason: 'ended' };
  // 最后一条可能是 sudo 问的密码：往前找
  if (commands.some((command) => segments(command).some((part) => REBOOT_COMMAND.test(part)))) return { kind: 'reboot', reason: 'rebooting' };
  return event === 'remote_closed' ? { kind: 'reboot', reason: 'broken' } : { kind: 'exit', reason: 'ended' };
}

/** 关机而不是重启：poweroff、halt、init 0、systemctl poweroff / halt、不带 -r 的 shutdown（shutdown 默认关机） */
function powerOffCommand(part: string): boolean {
  if (!REBOOT_COMMAND.test(part)) return false;
  if (/(?:^|\s|\/)(?:poweroff|halt)(?:\s|$)|(?:^|\s)(?:tel)?init\s+0(?:\s|$)/.test(part)) return true;
  return /(?:^|\s|\/)shutdown(?:\s|$)/.test(part) && !/\s(?:-[a-zA-Z]*r[a-zA-Z]*|--reboot)(?:\s|$)/.test(part);
}

/** 最近执行的重启 / 关机命令里，最后一条是关机 */
export function poweredOff(commands: readonly string[]): boolean {
  for (let index = commands.length - 1; index >= 0; index--) {
    const parts = segments(commands[index]).filter((part) => REBOOT_COMMAND.test(part));
    if (parts.length) return powerOffCommand(parts[parts.length - 1]);
  }
  return false;
}

// ---------- 记下回车执行的命令 ----------

/** 关闭前这么久内往会话里输入过，才当成你自己结束的（直接打的 reboot 到 sshd 退出一般在这之内；自动登出、闲置断开都远长于它） */
const RECENT_INPUT_MS = 60_000;
/** 每个终端记最近几次回车（sudo reboot 之后还有一次输密码的回车） */
const MAX_ENTERS = 4;

interface EnterRecord {
  at: number;
  /** 回车那一行：关闭时再读一遍（回车那一刻服务器的回显可能还没到齐） */
  marker: IMarker | undefined;
  typed: string;
}

interface TerminalMarks {
  /** 网页版终端管理器里的 xterm */
  terminal?: unknown;
  __cloudsshWasReady?: unknown;
  __cloudsshClosingEvent?: unknown;
  /** 构建钩子：最后一次往会话里输入的时间 */
  __cloudsshLastInputAt?: unknown;
  __cloudsshEnters?: EnterRecord[];
}

function xtermOf(marks: TerminalMarks): Terminal | null {
  const term = marks.terminal as Terminal | undefined;
  return term && typeof term.registerMarker === 'function' ? term : null;
}

function noteInput(terminal: unknown, data: string | Uint8Array): void {
  // 开关都关着也记：重启后等服务器回来再连（./terminal/reboot-wait.ts）同样要知道你刚执行的是不是重启命令
  if (typeof data !== 'string' || !data.includes('\r')) return;
  const marks = terminal as TerminalMarks | null;
  const term = marks && xtermOf(marks);
  // vim、less 这类全屏程序里的回车不是 Shell 命令
  if (!marks || !term || term.buffer.active.type !== 'normal') return;
  const buffer = term.buffer.active;
  const enters = (marks.__cloudsshEnters ??= []);
  enters.push({ at: Date.now(), marker: term.registerMarker(0), typed: commandFromLine(logicalLine(term, buffer.baseY + buffer.cursorY)) });
  while (enters.length > MAX_ENTERS) enters.shift()?.marker?.dispose();
}

function recentCommands(marks: TerminalMarks, now: number): string[] {
  const term = xtermOf(marks);
  return (marks.__cloudsshEnters ?? [])
    .filter((enter) => now - enter.at <= RECENT_INPUT_MS)
    .map(({ marker, typed }) => (term && marker && !marker.isDisposed && marker.line >= 0 ? commandFromLine(logicalLine(term, marker.line)) : '') || typed);
}

// ---------- 关闭 ----------

interface TabLike {
  id: string;
  label?: string;
  terminal?: unknown;
}

function onServerEnded(terminal: unknown, event: CloseEvent): boolean {
  // 正在等重启的服务器回来、这次又没连上：接着等
  if (continueRebootWait(terminal)) return true;
  if (event.code !== 1000 && event.code !== 1011) return false;
  const marks = terminal as TerminalMarks | null;
  if (marks?.__cloudsshWasReady !== true || typeof marks.__cloudsshClosingEvent !== 'string') return false;
  const now = Date.now();
  const lastInput = marks.__cloudsshLastInputAt;
  // 你刚操作过才看执行过的命令、才会关标签；没操作过就只看 Worker 报的原因（服务器那头关了连接照样等它回来）
  const recent = typeof lastInput === 'number' && now - lastInput <= RECENT_INPUT_MS;
  const commands = recent ? recentCommands(marks, now) : [];
  const found = classifyEnd(marks.__cloudsshClosingEvent, commands);
  if (!found) return false;
  if (recent && closeOnEnd(found.kind) && document.visibilityState !== 'hidden') {
    const manager = (globalThis as { __cloudsshTabManager?: { tabs?: Map<string, TabLike> } }).__cloudsshTabManager;
    const tab = manager?.tabs ? [...manager.tabs.values()].find((item) => item.terminal === terminal) : undefined;
    if (tab) {
      const words = text();
      const message = words.closed.replace('{name}', tab.label ?? '').replace('{reason}', words[found.reason]);
      // 不在网页版处理关闭事件的过程中销毁终端
      setTimeout(() => {
        if (closeTabById(tab.id)) notify(message, { variant: 'info', duration: 3500 });
      }, 0);
      return true;
    }
  }
  // 标签留着、你刚执行了重启命令：不去恢复（会话已经没了），等服务器回来自动连上；关机的说明一下、按键再连
  if (found.reason === 'rebooting') {
    if (poweredOff(commands)) noteServerPoweredOff(terminal);
    else startRebootWait(terminal);
    return true;
  }
  // 服务器那头关了连接，但不是你打的重启命令（升级脚本问“是否立即重启”后自己重启、服务器宕机、sshd 重启）：
  // 会话同样已经没了，等它回来再连。原来交给网页版按 2、4、8、16、30 秒重连 5 次，服务器回来得慢就连不上了
  if (found.reason === 'broken') {
    startServerDropWait(terminal);
    return true;
  }
  return false;
}

let installed = false;

export function installSessionEnd(): void {
  if (installed) return;
  installed = true;
  const hooks = globalThis as { __cloudsshServerEnded?: typeof onServerEnded; __cloudsshNoteInput?: typeof noteInput };
  hooks.__cloudsshServerEnded = onServerEnded;
  hooks.__cloudsshNoteInput = noteInput;
}
