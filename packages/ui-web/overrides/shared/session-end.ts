/**
 * 服务器端断开时自动关闭会话标签（电脑与手机共用，可开关，默认关）。
 *
 * 宁可不关、不能误关：拿不准的一律留着标签，交给网页版照常自动重连或提示按任意键重连。全部满足才关：
 * - 会话曾经连上（这条连接 Shell 就绪过），Worker 主动关闭了 WebSocket（1000 / 1011）
 * - Worker 关闭前报的原因（这条连接最后一个带 event 的 status / error 消息）是会话结束或远程主机断开（SERVER_END_EVENTS）。
 *   只看关闭码不够：本机省电冻结没确认终端输出（output_backlog_closed）、太久没操作（session_idle_timeout）也是 1000；
 *   远程主机无响应（keepalive_timeout、idle_timeout）多半是网络问题，重连就好，也不关
 * - 你刚在这个标签里操作过（RECENT_INPUT_MS 内往会话里输入过）：exit、Ctrl+D、reboot 都是刚打的字。
 *   同样是会话结束 / 远程断开，也可能是太久没动静造成的——服务器自动登出（bash 的 TMOUT）、防火墙或 NAT 掐掉闲置的连接；
 *   手机切到后台、电脑睡眠时收到的关闭也要等回来才处理，那时早就过了这个时间
 * - 页面在前台：在后台收到的关闭不关
 * 本机网络断开时浏览器收到的是异常关闭（1006）或心跳超时，本来就不经过这里；从没连上（密码错误、主机指纹待确认……）的也不关。
 *
 * 构建钩子（vite.config.ts）在网页版处理连接关闭时调用 __cloudsshServerEnded(终端, 关闭事件)，原因放在终端的
 * __cloudsshClosingEvent 上；返回 true 时网页版不再排定重连；标签在下一轮事件循环里关闭，并提示原因。
 */
import { getLocale } from '../../upstream/frontend/src/i18n';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { closeTabById } from '../sidebar/hooks';

const STORAGE_KEY = 'cloudssh_close_on_server_end';

const TEXT: Record<string, { title: string; short: string; hint: string; ended: string; broken: string; closed: string }> = {
  'zh-CN': {
    title: '服务器端断开时自动关闭标签',
    short: '服务器端断开时自动关闭标签',
    hint: '你刚操作过（1 分钟内），随后会话结束或远程主机断开（exit 退出、重启服务器等）时，直接关闭它的标签；太久没操作被断开（自动登出、空闲超时）、远程主机无响应、本机断网 / 省电 / 待机，以及在后台时的断开都不关，照常自动重连或按任意键重连',
    ended: '会话已结束',
    broken: '服务器端断开了连接',
    closed: '「{name}」{reason}，已自动关闭标签',
  },
  'zh-TW': {
    title: '伺服器端中斷時自動關閉標籤',
    short: '伺服器端中斷時自動關閉標籤',
    hint: '你剛操作過（1 分鐘內），隨後會話結束或遠端主機中斷（exit 退出、重新開機伺服器等）時，直接關閉它的標籤；太久沒操作被中斷（自動登出、閒置逾時）、遠端主機無回應、本機斷網 / 省電 / 待機，以及在背景時的中斷都不關，照常自動重新連線或按任意鍵重新連線',
    ended: '會話已結束',
    broken: '伺服器端中斷了連線',
    closed: '「{name}」{reason}，已自動關閉標籤',
  },
  'en-US': {
    title: 'Close the tab when the server ends the session',
    short: 'Close tab when the server ends it',
    hint: 'If you used the tab within the last minute and the session then ends or the remote host disconnects (exit, rebooting the server…), the tab closes right away; drops after long inactivity (auto logout, idle timeout), an unresponsive remote host, network loss / power saving / sleep on this device, and drops while in the background keep the tab and reconnect automatically or on a key press',
    ended: 'session ended',
    broken: 'the server closed the connection',
    closed: '"{name}": {reason}, tab closed',
  },
};

function text() {
  return TEXT[getLocale()] ?? TEXT['zh-CN'];
}

/** short 是电脑端设置面板用的短名 */
export function serverEndText(): { title: string; short: string; hint: string } {
  const { title, short, hint } = text();
  return { title, short, hint };
}

export function closeOnServerEnd(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setCloseOnServerEnd(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // 忽略
  }
}

interface TabLike {
  id: string;
  label?: string;
  terminal?: unknown;
}

/**
 * Worker（src/worker/ssh-session.ts）关闭前报的、服务器那头结束的原因。值是提示里用的说法：ended 会话已结束，broken 服务器端断开了连接
 */
const SERVER_END_EVENTS: ReadonlyMap<string, 'ended' | 'broken'> = new Map([
  // Shell 通道结束：exit、Ctrl+D、被 kill、服务器关机时被挂断
  ['session_ended', 'ended'],
  // SSH 服务器关了 TCP 连接：重启、sshd 被停、被踢下线
  ['remote_closed', 'broken'],
]);

/** 关闭前这么久内往会话里输入过，才当成你自己结束的（直接打的 reboot 到 sshd 退出一般在这之内；自动登出、闲置断开都远长于它） */
const RECENT_INPUT_MS = 60_000;

interface TerminalMarks {
  __cloudsshWasReady?: unknown;
  __cloudsshClosingEvent?: unknown;
  /** 构建钩子：最后一次往会话里输入的时间 */
  __cloudsshLastInputAt?: unknown;
}

function onServerEnded(terminal: unknown, event: CloseEvent): boolean {
  if (!closeOnServerEnd() || (event.code !== 1000 && event.code !== 1011)) return false;
  const marks = terminal as TerminalMarks | null;
  if (marks?.__cloudsshWasReady !== true) return false;
  const reason = typeof marks.__cloudsshClosingEvent === 'string' ? SERVER_END_EVENTS.get(marks.__cloudsshClosingEvent) : undefined;
  if (!reason) return false;
  const lastInput = marks.__cloudsshLastInputAt;
  if (typeof lastInput !== 'number' || Date.now() - lastInput > RECENT_INPUT_MS) return false;
  if (document.visibilityState === 'hidden') return false;
  const manager = (globalThis as { __cloudsshTabManager?: { tabs?: Map<string, TabLike> } }).__cloudsshTabManager;
  const tab = manager?.tabs ? [...manager.tabs.values()].find((item) => item.terminal === terminal) : undefined;
  if (!tab) return false;
  const words = text();
  const message = words.closed.replace('{name}', tab.label ?? '').replace('{reason}', words[reason]);
  // 不在网页版处理关闭事件的过程中销毁终端
  setTimeout(() => {
    if (closeTabById(tab.id)) notify(message, { variant: 'info', duration: 3500 });
  }, 0);
  return true;
}

let installed = false;

export function installSessionEnd(): void {
  if (installed) return;
  installed = true;
  (globalThis as { __cloudsshServerEnded?: typeof onServerEnded }).__cloudsshServerEnded = onServerEnded;
}
