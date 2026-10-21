/**
 * 网页版“添加 / 编辑服务器”对话框里的凭据预设：认证方式上面加一行
 *   [凭据预设 ▾]  [存为预设]  [管理]
 * 选一个预设就把用户名（预设里有的话）、认证方式、密码或私钥填进表单，保存照常走网页版。
 * 填入后原样保存成功时，记下这台服务器用的是这个预设（之后改预设可以一键同步）。
 */
import { notify, requestText } from '../../../upstream/frontend/src/ui-feedback';
import { pt } from './i18n';
import { openPresetManager } from './manager';
import { type CredentialPreset, getPreset, linkServers, listPresets, PRESETS_CHANGED_EVENT, presetsAvailable, revealSecret, savePreset } from './store';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function input(id: string): HTMLInputElement | HTMLTextAreaElement | null {
  return document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
}

function setValue(field: HTMLInputElement | HTMLTextAreaElement | null, value: string): void {
  if (!field) return;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function keyMode(): boolean {
  return !!document.getElementById('modal-auth-tab-key')?.classList.contains('auth-tab-active');
}

/** 网页版 v2.7 起的“无认证（none）”：不用凭据 */
function noneMode(): boolean {
  return !!document.getElementById('modal-auth-tab-none')?.classList.contains('auth-tab-active');
}

/** 本次打开对话框时填入的预设（用于保存成功后记下关联） */
let filled: { preset: CredentialPreset; secret: string } | null = null;

function observeSaves(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (request: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(request, init);
    const current = filled;
    if (!current || !response.ok) return response;
    try {
      const method = (init?.method ?? (request instanceof Request ? request.method : 'GET')).toUpperCase();
      const url = new URL(request instanceof Request ? request.url : String(request), location.href);
      const match = /^\/api\/servers(?:\/(\d+))?$/.exec(url.pathname);
      if (!match || (method !== 'POST' && method !== 'PUT') || typeof init?.body !== 'string') return response;
      const body = JSON.parse(init.body) as { credential?: unknown };
      if (body.credential !== current.secret) return response;
      const id = match[1] ? Number(match[1]) : Number(((await response.clone().json()) as { id?: unknown }).id);
      if (Number.isInteger(id) && id > 0) void linkServers(current.preset.id, [id]);
    } catch {
      // 记不下关联不影响保存
    }
    return response;
  };
}

export function installPresetPicker(): void {
  const modal = document.getElementById('server-modal');
  const anchor = document.getElementById('modal-auth-tab-password')?.parentElement?.parentElement;
  if (!modal || !anchor) return;

  const row = el('div', 'cs-cp-pick');
  const label = el('label', 'block text-xs font-bold tracking-[0.1em] text-muted mb-2', pt('field'));
  const line = el('div', 'cs-cp-pick-line');
  const select = el('select', 'terminal-input cs-cp-select');
  select.id = 'cs-credential-preset';
  label.htmlFor = select.id;
  // 窄屏（手机）只显示图标，给下拉框留出宽度
  const saveAs = el('button', 'cs-cp-pick-btn is-save');
  saveAs.type = 'button';
  saveAs.title = pt('saveAsTitle');
  saveAs.setAttribute('aria-label', pt('saveAs'));
  const saveIcon = el('span', 'material-symbols-outlined', 'bookmark_add');
  saveIcon.setAttribute('aria-hidden', 'true');
  saveAs.append(saveIcon, el('span', 'cs-cp-pick-text', pt('saveAs')));
  const manage = el('button', 'cs-cp-pick-btn is-icon');
  manage.type = 'button';
  manage.title = pt('manage');
  manage.setAttribute('aria-label', pt('manage'));
  const manageIcon = el('span', 'material-symbols-outlined', 'tune');
  manageIcon.setAttribute('aria-hidden', 'true');
  manage.append(manageIcon);
  line.append(select, saveAs, manage);
  const note = el('div', 'cs-cp-pick-note');
  note.hidden = true;
  row.append(label, line, note);
  anchor.prepend(row);

  let available = false;
  const refresh = async (keep = select.value) => {
    available = await presetsAvailable();
    row.hidden = !available;
    if (!available) return;
    const presets = await listPresets();
    select.replaceChildren(new Option(pt('none'), ''));
    for (const preset of presets) {
      const text = preset.username ? `${preset.name}（${preset.username}）` : preset.name;
      select.append(new Option(text, preset.id));
    }
    select.value = presets.some((preset) => preset.id === keep) ? keep : '';
  };

  const clearFilled = () => {
    if (filled) {
      // 取消选择时把刚才填进去的凭据也清掉（没被改过的话）
      for (const id of ['server-password', 'server-private-key']) {
        const field = input(id);
        if (field && field.value === filled.secret) setValue(field, '');
      }
    }
    filled = null;
    note.hidden = true;
  };

  select.addEventListener('change', async () => {
    const id = select.value;
    if (!id) {
      clearFilled();
      return;
    }
    const preset = await getPreset(id);
    if (!preset) return;
    try {
      const secret = await revealSecret(preset);
      if (preset.username) setValue(input('server-username'), preset.username);
      document.getElementById(preset.method === 'publickey' ? 'modal-auth-tab-key' : 'modal-auth-tab-password')?.click();
      setValue(input(preset.method === 'publickey' ? 'server-private-key' : 'server-password'), secret);
      filled = { preset, secret };
      note.textContent = pt('filled', { name: preset.name });
      note.hidden = false;
    } catch (error) {
      select.value = '';
      notify(pt('fillFailed', { reason: error instanceof Error ? error.message : String(error) }), { variant: 'danger' });
    }
  });

  saveAs.addEventListener('click', async () => {
    // 不然会读到隐藏着的密码框，把切换前填的密码存成预设
    if (noneMode()) {
      notify(pt('noneNoSecret'), { variant: 'info' });
      return;
    }
    const method = keyMode() ? 'publickey' : 'password';
    const field = input(method === 'publickey' ? 'server-private-key' : 'server-password');
    const secret = method === 'publickey' ? (field?.value.trim() ?? '') : (field?.value ?? '');
    if (!secret) {
      notify(pt('secretRequired'), { variant: 'warning' });
      field?.focus();
      return;
    }
    const username = input('server-username')?.value.trim() ?? '';
    const name = await requestText({
      title: pt('saveAs'),
      message: pt('saveAsPrompt'),
      label: pt('saveAsName'),
      placeholder: pt('namePlaceholder'),
      defaultValue: username ? `${username} · ${method === 'publickey' ? pt('privateKey') : pt('password')}` : '',
      confirmText: pt('save'),
      cancelText: pt('cancel'),
    });
    if (!name?.trim()) return;
    try {
      const preset = await savePreset({ name, username, method, secret });
      await refresh(preset.id);
      filled = { preset, secret };
      note.textContent = pt('filled', { name: preset.name });
      note.hidden = false;
      notify(pt('saved'), { variant: 'success', duration: 2000 });
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), { variant: 'danger' });
    }
  });

  manage.addEventListener('click', () => void openPresetManager());

  // 每次打开对话框：重新列出预设，清掉上次的选择（网页版打开时会清空密码和私钥）
  let wasOpen = false;
  new MutationObserver(() => {
    const open = !modal.classList.contains('hidden');
    if (open && !wasOpen) {
      filled = null;
      note.hidden = true;
      void refresh('');
    }
    wasOpen = open;
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener(PRESETS_CHANGED_EVENT, () => {
    if (!modal.classList.contains('hidden')) void refresh();
  });
  observeSaves();
  void refresh('');
}
