/**
 * AI 助手的“完全”权限模式（在网页版的“交互 / 自动”之外，不改 Worker）：任何确认都不再提示，直接执行。
 *
 * - AI 自己执行的危险命令、以及 AI 主动发起的确认（ask_user_confirmation）：Worker 发来 confirm_required 时，
 *   客户端立刻回 agent_confirm 同意（与网页版自动模式倒数结束后发的内容相同，只是不等 3 秒、不显示确认框，
 *   面板没显示时也同意）。
 * - 跨服务器操作（ai-remote）：危险命令与覆盖已有文件不再确认。
 * - 拦截级命令（rm -rf /、格式化磁盘等）仍然拒绝：Worker 对 AI 自己的命令一律拦截，跨服务器操作与之保持一致。
 *
 * 模式就存在网页版同一个设置里（cloudssh_agent_mode = full）。网页版加载时只认交互与自动，这里在面板渲染完后
 * （构建钩子 __cloudsshAgentPanelReady，在 index.ts 里分发）补上按钮、恢复完全模式；切到交互 / 自动由网页版自己处理。
 */
import { getLocale, onLocaleChange } from '../../../upstream/frontend/src/i18n';

export const FULL_MODE = 'full';
const STORAGE_KEY = 'cloudssh_agent_mode';

const TEXT: Record<string, { label: string; tip: string }> = {
  'zh-CN': {
    label: '完全',
    tip: '完全权限：危险命令、AI 发起的确认、跨服务器操作都直接执行，不再提示（rm -rf / 这类拦截级命令仍会拒绝）',
  },
  'zh-TW': {
    label: '完全',
    tip: '完全權限：危險指令、AI 發起的確認、跨伺服器操作都直接執行，不再提示（rm -rf / 這類攔截級指令仍會拒絕）',
  },
  'en-US': {
    label: 'Full',
    tip: 'Full access: risky commands, confirmations the AI asks for and cross-server actions all run without prompting (catastrophic commands such as rm -rf / are still blocked)',
  },
};

interface ModePanel {
  panelEl: HTMLElement | null;
  agentMode: string;
  setAgentMode(mode: string): void;
  updateModeUI?(): void;
  activeRequestId?: string | null;
  wsSend?: ((data: string) => void) | null;
}

export function isFullAccess(panel: unknown): boolean {
  return (panel as { agentMode?: unknown } | null)?.agentMode === FULL_MODE;
}

function text() {
  return TEXT[getLocale()] ?? TEXT['zh-CN'];
}

const buttons = new Set<HTMLButtonElement>();

function applyText(button: HTMLButtonElement): void {
  const { label, tip } = text();
  button.title = tip;
  button.setAttribute('aria-label', tip);
  const span = button.querySelector('.agent-mode-btn-text');
  if (span) span.textContent = label;
}

/** 面板渲染完：加“完全”按钮，恢复上次的完全模式 */
export function onPanelReady(panel: unknown): void {
  const p = panel as ModePanel;
  const control = p?.panelEl?.querySelector<HTMLElement>('#agent-mode-control');
  if (!control || typeof p.setAgentMode !== 'function' || control.querySelector('[data-mode="full"]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'agent-mode-btn';
  button.dataset.mode = FULL_MODE;
  button.setAttribute('role', 'radio');
  const glyph = document.createElement('span');
  glyph.className = 'material-symbols-outlined';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = 'admin_panel_settings';
  const label = document.createElement('span');
  label.className = 'agent-mode-btn-text';
  button.append(glyph, label);
  applyText(button);
  button.addEventListener('click', () => p.setAgentMode(FULL_MODE));
  control.append(button);
  buttons.add(button);

  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
  if (saved === FULL_MODE) p.agentMode = FULL_MODE;
  // 网页版按 agentMode 设置各按钮的选中状态（新加的按钮也在内）
  if (typeof p.updateModeUI === 'function') p.updateModeUI();
  else button.classList.toggle('is-active', p.agentMode === FULL_MODE);
}

/** 完全模式下 Worker 要求确认：直接同意，网页版不再显示确认框。返回 true 表示已处理 */
export function autoApprove(panel: unknown, frame: Record<string, unknown>): boolean {
  if (frame.subType !== 'confirm_required' || !isFullAccess(panel)) return false;
  const p = panel as ModePanel;
  if (frame.requestId && frame.requestId !== p.activeRequestId) return false;
  if (typeof p.wsSend !== 'function' || typeof frame.confirmationId !== 'string' || typeof frame.command !== 'string') return false;
  p.wsSend(JSON.stringify({ type: 'agent_confirm', confirmationId: frame.confirmationId, approved: true, command: frame.command }));
  return true;
}

let installed = false;

export function installFullAccess(): void {
  if (installed) return;
  installed = true;
  onLocaleChange(() => {
    for (const button of [...buttons]) {
      if (button.isConnected) applyText(button);
      else buttons.delete(button);
    }
  });
}
