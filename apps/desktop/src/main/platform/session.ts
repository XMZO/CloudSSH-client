/**
 * 平台适配层：实例会话。
 *
 * 每个实例一个持久化分区（persist:instance-<id>），Cookie / LocalStorage / 缓存完全隔离：
 * 同一个 Worker 也可以配成两个实例登录两个 GitHub 账号。
 */
import { type InstanceConfig, isSameInstanceOrigin, originOf } from '@cloudssh/core';
import { app, session, type Session } from 'electron';
import path from 'node:path';
import { createLogger, isDebug } from '../logger';
import { resolveUi, type ResolvedUi } from '../ui/providers';
import { claimDragDownload } from './drag-out';
import { applyOriginBridge } from './origin-bridge';
import { clearUiCache } from './ui-cache';

const log = createLogger('session');

/** 网页版实际需要的权限：剪贴板读写（终端粘贴）、通知、全屏 */
const ALLOWED_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'notifications',
  'fullscreen',
]);

const configured = new WeakSet<Session>();
const instanceOfSession = new WeakMap<Session, string>();
const baseUrlOfSession = new WeakMap<Session, string>();

export function instancePartition(id: string): string {
  return `persist:instance-${id}`;
}

export function oauthPartition(id: string): string {
  return `persist:oauth-${id}`;
}

export function getInstanceSession(instance: InstanceConfig): Session {
  const ses = session.fromPartition(instancePartition(instance.id));
  instanceOfSession.set(ses, instance.id);
  baseUrlOfSession.set(ses, instance.baseUrl);
  if (!configured.has(ses)) {
    configureSession(ses);
    configured.add(ses);
  }
  return ses;
}

function isFromInstance(ses: Session, url: string | undefined): boolean {
  const baseUrl = baseUrlOfSession.get(ses);
  return !!baseUrl && !!url && isSameInstanceOrigin(url, baseUrl);
}

function configureSession(ses: Session): void {
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission) && isFromInstance(ses, details.requestingUrl);
    if (!allowed) log.debug('拒绝权限请求', permission, details.requestingUrl);
    callback(allowed);
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isFromInstance(ses, requestingOrigin);
  });

  // SFTP 下载、终端日志导出、审计导出都走 <a download>：弹出系统保存对话框，默认目录为“下载”。
  // 设置 CLOUDSSH_DOWNLOAD_DIR 时直接保存到该目录、不弹对话框（自动化测试/批量下载用）。
  const downloadDir = process.env.CLOUDSSH_DOWNLOAD_DIR;
  ses.on('will-download', (_event, item, webContents) => {
    // 正在准备拖到桌面的 SFTP 文件：存进临时目录，不弹保存框（drag-out.ts）
    if (claimDragDownload(item, webContents)) return;
    if (downloadDir) {
      item.setSavePath(path.join(path.resolve(downloadDir), path.basename(item.getFilename())));
    } else {
      item.setSaveDialogOptions({
        title: '保存文件',
        defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
      });
    }
    item.once('done', (_e, state) => log.info('下载结束', item.getFilename(), state, item.getReceivedBytes(), 'bytes'));
  });

  if (isDebug) {
    // 调试：记录 WebSocket 握手结果（403 = Origin 被拒，401 = 未登录）
    ses.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType === 'webSocket') {
        log.debug('WebSocket 握手', details.statusCode, new URL(details.url).pathname);
      }
      callback({});
    });
  }
}

export interface PreparedSession {
  session: Session;
  ui: ResolvedUi;
  warning?: string;
}

/** 为实例准备会话并按 UI 来源挂载 origin bridge */
export function prepareInstanceSession(instance: InstanceConfig): PreparedSession {
  const ses = getInstanceSession(instance);
  const { ui, warning } = resolveUi(instance.ui);
  applyOriginBridge(ses, instance.baseUrl, ui);
  if (warning) log.warn(warning);
  return { session: ses, ui, warning };
}

/** 清除实例的登录状态与网页数据（含独立登录窗口里的 GitHub 登录） */
export async function clearInstanceData(instance: InstanceConfig): Promise<void> {
  const ses = getInstanceSession(instance);
  await ses.clearStorageData();
  await ses.clearCache();
  clearUiCache(instance.id);
  await session.fromPartition(oauthPartition(instance.id)).clearStorageData();
  log.info('已清除实例数据', instance.id, originOf(instance.baseUrl));
}
