/**
 * 连接与配置层：实例列表、默认实例、窗口状态与偏好设置。
 * 持久化到 <userData>/config.json（原子写入，损坏时自动备份并回退默认值）。
 */
import {
  DEFAULT_INSTANCE,
  type InstanceConfig,
  InstanceConfigError,
  normalizeInstance,
  normalizeWorkerUrl,
} from '@cloudssh/core';
import { app } from 'electron';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger';

const log = createLogger('config');

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface Preferences {
  /** 关闭主窗口时隐藏到托盘而不是退出（保持 SSH 会话） */
  closeToTray: boolean;
  /** 显示窗口菜单栏（默认隐藏，快捷键照常可用） */
  showMenuBar: boolean;
}

export interface AppConfig {
  version: 1;
  instances: InstanceConfig[];
  defaultInstanceId: string;
  window: WindowState;
  preferences: Preferences;
}

export const DEFAULT_PREFERENCES: Preferences = {
  closeToTray: false,
  showMenuBar: false,
};

const DEFAULT_WINDOW: WindowState = { width: 1280, height: 820, maximized: false };

function initialInstance(): InstanceConfig {
  // 首次运行可用环境变量指定默认 Worker：CLOUDSSH_WORKER_URL=https://xxx.workers.dev
  const envUrl = process.env.CLOUDSSH_WORKER_URL;
  if (envUrl) {
    try {
      return { ...DEFAULT_INSTANCE, baseUrl: normalizeWorkerUrl(envUrl) };
    } catch (error) {
      log.warn('忽略非法的 CLOUDSSH_WORKER_URL：', (error as Error).message);
    }
  }
  return { ...DEFAULT_INSTANCE };
}

function defaultConfig(): AppConfig {
  const instance = initialInstance();
  return {
    version: 1,
    instances: [instance],
    defaultInstanceId: instance.id,
    window: { ...DEFAULT_WINDOW },
    preferences: { ...DEFAULT_PREFERENCES },
  };
}

function normalizeConfig(raw: unknown): AppConfig {
  const fallback = defaultConfig();
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Partial<AppConfig>;
  const instances: InstanceConfig[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value.instances) ? value.instances : []) {
    try {
      const instance = normalizeInstance(item);
      if (!seen.has(instance.id)) {
        seen.add(instance.id);
        instances.push(instance);
      }
    } catch (error) {
      log.warn('跳过无效实例配置：', (error as Error).message);
    }
  }
  if (instances.length === 0) instances.push(...fallback.instances);
  const defaultInstanceId =
    typeof value.defaultInstanceId === 'string' && seen.has(value.defaultInstanceId)
      ? value.defaultInstanceId
      : instances[0].id;
  const win = (value.window ?? {}) as Partial<WindowState>;
  const prefs = (value.preferences ?? {}) as Partial<Preferences>;
  return {
    version: 1,
    instances,
    defaultInstanceId,
    window: {
      x: Number.isFinite(win.x) ? win.x : undefined,
      y: Number.isFinite(win.y) ? win.y : undefined,
      width: Number.isFinite(win.width) && win.width! >= 360 ? win.width! : DEFAULT_WINDOW.width,
      height: Number.isFinite(win.height) && win.height! >= 400 ? win.height! : DEFAULT_WINDOW.height,
      maximized: win.maximized === true,
    },
    preferences: {
      closeToTray: typeof prefs.closeToTray === 'boolean' ? prefs.closeToTray : DEFAULT_PREFERENCES.closeToTray,
      showMenuBar: typeof prefs.showMenuBar === 'boolean' ? prefs.showMenuBar : DEFAULT_PREFERENCES.showMenuBar,
    },
  };
}

class ConfigStore extends EventEmitter {
  private config: AppConfig = defaultConfig();
  private filePath = '';

  load(): void {
    this.filePath = path.join(app.getPath('userData'), 'config.json');
    if (!fs.existsSync(this.filePath)) {
      this.config = defaultConfig();
      this.persist();
      log.info('已创建默认配置', this.filePath);
      return;
    }
    try {
      this.config = normalizeConfig(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      const backup = `${this.filePath}.broken-${Date.now()}`;
      log.error('配置文件损坏，已备份到', backup, error);
      try {
        fs.copyFileSync(this.filePath, backup);
      } catch {
        // 备份失败也继续用默认配置启动
      }
      this.config = defaultConfig();
      this.persist();
    }
  }

  get path(): string {
    return this.filePath;
  }

  get snapshot(): AppConfig {
    return structuredClone(this.config);
  }

  get instances(): InstanceConfig[] {
    return structuredClone(this.config.instances);
  }

  get preferences(): Preferences {
    return { ...this.config.preferences };
  }

  get windowState(): WindowState {
    return { ...this.config.window };
  }

  get defaultInstanceId(): string {
    return this.config.defaultInstanceId;
  }

  getInstance(id: string): InstanceConfig | undefined {
    const found = this.config.instances.find((instance) => instance.id === id);
    return found ? structuredClone(found) : undefined;
  }

  getDefaultInstance(): InstanceConfig {
    return this.getInstance(this.config.defaultInstanceId) ?? structuredClone(this.config.instances[0]);
  }

  /** 新增或更新实例（按 id 匹配）。返回规范化后的实例。 */
  upsertInstance(input: unknown): InstanceConfig {
    const instance = normalizeInstance(input);
    const index = this.config.instances.findIndex((item) => item.id === instance.id);
    const previous = index >= 0 ? this.config.instances[index] : undefined;
    if (index >= 0) this.config.instances[index] = instance;
    else this.config.instances.push(instance);
    this.persist();
    this.emit('instances-changed', { instance, previous });
    return structuredClone(instance);
  }

  removeInstance(id: string): void {
    if (this.config.instances.length <= 1) {
      throw new InstanceConfigError('至少需要保留一个实例');
    }
    const before = this.config.instances.length;
    this.config.instances = this.config.instances.filter((instance) => instance.id !== id);
    if (this.config.instances.length === before) return;
    if (this.config.defaultInstanceId === id) this.config.defaultInstanceId = this.config.instances[0].id;
    this.persist();
    this.emit('instances-changed', { removedId: id });
  }

  setDefaultInstance(id: string): void {
    if (!this.config.instances.some((instance) => instance.id === id)) {
      throw new InstanceConfigError(`实例不存在：${id}`);
    }
    this.config.defaultInstanceId = id;
    this.persist();
    this.emit('instances-changed', {});
  }

  setPreferences(patch: Partial<Preferences>): Preferences {
    const next = { ...this.config.preferences };
    if (typeof patch.closeToTray === 'boolean') next.closeToTray = patch.closeToTray;
    if (typeof patch.showMenuBar === 'boolean') next.showMenuBar = patch.showMenuBar;
    this.config.preferences = next;
    this.persist();
    this.emit('preferences-changed', next);
    return { ...next };
  }

  setWindowState(state: WindowState): void {
    this.config.window = { ...state };
    this.persist();
  }

  private persist(): void {
    if (!this.filePath) return;
    const tmp = `${this.filePath}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

export const configStore = new ConfigStore();
