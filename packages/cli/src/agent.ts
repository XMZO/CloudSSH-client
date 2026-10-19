/**
 * 后台会话进程（agent）：让命令行像 MCP 一样复用到服务器的会话，同一台服务器的后续命令不用再重新登录。
 *
 * - cloudssh exec 先连本机的后台进程，没有就在后台启动一个，命令交给它跑；关掉了、启动不了、连不上时照旧在本进程里
 *   执行，用法、输出、退出码都不变
 * - 每个系统账户、配置目录（CLOUDSSH_HOME）、实例、程序（路径与修改时间）各一个，互不相干：Windows 用命名管道，
 *   其他系统用配置目录里的 Unix socket（仅本人可访问）
 * - 互相验证身份不写任何文件：双方都读得到这个实例的登录（session Cookie），各用它对对方给的随机数做 HMAC。
 *   命令行先核对后台进程的应答，对得上才把命令发过去，别的程序抢先占了同名管道也拿不到命令；后台进程也核对命令行的应答。
 *   只读的环境（AI 工具的沙箱）里照样能用
 * - 会话：每台服务器最多 3 条（同一台同时跑多条命令时不互相排队）。命令行断开（Ctrl+C、被调用方结束）时关掉它正在用的
 *   会话，远端命令随之结束，与在本进程执行时一样
 * - 服务器列表缓存 30 秒，按名称找不到时重新取一次；登录换了（换账号、重新登录）就关掉旧会话、清缓存
 * - 空闲 3 分钟（CLOUDSSH_AGENT_IDLE 秒）自动退出，会话一起关掉；CLOUDSSH_AGENT=0 不用后台进程
 * - 运行时：本机有 Node 22 起就用它（命令行由 CloudSSH 客户端运行时也是，内存约 65MB，客户端约 115MB），否则用命令行自己的
 * - 只有不需要确认的 exec 走后台进程；危险命令要在终端里确认、upload / download / copy，仍在本进程里做
 */
import { CLIENT_VERSION, type ServerConfig } from '@cloudssh/core';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteSession } from '../../ui-web/overrides/shared/ai-remote/session';
import { homeDir, loadConfig, loadCredentials, resolveInstance, UsageError } from './config';
import { runExec, type ExecOutcome } from './exec';
import { installNetwork } from './net';
import { hostIdsOf, loadServers, resolveTargets } from './targets';

const IDLE_MS = (() => {
  const seconds = Number(process.env.CLOUDSSH_AGENT_IDLE);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 180_000;
})();
const SERVERS_TTL_MS = 30_000;
const MAX_SESSIONS_PER_SERVER = 3;
const MAX_LINE = 256 * 1024;

export const agentDisabled = (): boolean => /^(0|false|off|no)$/i.test(process.env.CLOUDSSH_AGENT ?? '');

const self = fileURLToPath(import.meta.url);

/** 这个账户、配置目录、实例、这份程序（路径与修改时间：版本相同但换了程序也不串用）各一个 */
function agentAddress(origin: string): string {
  let user = '';
  let stamp = '';
  try {
    user = os.userInfo().username;
  } catch {
    // 取不到用户名就只靠其他几项
  }
  try {
    stamp = String(fs.statSync(self).mtimeMs);
  } catch {
    // 同上
  }
  const key = crypto
    .createHash('sha256')
    .update([user, homeDir(), origin, CLIENT_VERSION, self, stamp].join('\n'))
    .digest('hex')
    .slice(0, 16);
  return process.platform === 'win32' ? `\\\\.\\pipe\\cloudssh-agent-${key}` : path.join(homeDir(), `agent-${key}.sock`);
}

/** 用这个实例当前的登录对随机数做的应答；没登录时为 null */
function answer(origin: string, role: 'agent' | 'client', nonce: unknown): string | null {
  const session = typeof nonce === 'string' && nonce.length >= 16 ? loadCredentials()[origin]?.session : undefined;
  return session ? crypto.createHmac('sha256', session).update(`cloudssh-agent ${role} ${nonce}`).digest('hex') : null;
}

function sameAnswer(expected: string | null, actual: unknown): boolean {
  if (!expected || typeof actual !== 'string' || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

const nonce = () => crypto.randomBytes(16).toString('hex');

function send(socket: net.Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

/** 按行读 JSON（一行一条消息） */
function onLines(socket: net.Socket, handle: (message: Record<string, unknown>) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE) {
      socket.destroy();
      return;
    }
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        handle(JSON.parse(line) as Record<string, unknown>);
      } catch {
        socket.destroy();
        return;
      }
    }
  });
}

// ---------------------------------------------------------------- 后台进程

interface AgentStatus {
  pid: number;
  version: string;
  sessions: { server: string; open: number; busy: number }[];
  /** 现在空闲时，再过多少毫秒自动退出（有命令在跑时为 null） */
  idleExitMs: number | null;
}

/** cloudssh __agent <实例>：后台进程本体，一直跑到空闲退出或被 stop */
export async function runAgent(origin: string): Promise<void> {
  process.title = 'cloudssh-agent';
  const address = agentAddress(origin);
  if (process.platform !== 'win32' && fs.existsSync(address)) {
    // 另一个还活着就退出；没人监听的旧 socket 文件删掉
    if (await openAgentConnection(address, 500)) return;
    fs.rmSync(address, { force: true });
  }

  const pool = new Map<number, RemoteSession[]>();
  const busy = new Map<RemoteSession, number>();
  let session = '';
  let servers: { list: ServerConfig[]; at: number } | null = null;
  let active = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleSince = Date.now();

  const sessions = () => [...pool.values()].flat().filter((item) => !item.closed);
  const closeAll = () => {
    for (const item of sessions()) item.close();
    pool.clear();
  };
  const scheduleExit = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (active > 0) return;
    idleSince = Date.now();
    idleTimer = setTimeout(shutdown, IDLE_MS);
  };

  /** 取一条到这台服务器的会话：有空闲的用空闲的，都在忙就再开一条（每台最多 3 条，再多就排在最闲的那条上） */
  const acquire = (serverId: number): RemoteSession => {
    const list = (pool.get(serverId) ?? []).filter((item) => !item.closed);
    pool.set(serverId, list);
    const idle = list.find((item) => !busy.get(item));
    if (idle) return idle;
    if (list.length < MAX_SESSIONS_PER_SERVER) {
      const created = new RemoteSession(serverId, (closed) => {
        const rest = (pool.get(serverId) ?? []).filter((item) => item !== closed);
        if (rest.length) pool.set(serverId, rest);
        else pool.delete(serverId);
        busy.delete(closed);
      });
      list.push(created);
      return created;
    }
    return list.reduce((a, b) => ((busy.get(a) ?? 0) <= (busy.get(b) ?? 0) ? a : b));
  };

  const serverList = async (fresh: boolean): Promise<{ list: ServerConfig[]; cached: boolean }> => {
    if (!fresh && servers && Date.now() - servers.at < SERVERS_TTL_MS) return { list: servers.list, cached: true };
    const list = await loadServers();
    servers = { list, at: Date.now() };
    return { list, cached: false };
  };

  const exec = async (message: Record<string, unknown>, client: net.Socket): Promise<ExecOutcome[]> => {
    const spec = String(message.spec ?? '');
    const command = String(message.command ?? '');
    const timeout = Math.max(1, Math.min(3600, Math.round(Number(message.timeout) || 60)));
    const config = loadConfig();
    const instance = resolveInstance(config, origin);
    if (!instance.credential) {
      throw new UsageError(`还没有登录 ${origin}：运行 cloudssh login ${origin}（或在桌面客户端里打开“同步登录给命令行”）`);
    }
    // 换了登录（可能换了账号）：旧会话、旧列表都不能再用
    if (instance.credential.session !== session) {
      closeAll();
      servers = null;
      session = instance.credential.session;
      installNetwork(origin, session);
    }
    // 目标都是主机 ID 且还没有列表时，先开始连接（与取列表同时进行）
    const ids = hostIdsOf(spec, config);
    if (ids && !servers) for (const id of ids.slice(0, config.concurrency)) if (!pool.get(id)?.some((item) => !item.closed)) acquire(id);
    let resolved = await serverList(false);
    let targets: ServerConfig[];
    try {
      targets = resolveTargets(spec, resolved.list, config);
    } catch (error) {
      // 缓存的列表里找不到（刚改名、刚添加）：重新取一次
      if (!(error instanceof UsageError) || !resolved.cached) throw error;
      resolved = await serverList(true);
      targets = resolveTargets(spec, resolved.list, config);
    }
    // 命令行断开（Ctrl+C、被调用方结束）：关掉这次用到的会话，远端命令随之结束
    const used = new Set<RemoteSession>();
    let finished = false;
    client.once('close', () => {
      if (!finished) for (const item of used) item.close();
    });
    try {
      return await runExec(targets, command, timeout, config.concurrency, async (server, text, seconds) => {
        const item = acquire(server.id);
        used.add(item);
        busy.set(item, (busy.get(item) ?? 0) + 1);
        try {
          return await item.exec(text, seconds);
        } finally {
          busy.set(item, Math.max(0, (busy.get(item) ?? 1) - 1));
        }
      });
    } finally {
      finished = true;
    }
  };

  const status = (): AgentStatus => {
    const byServer = new Map<number, { open: number; busy: number }>();
    for (const item of sessions()) {
      const entry = byServer.get(item.serverId) ?? { open: 0, busy: 0 };
      entry.open += 1;
      if (busy.get(item)) entry.busy += 1;
      byServer.set(item.serverId, entry);
    }
    return {
      pid: process.pid,
      version: CLIENT_VERSION,
      sessions: [...byServer].map(([id, entry]) => ({ server: `srv-${id}`, ...entry })),
      idleExitMs: active > 0 ? null : Math.max(0, IDLE_MS - (Date.now() - idleSince)),
    };
  };

  // 一次连接：命令行给随机数 → 后台进程应答并给自己的随机数 → 命令行核对后发请求（带它的应答）→ 后台进程核对后执行
  const server = net.createServer((client) => {
    client.on('error', () => undefined);
    const challenge = nonce();
    let stage: 'hello' | 'request' | 'done' = 'hello';
    onLines(client, (message) => {
      if (stage === 'hello') {
        stage = 'request';
        const reply = answer(origin, 'agent', message.nonce);
        if (!reply) return void client.destroy();
        return void send(client, { answer: reply, challenge, version: CLIENT_VERSION, pid: process.pid });
      }
      if (stage !== 'request') return;
      stage = 'done';
      if (!sameAnswer(answer(origin, 'client', challenge), message.answer)) return void client.destroy();
      if (message.op === 'status') return void client.end(`${JSON.stringify({ status: status() })}\n`);
      if (message.op === 'stop') {
        client.end(`${JSON.stringify({ ok: true })}\n`);
        return void setImmediate(shutdown);
      }
      if (message.op !== 'exec') return void client.destroy();
      active += 1;
      scheduleExit();
      exec(message, client)
        .then(
          (results) => send(client, { results }),
          (error: unknown) => send(client, { error: error instanceof Error ? error.message : String(error), usage: error instanceof UsageError })
        )
        .finally(() => {
          client.end();
          active -= 1;
          scheduleExit();
        });
    });
  });

  function shutdown(): void {
    server.close();
    closeAll();
    if (process.platform !== 'win32') fs.rmSync(address, { force: true });
  }

  const listening = await new Promise<boolean>((resolve) => {
    // 已经有一个在跑（同名管道 / socket 被占用）：关掉监听句柄，直接退出
    server.once('error', () => {
      server.close();
      resolve(false);
    });
    server.listen(address, () => {
      if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
      scheduleExit();
      resolve(true);
    });
  });
  // 一直跑到空闲退出或被 stop（进程由调用方结束）
  if (listening) await new Promise<void>((resolve) => server.once('close', () => resolve()));
}

// ---------------------------------------------------------------- 命令行这一侧

interface AgentConnection {
  socket: net.Socket;
  /** 发一条请求，等一条回复；连接先断了返回 null */
  call(message: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

/** 连上了，但对方的应答对不上：不是我们的后台进程（别的程序占了同名管道），什么都不发 */
const IMPOSTOR = 'impostor';

/**
 * 连上后台进程并核对它的应答；没有在跑、超时返回 null，应答对不上返回 IMPOSTOR。
 * 不给 origin 时只看有没有人在听（启动时判断旧 socket 文件还有没有人用）
 */
function openAgentConnection(address: string, timeoutMs: number, origin?: string): Promise<AgentConnection | null | typeof IMPOSTOR> {
  return new Promise((resolve) => {
    const mine = nonce();
    const socket = net.connect(address, () => send(socket, { nonce: mine }));
    const replies: ((message: Record<string, unknown> | null) => void)[] = [];
    let hello = false;
    const fail = (result: null | typeof IMPOSTOR = null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => fail(origin ? null : IMPOSTOR), timeoutMs);
    const onError = () => fail();
    socket.on('error', onError);
    socket.on('close', () => {
      while (replies.length) replies.shift()?.(null);
      if (!hello) fail();
    });
    onLines(socket, (message) => {
      if (!hello) {
        hello = true;
        clearTimeout(timer);
        if (!origin) return fail(IMPOSTOR);
        if (!sameAnswer(answer(origin, 'agent', mine), message.answer)) return fail(IMPOSTOR);
        const reply = answer(origin, 'client', message.challenge);
        socket.off('error', onError);
        socket.on('error', () => undefined);
        resolve({
          socket,
          call: (request) =>
            new Promise((done) => {
              replies.push(done);
              send(socket, { ...request, answer: reply });
            }),
        });
        return;
      }
      replies.shift()?.(message);
    });
  });
}

/**
 * 后台进程用哪个运行时：命令行由 CloudSSH 客户端（Electron）运行时，本机有 Node 22 起就改用它（内存约少一半），
 * 否则就用命令行自己的
 */
function agentRuntime(): { command: string; env: NodeJS.ProcessEnv } {
  if (!process.versions.electron) return { command: process.execPath, env: process.env };
  const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = dir && path.join(dir, name);
      if (!candidate || !fs.existsSync(candidate)) continue;
      const version = spawnSync(candidate, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 3000, windowsHide: true }).stdout?.trim();
      if (Number(version?.split('.')[0]) >= 22) {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        return { command: candidate, env };
      }
    }
  }
  return { command: process.execPath, env: process.env };
}

/** 在后台启动一个，等它能连上（最多约 3 秒；它提前退出就不等了） */
async function startAgent(origin: string): Promise<AgentConnection | null> {
  let exited = false;
  try {
    const runtime = agentRuntime();
    const child = spawn(runtime.command, [self, '__agent', origin], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // 别占着调用方的当前目录（Windows 上会锁住，删不掉）
      cwd: os.homedir(),
      env: runtime.env,
    });
    child.on('error', () => (exited = true));
    child.on('exit', () => (exited = true));
    child.unref();
  } catch {
    return null;
  }
  const address = agentAddress(origin);
  const deadline = Date.now() + 3000;
  while (!exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const connection = await openAgentConnection(address, 500, origin);
    if (connection === IMPOSTOR) return null;
    if (connection) return connection;
  }
  // 它可能是因为已经有别的在跑而退出的
  const connection = await openAgentConnection(address, 500, origin);
  return connection === IMPOSTOR ? null : connection;
}

/** 连上正在跑的后台进程（不启动新的）；没有在跑、不是我们的都返回 null */
async function connectRunning(origin: string): Promise<AgentConnection | null> {
  const connection = await openAgentConnection(agentAddress(origin), 1000, origin);
  return connection === IMPOSTOR ? null : connection;
}

/**
 * 交给后台进程执行；用不了后台进程（关掉了、启动不了、连不上、同名管道不是我们的）返回 null，调用方照旧在本进程执行。
 * 已经交出去之后连接断了：命令可能已经执行，不能重试，报错
 */
export async function execViaAgent(origin: string, request: { spec: string; command: string; timeout: number }): Promise<ExecOutcome[] | null> {
  if (agentDisabled()) return null;
  const existing = await openAgentConnection(agentAddress(origin), 1000, origin);
  if (existing === IMPOSTOR) return null;
  const connection = existing ?? (await startAgent(origin));
  if (!connection) return null;
  const reply = await connection.call({ op: 'exec', ...request });
  connection.socket.end();
  if (!reply) throw new Error('后台会话进程中断，执行状态未知（CLOUDSSH_AGENT=0 可不用后台进程）');
  if (typeof reply.error === 'string') throw reply.usage ? new UsageError(reply.error) : new Error(reply.error);
  return reply.results as ExecOutcome[];
}

/** 正在跑的后台进程的状态；没有在跑返回 null（不会启动新的） */
export async function agentStatus(origin: string): Promise<AgentStatus | null> {
  const connection = await connectRunning(origin);
  if (!connection) return null;
  const reply = await connection.call({ op: 'status' });
  connection.socket.end();
  return (reply?.status as AgentStatus | undefined) ?? null;
}

/** 让正在跑的后台进程退出（关掉所有会话）；没有在跑返回 false */
export async function stopAgent(origin: string): Promise<boolean> {
  const connection = await connectRunning(origin);
  if (!connection) return false;
  const reply = await connection.call({ op: 'stop' });
  connection.socket.end();
  return reply?.ok === true;
}
