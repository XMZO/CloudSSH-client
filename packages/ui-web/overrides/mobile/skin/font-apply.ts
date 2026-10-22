/**
 * 改终端字号只重排一次（双指缩放与 A− / A+ 共用）。
 *
 * 字号一变，终端就要重算行列并通知服务器，远端程序整屏重画。原来双指缩放过程中每停顿一下就应用一次，
 * A− / A+ 每点一下应用一次，一次调整里终端会重排、远端会重画好几遍。现在调整过程中只按比例缩放画面预览
 * （不重排、不通知服务器），松手或停手后才应用最终字号，只重排一次。
 */
import type { Terminal } from '@xterm/xterm';
import { activeTab } from '../../sidebar/hooks';
import { skinState, updateSkin } from './engine';

interface SessionLike {
  terminal?: Terminal;
  fit?: () => boolean;
}

function activeSession(): { inner: HTMLElement | null; session: SessionLike | null } {
  const tab = activeTab() as { id: string; terminal?: SessionLike } | null;
  return {
    inner: tab ? document.getElementById(`terminal-inner-${tab.id}`) : null,
    session: tab?.terminal ?? null,
  };
}

/** 预览：按目标字号与终端当前字号的比例缩放画面，左下角不动（光标所在的底部留在原处） */
export function previewFontSize(size: number): void {
  const { inner, session } = activeSession();
  const current = session?.terminal?.options.fontSize;
  if (!inner || !current) return;
  const scale = size / current;
  inner.style.transformOrigin = '0 100%';
  inner.style.transform = Math.abs(scale - 1) < 0.001 ? '' : `scale(${scale})`;
}

export function clearFontPreview(): void {
  for (const inner of document.querySelectorAll<HTMLElement>('#terminal-area [id^="terminal-inner-"]')) {
    inner.style.removeProperty('transform');
    inner.style.removeProperty('transform-origin');
  }
}

let timer = 0;

/** 保存字号（0 = 自动）并立即按它重排一次；预览在同一刻撤掉，中间不露出旧字号 */
export function commitFontSize(size: number): void {
  window.clearTimeout(timer);
  timer = 0;
  if (size !== skinState().fontSize) {
    updateSkin((draft) => {
      draft.fontSize = size;
    });
  }
  activeSession().session?.fit?.();
  clearFontPreview();
}

/** 连续调整（A− / A+）：先预览，停手一会儿再应用；应用后调用 onDone */
export function scheduleFontSize(size: number, onDone?: () => void, delay = 600): void {
  previewFontSize(size);
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    commitFontSize(size);
    onDone?.();
  }, delay);
}

export function cancelScheduledFontSize(): void {
  window.clearTimeout(timer);
  timer = 0;
}
