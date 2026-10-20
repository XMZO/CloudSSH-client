/**
 * 服务器端断开时自动关闭会话标签（电脑与手机共用，可开关，默认关）。
 *
 * 判断“确实是服务器那头结束的”，三条都要满足：会话曾经连上（这条连接 Shell 就绪过）；Worker 主动关闭了 WebSocket
 * （1000 / 1011）；Worker 关闭前报的原因（这条连接最后一个带 event 的 status / error 消息）在 SERVER_END_EVENTS 里。
 * 只看关闭码不够：本机省电冻结、切到后台没确认终端输出（output_backlog_closed）、待机太久没操作（session_idle_timeout），
 * Worker 同样以 1000 关闭；这些和没报原因的、认不出的原因一律不关，交给网页版照常重连或提示按任意键重连。
 * 本机网络断开时浏览器收到的是异常关闭（1006）或心跳超时，本来就不经过这里；从没连上（密码错误、主机指纹待确认……）的也不关。
 *
 * 构建钩子（vite.config.ts）在网页版处理连接关闭时调用 __cloudsshServerEnded(终端, 关闭事件)，原因放在终端的
 * __cloudsshClosingEvent 上；返回 true 时网页版不再排定重连；标签在下一轮事件循环里关闭，并提示原因。
 */
import { getLocale } from '../../upstream/frontend/src/i18n';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { closeTabById } from '../sidebar/hooks';

const STORAGE_KEY = 'cloudssh_close_on_server_end';

const TEXT: Record<string, { title: string; hint: string; ended: string; broken: string; closed: string }> = {
  'zh-CN': {
    title: '服务器端断开时自动关闭标签',
    hint: 'exit 退出、远程主机断开、服务器重启或无响应等确定是服务器那边结束的会话，直接关闭它的标签；本机断网、省电、待机造成的断线（包括长时间没操作的空闲超时）不关，照常自动重连或按任意键重连；没连上过的也不关',
    ended: '会话已结束',
    broken: '服务器端断开了连接',
    closed: '「{name}」{reason}，已自动关闭标签',
  },
  'zh-TW': {
    title: '伺服器端中斷時自動關閉標籤',
    hint: 'exit 退出、遠端主機中斷、伺服器重新開機或無回應等確定是伺服器那邊結束的會話，直接關閉它的標籤；本機斷網、省電、待機造成的中斷（包括長時間沒操作的閒置逾時）不關，照常自動重新連線或按任意鍵重新連線；沒連上過的也不關',
    ended: '會話已結束',
    broken: '伺服器端中斷了連線',
    closed: '「{name}」{reason}，已自動關閉標籤',
  },
  'en-US': {
    title: 'Close the tab when the server ends the session',
    hint: 'Sessions the server clearly ended (exit, remote host disconnect, reboot or no response) close their tab right away; drops caused by this device (network loss, power saving, sleep, including the idle timeout) keep the tab and reconnect automatically or on a key press, and sessions that never connected stay open',
    ended: 'session ended',
    broken: 'the server closed the connection',
    closed: '"{name}": {reason}, tab closed',
  },
};

function text() {
  return TEXT[getLocale()] ?? TEXT['zh-CN'];
}

export function serverEndText(): { title: string; hint: string } {
  const { title, hint } = text();
  return { title, hint };
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
 * Worker（src/worker/ssh-session.ts）关闭前报的、确定是服务器那头结束的原因——与本机网络、省电、待机无关。
 * 值是提示里用的说法：ended 会话已结束，broken 服务器端断开了连接
 */
const SERVER_END_EVENTS: ReadonlyMap<string, 'ended' | 'broken'> = new Map([
  // Shell 通道结束：exit、Ctrl+D、被 kill
  ['session_ended', 'ended'],
  // SSH 服务器关了 TCP 连接：重启、sshd 被停、被踢下线
  ['remote_closed', 'broken'],
  // SSH 服务器连续不回保活：宕机、断网（Worker 到服务器这一段，不经过本机）
  ['keepalive_timeout', 'broken'],
  // SSH 服务器长时间没有任何数据：同上（不是用户空闲超时，那个是 session_idle_timeout）
  ['idle_timeout', 'broken'],
]);

interface TerminalMarks {
  __cloudsshWasReady?: unknown;
  __cloudsshClosingEvent?: unknown;
}

function onServerEnded(terminal: unknown, event: CloseEvent): boolean {
  if (!closeOnServerEnd() || (event.code !== 1000 && event.code !== 1011)) return false;
  const marks = terminal as TerminalMarks | null;
  if (marks?.__cloudsshWasReady !== true) return false;
  const reason = typeof marks.__cloudsshClosingEvent === 'string' ? SERVER_END_EVENTS.get(marks.__cloudsshClosingEvent) : undefined;
  if (!reason) return false;
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
