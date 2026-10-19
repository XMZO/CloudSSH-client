/**
 * 测试工具：起假 Worker（scripts/mock-worker.mjs，端口由系统分配）、准备临时的 CLOUDSSH_HOME 与家目录、
 * 跑打好的命令行（dist/cloudssh.mjs），以及一个最小的 MCP 客户端（stdio，一行一条 JSON-RPC 消息）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLI = path.resolve(here, '..', 'dist', 'cloudssh.mjs');
const MOCK = path.resolve(here, '..', '..', '..', 'scripts', 'mock-worker.mjs');

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 起假 Worker，返回地址与关闭函数；args 透传（例如 --anon：未登录，可走模拟的 GitHub 登录） */
export async function startMock(args = []) {
  const child = spawn(process.execPath, [MOCK, '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const url = await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
    });
    child.on('exit', (code) => reject(new Error(`假 Worker 退出了（${code}）`)));
  });
  return { url, stop: () => child.kill() };
}

/**
 * 隔离的环境：CLOUDSSH_HOME 里登记好实例与登录（假 Worker 认任何会话），家目录、APPDATA 等也指到临时目录，
 * 测试不会碰到这台电脑上真实的配置
 */
export function isolatedEnv(url) {
  const root = tempDir('cloudssh-test-');
  const home = path.join(root, 'home');
  const cloudssh = path.join(root, 'cloudssh');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cloudssh, { recursive: true });
  if (url) {
    fs.writeFileSync(path.join(cloudssh, 'config.json'), JSON.stringify({ instances: [{ name: 'mock', url }], defaultInstance: url }));
    fs.writeFileSync(
      path.join(cloudssh, 'credentials.json'),
      JSON.stringify({ version: 1, instances: { [url]: { session: 'test', source: 'login', savedAt: new Date().toISOString() } } })
    );
  }
  const env = {
    ...process.env,
    CLOUDSSH_HOME: cloudssh,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
  };
  delete env.CLOUDSSH_INSTANCE;
  delete env.CLOUDSSH_SHIM;
  // 默认不用后台会话进程（免得每个用例留下一个）；测它的用例自己打开
  env.CLOUDSSH_AGENT = '0';
  delete env.CLOUDSSH_AGENT_IDLE;
  return { root, home, env };
}

/** 跑一次命令行，返回退出码与输出 */
export function runCli(args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 起 cloudssh mcp，返回一个最小的 MCP 客户端 */
export function startMcp(env, args = []) {
  const child = spawn(process.execPath, [CLI, 'mcp', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const pending = new Map();
  const notifications = [];
  /** stdout 上出现的每一行（都必须是 JSON-RPC 消息） */
  const lines = [];
  const badLines = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      badLines.push(line);
      return;
    }
    const list = Array.isArray(message) ? message : [message];
    for (const item of list) {
      if (item.method) notifications.push(item);
      else if (pending.has(JSON.stringify(item.id))) {
        pending.get(JSON.stringify(item.id))(item);
        pending.delete(JSON.stringify(item.id));
      } else notifications.push(item);
    }
  });
  let nextId = 1;
  const client = {
    child,
    notifications,
    lines,
    badLines,
    get stderr() {
      return stderr;
    },
    write(text) {
      child.stdin.write(text);
    },
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    /** 发请求，等对应 id 的回复（可以指定 id） */
    request(method, params, id = nextId++) {
      return new Promise((resolve) => {
        pending.set(JSON.stringify(id), resolve);
        client.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    /** 等某个 id 的回复，超时返回 null */
    waitFor(id, ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(JSON.stringify(id));
          resolve(null);
        }, ms);
        pending.set(JSON.stringify(id), (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    async callTool(name, args, extra = {}) {
      const response = await client.request('tools/call', { name, arguments: args, ...extra });
      if (response.error) throw new Error(`JSON-RPC 错误 ${response.error.code}：${response.error.message}`);
      return { text: response.result.content.map((item) => item.text).join('\n'), isError: response.result.isError === true, raw: response.result };
    },
    async close() {
      child.stdin.end();
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 5000);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return child.exitCode;
    },
  };
  return client;
}
