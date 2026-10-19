/**
 * 无界面的 SSH 会话：AI 跨服务器操作时，客户端在后台连到目标服务器执行命令、传文件，界面上不开标签。
 *
 * 连接走网页版同一个接口：POST /api/servers/:id/connect 换一次性令牌，WebSocket 连上后由 Worker 用保存的凭据认证，
 * 跳板机链与 CF 隧道也由 Worker 处理，客户端不经手任何密码或私钥（手机上 fetch/WebSocket 照常经原生层转发）。
 * 协议与网页版终端一致：连上先发 resize；Shell 就绪（status shell_ready）后键盘输入以二进制帧发送；
 * 输出按 terminal_output_flow 给的 id 累计回执（不回执时 Worker 会在积压后断开）；每 20 秒 ping 一次防止空闲断线。
 *
 * 执行命令：初始化时关掉回显与提示符、禁用分页器，探测 bash 与 timeout；每条命令用 sh -c 跑在 stdin 为空的子进程里，
 * 前后打印标记、末尾打印退出码，只保留最后 64KB 输出。标记在命令行里写成八进制转义，回显出来的命令不会被误认成标记。
 * 超时由服务器上的 timeout 结束命令；没有 timeout 或仍不返回时客户端放弃这条会话（下次重新连接）。
 */

export interface ExecResult {
  output: string;
  /** 退出码；超时或连接中断时为 null */
  exitCode: number | null;
  timedOut: boolean;
  /** 输出超过上限，只保留了末尾 */
  truncated: boolean;
  durationMs: number;
}

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly code: 'connect' | 'auth' | 'host_key' | 'closed' | 'shell' | 'timeout' | 'too_long' = 'connect'
  ) {
    super(message);
  }
}

const OUTPUT_LIMIT = 64 * 1024;
const READY_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 15_000;
const PING_MS = 20_000;
const IDLE_CLOSE_MS = 180_000;
/** 终端行缓冲（canonical 模式）每行最多 4095 字节，超长的行会被截断 */
const MAX_LINE_BYTES = 3500;

const encoder = new TextEncoder();
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78NOM]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

function marker(name: string, id: string): string {
  // __CS<name><id>：下划线写成八进制，回显的命令行里不会出现标记原文
  return `'\\137\\137CS${name}%s\\n' '${id}'`;
}

function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 服务器 id → 连接用的 WebSocket 地址 */
async function requestWsUrl(serverId: number): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`/api/servers/${serverId}/connect`, { method: 'POST', credentials: 'same-origin' });
  } catch (error) {
    throw new RemoteError(error instanceof Error ? error.message : String(error));
  }
  const body = (await response.json().catch(() => null)) as { wsUrl?: unknown; error?: unknown } | null;
  if (!response.ok || typeof body?.wsUrl !== 'string' || !/^wss?:\/\//.test(body.wsUrl)) {
    throw new RemoteError(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`);
  }
  return body.wsUrl;
}

export class RemoteSession {
  private ws: WebSocket | null = null;
  private text = '';
  private readonly decoder = new TextDecoder();
  private ackId: string | null = null;
  private ackBytes = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private outputListener: (() => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closedReason: string | null = null;
  /** SFTP 数据通道地址（Worker 在会话建立后发来） */
  sftpUrl: string | null = null;
  readonly ready: Promise<void>;

  constructor(readonly serverId: number, private readonly onClosed: (session: RemoteSession) => void) {
    this.ready = this.connect();
    this.ready.catch(() => this.close());
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  private async connect(): Promise<void> {
    const url = await requestWsUrl(this.serverId);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RemoteError('Shell 就绪超时', 'timeout')), READY_TIMEOUT_MS);
      const fail = (error: RemoteError) => {
        clearTimeout(timer);
        reject(error);
      };
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'resize', cols: 200, rows: 50 }));
        this.pingTimer = setInterval(() => this.sendJson({ type: 'ping', id: randomId() }), PING_MS);
      };
      ws.onerror = () => fail(new RemoteError('WebSocket 连接失败'));
      ws.onclose = (event) => {
        this.closedReason ??= `连接已关闭（${event.code}）`;
        fail(new RemoteError(this.closedReason, 'closed'));
        this.cleanup();
        this.outputListener?.();
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          this.ack(bytes.byteLength);
          this.append(this.decoder.decode(bytes, { stream: true }));
          return;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data);
        } catch {
          this.append(event.data);
          return;
        }
        switch (msg.type) {
          case 'terminal_output_flow':
            this.ackId = typeof msg.id === 'string' && msg.id.length <= 64 ? msg.id : null;
            this.ackBytes = 0;
            break;
          case 'sftp_attach':
            this.sftpUrl = typeof msg.url === 'string' ? msg.url : null;
            break;
          case 'session_resumed':
            if (typeof msg.sftpAttachUrl === 'string' && msg.sftpAttachUrl) this.sftpUrl = msg.sftpAttachUrl;
            break;
          case 'status':
            if (msg.event === 'shell_ready') {
              clearTimeout(timer);
              resolve();
            }
            break;
          case 'auth_challenge':
            // 需要交互式认证（验证码、二次验证）的服务器无法在后台登录
            this.sendJson({ type: 'auth_cancel', id: msg.id });
            fail(new RemoteError('这台服务器需要交互式认证，无法在后台登录', 'auth'));
            break;
          case 'host_key_changed':
            fail(new RemoteError('主机指纹已变化，请先在终端里连接一次并确认', 'host_key'));
            break;
          case 'error':
            fail(new RemoteError(typeof msg.message === 'string' ? msg.message : String(msg.event ?? 'error'), 'auth'));
            break;
        }
      };
    });
    await this.init();
  }

  private sendJson(value: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(value));
  }

  private ack(bytes: number): void {
    if (!this.ackId || bytes <= 0) return;
    this.ackBytes += bytes;
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.ackId) this.sendJson({ type: 'terminal_output_ack', id: this.ackId, bytes: this.ackBytes });
    }, 16);
  }

  private append(chunk: string): void {
    this.text += chunk;
    // 只留最近的内容：等待中的命令只关心标记之后
    if (this.text.length > OUTPUT_LIMIT * 4) this.text = this.text.slice(-OUTPUT_LIMIT * 2);
    this.outputListener?.();
  }

  private input(text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new RemoteError(this.closedReason ?? '连接已关闭', 'closed');
    this.ws.send(encoder.encode(text));
  }

  /** 等输出里出现 pattern，返回其后的全部文本（已去掉颜色控制符） */
  private waitFor(pattern: RegExp, timeoutMs: number): Promise<RegExpExecArray> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const clean = this.text.replace(/\r/g, '').replace(ANSI, '');
        const match = pattern.exec(clean);
        if (match) {
          done();
          resolve(match);
        } else if (this.closed) {
          done();
          reject(new RemoteError(this.closedReason ?? '连接已关闭', 'closed'));
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new RemoteError('等待输出超时', 'timeout'));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        if (this.outputListener === check) this.outputListener = null;
      };
      this.outputListener = check;
      check();
    });
  }

  private async init(): Promise<void> {
    const id = randomId();
    this.text = '';
    this.input(
      [
        ' stty -echo 2>/dev/null; set +H 2>/dev/null; unset PROMPT_COMMAND 2>/dev/null; PS1=; PS2=',
        'export TERM=dumb PAGER=cat GIT_PAGER=cat MANPAGER=cat SYSTEMD_PAGER= SYSTEMD_COLORS=0 HISTFILE=/dev/null',
        'CS_SH=$(command -v bash 2>/dev/null || echo sh); CS_TO=; timeout -k 1 5 true 2>/dev/null && CS_TO=timeout',
        'cs_run() { if [ -n "$CS_TO" ]; then "$CS_TO" -k 5 "$1" "$CS_SH" -c "$2"; else "$CS_SH" -c "$2"; fi; }',
        `printf ${marker('RDY', id)}`,
      ].join('; ') + '\n'
    );
    try {
      await this.waitFor(new RegExp(`__CSRDY${id}\\n`), INIT_TIMEOUT_MS);
    } catch {
      throw new RemoteError('无法初始化远程 Shell（可能不是 POSIX Shell）', 'shell');
    }
  }

  /** 在这台服务器上执行一条命令（同一会话内排队执行） */
  exec(command: string, timeoutSec = 60): Promise<ExecResult> {
    const run = this.queue.then(() => this.execNow(command, timeoutSec));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async execNow(command: string, timeoutSec: number): Promise<ExecResult> {
    if (command.length > 20_000) throw new RemoteError('命令太长，请拆分或改用文件', 'too_long');
    await this.ready;
    this.touch();
    const id = randomId();
    // AI 的 exec 在协议解析时已限制在 600 秒内；传大文件时内部用到 3600 秒
    const seconds = Math.max(1, Math.min(3600, Math.round(timeoutSec)));
    // 含制表符等控制字符（交互式 Shell 会当成补全键）时改用 base64 传命令
    const literal = /[\x00-\x08\x0b-\x1f\x7f]/.test(command)
      ? `"$(printf %s ${quote(btoa(String.fromCharCode(...encoder.encode(command))))} | base64 -d)"`
      : quote(command);
    const line =
      ` printf ${marker('BEG', id)}; { cs_run ${seconds} ${literal} </dev/null 2>&1; printf '\\n\\137\\137CSRC%s\\n' "$?"; }` +
      ` | tail -c ${OUTPUT_LIMIT}; printf ${marker('END', id)}\n`;
    if (line.split('\n').some((part) => encoder.encode(part).length > MAX_LINE_BYTES)) {
      throw new RemoteError('命令单行太长（超过约 3500 字节），请拆分或改用文件', 'too_long');
    }
    const started = Date.now();
    this.text = '';
    this.input(line);
    let match: RegExpExecArray;
    try {
      match = await this.waitFor(new RegExp(`__CSBEG${id}\\n([\\s\\S]*?)__CSEND${id}\\n`), (seconds + 15) * 1000);
    } catch (error) {
      // 超时或断线：这条会话的状态不再可信，丢弃
      this.close();
      if (error instanceof RemoteError && error.code === 'timeout') {
        return { output: '', exitCode: null, timedOut: true, truncated: false, durationMs: Date.now() - started };
      }
      throw error;
    } finally {
      this.touch();
    }
    let body = match[1];
    const rc = /\n?__CSRC(\d+)\n?$/.exec(body);
    let exitCode: number | null = null;
    if (rc) {
      exitCode = Number(rc[1]);
      body = body.slice(0, rc.index);
    }
    const truncated = encoder.encode(body).length >= OUTPUT_LIMIT - 64;
    // timeout 命令超时退出码 124（被 -k 强杀为 137）
    const timedOut = exitCode === 124 || (exitCode === 137 && Date.now() - started >= seconds * 1000);
    return { output: body, exitCode, timedOut, truncated, durationMs: Date.now() - started };
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ackTimer) clearTimeout(this.ackTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.pingTimer = this.ackTimer = this.idleTimer = null;
    this.onClosed(this);
  }

  close(): void {
    this.closedReason ??= '会话已关闭';
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      try {
        ws.close(1000);
      } catch {
        // 忽略
      }
    }
    this.cleanup();
    this.outputListener?.();
  }
}

const pool = new Map<number, RemoteSession>();

/** 取一条到这台服务器的后台会话（已有就复用） */
export function remoteSession(serverId: number): RemoteSession {
  const existing = pool.get(serverId);
  if (existing && !existing.closed) return existing;
  const session = new RemoteSession(serverId, (closed) => {
    if (pool.get(serverId) === closed) pool.delete(serverId);
  });
  pool.set(serverId, session);
  return session;
}

/** 执行一条命令（中途断线不自动重试：命令可能已经执行了一部分） */
export function remoteExec(serverId: number, command: string, timeoutSec = 60): Promise<ExecResult> {
  return remoteSession(serverId).exec(command, timeoutSec);
}

/** 关闭到这台服务器的后台会话（没有就什么都不做）：用户取消时用来结束正在跑的远程命令 */
export function closeRemoteSession(serverId: number): void {
  pool.get(serverId)?.close();
}

export function closeAllRemoteSessions(): void {
  for (const session of [...pool.values()]) session.close();
  pool.clear();
}
