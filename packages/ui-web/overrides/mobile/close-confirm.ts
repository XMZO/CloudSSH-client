/**
 * 关闭会话前要不要确认（“设置 → 关闭会话前确认”）：
 * - connected（默认）：只有真正连着的会话才确认；已断开、正在连接、重连中的直接关闭
 * - always：总是确认
 * - never：从不确认
 * 关闭标签、会话列表里的 ×、黑曜“更多”里的“断开”都按这里判断。
 */
import { sessionIsConnected, type TabInfo } from '../sidebar/hooks';

export type CloseConfirmMode = 'connected' | 'always' | 'never';
export const CLOSE_CONFIRM_MODES: readonly CloseConfirmMode[] = ['connected', 'always', 'never'];

const STORAGE_KEY = 'cloudssh_mobile_close_confirm';

export function closeConfirmMode(): CloseConfirmMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return CLOSE_CONFIRM_MODES.includes(value as CloseConfirmMode) ? (value as CloseConfirmMode) : 'connected';
  } catch {
    return 'connected';
  }
}

export function setCloseConfirmMode(mode: CloseConfirmMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 不记忆
  }
}

export function shouldConfirmClose(tab: TabInfo | null | undefined): boolean {
  if (!tab) return false;
  const mode = closeConfirmMode();
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return sessionIsConnected(tab);
}
