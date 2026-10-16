/**
 * 自动更新预留接口。
 *
 * 第一版不内置更新服务器。接入时推荐 electron-updater：
 *   1. pnpm --filter @cloudssh/desktop add electron-updater
 *   2. 在 electron-builder.yml 配置 publish（github / generic 均可）
 *   3. 实现下面的 UpdateProvider 并在 index.ts 里替换 NoopUpdater
 * 界面层只依赖 UpdateProvider，不直接依赖具体更新库。
 */
import { createLogger } from '../logger';

const log = createLogger('updater');

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }
  | { state: 'disabled'; reason: string };

export interface UpdateProvider {
  readonly name: string;
  check(): Promise<UpdateStatus>;
  quitAndInstall(): void;
  onStatus(listener: (status: UpdateStatus) => void): () => void;
}

export class NoopUpdater implements UpdateProvider {
  readonly name = 'noop';

  async check(): Promise<UpdateStatus> {
    const status: UpdateStatus = { state: 'disabled', reason: '当前版本未配置自动更新' };
    log.info(status.reason);
    return status;
  }

  quitAndInstall(): void {
    // 未配置更新源，无操作
  }

  onStatus(): () => void {
    return () => undefined;
  }
}

let current: UpdateProvider = new NoopUpdater();

export function getUpdater(): UpdateProvider {
  return current;
}

export function setUpdater(provider: UpdateProvider): void {
  current = provider;
}
