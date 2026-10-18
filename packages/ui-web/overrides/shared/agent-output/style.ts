/**
 * AI 回复风格提示：一段简短的英文提示（英文对各家模型都最稳定，也最省字数），发送时附加在用户消息后面。
 * 用户可以改写、关闭、恢复默认；只存在这台设备的本地存储里。
 */
import { notify } from '../../../upstream/frontend/src/ui-feedback';
import { at } from './i18n';

const STORAGE_KEY = 'cloudssh_agent_reply_style';
const MAX_PROMPT = 2000;

export const DEFAULT_STYLE_PROMPT = [
  'Reply formatting (a display preference, not part of the task; do not save it to memory):',
  "- Use the user's language. Open with a one-line conclusion.",
  '- Be concise: ### headings and bullets; no filler, no repeating raw output.',
  '- Use a table only for 3+ comparable items, with 2-4 columns.',
  '- Start each status with ✅ ok, ⚠️ warning or ❌ problem.',
  '- Put commands, paths and values in `code`; commands to run go in ```bash blocks.',
  '- End with next steps only when action is needed.',
].join('\n');

interface StyleSettings {
  enabled: boolean;
  /** null 表示用内置默认（以后默认提示改进时自动跟上） */
  prompt: string | null;
}

function load(): StyleSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<StyleSettings> | null;
    return {
      enabled: raw?.enabled !== false,
      prompt: typeof raw?.prompt === 'string' ? raw.prompt.slice(0, MAX_PROMPT) : null,
    };
  } catch {
    return { enabled: true, prompt: null };
  }
}

function save(settings: StyleSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 本地存储不可用时只是不记忆
  }
}

function activePrompt(): string {
  const settings = load();
  if (!settings.enabled) return '';
  return (settings.prompt ?? DEFAULT_STYLE_PROMPT).trim();
}

/** 发给 AI 的内容：原话 + 风格提示（关闭或为空时原样返回） */
export function styledMessage(message: string): string {
  const prompt = activePrompt();
  if (!prompt) return message;
  return `${message}\n\n<reply_style>\n${prompt}\n</reply_style>`;
}

// ---------- 编辑 ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let openRoot: HTMLElement | null = null;

export function closeStyleEditor(): void {
  openRoot?.remove();
  openRoot = null;
}

export function openStyleEditor(): void {
  closeStyleEditor();
  const settings = load();
  const root = el('div', 'cs-as-root');
  const dialog = el('div', 'cs-as-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', at('title'));
  dialog.tabIndex = -1;
  const head = el('div', 'cs-as-head');
  head.append(el('h2', 'cs-as-title', at('title')));
  const close = el('button', 'cs-as-close');
  close.type = 'button';
  close.setAttribute('aria-label', at('cancel'));
  const closeIcon = el('span', 'material-symbols-outlined', 'close');
  closeIcon.setAttribute('aria-hidden', 'true');
  close.append(closeIcon);
  close.addEventListener('click', closeStyleEditor);
  head.append(close);

  const body = el('div', 'cs-as-body');
  body.append(el('p', 'cs-as-intro', at('intro')));
  const toggle = el('label', 'cs-as-toggle');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = settings.enabled;
  toggle.append(box, el('span', '', at('enabled')));
  const label = el('label', 'cs-as-label', at('promptLabel'));
  const area = el('textarea', 'cs-as-prompt');
  area.id = 'cs-agent-style-prompt';
  label.htmlFor = area.id;
  area.rows = 11;
  area.spellcheck = false;
  area.maxLength = MAX_PROMPT;
  area.value = settings.prompt ?? DEFAULT_STYLE_PROMPT;
  const meta = el('div', 'cs-as-meta');
  const syncMeta = () => {
    meta.textContent = area.value.trim() ? at('cost', { n: area.value.trim().length }) : at('empty');
    area.disabled = !box.checked;
  };
  area.addEventListener('input', syncMeta);
  box.addEventListener('change', syncMeta);
  syncMeta();
  body.append(toggle, label, area, meta);

  const foot = el('div', 'cs-as-foot');
  const reset = el('button', 'cs-as-btn', at('reset'));
  reset.type = 'button';
  reset.addEventListener('click', () => {
    area.value = DEFAULT_STYLE_PROMPT;
    syncMeta();
  });
  const cancel = el('button', 'cs-as-btn', at('cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', closeStyleEditor);
  const ok = el('button', 'cs-as-btn is-primary', at('save'));
  ok.type = 'button';
  ok.addEventListener('click', () => {
    const text = area.value.trim();
    // 和默认一样就存 null：以后内置提示改进时自动跟上
    save({ enabled: box.checked, prompt: text === DEFAULT_STYLE_PROMPT ? null : text });
    closeStyleEditor();
    notify(at('saved'), { variant: 'success', duration: 2200 });
  });
  foot.append(reset, el('span', 'cs-as-spacer'), cancel, ok);

  dialog.append(head, body, foot);
  root.append(dialog);
  document.body.append(root);
  openRoot = root;
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) closeStyleEditor();
  });
  // Esc / 手机返回键
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    closeStyleEditor();
  });
  dialog.focus();
}
