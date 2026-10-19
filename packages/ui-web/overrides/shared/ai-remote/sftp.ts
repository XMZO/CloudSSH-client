/**
 * 无界面的 SFTP 通道：服务器之间不能直连时，文件经客户端中转（从源服务器下载、再上传到目标）。
 *
 * 用无界面会话（session.ts）收到的 sftp_attach 地址连 Worker 的 SFTP WebSocket，协议与网页版 SFTP 面板一致：
 *   sftp_init → sftp_ready；下载 sftp_download → sftp_download_start / 二进制分块 / sftp_download_done；
 *   上传 sftp_upload_start → sftp_upload_ready → 按窗口发送二进制分块、等 sftp_upload_progress 确认
 *   → sftp_upload_end（带 SHA-256）→ sftp_upload_complete（Worker 校验哈希）。
 * 分块大小与窗口用网页版同一份策略（直连 / 隧道不同）。中转的文件整个放在内存里，调用方负责限制大小。
 */
import { StreamingSHA256 } from '../../../upstream/frontend/src/sha256-stream';
import { getSFTPUploadPolicy } from '../../../upstream/src/sftp-upload-policy';

type Message = Record<string, unknown> & { type?: string };

const OPEN_TIMEOUT_MS = 20_000;
const STEP_TIMEOUT_MS = 60_000;
const PING_MS = 20_000;

export class HeadlessSftp {
  private ws: WebSocket | null = null;
  private inbox: Message[] = [];
  private binary: ((chunk: Uint8Array) => void) | null = null;
  private wake: (() => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedReason: string | null = null;
  private isTunnel = false;

  static async open(url: string): Promise<HeadlessSftp> {
    const sftp = new HeadlessSftp();
    try {
      await sftp.connect(url);
    } catch (error) {
      sftp.close();
      throw error;
    }
    return sftp;
  }

  private connect(url: string): Promise<void> {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        this.binary?.(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      try {
        this.inbox.push(JSON.parse(event.data) as Message);
      } catch {
        return;
      }
      this.wake?.();
    };
    ws.onclose = (event) => {
      this.closedReason ??= `SFTP 连接已关闭（${event.code}）`;
      this.stopPing();
      this.wake?.();
    };
    ws.onerror = () => {
      this.closedReason ??= 'SFTP 连接失败';
      this.wake?.();
    };
    ws.onopen = () => {
      this.send({ type: 'sftp_init' });
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_MS);
    };
    return this.take((msg) => msg.type === 'sftp_ready', OPEN_TIMEOUT_MS).then((msg) => {
      this.isTunnel = msg.isTunnel === true;
    });
  }

  private send(value: Message | Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(value instanceof Uint8Array ? value : JSON.stringify(value));
  }

  /** 取下一条符合条件的消息；sftp_error / sftp_closed / 断线时抛错 */
  private take(match: (msg: Message) => boolean, timeoutMs: number): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('SFTP 响应超时')), timeoutMs);
      const finish = (error: Error | null, msg?: Message) => {
        clearTimeout(timer);
        if (this.wake === check) this.wake = null;
        if (error) reject(error);
        else resolve(msg!);
      };
      const check = () => {
        for (let i = 0; i < this.inbox.length; i++) {
          const msg = this.inbox[i];
          if (msg.type === 'sftp_error') {
            this.inbox.splice(i, 1);
            return finish(new Error(typeof msg.message === 'string' ? msg.message : 'SFTP 操作失败'));
          }
          if (msg.type === 'sftp_closed') return finish(new Error('SFTP 会话已关闭'));
          if (match(msg)) {
            this.inbox.splice(i, 1);
            return finish(null, msg);
          }
        }
        if (this.closedReason) finish(new Error(this.closedReason));
      };
      this.wake = check;
      check();
    });
  }

  /** 下载整个文件到内存；超过 maxBytes 时取消 */
  async download(path: string, maxBytes: number, onProgress?: (loaded: number, total: number) => void): Promise<Blob> {
    const chunks: Uint8Array[] = [];
    let received = 0;
    let overflow = false;
    this.inbox = [];
    this.binary = (chunk) => {
      if (overflow) return;
      received += chunk.byteLength;
      if (received > maxBytes) {
        overflow = true;
        this.send({ type: 'sftp_download_cancel' });
        return;
      }
      chunks.push(chunk);
    };
    try {
      this.send({ type: 'sftp_download', path });
      const start = await this.take((msg) => msg.type === 'sftp_download_start', STEP_TIMEOUT_MS);
      const total = Number(start.size) || 0;
      if (total > maxBytes) {
        this.send({ type: 'sftp_download_cancel' });
        throw new Error(`文件太大（${total} 字节），超过中转上限`);
      }
      for (;;) {
        const msg = await this.take(
          (m) => m.type === 'sftp_download_progress' || m.type === 'sftp_download_done' || m.type === 'sftp_download_cancelled',
          STEP_TIMEOUT_MS
        );
        if (msg.type === 'sftp_download_progress') onProgress?.(Number(msg.loaded) || received, total);
        else if (msg.type === 'sftp_download_cancelled' || overflow) throw new Error('文件超过中转上限，已取消');
        else break;
      }
      return new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
    } finally {
      this.binary = null;
    }
  }

  /** 上传（覆盖目标文件，是否允许覆盖由调用方事先决定） */
  async upload(path: string, blob: Blob, onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const policy = getSFTPUploadPolicy(this.isTunnel);
    const hasher = new StreamingSHA256();
    const size = blob.size;
    this.inbox = [];
    this.send({ type: 'sftp_upload_start', path, size, overwrite: true });
    const ready = await this.take((m) => m.type === 'sftp_upload_ready' || m.type === 'sftp_upload_conflict', STEP_TIMEOUT_MS);
    if (ready.type !== 'sftp_upload_ready') throw new Error('目标文件已存在且无法覆盖');
    if (ready.isTunnel !== undefined) this.isTunnel = ready.isTunnel === true;
    const reader = blob.stream().getReader();
    let pending: Uint8Array | null = null;
    let pendingOffset = 0;
    let sent = 0;
    let acked = 0;
    let windowBytes = policy.initialWindowBytes;
    try {
      while (sent < size || acked < size) {
        while (sent < size && sent - acked < windowBytes) {
          while (!pending || pendingOffset >= pending.length) {
            const { done, value } = await reader.read();
            if (done) throw new Error('读取中转数据时提前结束');
            pending = value;
            pendingOffset = 0;
          }
          const end = Math.min(pendingOffset + policy.chunkSize, pending.length);
          // 复制一份再发：手机端经原生层转发，不依赖视图偏移
          const chunk = pending.slice(pendingOffset, end);
          pendingOffset = end;
          hasher.update(chunk);
          this.send(chunk);
          sent += chunk.length;
        }
        if (acked >= size) break;
        const progress = await this.take((m) => m.type === 'sftp_upload_progress', 4000).catch((error: Error) => {
          if (/超时/.test(error.message)) return null;
          throw error;
        });
        if (progress) {
          acked = Math.max(acked, Number(progress.loaded) || 0);
          // 把积压的进度消息一并读掉
          for (let i = this.inbox.length - 1; i >= 0; i--) {
            if (this.inbox[i].type === 'sftp_upload_progress') {
              acked = Math.max(acked, Number(this.inbox[i].loaded) || 0);
              this.inbox.splice(i, 1);
            }
          }
          windowBytes = Math.min(policy.maxWindowBytes, windowBytes + policy.windowStepBytes);
          onProgress?.(acked, size);
        } else {
          windowBytes = Math.min(policy.maxWindowBytes, windowBytes + policy.windowStepBytes);
        }
        if (this.closedReason) throw new Error(this.closedReason);
      }
      this.send({ type: 'sftp_upload_end', expectedHash: hasher.digest() });
      const complete = await this.take((m) => m.type === 'sftp_upload_complete', STEP_TIMEOUT_MS * 2);
      if (complete.hashMatch === false) throw new Error('上传后校验失败（SHA-256 不一致）');
    } catch (error) {
      this.send({ type: 'sftp_upload_cancel' });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  close(): void {
    this.closedReason ??= 'SFTP 已关闭';
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'sftp_close' }));
        ws.close(1000);
      } catch {
        // 忽略
      }
    }
    this.wake?.();
  }
}
