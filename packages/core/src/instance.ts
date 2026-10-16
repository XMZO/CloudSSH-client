/**
 * 实例（Worker 部署）配置模型。
 *
 * 一个“实例”= 一个已部署的 CloudSSH Worker 地址 + 该实例使用的 UI 来源。
 * 桌面端按实例隔离 Cookie/LocalStorage（每个实例一个独立会话分区），
 * 移动端/自研 UI 可直接复用这里的类型与校验逻辑。
 */

/** 默认 Worker 地址（可在实例管理中修改或新增其他实例） */
export const DEFAULT_WORKER_URL = 'https://cloudssh.example.workers.dev';

/**
 * UI 来源。UI 层与连接层解耦：无论哪种来源，页面都运行在 Worker 的 origin 下，
 * 因此相对路径 `/api`、同源 WebSocket、HttpOnly Session Cookie 全部原样可用。
 *
 * - `bundled`：客户端内置的 UI 包（默认 `web`，即网页版前端的同步副本）
 * - `remote`：直接使用 Worker 自己返回的页面（永远与服务端版本一致）
 * - `directory`：任意本地静态目录（自研 UI 的接入点，入口为 index.html）
 * - `dev-server`：UI 开发服务器（如 Vite），用于开发自研/改版 UI 时热更新
 */
export type UiSource =
  | { kind: 'bundled'; id?: string }
  | { kind: 'remote' }
  | { kind: 'directory'; path: string }
  | { kind: 'dev-server'; url: string };

export type UiSourceKind = UiSource['kind'];

export interface InstanceConfig {
  /** 稳定 ID：用于会话分区名，创建后不可修改，否则会丢失登录状态 */
  id: string;
  /** 展示名称 */
  name: string;
  /** Worker 根地址（规范化后只含 origin，例如 https://example.workers.dev） */
  baseUrl: string;
  /** UI 来源 */
  ui: UiSource;
}

export const DEFAULT_UI_SOURCE: UiSource = { kind: 'bundled', id: 'web' };

export const DEFAULT_INSTANCE: InstanceConfig = {
  id: 'default',
  name: 'CloudSSH',
  baseUrl: DEFAULT_WORKER_URL,
  ui: DEFAULT_UI_SOURCE,
};

export class InstanceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * 规范化 Worker 地址：只保留 origin。
 * - 仅允许 https；本地开发（wrangler dev）允许 http://localhost / 127.0.0.1 / [::1]
 * - 拒绝带用户名密码的地址
 * - 自动补全协议（输入 `foo.workers.dev` 视为 https）
 */
export function normalizeWorkerUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new InstanceConfigError('Worker 地址不能为空');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InstanceConfigError(`无法解析 Worker 地址：${raw}`);
  }
  if (url.username || url.password) {
    throw new InstanceConfigError('Worker 地址不能包含用户名或密码');
  }
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new InstanceConfigError('仅本地开发地址（localhost）允许使用 http，其余必须使用 https');
    }
  } else if (url.protocol !== 'https:') {
    throw new InstanceConfigError(`不支持的协议：${url.protocol}`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new InstanceConfigError('Worker 地址只能是根地址，不能带路径');
  }
  return url.origin;
}

/** 实例 ID 只允许小写字母、数字、连字符（用于会话分区名与文件名） */
export function isValidInstanceId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/** 由名称生成可读且唯一的实例 ID */
export function createInstanceId(name: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'instance';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function normalizeUiSource(input: unknown): UiSource {
  if (!input || typeof input !== 'object') return DEFAULT_UI_SOURCE;
  const value = input as Record<string, unknown>;
  switch (value.kind) {
    case 'remote':
      return { kind: 'remote' };
    case 'bundled':
      return {
        kind: 'bundled',
        id: typeof value.id === 'string' && /^[a-z0-9-]{1,64}$/.test(value.id) ? value.id : 'web',
      };
    case 'directory':
      if (typeof value.path === 'string' && value.path.trim()) {
        return { kind: 'directory', path: value.path.trim() };
      }
      throw new InstanceConfigError('directory 类型的 UI 来源必须提供 path');
    case 'dev-server': {
      if (typeof value.url !== 'string') {
        throw new InstanceConfigError('dev-server 类型的 UI 来源必须提供 url');
      }
      let url: URL;
      try {
        url = new URL(value.url);
      } catch {
        throw new InstanceConfigError(`无法解析 UI 开发服务器地址：${value.url}`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new InstanceConfigError('UI 开发服务器只支持 http/https');
      }
      return { kind: 'dev-server', url: url.origin };
    }
    default:
      return DEFAULT_UI_SOURCE;
  }
}

/** 校验并规范化一个实例配置（用于读取持久化数据或用户输入） */
export function normalizeInstance(input: unknown): InstanceConfig {
  if (!input || typeof input !== 'object') throw new InstanceConfigError('实例配置格式错误');
  const value = input as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id : '';
  if (!isValidInstanceId(id)) throw new InstanceConfigError(`非法实例 ID：${id || '(空)'}`);
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 64) : id;
  const baseUrl = normalizeWorkerUrl(typeof value.baseUrl === 'string' ? value.baseUrl : '');
  return { id, name, baseUrl, ui: normalizeUiSource(value.ui) };
}

export function describeUiSource(ui: UiSource): string {
  switch (ui.kind) {
    case 'bundled':
      return `内置 UI（${ui.id ?? 'web'}）`;
    case 'remote':
      return '跟随 Worker（远程页面）';
    case 'directory':
      return `本地目录（${ui.path}）`;
    case 'dev-server':
      return `开发服务器（${ui.url}）`;
  }
}
