/**
 * 移动端设置面板：实例管理（切换/新增/编辑/删除/清除登录/测试连接）、网络代理、后台保活、关于。
 * 实例与代理保存在 Rust 侧（settings.json），切换实例后整页重新加载。
 */
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { tabCount } from '../sidebar/hooks';
import { mt } from './i18n';
import { closeSheet, confirmSheet, el, icon, openSheet } from './sheet';
import { native, type MobileInstance, type MobileState } from './tauri';

export const KEEPALIVE_KEY = 'cloudssh_mobile_keepalive';

export function keepAliveEnabled(): boolean {
  try {
    return localStorage.getItem(KEEPALIVE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function field(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  const wrap = el('label', 'cs-m-field');
  wrap.append(el('span', 'cs-m-field-label', label), input);
  if (hint) wrap.append(el('span', 'cs-m-hint', hint));
  return wrap;
}

function textInput(value: string, placeholder: string, type = 'text'): HTMLInputElement {
  const input = el('input', 'cs-m-input');
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  return input;
}

function button(label: string, variant: '' | 'primary' | 'danger' = ''): HTMLButtonElement {
  const b = el('button', `cs-m-btn${variant ? ` is-${variant}` : ''}`, label);
  b.type = 'button';
  return b;
}

function section(title: string): HTMLElement {
  const s = el('section', 'cs-m-section');
  s.append(el('h3', 'cs-m-section-title', title));
  return s;
}

function errorMessage(error: unknown): string {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
}

async function switchInstance(instance: MobileInstance): Promise<void> {
  if (tabCount() > 0 && !(await confirmSheet(mt('switchConfirm', { name: instance.name }), mt('save'), mt('cancel')))) return;
  await native.selectInstance(instance.id);
  location.href = '/';
}

function authLabel(mode: string): string {
  return mode === 'github' ? mt('authGithub') : mode === 'password' ? mt('authPassword') : mt('authAnonymous');
}

function openInstanceEditor(instance: MobileInstance | null, onSaved: () => void): void {
  const body = el('div', 'cs-m-form');
  const nameInput = textInput(instance?.name ?? '', 'CloudSSH');
  const urlInput = textInput(instance?.baseUrl ?? '', 'https://bash.al', 'url');
  const result = el('p', 'cs-m-hint cs-m-result');
  const testButton = button(mt('test'));
  const saveButton = button(mt('save'), 'primary');

  testButton.addEventListener('click', async () => {
    result.textContent = mt('testing');
    result.className = 'cs-m-hint cs-m-result';
    try {
      const probe = await native.testInstance(urlInput.value);
      const lines = [mt('testOk', { ms: probe.latencyMs, auth: authLabel(probe.authMode) + (probe.loginRequired ? mt('required') : '') })];
      if (probe.oauthRedirectUri) {
        lines.push(mt('testOauth', { uri: probe.oauthRedirectUri }));
        const callbackOrigin = new URL(probe.oauthRedirectUri).origin;
        const typed = urlInput.value.includes('://') ? urlInput.value : `https://${urlInput.value}`;
        if (callbackOrigin !== new URL(typed).origin) lines.push(mt('testMismatch', { origin: callbackOrigin }));
      }
      result.textContent = lines.join('\n');
      result.classList.add('is-ok');
    } catch (error) {
      result.textContent = errorMessage(error);
      result.classList.add('is-bad');
    }
  });

  saveButton.addEventListener('click', async () => {
    try {
      await native.saveInstance(instance?.id ?? null, nameInput.value, urlInput.value);
      notify(mt('saved'), { variant: 'success', duration: 1500 });
      closeSheet();
      onSaved();
    } catch (error) {
      result.textContent = errorMessage(error);
      result.className = 'cs-m-hint cs-m-result is-bad';
    }
  });

  const actions = el('div', 'cs-m-row');
  actions.append(testButton, saveButton);
  body.append(field(mt('name'), nameInput), field(mt('workerUrl'), urlInput, mt('workerHint')), result, actions);
  openSheet(instance ? mt('editInstance') : mt('addInstance'), body, { tall: true });
}

function renderInstances(state: MobileState, container: HTMLElement): void {
  for (const instance of state.instances) {
    const row = el('div', 'cs-m-instance');
    const pick = el('button', 'cs-m-instance-main');
    pick.type = 'button';
    pick.append(icon(instance.id === state.currentId ? 'radio_button_checked' : 'radio_button_unchecked'));
    const text = el('span', 'cs-m-row-text');
    text.append(el('span', 'cs-m-row-name', instance.name), el('span', 'cs-m-row-sub', instance.baseUrl));
    pick.append(text);
    pick.addEventListener('click', () => {
      if (instance.id !== state.currentId) void switchInstance(instance);
    });

    const edit = el('button', 'cs-m-iconbtn');
    edit.type = 'button';
    edit.setAttribute('aria-label', mt('edit'));
    edit.append(icon('edit'));
    edit.addEventListener('click', () => openInstanceEditor(instance, () => void openSettings()));

    const remove = el('button', 'cs-m-iconbtn');
    remove.type = 'button';
    remove.setAttribute('aria-label', mt('delete'));
    remove.append(icon('delete'));
    remove.disabled = state.instances.length <= 1;
    remove.addEventListener('click', async () => {
      if (!(await confirmSheet(mt('deleteConfirm', { name: instance.name }), mt('delete'), mt('cancel'), true))) return;
      try {
        await native.deleteInstance(instance.id);
        if (instance.id === state.currentId) location.href = '/';
        else void openSettings();
      } catch (error) {
        notify(errorMessage(error), { variant: 'danger' });
      }
    });
    row.append(pick, edit, remove);
    container.append(row);
  }
  const add = button(`＋ ${mt('addInstance')}`);
  add.addEventListener('click', () => openInstanceEditor(null, () => void openSettings()));
  const signOut = button(mt('clearLogin'), 'danger');
  signOut.addEventListener('click', async () => {
    if (!(await confirmSheet(mt('clearLoginConfirm', { name: state.current.name }), mt('clearLogin'), mt('cancel'), true))) return;
    // 先让服务端作废 session（尽力而为，离线时只清本地），再删掉本地 Cookie
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    await native.clearLogin(state.currentId);
    location.href = '/';
  });
  const row = el('div', 'cs-m-row');
  row.append(add, signOut);
  container.append(row);
}

export async function openSettings(): Promise<void> {
  let state: MobileState;
  try {
    state = await native.state();
  } catch (error) {
    notify(errorMessage(error), { variant: 'danger' });
    return;
  }
  const body = el('div', 'cs-m-form');

  const instances = section(mt('instances'));
  renderInstances(state, instances);

  const proxy = section(mt('proxy'));
  const proxyInput = textInput(state.proxy ?? '', 'http://127.0.0.1:7890', 'url');
  const proxySave = button(mt('save'));
  proxySave.addEventListener('click', async () => {
    try {
      const saved = await native.setProxy(proxyInput.value || null);
      proxyInput.value = saved ?? '';
      notify(mt('saved'), { variant: 'success', duration: 1500 });
    } catch (error) {
      notify(errorMessage(error), { variant: 'danger' });
    }
  });
  const proxyRow = el('div', 'cs-m-inline');
  proxyRow.append(proxyInput, proxySave);
  proxy.append(proxyRow, el('p', 'cs-m-hint', mt('proxyHint')));

  const keep = section(mt('keepAlive'));
  const toggle = el('label', 'cs-m-switch');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.checked = keepAliveEnabled();
  checkbox.addEventListener('change', () => {
    try {
      localStorage.setItem(KEEPALIVE_KEY, checkbox.checked ? 'on' : 'off');
    } catch {
      // 忽略
    }
    window.dispatchEvent(new CustomEvent('cloudssh:keepalive-changed'));
  });
  toggle.append(checkbox, el('span', '', mt('keepAliveHint')));
  keep.append(toggle);
  // 电池优化白名单：长时间锁屏挂 SSH 时，部分系统仍会限制后台网络
  const battery = el('div', 'cs-m-inline');
  const batteryHint = el('p', 'cs-m-hint', mt('batteryChecking'));
  const batteryButton = button(mt('batteryRequest'));
  const refreshBattery = () =>
    native
      .batteryStatus()
      .then((ignoring) => {
        if (ignoring === null) {
          battery.remove();
          return;
        }
        batteryHint.textContent = ignoring ? mt('batteryOk') : mt('batteryLimited');
        batteryButton.hidden = ignoring;
      })
      .catch(() => battery.remove());
  batteryButton.addEventListener('click', () => {
    void native.requestBatteryExemption();
    // 从系统设置返回后刷新状态
    window.addEventListener('focus', () => void refreshBattery(), { once: true });
    document.addEventListener('visibilitychange', () => void refreshBattery(), { once: true });
  });
  battery.append(batteryHint, batteryButton);
  keep.append(battery);
  void refreshBattery();

  // 存储：应用数据（不含安装包）与缓存，可手动清缓存
  const storage = section(mt('storage'));
  const storageHint = el('p', 'cs-m-hint', '…');
  const clearButton = button(mt('clearCache'));
  const formatSize = (bytes: number) =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const refreshStorage = () =>
    native
      .storageInfo()
      .then((info) => {
        if (!info) {
          storage.remove();
          return;
        }
        storageHint.textContent = mt('storageUsage', { data: formatSize(info.data), cache: formatSize(info.cache) });
      })
      .catch(() => storage.remove());
  clearButton.addEventListener('click', () => {
    clearButton.disabled = true;
    native
      .clearCache()
      .then(() => notify(mt('cacheCleared'), { variant: 'success', duration: 1500 }))
      .catch((error: unknown) => notify(errorMessage(error), { variant: 'danger' }))
      .finally(() => {
        clearButton.disabled = false;
        void refreshStorage();
      });
  });
  const storageRow = el('div', 'cs-m-inline');
  storageRow.append(storageHint, clearButton);
  storage.append(storageRow);
  void refreshStorage();

  const about = section(mt('about'));
  about.append(el('p', 'cs-m-hint', mt('appVersion', { v: state.appVersion })));
  const uiVersion = el('p', 'cs-m-hint');
  about.append(uiVersion);
  fetch('/cloudssh-ui.json')
    .then((r) => r.json())
    .then((m: { upstreamVersion?: string }) => (uiVersion.textContent = mt('uiVersion', { v: m.upstreamVersion ?? '?' })))
    .catch(() => undefined);

  body.append(instances, proxy, keep, storage, about);
  openSheet(mt('settings'), body, { tall: true });
}
