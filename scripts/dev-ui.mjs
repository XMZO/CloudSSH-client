#!/usr/bin/env node
/**
 * UI 热更新开发：同时启动 ui-web 的 Vite 开发服务器与桌面端，
 * 桌面端通过 CLOUDSSH_UI_DEV_SERVER 把所有实例的 UI 指向开发服务器（remote 实例除外）。
 * 修改 packages/ui-web/upstream 或 overrides 下的文件即可在客户端里热更新。
 * 关闭客户端窗口后自动停止开发服务器。
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const DEV_HOST = '127.0.0.1';
const DEV_PORT = 5173;
const isWin = process.platform === 'win32';

function run(args, env = {}) {
  return spawn('pnpm', args, {
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, ...env },
  });
}

function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

function waitForPort(timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(DEV_PORT, DEV_HOST);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error('等待 Vite 开发服务器超时'));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

const vite = run(['--filter', '@cloudssh/ui-web', 'dev']);
let desktop;

const shutdown = (code = 0) => {
  kill(desktop);
  kill(vite);
  process.exit(code);
};
process.on('SIGINT', () => shutdown(130));
vite.on('exit', (code) => {
  if (!desktop) {
    console.error('[dev-ui] Vite 启动失败');
    process.exit(code ?? 1);
  }
});

try {
  await waitForPort();
} catch (error) {
  console.error(`[dev-ui] ${error.message}`);
  shutdown(1);
}

desktop = run(['--filter', '@cloudssh/desktop', 'dev'], {
  CLOUDSSH_UI_DEV_SERVER: `http://${DEV_HOST}:${DEV_PORT}`,
});
desktop.on('exit', (code) => shutdown(code ?? 0));
