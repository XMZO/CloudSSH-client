/**
 * 凭据预设管理（桌面端与手机端共用）：列表 → 新建/编辑 → 选服务器批量写入。
 * 改了预设的密码或私钥后，提示同步到用过它的服务器（Worker 给每台服务器各存一份凭据）。
 */
import type { ServerConfig } from '@cloudssh/core';
import { maskIPAddress } from '../../../upstream/frontend/src/host-display';
import { confirmAction, notify } from '../../../upstream/frontend/src/ui-feedback';
import { getServers } from '../../sidebar/store';
import { pt } from './i18n';
import {
  applyPreset,
  type AuthMethod,
  type CredentialPreset,
  deletePreset,
  linkedServers,
  listPresets,
  MAX_SECRET_LENGTH,
  presetsAvailable,
  savePreset,
} from './store';
import './presets.css';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string): HTMLSpanElement {
  const span = el('span', 'material-symbols-outlined cs-cp-icon', name);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function iconButton(name: string, label: string, className = 'cs-cp-iconbtn'): HTMLButtonElement {
  const button = el('button', className);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  return button;
}

function textButton(label: string, variant: '' | 'primary' | 'danger' = '', iconName?: string): HTMLButtonElement {
  const button = el('button', `cs-cp-btn${variant ? ` is-${variant}` : ''}`);
  button.type = 'button';
  if (iconName) button.append(icon(iconName));
  button.append(el('span', '', label));
  return button;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serverAddress(server: ServerConfig): string {
  const raw = server.transport_type === 'cf_tunnel' && server.cf_tunnel_host ? server.cf_tunnel_host : server.host;
  const host = maskIPAddress(raw) ?? raw;
  return `${server.username}@${host}${server.port && server.port !== 22 && server.transport_type !== 'cf_tunnel' ? `:${server.port}` : ''}`;
}

/** 当前实例里还存在的、用过这个预设的服务器 */
async function liveLinks(presetId: string): Promise<number[]> {
  const existing = new Set((getServers() ?? []).map((server) => server.id));
  return (await linkedServers(presetId)).filter((id) => existing.has(id));
}

/** 写入并提示结果；返回成功的数量 */
export async function applyWithFeedback(preset: CredentialPreset, ids: number[], onProgress?: (done: number) => void): Promise<number> {
  const result = await applyPreset(preset, ids, onProgress);
  if (result.ok.length) notify(pt('applied', { n: result.ok.length }), { title: preset.name, variant: 'success' });
  if (result.failed.length) {
    const names = new Map((getServers() ?? []).map((server) => [server.id, server.name]));
    const detail = result.failed
      .slice(0, 3)
      .map((item) => `${names.get(item.id) ?? `#${item.id}`}（${item.error}）`)
      .join('；');
    notify(pt('applyFailed', { n: result.failed.length, detail }), { title: preset.name, variant: 'danger' });
  }
  return result.ok.length;
}

let openRoot: HTMLElement | null = null;

export function closePresetManager(): void {
  openRoot?.remove();
  openRoot = null;
}

export function isPresetManagerOpen(): boolean {
  return openRoot !== null;
}

export async function openPresetManager(): Promise<void> {
  closePresetManager();
  const root = el('div', 'cs-cp-root');
  const dialog = el('div', 'cs-cp-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;
  const head = el('div', 'cs-cp-head');
  const back = iconButton('arrow_back', pt('back'));
  const title = el('h2', 'cs-cp-title', pt('title'));
  const close = iconButton('close', pt('close'));
  head.append(back, title, close);
  const body = el('div', 'cs-cp-body');
  const foot = el('div', 'cs-cp-foot');
  dialog.append(head, body, foot);
  root.append(dialog);
  document.body.append(root);
  openRoot = root;

  let goBack: (() => void) | null = null;
  close.addEventListener('click', closePresetManager);
  back.addEventListener('click', () => goBack?.());
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) closePresetManager();
  });
  // Esc：子页面先返回列表，列表页再关闭（手机返回键也是派发 Esc）
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (goBack) goBack();
    else closePresetManager();
  });

  const setView = (heading: string, onBack: (() => void) | null) => {
    title.textContent = heading;
    goBack = onBack;
    back.hidden = !onBack;
    body.replaceChildren();
    foot.replaceChildren();
    body.scrollTop = 0;
  };

  // ---------- 列表 ----------
  const showList = async () => {
    if (openRoot !== root) return;
    setView(pt('title'), null);
    if (!(await presetsAvailable())) {
      body.append(el('p', 'cs-cp-note is-warning', pt('unavailable')));
      return;
    }
    body.append(el('p', 'cs-cp-note', pt('intro')), el('p', 'cs-cp-note', pt('introSync')));
    const presets = await listPresets();
    if (!presets.length) body.append(el('div', 'cs-cp-empty', pt('empty')));
    const list = el('div', 'cs-cp-list');
    for (const preset of presets) {
      const links = await liveLinks(preset.id);
      const card = el('div', 'cs-cp-card');
      const main = el('div', 'cs-cp-card-main');
      main.append(icon(preset.method === 'publickey' ? 'vpn_key' : 'password'));
      const text = el('div', 'cs-cp-card-text');
      text.append(el('div', 'cs-cp-card-name', preset.name));
      const summary = [preset.username, preset.method === 'publickey' ? pt('summaryKey') : pt('summaryPassword')];
      if (links.length) summary.push(pt('summaryUsed', { n: links.length }));
      text.append(el('div', 'cs-cp-card-sub', summary.filter(Boolean).join(' · ')));
      main.append(text);
      const actions = el('div', 'cs-cp-card-actions');
      if (links.length) {
        const sync = textButton(pt('sync'), '', 'sync');
        sync.title = pt('syncHint', { n: links.length });
        sync.addEventListener('click', () => void syncPreset(preset, links));
        actions.append(sync);
      }
      const apply = iconButton('dns', pt('apply'));
      apply.addEventListener('click', () => void showApply(preset));
      const edit = iconButton('edit', pt('edit'));
      edit.addEventListener('click', () => showEdit(preset));
      const remove = iconButton('delete', pt('delete'), 'cs-cp-iconbtn is-danger');
      remove.addEventListener('click', async () => {
        const ok = await confirmAction({ message: pt('deleteConfirm', { name: preset.name }), confirmText: pt('delete'), cancelText: pt('cancel'), variant: 'danger' });
        if (!ok) return;
        await deletePreset(preset.id);
        void showList();
      });
      actions.append(apply, edit, remove);
      card.append(main, actions);
      list.append(card);
    }
    body.append(list);
    const add = textButton(pt('add'), 'primary', 'add');
    add.addEventListener('click', () => showEdit(null));
    foot.append(add);
  };

  const syncPreset = async (preset: CredentialPreset, ids: number[]) => {
    const ok = await confirmAction({
      title: pt('syncAsk', { n: ids.length }),
      message: pt('syncAskDetail'),
      confirmText: pt('sync'),
      cancelText: pt('cancel'),
      variant: 'warning',
    });
    if (!ok) return;
    await applyWithFeedback(preset, ids);
    void showList();
  };

  // ---------- 新建 / 编辑 ----------
  const showEdit = (preset: CredentialPreset | null) => {
    setView(preset ? preset.name : pt('add'), () => void showList());
    let method: AuthMethod = preset?.method ?? 'password';
    const form = el('div', 'cs-cp-form');
    const field = (label: string, input: HTMLElement, hint?: string) => {
      const wrap = el('label', 'cs-cp-field');
      wrap.append(el('span', 'cs-cp-label', label), input);
      if (hint) wrap.append(el('span', 'cs-cp-hint', hint));
      return wrap;
    };
    const name = el('input', 'cs-cp-input');
    name.value = preset?.name ?? '';
    name.placeholder = pt('namePlaceholder');
    name.maxLength = 60;
    const username = el('input', 'cs-cp-input');
    username.value = preset?.username ?? '';
    username.placeholder = 'root';
    username.autocapitalize = 'off';
    username.spellcheck = false;
    const tabs = el('div', 'cs-cp-segment');
    tabs.setAttribute('role', 'radiogroup');
    const password = el('input', 'cs-cp-input');
    password.type = 'password';
    password.autocomplete = 'new-password';
    const key = el('textarea', 'cs-cp-input cs-cp-key');
    key.rows = 6;
    key.spellcheck = false;
    key.placeholder = '-----BEGIN OPENSSH PRIVATE KEY-----';
    if (preset) password.placeholder = key.placeholder = pt('secretKeep');
    const file = el('input');
    file.type = 'file';
    file.hidden = true;
    const loadKey = textButton(pt('loadKeyFile'), '', 'upload_file');
    loadKey.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const picked = file.files?.[0];
      file.value = '';
      if (!picked) return;
      if (picked.size > MAX_SECRET_LENGTH) {
        notify(pt('keyFileTooLarge'), { variant: 'warning' });
        return;
      }
      key.value = (await picked.text()).trim();
    });
    const keyBox = el('div', 'cs-cp-keybox');
    keyBox.append(key, loadKey, file);
    const passwordField = field(pt('password'), password);
    const keyField = field(pt('privateKey'), keyBox);
    const syncMethod = () => {
      for (const button of tabs.querySelectorAll<HTMLElement>('button')) {
        const on = button.dataset.method === method;
        button.classList.toggle('is-on', on);
        button.setAttribute('aria-checked', String(on));
      }
      passwordField.hidden = method !== 'password';
      keyField.hidden = method !== 'publickey';
    };
    for (const [value, label] of [
      ['password', pt('password')],
      ['publickey', pt('privateKey')],
    ] as const) {
      const button = el('button', 'cs-cp-segment-btn', label);
      button.type = 'button';
      button.dataset.method = value;
      button.setAttribute('role', 'radio');
      button.addEventListener('click', () => {
        method = value;
        syncMethod();
      });
      tabs.append(button);
    }
    syncMethod();
    form.append(field(pt('name'), name), field(pt('username'), username, pt('usernameHint')), tabs, passwordField, keyField);
    body.append(form);

    const cancel = textButton(pt('cancel'));
    cancel.addEventListener('click', () => void showList());
    const save = textButton(pt('save'), 'primary', 'check');
    save.addEventListener('click', async () => {
      const secret = method === 'publickey' ? key.value.trim() : password.value;
      if (!name.value.trim()) {
        notify(pt('nameRequired'), { variant: 'warning' });
        name.focus();
        return;
      }
      // 换了认证方式时必须重新填凭据
      const needSecret = !preset || method !== preset.method;
      if (needSecret && !secret) {
        notify(pt('secretRequired'), { variant: 'warning' });
        (method === 'publickey' ? key : password).focus();
        return;
      }
      save.disabled = true;
      try {
        const saved = await savePreset({ id: preset?.id, name: name.value, username: username.value, method, secret: secret || undefined });
        notify(pt('saved'), { variant: 'success', duration: 2000 });
        const changed = !!preset && (!!secret || saved.username !== preset.username);
        const links = changed ? await liveLinks(saved.id) : [];
        if (links.length) await syncPreset(saved, links);
        else void showList();
      } catch (error) {
        notify(errorText(error), { variant: 'danger' });
        save.disabled = false;
      }
    });
    foot.append(cancel, save);
    name.focus();
  };

  // ---------- 选服务器批量写入 ----------
  const showApply = async (preset: CredentialPreset) => {
    setView(pt('apply'), () => void showList());
    const servers = getServers();
    if (!servers) {
      body.append(el('p', 'cs-cp-note is-warning', pt('notLoggedIn')));
      return;
    }
    if (!servers.length) {
      body.append(el('div', 'cs-cp-empty', pt('noServers')));
      return;
    }
    const linked = new Set(await linkedServers(preset.id));
    const chosen = new Set<number>(servers.filter((server) => linked.has(server.id)).map((server) => server.id));
    const head = el('div', 'cs-cp-apply-head');
    const search = el('input', 'cs-cp-input');
    search.type = 'search';
    search.placeholder = pt('search');
    const toggleAll = textButton(pt('selectAll'));
    head.append(search, toggleAll);
    const list = el('div', 'cs-cp-servers');
    body.append(el('div', 'cs-cp-apply-preset', `${preset.name}${preset.username ? ` · ${preset.username}` : ''}`), head, list);

    const count = el('span', 'cs-cp-count');
    const cancel = textButton(pt('cancel'));
    cancel.addEventListener('click', () => void showList());
    const run = textButton('', 'primary', 'done_all');
    foot.append(count, cancel, run);

    const visible = () => {
      const query = search.value.trim().toLowerCase();
      return servers.filter((server) =>
        !query || [server.name, server.host, server.username, ...(server.tags ?? [])].some((value) => value?.toLowerCase().includes(query))
      );
    };
    const sync = () => {
      count.textContent = pt('selected', { n: chosen.size });
      run.querySelector('span:last-child')!.textContent = pt('applyTo', { n: chosen.size });
      run.disabled = chosen.size === 0;
      const shown = visible();
      const allOn = shown.length > 0 && shown.every((server) => chosen.has(server.id));
      toggleAll.querySelector('span')!.textContent = allOn ? pt('selectNone') : pt('selectAll');
    };
    const render = () => {
      list.replaceChildren();
      for (const server of visible()) {
        const row = el('label', 'cs-cp-server');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = chosen.has(server.id);
        box.addEventListener('change', () => {
          if (box.checked) chosen.add(server.id);
          else chosen.delete(server.id);
          sync();
        });
        const text = el('span', 'cs-cp-server-text');
        text.append(el('span', 'cs-cp-server-name', server.name), el('span', 'cs-cp-server-sub', serverAddress(server)));
        row.append(box, text);
        if (linked.has(server.id)) row.append(el('span', 'cs-cp-tag', pt('used')));
        for (const tag of (server.tags ?? []).slice(0, 2)) row.append(el('span', 'cs-cp-tag is-muted', tag));
        list.append(row);
      }
      sync();
    };
    search.addEventListener('input', render);
    toggleAll.addEventListener('click', () => {
      const shown = visible();
      const allOn = shown.every((server) => chosen.has(server.id));
      for (const server of shown) {
        if (allOn) chosen.delete(server.id);
        else chosen.add(server.id);
      }
      render();
    });
    run.addEventListener('click', async () => {
      const ids = servers.filter((server) => chosen.has(server.id)).map((server) => server.id);
      if (!ids.length) return;
      const ok = await confirmAction({
        message: preset.username
          ? pt('applyConfirmUser', { name: preset.name, n: ids.length, user: preset.username })
          : pt('applyConfirm', { name: preset.name, n: ids.length }),
        confirmText: pt('applyTo', { n: ids.length }),
        cancelText: pt('cancel'),
        variant: 'warning',
      });
      if (!ok) return;
      run.disabled = cancel.disabled = true;
      const label = run.querySelector('span:last-child')!;
      try {
        await applyWithFeedback(preset, ids, (done) => {
          label.textContent = pt('applying', { done, total: ids.length });
        });
      } catch (error) {
        notify(errorText(error), { variant: 'danger' });
      }
      void showList();
    });
    render();
    search.focus();
  };

  await showList();
  dialog.focus();
}
