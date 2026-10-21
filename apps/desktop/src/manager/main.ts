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
  preferences: { closeToTray: boolean; showMenuBar: boolean; quickConnectShortcut: string; cliLoginSync: boolean };
  openInstanceIds: string[];
  bundledUis: { id: string; manifest: UiManifest | null }[];
  appVersion: string;
  /** 带代号的版本文本，如 v0.2.0「织女 Vega」 */
  appVersionLabel: string;
  electronVersion: string;
  configPath: string;
  /** 快速连接的全局快捷键的注册结果（taken = 被其他程序占用） */
  quickConnect?: { status: 'off' | 'on' | 'taken' | 'invalid' };
}

interface TestResult {
  ok: boolean;
  latencyMs: number;
  /** 这次测试走的路线：DIRECT，或系统代理解析出的结果（如 PROXY 127.0.0.1:7890） */
  route?: string;
  error?: string;
  oauthRedirectUri?: string | null;
  config?: { authMode: string; githubAuthRequired: boolean; sshSharingEnabled: boolean; turnstileEnabled: boolean };
}

interface CliStatus {
  available: boolean;
  installed: boolean;
  program: string | null;
  exists: boolean;
  appRuntime: boolean;
  /** 装命令时的命令行版本（旧版命令行没有） */
  commandVersion?: string | null;
  managed: boolean;
  binDir: string;
  onPath: boolean;
  skill: boolean;
  skillCurrent: boolean;
  skillPath: string;
  skills?: { id: string; name: string; path: string; enabled?: boolean; installed: boolean; current: boolean; version?: string | null }[];
  mcp?: { id: string; name: string; path: string; present: boolean; registered: boolean; current: boolean; error?: string }[];
  version: string;
  error?: string;
}

interface CliConfigView {
  confirm: 'ask' | 'never';
  concurrency: number;
  timeout: number;
  aliases: Record<string, string>;
  skills: Record<string, boolean>;
  skillNotes: string;
  defaultInstance?: string;
}

interface CliSettings {
  status: CliStatus;
  config: CliConfigView;
  instances: { name: string; url: string; signedIn: boolean }[];
}

interface ManagerApi {
  state(): Promise<ManagerState>;
  saveInstance(input: Partial<InstanceConfig>): Promise<InstanceConfig>;
  deleteInstance(id: string, clearData: boolean): Promise<void>;
  setDefault(id: string): Promise<void>;
  openInstance(id: string, newWindow: boolean): Promise<void>;
  login(id: string): Promise<void>;
  clearData(id: string): Promise<void>;
  testInstance(baseUrl: string, options?: { direct?: boolean }): Promise<TestResult>;
  setPreferences(patch: Partial<ManagerState['preferences']>): Promise<unknown>;
  setShortcutRecording(recording: boolean): Promise<void>;
  pickDirectory(): Promise<string | null>;
  openPath(kind: 'config' | 'logs'): Promise<void>;
  onChanged(listener: (state: ManagerState) => void): () => void;
  cliStatus(): Promise<CliStatus>;
  cliInstall(): Promise<CliStatus>;
  cliUninstall(): Promise<CliStatus>;
  cliSettings(): Promise<CliSettings>;
  setCliSettings(patch: Partial<CliConfigView>): Promise<CliSettings>;
  setCliMcp(id: string, on: boolean): Promise<CliStatus>;
  /** 应用里点了“命令行与 Skill”（旧版 preload 没有） */
  onShowView?(listener: (view: string) => void): void;
  /** 跟随主题：实例页面报来的配色（还没有时为 null）与之后的变化 */
  palette?(): Promise<Palette | null>;
  onPalette?(listener: (palette: Palette) => void): void;
}

/** 主进程转来的配色（十六进制颜色），对应 style.css 里 :root 的变量 */
interface Palette {
  bg: string;
  surface: string;
  elevated: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  accent: string;
  onAccent: string;
  danger: string;
}

const api = (window as unknown as { managerApi: ManagerApi }).managerApi;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const list = $<HTMLUListElement>('instance-list');
const form = $<HTMLFormElement>('instance-form');
const formTitle = $('form-title');
const formSubtitle = $('form-subtitle');
// macOS 的红绿灯在标题栏左侧
document.documentElement.dataset.platform = navigator.userAgent.includes('Mac OS') ? 'darwin' : 'other';
// 窗口布局是固定的（各栏自己滚动），整个页面不该滚：聚焦某个元素等引起的整页滚动立即还原，免得标题栏被顶出去
window.addEventListener('scroll', () => {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
});
const fieldName = $<HTMLInputElement>('field-name');
const fieldUrl = $<HTMLInputElement>('field-url');
const fieldDirect = $<HTMLInputElement>('field-direct');
const fieldBundledId = $<HTMLSelectElement>('field-bundled-id');
const fieldDirectory = $<HTMLInputElement>('field-directory');
const fieldDevServer = $<HTMLInputElement>('field-dev-server');
const bundledMeta = $('bundled-meta');
const testResult = $('test-result');
const formError = $('form-error');
const prefCloseToTray = $<HTMLInputElement>('pref-close-to-tray');
const prefShowMenuBar = $<HTMLInputElement>('pref-show-menubar');
const prefCliSync = $<HTMLInputElement>('pref-cli-sync');
const prefQuickConnect = $<HTMLButtonElement>('pref-quick-connect');
const prefQuickConnectToggle = $<HTMLButtonElement>('pref-quick-connect-toggle');
const DEFAULT_QUICK_CONNECT = 'CommandOrControl+Alt+T';
let recordingShortcut = false;

/** Control+Alt+T → Ctrl+Alt+T */
function shortcutLabel(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => ({ CommandOrControl: 'Ctrl', Control: 'Ctrl', Super: 'Win', Command: 'Cmd' })[part] ?? part)
    .join('+');
}

/** 按键事件 → Electron 加速键；只按了修饰键、或没有 Ctrl/Alt/Win 时返回 null */
function acceleratorFrom(event: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push('Super');
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return null;
  const code = event.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else {
    const named: Record<string, string> = {
      Space: 'Space',
      Backquote: '`',
      Minus: '-',
      Equal: '=',
      BracketLeft: '[',
      BracketRight: ']',
      Semicolon: ';',
      Quote: "'",
      Comma: ',',
      Period: '.',
      Slash: '/',
      Backslash: '\\',
      Insert: 'Insert',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
    };
    key = named[code] ?? null;
  }
  return key ? [...mods, key].join('+') : null;
}

function renderShortcut(): void {
  if (!state) return;
  const accelerator = state.preferences.quickConnectShortcut;
  const status = state.quickConnect?.status ?? 'off';
  prefQuickConnect.textContent = recordingShortcut ? '按下新的组合键…' : accelerator ? shortcutLabel(accelerator) : '未设置';
  prefQuickConnect.classList.toggle('is-recording', recordingShortcut);
  prefQuickConnectToggle.textContent = accelerator ? '关闭' : '恢复默认';
  const hint = $('pref-quick-connect-hint');
  hint.textContent = recordingShortcut
    ? '按 Esc 取消，Backspace 关闭快捷键'
    : status === 'taken'
      ? '这个组合键已被其他程序占用，点上面换一个'
      : status === 'invalid'
        ? '这个组合键无效，点上面换一个'
        : accelerator
          ? '在任何程序里按下：叫出窗口并打开命令面板'
          : '已关闭';
  hint.classList.toggle('is-warning', !recordingShortcut && (status === 'taken' || status === 'invalid'));
}

async function stopRecording(next?: string): Promise<void> {
  if (!recordingShortcut) return;
  recordingShortcut = false;
  if (next !== undefined) await run(() => api.setPreferences({ quickConnectShortcut: next }));
  await api.setShortcutRecording(false);
  renderShortcut();
}

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
  $('ui-kind-desc').textContent = uiKindRadios().find((radio) => radio.checked)?.dataset.desc ?? '';
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
    if (instance.proxy === 'direct') {
      const direct = badge('直连');
      direct.title = '不走系统代理，直接连 Worker';
      name.append(direct);
    }

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

/** 测试连接走的路线：DIRECT → 直连；PROXY / SOCKS … → 经系统代理（带地址）；解析不出 → 跟随系统代理 */
function routeText(route: string | undefined): string {
  if (!route || route === 'unknown') return '跟随系统代理';
  if (route.trim().toUpperCase() === 'DIRECT') return '直连';
  return `经系统代理 ${route.split(';')[0].trim()}`;
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
  fieldDirect.checked = instance?.proxy === 'direct';
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
  if (form.hidden) showView('form');
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
  prefCliSync.checked = next.preferences.cliLoginSync;
  renderShortcut();
  $('app-meta').textContent = `客户端 ${next.appVersionLabel} · Electron ${next.electronVersion}`;
  renderList();
}

async function refresh(keepForm = false): Promise<void> {
  applyState(await api.state());
  if (!keepForm) select(selectedId ?? state!.defaultInstanceId);
}

// ---------- 命令行与 Claude Code ----------

/** 侧栏“命令行与 Skill”后面的短状态（完整说明在设置页里） */
const cliStatusEl = $('cli-status');
const cliViewStatus = $('cli-view-status');
const cliViewInstall = $<HTMLButtonElement>('cli-view-install');
const cliViewUninstall = $<HTMLButtonElement>('cli-view-uninstall');
const cliView = $('cli-view');
const actionbar = document.querySelector<HTMLElement>('.actionbar')!;
const cliError = $('cli-error');
let cliSettingsState: CliSettings | null = null;

function renderCli(status: CliStatus): void {
  const lines: string[] = [];
  let warning = false;
  if (!status.available) {
    lines.push(status.error ?? '这个客户端没有带命令行程序');
    warning = true;
  } else if (!status.installed) {
    lines.push('未安装。装好后可以在终端，或让 Claude Code、Codex 等 AI 用 cloudssh 操作服务器（执行命令、传文件、批量），不用开客户端。');
  } else {
    lines.push(`已安装：cloudssh、cssh（${status.binDir}）`);
    if (!status.exists) {
      lines.push('命令指向的程序不在了，请重新安装');
      warning = true;
    } else if (status.managed) lines.push('用客户端运行，随客户端更新');
    else {
      const version = status.commandVersion ? `，版本 ${status.commandVersion}` : '';
      lines.push(`用${status.appRuntime ? '另一个客户端' : ' Node '}运行（${status.program}${version}）；重新安装可改用这个客户端`);
    }
    if (!status.onPath) {
      lines.push(`${status.binDir} 不在 PATH 里，终端里找不到命令：请把它加进 PATH`);
      warning = true;
    }
  }
  if (status.available) {
    const skills = status.skills ?? [];
    const on = skills.filter((item) => item.enabled !== false);
    const done = on.filter((item) => item.installed && item.current).map((item) => item.name);
    const old = on
      .filter((item) => item.installed && !item.current)
      .map((item) => (item.version && item.version !== status.version ? `${item.name}（${item.version}）` : item.name));
    const missing = on.filter((item) => !item.installed).map((item) => item.name);
    const off = skills.filter((item) => item.enabled === false).map((item) => item.name);
    if (done.length) lines.push(`skill 已装：${done.join('、')}`);
    if (old.length) lines.push(`skill 不是最新的（点“重新安装”更新）：${old.join('、')}`);
    if (missing.length) lines.push(`skill 未装：${missing.join('、')}`);
    if (off.length) lines.push(`skill 已关：${off.join('、')}`);
    const mcp = (status.mcp ?? []).filter((item) => item.registered);
    const mcpOld = mcp.filter((item) => !item.current).map((item) => item.name);
    if (mcp.length) lines.push(`MCP 已登记：${mcp.map((item) => item.name).join('、')}`);
    if (mcpOld.length) lines.push(`MCP 登记指向的不是这个程序（点“重新安装”更新）：${mcpOld.join('、')}`);
  }
  cliViewStatus.textContent = lines.join('\n');
  cliViewStatus.classList.toggle('is-warning', warning);
  cliStatusEl.textContent = !status.available ? '不可用' : !status.installed ? '未安装' : warning ? '需处理' : '已安装';
  cliStatusEl.title = lines.join('\n');
  cliStatusEl.classList.toggle('is-warning', warning);
  cliViewInstall.disabled = !status.available;
  cliViewInstall.textContent = status.installed ? '重新安装' : '安装';
  cliViewUninstall.disabled =
    !status.installed && !(status.skills ?? []).some((item) => item.installed) && !(status.mcp ?? []).some((item) => item.registered);
}

const remoteMessage = (error: unknown) => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function cliAction(action: () => Promise<CliStatus>): Promise<void> {
  cliViewInstall.disabled = cliViewUninstall.disabled = true;
  try {
    renderCli(await action());
    if (!cliView.hidden) await loadCliSettings();
  } catch (error) {
    cliViewStatus.textContent = remoteMessage(error);
    cliViewStatus.classList.add('is-warning');
    cliStatusEl.textContent = '出错';
    cliStatusEl.title = remoteMessage(error);
    cliStatusEl.classList.add('is-warning');
    cliViewInstall.disabled = cliViewUninstall.disabled = false;
  }
}

cliViewInstall.addEventListener('click', () => void cliAction(() => api.cliInstall()));
cliViewUninstall.addEventListener('click', () => {
  if (confirm('卸载命令行 cloudssh、所有 AI 的 skill 与 MCP 登记？（~/.cloudssh 里的配置与登录保留）')) void cliAction(() => api.cliUninstall());
});
void cliAction(() => api.cliStatus());

// ---------- 命令行与 AI 设置页 ----------

const cliSkills = $('cli-skills');
const cliMcp = $('cli-mcp');
const cliFullAccess = $<HTMLInputElement>('cli-full-access');
const cliDefaultInstance = $<HTMLSelectElement>('cli-default-instance');
const cliTimeout = $<HTMLInputElement>('cli-timeout');
const cliConcurrency = $<HTMLInputElement>('cli-concurrency');
const cliAliases = $('cli-aliases');
const cliAliasName = $<HTMLInputElement>('cli-alias-name');
const cliAliasTarget = $<HTMLInputElement>('cli-alias-target');
const cliNotes = $<HTMLTextAreaElement>('cli-notes');
const cliNotesState = $('cli-notes-state');

const prefsView = $('prefs-view');
const navPrefs = $<HTMLButtonElement>('nav-prefs');
const navCli = $<HTMLButtonElement>('cli-open-settings');

/** 右侧显示哪一页：实例表单（带底部按钮栏）、偏好设置、命令行与 Skill */
function showView(view: 'form' | 'prefs' | 'cli'): void {
  form.hidden = view !== 'form';
  actionbar.hidden = view !== 'form';
  prefsView.hidden = view !== 'prefs';
  cliView.hidden = view !== 'cli';
  navPrefs.setAttribute('aria-current', String(view === 'prefs'));
  navCli.setAttribute('aria-current', String(view === 'cli'));
  if (view === 'form') return;
  selectedId = null;
  renderList();
  if (view === 'cli') void loadCliSettings();
}

function showCliView(show: boolean): void {
  showView(show ? 'cli' : 'form');
}

function switchRow(id: string, title: string, hint: string, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const track = document.createElement('span');
  track.className = 'switch-track';
  track.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'switch-text';
  const small = document.createElement('small');
  small.textContent = hint;
  text.append(title, small);
  label.append(input, track, text);
  return label;
}

function renderCliSettings(settings: CliSettings): void {
  cliSettingsState = settings;
  renderCli(settings.status);
  const { config } = settings;
  // skill：每个 AI 一个开关
  cliSkills.replaceChildren();
  const skills = settings.status.skills ?? [];
  if (!skills.length) cliSkills.textContent = '还没有可以装 skill 的 AI';
  for (const item of skills) {
    const enabled = item.enabled ?? config.skills[item.id] !== false;
    const state = enabled
      ? item.installed
        ? item.current
          ? '已装'
          : '已装，设置改了还没同步（点“重新安装”）'
        : settings.status.installed
          ? '开着，还没装（点“重新安装”）'
          : '开着，安装后生效'
      : '关';
    cliSkills.append(
      switchRow(`cli-skill-${item.id}`, item.name, `${state} · ${item.path}`, enabled, (on) =>
        void saveCli({ skills: { ...config.skills, [item.id]: on } })
      )
    );
  }
  // MCP：这台电脑上有的应用（以及已经登记过的）每个一个开关
  cliMcp.replaceChildren();
  const clients = (settings.status.mcp ?? []).filter((item) => item.present || item.registered);
  if (!clients.length) cliMcp.textContent = '这台电脑上没有找到支持 MCP 的应用（Claude Desktop、Cursor、VS Code、Windsurf、Codex）';
  for (const item of clients) {
    const state = item.error
      ? `读不了配置：${item.error}`
      : item.registered
        ? item.current
          ? '已登记'
          : '已登记，指向的不是这个程序（点“重新安装”更新）'
        : '未登记';
    cliMcp.append(switchRow(`cli-mcp-${item.id}`, item.name, `${state} · ${item.path}`, item.registered, (on) => void saveMcp(item.id, on)));
  }
  cliFullAccess.checked = config.confirm === 'never';
  // 默认实例
  cliDefaultInstance.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = settings.instances.length ? '（未设置：只有一个已登录的实例时用它）' : '（还没有实例）';
  cliDefaultInstance.append(none);
  for (const instance of settings.instances) {
    const option = document.createElement('option');
    option.value = instance.url;
    option.textContent = `${instance.name}（${hostOf(instance.url)}）${instance.signedIn ? '' : ' · 未登录'}`;
    cliDefaultInstance.append(option);
  }
  cliDefaultInstance.value = config.defaultInstance ?? '';
  cliTimeout.value = String(config.timeout);
  cliConcurrency.value = String(config.concurrency);
  // 别名
  cliAliases.replaceChildren();
  for (const [name, target] of Object.entries(config.aliases)) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = name;
    const arrow = document.createElement('span');
    arrow.textContent = '→';
    arrow.className = 'muted';
    const value = document.createElement('span');
    value.className = 'alias-target';
    value.textContent = target;
    value.title = target;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link';
    remove.textContent = '删除';
    remove.addEventListener('click', () => {
      const next = { ...config.aliases };
      delete next[name];
      void saveCli({ aliases: next });
    });
    li.append(code, arrow, value, remove);
    cliAliases.append(li);
  }
  if (document.activeElement !== cliNotes) cliNotes.value = config.skillNotes;
}

async function loadCliSettings(): Promise<void> {
  cliError.textContent = '';
  try {
    renderCliSettings(await api.cliSettings());
  } catch (error) {
    cliError.textContent = remoteMessage(error);
  }
}

async function saveCli(patch: Partial<CliConfigView>): Promise<boolean> {
  cliError.textContent = '';
  try {
    renderCliSettings(await api.setCliSettings(patch));
    return true;
  } catch (error) {
    cliError.textContent = remoteMessage(error);
    if (cliSettingsState) renderCliSettings(cliSettingsState);
    return false;
  }
}

/** MCP 开关：写进（或移出）那个应用的配置，再整页刷新 */
async function saveMcp(id: string, on: boolean): Promise<void> {
  cliError.textContent = '';
  for (const input of cliMcp.querySelectorAll('input')) input.disabled = true;
  try {
    const status = await api.setCliMcp(id, on);
    if (cliSettingsState) renderCliSettings({ ...cliSettingsState, status });
  } catch (error) {
    cliError.textContent = remoteMessage(error);
    if (cliSettingsState) renderCliSettings(cliSettingsState);
  }
}

navCli.addEventListener('click', () => showCliView(true));
navPrefs.addEventListener('click', () => showView('prefs'));
api.onShowView?.((view) => {
  if (view === 'cli') showCliView(true);
});
cliFullAccess.addEventListener('change', () => {
  if (cliFullAccess.checked && !confirm('打开完全权限？AI 和命令行执行危险命令（删除、关机、改权限……）时不再要求确认。')) {
    cliFullAccess.checked = false;
    return;
  }
  void saveCli({ confirm: cliFullAccess.checked ? 'never' : 'ask' });
});
cliDefaultInstance.addEventListener('change', () => {
  if (cliDefaultInstance.value) void saveCli({ defaultInstance: cliDefaultInstance.value });
});
for (const [input, key] of [
  [cliTimeout, 'timeout'],
  [cliConcurrency, 'concurrency'],
] as const) {
  input.addEventListener('change', () => void saveCli({ [key]: Number(input.value) }));
}
$('cli-alias-add').addEventListener('click', async () => {
  const name = cliAliasName.value.trim();
  const target = cliAliasTarget.value.trim();
  if (!name || !target || !cliSettingsState) {
    cliError.textContent = '别名的名字和目标都要填';
    return;
  }
  if (await saveCli({ aliases: { ...cliSettingsState.config.aliases, [name]: target } })) {
    cliAliasName.value = '';
    cliAliasTarget.value = '';
  }
});
cliNotes.addEventListener('input', () => {
  cliNotesState.textContent = cliSettingsState && cliNotes.value !== cliSettingsState.config.skillNotes ? '未保存' : '';
});
$('cli-notes-save').addEventListener('click', async () => {
  if (await saveCli({ skillNotes: cliNotes.value })) cliNotesState.textContent = '已保存，已写进 skill';
});

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
      proxy: fieldDirect.checked ? 'direct' : undefined,
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
    const result = await api.testInstance(baseUrl, { direct: fieldDirect.checked });
    if (result.ok && result.config) {
      const auth =
        result.config.authMode === 'github'
          ? 'GitHub 登录'
          : result.config.authMode === 'password'
            ? '管理员密码登录'
            : '匿名';
      const lines = [
        `连接正常（${result.latencyMs} ms，${routeText(result.route)}）· 认证模式：${auth}${
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
      testResult.textContent = `连接失败（${routeText(result.route)}）：${result.error ?? '未知错误'}`;
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
prefCliSync.addEventListener('change', () => void run(() => api.setPreferences({ cliLoginSync: prefCliSync.checked })));
prefQuickConnect.addEventListener('click', () => {
  if (recordingShortcut) return;
  recordingShortcut = true;
  renderShortcut();
  void api.setShortcutRecording(true);
});
prefQuickConnect.addEventListener('keydown', (event) => {
  if (!recordingShortcut) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') void stopRecording();
  else if (event.key === 'Backspace' || event.key === 'Delete') void stopRecording('');
  else {
    const accelerator = acceleratorFrom(event);
    if (accelerator) void stopRecording(accelerator);
  }
});
prefQuickConnect.addEventListener('blur', () => void stopRecording());
prefQuickConnectToggle.addEventListener('click', () =>
  void run(() => api.setPreferences({ quickConnectShortcut: state?.preferences.quickConnectShortcut ? '' : DEFAULT_QUICK_CONNECT }))
);

$('open-config').addEventListener('click', () => void api.openPath('config'));
$('open-logs').addEventListener('click', () => void api.openPath('logs'));

// ---------- 跟随主题 ----------

const PALETTE_VARS: [keyof Palette, string][] = [
  ['bg', '--bg'],
  ['surface', '--surface'],
  ['elevated', '--elevated'],
  ['border', '--border'],
  ['borderStrong', '--border-strong'],
  ['text', '--text'],
  ['muted', '--muted'],
  ['accent', '--accent'],
  ['onAccent', '--on-accent'],
  ['danger', '--danger'],
];

/** 把实例页面的配色写到 :root 上；表单控件、滚动条按背景深浅选 color-scheme */
function applyPalette(palette: Palette | null): void {
  const root = document.documentElement;
  if (!palette) return;
  for (const [key, name] of PALETTE_VARS) {
    if (/^#[0-9a-f]{6}$/i.test(palette[key] ?? '')) root.style.setProperty(name, palette[key]);
  }
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(palette.bg.slice(index, index + 2), 16) / 255);
  const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
  root.dataset.palette = '';
  root.dataset.scheme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
}

void api.palette?.().then(applyPalette).catch(() => undefined);
api.onPalette?.(applyPalette);

api.onChanged((next) => applyState(next));
void refresh().then(() => {
  if (location.hash === '#cli') showCliView(true);
});
