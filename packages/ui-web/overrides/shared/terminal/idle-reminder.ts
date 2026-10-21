/**
 * 快空闲断开时的提醒（电脑与手机共用）。Worker 在空闲超时前（默认 30 分钟里的最后 60 秒）发 session_idle_warning，
 * 网页版只在终端里写一行，看着 AI 面板、SFTP 或别的标签时看不到。这里弹一个不会自己消失的提醒（层级高于 AI 面板），
 * 带倒计时与“继续”按钮。
 *
 * 继续 = 发一次尺寸不变的 resize：Worker 把 resize 算作用户活动、重新开始空闲计时；服务器那头窗口大小没变，
 * 内核不会发 SIGWINCH，终端不重绘，也不会往终端里输入任何东西。
 * 这个会话里有了别的活动（键盘输入、调整大小、给 AI 发消息……都经同一个 WebSocket 发出）、会话断开、或者时间过了，
 * 提醒自己收起来；Worker 续期后会重新计时，下次快到点时再提醒。
 *
 * 构建钩子（vite.config.ts）在网页版收到带 event 的 status / error 消息时调用 __cloudsshServerEvent(终端, 事件名)。
 */
import { notify } from '../../../upstream/frontend/src/ui-feedback';
import { ht } from './i18n';

/** Worker 在超时前多久预警：min(60 秒, 空闲超时的 1/3)，默认 30 分钟时是 60 秒 */
const WARNING_LEAD_MS = 60_000;
/** 倒计时到 0 后再留一会儿：Worker 每 10 秒检查一次，断开的消息稍晚才到 */
const LINGER_MS = 15_000;

interface IdleTerminal {
  ws?: WebSocket | null;
  terminal?: { cols: number; rows: number };
}

interface TabLike {
  label?: string;
  terminal?: unknown;
}

/** 每个终端最多一个提醒：值是收起它的函数 */
const reminders = new Map<IdleTerminal, () => void>();

function tabName(term: IdleTerminal): string {
  const manager = (globalThis as { __cloudsshTabManager?: { tabs?: Map<string, TabLike> } }).__cloudsshTabManager;
  const tab = manager?.tabs ? [...manager.tabs.values()].find((item) => item.terminal === term) : undefined;
  return tab?.label || 'CloudSSH';
}

/** 网页版发出去的这条消息会不会让 Worker 重新开始计时：心跳与输出确认不算，其余（输入、调整大小、AI 消息……）都算 */
function countsAsActivity(data: unknown): boolean {
  if (typeof data !== 'string' || !data.startsWith('{')) return true;
  try {
    const type = (JSON.parse(data) as { type?: unknown }).type;
    return type !== 'ping' && type !== 'terminal_output_ack';
  } catch {
    return true;
  }
}

function showReminder(term: IdleTerminal): void {
  reminders.get(term)?.();
  const socket = term.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const deadline = Date.now() + WARNING_LEAD_MS;
  const name = tabName(term);
  const text = () => ht('idleBody', { name, seconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) });

  notify(text(), { title: ht('idleTitle'), variant: 'warning', duration: 0 });
  const toast = document.querySelector('.app-toast-container')?.lastElementChild as HTMLElement | null;
  if (!toast) return;
  toast.classList.add('cs-idle-toast');
  const body = toast.querySelector<HTMLElement>('.app-toast__message');
  const closeButton = toast.querySelector<HTMLElement>('.app-toast__close');
  const continueButton = document.createElement('button');
  continueButton.type = 'button';
  continueButton.className = 'cs-idle-continue';
  continueButton.textContent = ht('idleContinue');
  toast.querySelector('.app-toast__content')?.append(continueButton);

  // 盯住这个 WebSocket 发出去的消息：有活动就说明 Worker 已经重新开始计时
  const hadOwnSend = Object.prototype.hasOwnProperty.call(socket, 'send');
  const originalSend = socket.send;
  const watchedSend: WebSocket['send'] = function (this: WebSocket, data) {
    if (countsAsActivity(data)) queueMicrotask(() => close(true));
    return originalSend.call(this, data);
  };
  socket.send = watchedSend;

  let closed = false;
  const timer = window.setInterval(() => {
    if (term.ws !== socket || socket.readyState !== WebSocket.OPEN || Date.now() > deadline + LINGER_MS) return close(true);
    if (body) body.textContent = text();
  }, 1000);

  function close(dismiss: boolean): void {
    if (closed) return;
    closed = true;
    window.clearInterval(timer);
    if (socket && socket.send === watchedSend) {
      if (hadOwnSend) socket.send = originalSend;
      else delete (socket as { send?: unknown }).send;
    }
    if (reminders.get(term) === closeReminder) reminders.delete(term);
    // 网页版的关闭按钮带收起动画；自己点了关闭时它已经在收起了
    if (dismiss) closeButton?.click();
  }
  const closeReminder = () => close(true);
  reminders.set(term, closeReminder);

  closeButton?.addEventListener('click', () => close(false), { once: true });
  continueButton.addEventListener('click', () => {
    const size = term.terminal;
    if (socket.readyState !== WebSocket.OPEN || !size) return close(true);
    // 尺寸不变的 resize：只让 Worker 记一次活动（发出时上面的监听会收起提醒）
    socket.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
    notify(ht('idleRenewed'), { variant: 'success', duration: 2500 });
  });
}

function onServerEvent(term: unknown, event: unknown): void {
  if (event === 'session_idle_warning' && term && typeof term === 'object') showReminder(term as IdleTerminal);
}

let installed = false;

export function installIdleReminder(): void {
  if (installed) return;
  installed = true;
  (globalThis as { __cloudsshServerEvent?: typeof onServerEvent }).__cloudsshServerEvent = onServerEvent;
}
