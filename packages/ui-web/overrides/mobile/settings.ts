/**
 * 移动端设置面板。按使用频率分组，一项设置一行：
 *   实例（切换/新增/编辑/删除/清除登录）→ 终端（字号、关键词高亮、关闭确认）
 *   → 连接（代理、后台保活、电池优化）→ 外观（主题、强调色、布局模块）→ 关于（版本、存储）。
 * 顶部的分组导航用于快速定位。实例与代理保存在 Rust 侧（settings.json），切换实例后整页重新加载。
 */
import { CLIENT_CODENAME, CLIENT_VERSION } from '@cloudssh/core';
import { notify } from '../../upstream/frontend/src/ui-feedback';
import { appearanceGroup } from './skin';
import { skinState, SKIN_CHANGED_EVENT } from './skin/engine';
import { fontSizeControl } from './skin/font-size';
import { st } from './skin/i18n';
import { tabCount } from '../sidebar/hooks';
import { CLOSE_CONFIRM_MODES, closeConfirmMode, setCloseConfirmMode, type CloseConfirmMode } from './close-confirm';
import { openHighlightEditor } from '../shared/terminal';
import { loadSettings as loadHighlight, saveSettings as saveHighlight } from '../shared/terminal/highlight-rules';
import { ht } from '../shared/terminal/i18n';
import { mt } from './i18n';
import { groupNav, segmented, settingsGroup, settingsRow, smallButton, splitToggleRow, toggleRow } from './settings-ui';
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

function textInput(value: string, placeholder: string, type = 'text', className = 'cs-m-input'): HTMLInputElement {
  const input = el('input', className);
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

function errorMessage(error: unknown): string {
  return typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
}

/** 行里的“说明”文字节点，便于异步结果回来后更新 */
function subOf(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>('.cs-set-sub')!;
}

async function switchInstance(instance: MobileInstance): Promise<void> {
  if (tabCount() > 0 && !(await confirmSheet(mt('switchConfirm', { name: instance.name }), mt('save'), mt('cancel')))) return;
  await native.selectInstance(instance.id);
  location.href = '/';
}

function authLabel(mode: string): string {
  return mode === 'github' ? mt('authGithub') : mode === 'password' ? mt('authPassword') : mt('authAnonymous');
}

// ---------- 实例 ----------

function openInstanceEditor(instance: MobileInstance | null, state: MobileState): void {
  const reopen = () => void openSettings();
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
      reopen();
    } catch (error) {
      result.textContent = errorMessage(error);
      result.className = 'cs-m-hint cs-m-result is-bad';
    }
  });

  const actions = el('div', 'cs-m-row');
  actions.append(testButton, saveButton);
  body.append(field(mt('name'), nameInput), field(mt('workerUrl'), urlInput, mt('workerHint')), result, actions);

  // 删除放在编辑页里：列表上每行只留一个编辑按钮
  if (instance && state.instances.length > 1) {
    const remove = button(mt('deleteInstance'), 'danger');
    remove.addEventListener('click', async () => {
      if (!(await confirmSheet(mt('deleteConfirm', { name: instance.name }), mt('delete'), mt('cancel'), true))) return;
      try {
        await native.deleteInstance(instance.id);
        if (instance.id === state.currentId) location.href = '/';
        else reopen();
      } catch (error) {
        notify(errorMessage(error), { variant: 'danger' });
      }
    });
    body.append(remove);
  }
  openSheet(instance ? mt('editInstance') : mt('addInstance'), body, { tall: true });
}

function instanceRow(instance: MobileInstance, state: MobileState): HTMLElement {
  const current = instance.id === state.currentId;
  const row = el('div', `cs-set-row is-split is-instance${current ? ' is-current' : ''}`);
  const pick = el('button', 'cs-set-split-main');
  pick.type = 'button';
  pick.setAttribute('aria-pressed', String(current));
  const mark = icon(current ? 'radio_button_checked' : 'radio_button_unchecked');
  mark.classList.add('cs-set-lead');
  const text = el('span', 'cs-set-text');
  text.append(el('span', 'cs-set-title', instance.name), el('span', 'cs-set-sub', instance.baseUrl));
  pick.append(mark, text);
  pick.addEventListener('click', () => {
    if (!current) void switchInstance(instance);
  });
  const edit = el('button', 'cs-set-iconbtn');
  edit.type = 'button';
  edit.setAttribute('aria-label', `${mt('edit')} ${instance.name}`);
  edit.append(icon('edit'));
  edit.addEventListener('click', () => openInstanceEditor(instance, state));
  row.append(pick, edit);
  return row;
}

function instancesGroup(state: MobileState): HTMLElement {
  const rows = state.instances.map((instance) => instanceRow(instance, state));
  const actions = el('div', 'cs-set-actions');
  const add = el('button', 'cs-set-action');
  add.type = 'button';
  add.append(icon('add'), el('span', '', mt('addInstance')));
  add.addEventListener('click', () => openInstanceEditor(null, state));
  actions.append(add);
  if (state.loggedIn) {
    const signOut = el('button', 'cs-set-action is-danger');
    signOut.type = 'button';
    signOut.append(icon('logout'), el('span', '', mt('clearLogin')));
    signOut.addEventListener('click', async () => {
      if (!(await confirmSheet(mt('clearLoginConfirm', { name: state.current.name }), mt('clearLogin'), mt('cancel'), true))) return;
      // 先让服务端作废 session（尽力而为，离线时只清本地），再删掉本地 Cookie
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
      await native.clearLogin(state.currentId);
      location.href = '/';
    });
    actions.append(signOut);
  }
  return settingsGroup('instances', mt('instances'), [...rows, actions]);
}

// ---------- 终端 ----------

function terminalGroup(): HTMLElement {
  // 字号只在黑曜主题下生效：换主题时显示或隐藏
  const fontRow = settingsRow({ title: st('fontSize'), end: fontSizeControl(false) });
  fontRow.hidden = skinState().skin !== 'obsidian';
  const syncFont = () => {
    if (!fontRow.isConnected) {
      window.removeEventListener(SKIN_CHANGED_EVENT, syncFont);
      return;
    }
    fontRow.hidden = skinState().skin !== 'obsidian';
  };
  window.addEventListener(SKIN_CHANGED_EVENT, syncFont);

  const highlight = loadHighlight();
  const enabledRules = highlight.rules.filter((rule) => rule.enabled).length;
  const highlightRow = splitToggleRow({
    title: ht('title'),
    sub: ht('ruleCount', { on: enabledRules, all: highlight.rules.length }),
    checked: highlight.enabled,
    onOpen: () => {
      closeSheet();
      openHighlightEditor();
    },
    onChange: (on) => saveHighlight({ ...loadHighlight(), enabled: on }),
  });

  const closeLabels: Record<CloseConfirmMode, string> = {
    connected: mt('closeConfirmConnected'),
    always: mt('closeConfirmAlways'),
    never: mt('closeConfirmNever'),
  };
  const closeRow = settingsRow({
    title: mt('closeConfirm'),
    wrap: true,
    end: segmented<CloseConfirmMode>(
      mt('closeConfirm'),
      CLOSE_CONFIRM_MODES.map((mode) => ({ value: mode, label: closeLabels[mode] })),
      closeConfirmMode(),
      setCloseConfirmMode
    ),
  });

  return settingsGroup('terminal', mt('grpTerminal'), [fontRow, highlightRow, closeRow]);
}

// ---------- 连接 ----------

function proxyRow(state: MobileState): HTMLElement {
  const input = textInput(state.proxy ?? '', 'http://host:port', 'url', 'cs-set-input');
  input.enterKeyHint = 'done';
  input.setAttribute('aria-label', mt('proxy'));
  let saved = state.proxy ?? '';
  // 输入完成（回车或离开输入框）即保存，不再单独放“保存”按钮
  input.addEventListener('change', async () => {
    if (input.value.trim() === saved) return;
    try {
      saved = (await native.setProxy(input.value.trim() || null)) ?? '';
      input.value = saved;
      notify(mt('saved'), { variant: 'success', duration: 1500 });
    } catch (error) {
      notify(errorMessage(error), { variant: 'danger' });
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
  return settingsRow({ title: mt('proxy'), sub: mt('proxySub'), end: input });
}

function batteryRow(): HTMLElement {
  // 电池优化白名单：长时间锁屏挂 SSH 时，部分系统仍会限制后台网络
  const request = smallButton(mt('batteryRequest'), () => {
    void native.requestBatteryExemption();
    // 从系统设置返回后刷新状态
    window.addEventListener('focus', () => void refresh(), { once: true });
    document.addEventListener('visibilitychange', () => void refresh(), { once: true });
  });
  request.hidden = true;
  const row = settingsRow({ title: mt('batteryTitle'), sub: mt('batteryChecking'), end: request });
  const refresh = () =>
    native
      .batteryStatus()
      .then((ignoring) => {
        if (ignoring === null) {
          row.remove();
          return;
        }
        subOf(row).textContent = ignoring ? mt('batteryOk') : mt('batteryLimited');
        request.hidden = ignoring;
      })
      .catch(() => row.remove());
  void refresh();
  return row;
}

function connectionGroup(state: MobileState): HTMLElement {
  const keepAlive = toggleRow({
    title: mt('keepAlive'),
    sub: mt('keepAliveHint'),
    checked: keepAliveEnabled(),
    onChange: (on) => {
      try {
        localStorage.setItem(KEEPALIVE_KEY, on ? 'on' : 'off');
      } catch {
        // 忽略
      }
      window.dispatchEvent(new CustomEvent('cloudssh:keepalive-changed'));
    },
  });
  return settingsGroup('connection', mt('grpConnection'), [proxyRow(state), keepAlive, batteryRow()]);
}

// ---------- 关于 ----------

function aboutGroup(state: MobileState): HTMLElement {
  // 代号随界面一起打包；原生层版本与之一致时才显示代号（调试时混用新旧构建也不会张冠李戴）
  const version =
    state.appVersion === CLIENT_VERSION
      ? mt('appVersionNamed', { v: state.appVersion, zh: CLIENT_CODENAME.zh, en: CLIENT_CODENAME.en })
      : mt('appVersion', { v: state.appVersion });
  const versionRow = settingsRow({ title: mt('version'), sub: '', end: el('span', 'cs-set-value', version) });
  subOf(versionRow).hidden = true;
  fetch('/cloudssh-ui.json')
    .then((r) => r.json())
    .then((m: { upstreamVersion?: string }) => {
      subOf(versionRow).textContent = mt('uiVersion', { v: m.upstreamVersion ?? '?' });
      subOf(versionRow).hidden = false;
    })
    .catch(() => undefined);

  // 存储：应用数据（不含安装包）与缓存，可手动清缓存
  const formatSize = (bytes: number) =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const clear = smallButton(mt('clearCache'), () => {
    clear.disabled = true;
    native
      .clearCache()
      .then(() => notify(mt('cacheCleared'), { variant: 'success', duration: 1500 }))
      .catch((error: unknown) => notify(errorMessage(error), { variant: 'danger' }))
      .finally(() => {
        clear.disabled = false;
        void refreshStorage();
      });
  });
  const storageRow = settingsRow({ title: mt('storage'), sub: '…', end: clear });
  const refreshStorage = () =>
    native
      .storageInfo()
      .then((info) => {
        if (!info) {
          storageRow.remove();
          return;
        }
        subOf(storageRow).textContent = mt('storageUsage', { data: formatSize(info.data), cache: formatSize(info.cache) });
      })
      .catch(() => storageRow.remove());
  void refreshStorage();

  return settingsGroup('about', mt('about'), [versionRow, storageRow]);
}

export async function openSettings(): Promise<void> {
  let state: MobileState;
  try {
    state = await native.state();
  } catch (error) {
    notify(errorMessage(error), { variant: 'danger' });
    return;
  }
  const groups = [instancesGroup(state), terminalGroup(), connectionGroup(state), appearanceGroup(mt('grpAppearance')), aboutGroup(state)];
  const body = el('div', 'cs-set-page');
  body.append(groupNav(groups, mt('settingsNav')), ...groups);
  openSheet(mt('settings'), body, { tall: true });
}
