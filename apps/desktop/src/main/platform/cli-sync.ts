/**
 * 平台适配层：把登录同步给命令行（packages/cli 的 cloudssh）。
 *
 * 命令行不开客户端也能用，但它要 CloudSSH 的 session Cookie 才能调接口，而 GitHub 登录只能在浏览器里完成。
 * 偏好设置“同步登录给命令行”打开时，客户端运行期间把每个实例分区里的 session Cookie 写进
 * ~/.cloudssh/credentials.json（来源记为 desktop），登录、重新登录、退出时跟着更新；也把实例登记进命令行的
 * config.json。关掉时删掉所有来源为 desktop 的会话（命令行自己 cloudssh login 的不动）。
 * 会话 7 天有效：客户端隔几天打开一次，命令行就一直能用。
 */
import { type InstanceConfig, originOf, SESSION_COOKIE_NAME } from '@cloudssh/core';
import type { Cookie } from 'electron';
import {
  loadConfig,
  loadCredentials,
  rememberInstance,
  saveConfig,
  saveCredential,
} from '../../../../../packages/cli/src/config';
import { configStore } from '../config/store';
import { createLogger } from '../logger';
import { getInstanceSession } from './session';

const log = createLogger('cli-sync');

const watched = new WeakSet<object>();
let enabled = false;

function writeSession(instance: InstanceConfig, cookie: Cookie | null): void {
  const origin = originOf(instance.baseUrl) ?? instance.baseUrl;
  try {
    const current = loadCredentials()[origin];
    if (!cookie?.value) {
      // 退出登录：只删客户端同步过去的
      if (current?.source === 'desktop') saveCredential(origin, null);
      return;
    }
    if (current?.session === cookie.value) return;
    // Cookie 有 7 天的过期时间：倒推出登录时间，命令行据此显示到期时间
    const savedAt = cookie.expirationDate ? new Date(cookie.expirationDate * 1000 - 7 * 24 * 3600_000) : new Date();
    saveCredential(origin, { session: cookie.value, source: 'desktop', savedAt: savedAt.toISOString(), user: current?.user });
    const config = loadConfig();
    rememberInstance(config, origin, instance.name);
    saveConfig(config);
    log.info('已同步登录给命令行', origin);
  } catch (error) {
    log.warn('同步登录给命令行失败', (error as Error).message);
  }
}

async function syncInstance(instance: InstanceConfig): Promise<void> {
  const ses = getInstanceSession(instance);
  const cookies = await ses.cookies.get({ url: instance.baseUrl, name: SESSION_COOKIE_NAME }).catch(() => []);
  writeSession(instance, cookies[0] ?? null);
  if (watched.has(ses)) return;
  watched.add(ses);
  ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (!enabled || cookie.name !== SESSION_COOKIE_NAME) return;
    const current = configStore.getInstance(instance.id);
    if (!current) return;
    const host = new URL(current.baseUrl).hostname;
    if (cookie.domain && cookie.domain.replace(/^\./, '') !== host) return;
    writeSession(current, removed ? null : cookie);
  });
}

/** 按偏好设置开关同步（启动、改偏好、增删实例时调用） */
export function applyCliSync(on: boolean): void {
  enabled = on;
  if (on) {
    for (const instance of configStore.instances) void syncInstance(instance);
    return;
  }
  try {
    for (const [origin, credential] of Object.entries(loadCredentials())) {
      if (credential.source === 'desktop') saveCredential(origin, null);
    }
  } catch (error) {
    log.warn('清除同步给命令行的登录失败', (error as Error).message);
  }
}
