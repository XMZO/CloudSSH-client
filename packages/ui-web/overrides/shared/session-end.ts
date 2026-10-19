/**
 * 服务器端断开时自动关闭会话标签（电脑与手机共用，可开关，默认关）。
 *
 * 判断“不是本机网络的原因”：会话曾经连上（Shell 就绪过），且 Worker 主动关闭了 WebSocket——
 * 1000 是会话正常结束（exit、空闲超时……），1011 是 SSH 那头出错（远程主机断开、服务器重启、协议错误……）。
 * 本机网络断开时浏览器收到的是异常关闭（1006）或心跳超时，网页版照常自动重连，不受影响；
 * 从没连上（密码错误、主机指纹待确认……）的也不关，留着看报错。
 *
 * 构建钩子（vite.config.ts）在网页版处理连接关闭时调用 __cloudsshServerEnded(终端, 关闭事件)，
 * 返回 true 时网页版不再排定重连；标签在下一轮事件循环里关闭，并提示原因。
 */
import { getLocale } from '../../upstream/frontend/src/i18n';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { closeTabById } from '../sidebar/hooks';

const STORAGE_KEY = 'cloudssh_close_on_server_end';

const TEXT: Record<string, { title: string; hint: string; ended: string; broken: string; closed: string }> = {
  'zh-CN': {
    title: '服务器端断开时自动关闭标签',
    hint: 'exit、远程主机断开、服务器重启、空闲超时等服务器那边结束的会话，直接关闭它的标签；本机网络断开仍会自动重连，没连上过的也不关',
    ended: '会话已结束',
    broken: '服务器端断开了连接',
    closed: '「{name}」{reason}，已自动关闭标签',
  },
  'zh-TW': {
    title: '伺服器端中斷時自動關閉標籤',
    hint: 'exit、遠端主機中斷、伺服器重新開機、閒置逾時等伺服器那邊結束的會話，直接關閉它的標籤；本機網路中斷仍會自動重新連線，沒連上過的也不關',
    ended: '會話已結束',
    broken: '伺服器端中斷了連線',
    closed: '「{name}」{reason}，已自動關閉標籤',
  },
  'en-US': {
    title: 'Close the tab when the server ends the session',
    hint: 'Sessions ended on the server side (exit, remote host disconnect, reboot, idle timeout) close their tab right away; drops of this device\'s network still reconnect, and sessions that never connected stay open',
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

function onServerEnded(terminal: unknown, event: CloseEvent): boolean {
  if (!closeOnServerEnd() || (event.code !== 1000 && event.code !== 1011)) return false;
  if ((terminal as { __cloudsshWasReady?: unknown } | null)?.__cloudsshWasReady !== true) return false;
  const manager = (globalThis as { __cloudsshTabManager?: { tabs?: Map<string, TabLike> } }).__cloudsshTabManager;
  const tab = manager?.tabs ? [...manager.tabs.values()].find((item) => item.terminal === terminal) : undefined;
  if (!tab) return false;
  const { ended, broken, closed } = text();
  const message = closed.replace('{name}', tab.label ?? '').replace('{reason}', event.code === 1000 ? ended : broken);
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
