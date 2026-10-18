/**
 * 桌面端的后台提醒（判断逻辑见 shared/session-notify.ts）：用网页 Notification 发，Electron 转成系统通知
 * （Windows 的操作中心、macOS 通知中心）。点通知把窗口叫到前台并切到对应标签；窗口回到前台时收起已发的通知。
 */
import { installSessionNotifications, type SessionNotice } from '../shared/session-notify';
import { switchToTab } from '../sidebar/hooks';

const shown = new Set<Notification>();

function show(notice: SessionNotice): void {
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
  const post = () => {
    // 同一标签的新通知替换旧的（tag 相同），操作中心里不会堆一串
    const notification = new Notification(notice.title, { body: notice.body, tag: `cloudssh-${notice.tabId}` });
    shown.add(notification);
    notification.onclose = () => shown.delete(notification);
    notification.onclick = () => {
      void window.cloudsshDesktop?.focusWindow?.();
      window.focus();
      switchToTab(notice.tabId);
      notification.close();
    };
  };
  if (Notification.permission === 'granted') post();
  else void Notification.requestPermission().then((result) => result === 'granted' && post());
}

export function installDesktopNotifications(): void {
  installSessionNotifications({
    away: () => document.hidden || !document.hasFocus(),
    show,
  });
  window.addEventListener('focus', () => {
    for (const notification of shown) notification.close();
    shown.clear();
  });
}
