/**
 * 平台适配层：实例会话。
 *
 * 每个实例一个持久化分区（persist:instance-<id>），Cookie / LocalStorage / 缓存完全隔离：
 * 同一个 Worker 也可以配成两个实例登录两个 GitHub 账号。
 */
import { type InstanceConfig, isSameInstanceOrigin, originOf } from '@cloudssh/core';
import { app, session, type Session } from 'electron';
import path from 'node:path';
import { createLogger } from '../logger';
import { connectionEndpoint } from '../connection-log-data';
import { trackInstanceNetwork } from '../network-env';
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
  trackInstanceNetwork(instance.id, ses, instance.baseUrl);
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

/**
 * 恢复握手（带 resume_token 的 /api/ssh）没有升级成 WebSocket 时状态码的含义（CloudSSH Worker 在握手前拒绝）。
 * 404 最常见：Worker 这边没有处于保持期的这个会话——经过代理 / TUN 时它还没察觉旧连接断开（过几秒再试能接上），
 * 或者保持期已过、Worker 重新部署过（会话真没了）
 */
const RESUME_REJECT_MEANING: Record<number, string> = {
  401: 'not-signed-in',
  403: 'resume-token-or-device-rejected',
  404: 'session-not-in-grace-period',
  429: 'rate-limited',
};

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

  // 安装版默认开启。Electron 的这些事件只覆盖 WS 握手，帧和关闭原因由 UI 补充。
  // 只注册一组监听器，避免 Electron 同类 webRequest 监听器互相覆盖。
  // 带上过滤条件：不带时会话里每个请求（脚本、图片、字体、所有 API）都要先绕主进程一趟；
  // 这几种写法用 Electron 44 实测过，只匹配 WebSocket 握手与健康检查
  const filter = { urls: ['ws://*/*', 'wss://*/*', '*://*/api/health*'] };
  const networkLog = createLogger('connection-network');
  const pending = new Map<number, number>();
  const tracked = (details: { url: string; resourceType: string }) => {
    try {
      const url = new URL(details.url);
      url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
      return isFromInstance(ses, url.href) &&
        (details.resourceType === 'webSocket' || url.pathname === '/api/health');
    } catch { return false; }
  };
  const metadata = (details: { id: number; url: string; webContentsId?: number; timestamp: number }) => ({
    instance: instanceOfSession.get(ses), window: details.webContentsId, requestId: details.id,
    ...connectionEndpoint(details.url),
    durationMs: pending.has(details.id) ? Math.max(0, details.timestamp - pending.get(details.id)!) : undefined,
  });
  ses.webRequest.onBeforeRequest(filter, (details, callback) => {
    try {
      if (tracked(details)) {
        if (pending.size >= 512) pending.delete(pending.keys().next().value!);
        pending.set(details.id, details.timestamp);
        networkLog.info('request-start', metadata(details));
      }
    } finally { callback({}); }
  });
  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    try {
      if (tracked(details)) {
        const info = metadata(details);
        networkLog.info('response-headers', { ...info, status: details.statusCode });
        // 恢复握手被拒单独记一行，一眼能看出原会话为什么没接上
        if (info.resume && details.statusCode !== 101) {
          networkLog.warn('resume-rejected', { ...info, status: details.statusCode, meaning: RESUME_REJECT_MEANING[details.statusCode] ?? 'other' });
        }
      }
    } finally { callback({}); }
  });
  ses.webRequest.onCompleted(filter, (details) => {
    if (!tracked(details)) return;
    networkLog.info('request-completed', { ...metadata(details), status: details.statusCode, fromCache: details.fromCache });
    pending.delete(details.id);
  });
  ses.webRequest.onErrorOccurred(filter, (details) => {
    if (!tracked(details)) return;
    const info = metadata(details);
    networkLog.warn(info.resume ? 'resume-failed' : 'request-failed', { ...info, error: details.error });
    pending.delete(details.id);
  });
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
