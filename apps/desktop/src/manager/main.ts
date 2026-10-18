/** 实例管理页面（本地页面，通过 preload 暴露的 window.managerApi 与主进程通信） */
import { describeUiSource, type InstanceConfig, normalizeWorkerUrl, type UiSource } from '@cloudssh/core';

interface UiManifest {
  upstreamVersion?: string | null;
  upstreamCommit?: string | null;
  builtAt?: string;
}

interface ManagerState {
  instances: InstanceConfig[];
  defaultInstanceId: string;
  preferences: { closeToTray: boolean; showMenuBar: boolean };
  openInstanceIds: string[];
  bundledUis: { id: string; manifest: UiManifest | null }[];
  appVersion: string;
  /** 带代号的版本文本，如 v0.2.0「织女 Vega」 */
  appVersionLabel: string;
  electronVersion: string;
  configPath: string;
}

interface TestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  oauthRedirectUri?: string | null;
  config?: { authMode: string; githubAuthRequired: boolean; sshSharingEnabled: boolean; turnstileEnabled: boolean };
}

interface ManagerApi {
  state(): Promise<ManagerState>;
  saveInstance(input: Partial<InstanceConfig>): Promise<InstanceConfig>;
  deleteInstance(id: string, clearData: boolean): Promise<void>;
  setDefault(id: string): Promise<void>;
  openInstance(id: string, newWindow: boolean): Promise<void>;
  login(id: string): Promise<void>;
  clearData(id: string): Promise<void>;
  testInstance(baseUrl: string): Promise<TestResult>;
  setPreferences(patch: Partial<ManagerState['preferences']>): Promise<unknown>;
  pickDirectory(): Promise<string | null>;
  openPath(kind: 'config' | 'logs'): Promise<void>;
  onChanged(listener: (state: ManagerState) => void): () => void;
}

const api = (window as unknown as { managerApi: ManagerApi }).managerApi;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const list = $<HTMLUListElement>('instance-list');
const form = $<HTMLFormElement>('instance-form');
const formTitle = $('form-title');
const formSubtitle = $('form-subtitle');
// macOS 的红绿灯在标题栏左侧
document.documentElement.dataset.platform = navigator.userAgent.includes('Mac OS') ? 'darwin' : 'other';
const fieldName = $<HTMLInputElement>('field-name');
const fieldUrl = $<HTMLInputElement>('field-url');
const fieldBundledId = $<HTMLSelectElement>('field-bundled-id');
const fieldDirectory = $<HTMLInputElement>('field-directory');
const fieldDevServer = $<HTMLInputElement>('field-dev-server');
const bundledMeta = $('bundled-meta');
const testResult = $('test-result');
const formError = $('form-error');
const prefCloseToTray = $<HTMLInputElement>('pref-close-to-tray');
const prefShowMenuBar = $<HTMLInputElement>('pref-show-menubar');

let state: ManagerState | null = null;
/** 当前编辑的实例 id；null 表示新增 */
let selectedId: string | null = null;

function uiKindRadios(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[name="ui-kind"]')];
}

function selectedUiKind(): UiSource['kind'] {
  return (uiKindRadios().find((radio) => radio.checked)?.value ?? 'bundled') as UiSource['kind'];
}

function syncUiSubFields(): void {
  const kind = selectedUiKind();
  document.querySelectorAll<HTMLElement>('.sub').forEach((el) => {
    el.classList.toggle('visible', el.dataset.for === kind);
  });
}

function readUiSource(): UiSource {
  switch (selectedUiKind()) {
    case 'remote':
      return { kind: 'remote' };
    case 'directory':
      return { kind: 'directory', path: fieldDirectory.value.trim() };
    case 'dev-server':
      return { kind: 'dev-server', url: fieldDevServer.value.trim() || 'http://127.0.0.1:5173' };
    default:
      return { kind: 'bundled', id: fieldBundledId.value || 'web' };
  }
}

function renderList(): void {
  if (!state) return;
  list.replaceChildren();
  for (const instance of state.instances) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-current', String(instance.id === selectedId));

    const avatar = document.createElement('span');
    avatar.className = 'instance-avatar';
    avatar.textContent = [...instance.name.trim()][0]?.toUpperCase() ?? '?';

    const name = document.createElement('span');
    name.className = 'instance-name';
    const label = document.createElement('span');
    label.textContent = instance.name;
    name.append(label);
    if (instance.id === state.defaultInstanceId) name.append(badge('默认'));
    if (state.openInstanceIds.includes(instance.id)) name.append(badge('已打开', true));

    const url = document.createElement('span');
    url.className = 'instance-url';
    url.textContent = `${hostOf(instance.baseUrl)} · ${describeUiSource(instance.ui)}`;
    url.title = instance.baseUrl;

    button.append(avatar, name, url);
    button.addEventListener('click', () => select(instance.id));
    li.append(button);
    list.append(li);
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function badge(text: string, on = false): HTMLElement {
  const el = document.createElement('span');
  el.className = on ? 'badge on' : 'badge';
  el.textContent = text;
  return el;
}

function renderBundledOptions(currentId: string): void {
  if (!state) return;
  fieldBundledId.replaceChildren();
  const ids = state.bundledUis.length ? state.bundledUis : [{ id: 'web', manifest: null }];
  for (const ui of ids) {
    const option = document.createElement('option');
    option.value = ui.id;
    option.textContent = ui.id === 'web' ? 'web（CloudSSH 网页版）' : ui.id;
    fieldBundledId.append(option);
  }
  fieldBundledId.value = currentId;
  const manifest = state.bundledUis.find((ui) => ui.id === fieldBundledId.value)?.manifest;
  bundledMeta.textContent = manifest
    ? `上游版本 v${manifest.upstreamVersion ?? '?'} @ ${(manifest.upstreamCommit ?? '').slice(0, 7) || '?'}，构建于 ${manifest.builtAt?.slice(0, 19).replace('T', ' ') ?? '?'}`
    : '未找到构建产物：先运行 pnpm build:ui';
}

function fillForm(instance: InstanceConfig | null): void {
  formError.textContent = '';
  testResult.textContent = '';
  testResult.className = 'hint';
  formTitle.textContent = instance ? instance.name : '新增实例';
  formSubtitle.textContent = instance ? instance.baseUrl : '填写名称和 Worker 地址，保存后即可打开';
  fieldName.value = instance?.name ?? '';
  fieldUrl.value = instance?.baseUrl ?? '';
  const ui: UiSource = instance?.ui ?? { kind: 'bundled', id: 'web' };
  uiKindRadios().forEach((radio) => {
    radio.checked = radio.value === ui.kind;
  });
  renderBundledOptions(ui.kind === 'bundled' ? ui.id ?? 'web' : 'web');
  fieldDirectory.value = ui.kind === 'directory' ? ui.path : '';
  fieldDevServer.value = ui.kind === 'dev-server' ? ui.url : '';
  syncUiSubFields();

  const existing = !!instance;
  for (const id of ['open-here', 'open-new', 'login', 'set-default', 'clear-data', 'delete-instance']) {
    $<HTMLButtonElement>(id).disabled = !existing;
  }
  if (instance && state) {
    $<HTMLButtonElement>('set-default').disabled = instance.id === state.defaultInstanceId;
    $<HTMLButtonElement>('delete-instance').disabled = state.instances.length <= 1;
  }
}

function select(id: string | null): void {
  selectedId = id;
  renderList();
  fillForm(id && state ? state.instances.find((instance) => instance.id === id) ?? null : null);
}

function applyState(next: ManagerState): void {
  state = next;
  if (selectedId && !next.instances.some((instance) => instance.id === selectedId)) {
    selectedId = next.defaultInstanceId;
  }
  prefCloseToTray.checked = next.preferences.closeToTray;
  prefShowMenuBar.checked = next.preferences.showMenuBar;
  $('app-meta').textContent = `客户端 ${next.appVersionLabel} · Electron ${next.electronVersion}`;
  renderList();
}

async function refresh(keepForm = false): Promise<void> {
  applyState(await api.state());
  if (!keepForm) select(selectedId ?? state!.defaultInstanceId);
}

async function run(action: () => Promise<unknown>): Promise<void> {
  formError.textContent = '';
  try {
    await action();
  } catch (error) {
    formError.textContent = (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}

// ---------- 事件 ----------

uiKindRadios().forEach((radio) => radio.addEventListener('change', syncUiSubFields));
fieldBundledId.addEventListener('change', () => renderBundledOptions(fieldBundledId.value));

$('add-instance').addEventListener('click', () => select(null));

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    const baseUrl = normalizeWorkerUrl(fieldUrl.value);
    const saved = await api.saveInstance({
      id: selectedId ?? undefined,
      name: fieldName.value.trim(),
      baseUrl,
      ui: readUiSource(),
    });
    selectedId = saved.id;
    await refresh();
    testResult.textContent = '已保存';
    testResult.className = 'hint ok';
  });
});

$('test-instance').addEventListener('click', () => {
  void run(async () => {
    const baseUrl = normalizeWorkerUrl(fieldUrl.value);
    testResult.className = 'hint';
    testResult.textContent = '正在连接…';
    const result = await api.testInstance(baseUrl);
    if (result.ok && result.config) {
      const auth =
        result.config.authMode === 'github'
          ? 'GitHub 登录'
          : result.config.authMode === 'password'
            ? '管理员密码登录'
            : '匿名';
      const lines = [
        `连接正常（${result.latencyMs} ms）· 认证模式：${auth}${
          result.config.githubAuthRequired ? '（强制登录）' : ''
        } · 分享：${result.config.sshSharingEnabled ? '开启' : '关闭'}`,
      ];
      let warn = false;
      if (result.oauthRedirectUri) {
        lines.push(
          `OAuth 回调地址：${result.oauthRedirectUri}（必须与 GitHub OAuth App 登记的回调一致，否则授权页会提示 redirect_uri 不匹配）`
        );
        const callbackOrigin = new URL(result.oauthRedirectUri).origin;
        if (callbackOrigin !== baseUrl) {
          warn = true;
          lines.push(`⚠ 回调域名与实例地址不同，登录 Cookie 会写到 ${callbackOrigin}，请把实例地址改为该域名`);
        }
      }
      testResult.className = warn ? 'hint bad' : 'hint ok';
      testResult.textContent = lines.join('\n');
    } else {
      testResult.className = 'hint bad';
      testResult.textContent = `连接失败：${result.error ?? '未知错误'}`;
    }
  });
});

$('pick-directory').addEventListener('click', () => {
  void run(async () => {
    const dir = await api.pickDirectory();
    if (dir) fieldDirectory.value = dir;
  });
});

$('open-here').addEventListener('click', () => selectedId && void run(() => api.openInstance(selectedId!, false)));
$('open-new').addEventListener('click', () => selectedId && void run(() => api.openInstance(selectedId!, true)));
$('login').addEventListener('click', () => selectedId && void run(() => api.login(selectedId!)));
$('set-default').addEventListener('click', () =>
  selectedId && void run(async () => {
    await api.setDefault(selectedId!);
    await refresh();
  })
);
$('clear-data').addEventListener('click', () => {
  if (!selectedId || !confirm('清除该实例的登录状态、本地缓存与网页数据？已打开的窗口会重新加载。')) return;
  void run(async () => {
    await api.clearData(selectedId!);
    testResult.className = 'hint ok';
    testResult.textContent = '已清除登录数据';
  });
});
$('delete-instance').addEventListener('click', () => {
  if (!selectedId || !confirm('删除该实例？其窗口会被关闭。')) return;
  const clearData = confirm('同时清除该实例的登录状态与网页数据吗？');
  void run(async () => {
    await api.deleteInstance(selectedId!, clearData);
    selectedId = null;
    await refresh();
  });
});

prefCloseToTray.addEventListener('change', () => void run(() => api.setPreferences({ closeToTray: prefCloseToTray.checked })));
prefShowMenuBar.addEventListener('change', () => void run(() => api.setPreferences({ showMenuBar: prefShowMenuBar.checked })));

$('open-config').addEventListener('click', () => void api.openPath('config'));
$('open-logs').addEventListener('click', () => void api.openPath('logs'));

api.onChanged((next) => applyState(next));
void refresh();
