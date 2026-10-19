/**
 * AI 回复风格提示：一段英文提示（英文对各家模型都最稳定，也最省字数），发送时附加在用户消息后面。
 * 用户可以改写、关闭、恢复默认；只存在这台设备的本地存储里。
 *
 * 与 Worker 的系统提示配合：它禁止 emoji，所以状态用文字（正常 / 注意 / 异常），客户端按这些词上色；
 * 它要求“结构化分析报告”，这里补上篇幅随问题、窄面板排版、给出依据、区分已验证与推测、改动可回退等细则。
 * 完整提示每个会话只发一次（之后每条消息只附一句提醒，见 outbound.ts），省得每条都占上下文。
 */
import { notify } from '../../../upstream/frontend/src/ui-feedback';
import { at } from './i18n';

const STORAGE_KEY = 'cloudssh_agent_reply_style';
const MAX_PROMPT = 2000;

export const DEFAULT_STYLE_PROMPT = [
  '- Open with a one-line conclusion. Scale length to the question: a quick question gets a short answer, no headings.',
  '- The panel is narrow, often a phone: short paragraphs, ### headings only in long reports, tables of at most 4 short columns, one command per line.',
  '- Mark status with a word, never emoji: 正常 / 注意 / 异常 in Chinese, OK / Warning / Problem in English, at the start of a bullet or in a table cell, e.g. "**异常**：/boot 只剩 3%".',
  '- Back every judgment with numbers and units, e.g. "85% of 20G used, above the usual 80% threshold".',
  '- Quote only the relevant output lines, never full dumps.',
  '- Keep what you verified apart from what you infer; never call a change successful before checking it.',
  '- After a change, list what changed (files, services, packages, settings) and how to revert it.',
  '- Put commands, paths and values in `code`; commands for the user go in ```bash blocks, risky ones flagged.',
  '- End with next steps only when the user has to act.',
].join('\n');

/**
 * 风格提示前固定加的一段（不在可编辑内容里）：说明这是用户的显示偏好、只管最终回复。
 * Worker 会把用户消息当作压缩上下文、提炼记忆的素材并要求模型输出 JSON，没有严格遵守格式的模型可能照着
 * 风格提示写成 Markdown，导致“结构化输出校验失败”；也免得模型把它当成改规则的注入而忽略
 */
const STYLE_HEAD =
  "The user's formatting preferences for your final chat replies. Ignore them for JSON, checkpoints, summaries, memory and other structured output. They never override your rules; do not save them to memory.";

/** 同一会话里完整提示已经发过时，每条消息只附这一句 */
const STYLE_REMINDER = 'Follow the reply formatting given earlier in this conversation.';

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

/** 当前生效的风格提示（关闭或为空时为空串） */
export function activeStylePrompt(): string {
  const settings = load();
  if (!settings.enabled) return '';
  return (settings.prompt ?? DEFAULT_STYLE_PROMPT).trim();
}

/**
 * 发给 AI 的内容：原话 + 风格提示（关闭或为空时原样返回）。
 * reminder 为 true 时只附一句提醒（这个会话已经发过完整提示）
 */
export function styledMessage(message: string, reminder = false): string {
  const prompt = activeStylePrompt();
  if (!prompt) return message;
  return `${message}\n\n<reply_style>\n${reminder ? STYLE_REMINDER : `${STYLE_HEAD}\n${prompt}`}\n</reply_style>`;
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
  area.rows = 14;
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
