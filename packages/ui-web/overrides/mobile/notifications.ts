/**
 * 手机端的后台提醒（判断逻辑见 shared/session-notify.ts）：应用切到后台时，长命令结束、终端响铃、
 * 会话断线与重连发系统通知（原生插件 EventNotifications.kt）。点通知回到应用，原生层派发
 * cloudssh:notification-open，这里切到对应的会话标签。
 */
import { installSessionNotifications } from '../shared/session-notify';
import { switchToTab } from '../sidebar/hooks';
import { native } from './tauri';

export function installMobileNotifications(): void {
  installSessionNotifications({
    away: () => document.visibilityState === 'hidden',
    show: (notice) => {
      native.notify(notice.title, notice.body, notice.tabId).catch((error: unknown) => console.warn('[cloudssh] notify', error));
    },
  });
  window.addEventListener('cloudssh:notification-open', (event) => {
    const tabId = (event as CustomEvent<unknown>).detail;
    if (typeof tabId === 'string') switchToTab(tabId);
  });
}
