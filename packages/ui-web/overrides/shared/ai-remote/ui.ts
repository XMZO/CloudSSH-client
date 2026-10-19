/**
 * 跨服务器操作在 AI 面板里的卡片：一组操作一个容器，每个操作一张卡片（服务器、命令或传输路径、状态、输出）。
 * 需要确认时卡片里出现确认行，跟随 AI 面板当前的模式：交互模式等用户点；自动模式 3 秒后自动确认（期间可拒绝），
 * 与网页版处理危险命令的确认一致。
 */
import { rt } from './i18n';

export type CardState = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'rejected' | 'blocked' | 'cancelled';

const STATE_ICON: Record<CardState, string> = {
  queued: 'pending',
  running: 'progress_activity',
  waiting: 'warning',
  done: 'check_circle',
  failed: 'error',
  rejected: 'cancel',
  blocked: 'block',
  cancelled: 'cancel',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string, className = ''): HTMLSpanElement {
  const glyph = el('span', `material-symbols-outlined ${className}`.trim(), name);
  glyph.setAttribute('aria-hidden', 'true');
  return glyph;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export class ActionGroup {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;

  constructor(host: HTMLElement) {
    this.root = el('div', 'agent-message cs-ra-group');
    const head = el('div', 'cs-ra-group-head');
    head.append(icon('lan'), el('span', '', rt('title')));
    this.list = el('div', 'cs-ra-list');
    this.root.append(head, this.list);
    host.append(this.root);
  }

  add(kind: 'exec' | 'copy' | 'list', target: string, detail: string): ActionCard {
    const card = new ActionCard(kind, target, detail);
    this.list.append(card.root);
    return card;
  }
}

export class ActionCard {
  readonly root: HTMLElement;
  private readonly stateIcon: HTMLSpanElement;
  private readonly status: HTMLElement;
  private readonly extra: HTMLElement;

  constructor(kind: 'exec' | 'copy' | 'list', target: string, detail: string) {
    this.root = el('div', 'cs-ra-card');
    const head = el('div', 'cs-ra-head');
    head.append(icon(kind === 'exec' ? 'terminal' : kind === 'copy' ? 'swap_horiz' : 'dns', 'cs-ra-kind'), el('span', 'cs-ra-target', target));
    this.root.append(head);
    if (detail) this.root.append(el('div', 'cs-ra-detail', detail));
    const line = el('div', 'cs-ra-status');
    this.stateIcon = icon(STATE_ICON.queued, 'cs-ra-state');
    this.status = el('span', '', rt('queued'));
    line.append(this.stateIcon, this.status);
    this.extra = el('div', 'cs-ra-extra');
    this.root.append(line, this.extra);
    this.set('queued', rt('queued'));
  }

  set(state: CardState, text: string): void {
    this.root.dataset.state = state;
    this.stateIcon.textContent = STATE_ICON[state];
    this.status.textContent = text;
  }

  output(text: string, truncated: boolean): void {
    if (!text.trim()) return;
    const details = el('details', 'cs-ra-output');
    details.append(el('summary', '', truncated ? `${rt('output')} ${rt('truncated')}` : rt('output')), el('pre', '', text.replace(/\n+$/, '')));
    this.extra.append(details);
  }

  /**
   * 确认：auto 为 true 时 3 秒后自动确认。cancelled() 变为 true（用户停止或发了新消息）时按拒绝处理
   */
  confirm(reason: string, auto: boolean, cancelled: () => boolean): Promise<boolean> {
    this.set('waiting', rt('waiting'));
    const box = el('div', 'cs-ra-confirm');
    box.setAttribute('role', 'alertdialog');
    box.append(el('div', 'cs-ra-reason', reason));
    const bar = el('div', 'cs-ra-progress');
    if (auto) box.append(bar);
    const actions = el('div', 'cs-ra-actions');
    const reject = el('button', 'cs-ra-btn', rt('reject'));
    const approve = el('button', 'cs-ra-btn is-danger', auto ? rt('confirmAuto', { seconds: 3 }) : rt('confirm'));
    reject.type = approve.type = 'button';
    actions.append(reject, approve);
    box.append(actions);
    this.extra.append(box);
    box.scrollIntoView({ block: 'nearest' });
    return new Promise((resolve) => {
      let remaining = 3;
      const timers: Array<ReturnType<typeof setInterval>> = [];
      const finish = (approved: boolean) => {
        timers.forEach((timer) => clearInterval(timer));
        box.remove();
        resolve(approved);
      };
      reject.addEventListener('click', () => finish(false));
      approve.addEventListener('click', () => finish(true));
      timers.push(setInterval(() => cancelled() && finish(false), 300));
      if (auto) {
        requestAnimationFrame(() => bar.classList.add('is-running'));
        timers.push(
          setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) finish(true);
            else approve.textContent = rt('confirmAuto', { seconds: remaining });
          }, 1000)
        );
      }
    });
  }
}

/** 面板里一行说明（达到轮数上限等） */
export function noticeLine(host: HTMLElement, text: string): void {
  const line = el('div', 'agent-message cs-agent-recovered');
  line.append(icon('lan'), el('span', '', text));
  host.append(line);
}
