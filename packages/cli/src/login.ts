/**
 * 登录：拿到 CloudSSH 的 session Cookie，存进 ~/.cloudssh/credentials.json（不改 Worker）。
 *
 * GitHub 模式：Worker 的 OAuth 回调地址固定是它自己的域名，state 校验靠 oauth_state Cookie，命令行接不到回调。
 * 所以由命令行发起：GET /api/auth/github 拿到 GitHub 授权地址和 oauth_state Cookie，在浏览器里打开授权页；
 * 授权后浏览器跳回 Worker 的回调，因为浏览器里没有这个 oauth_state，Worker 显示 “Invalid state parameter”
 * 并且不会使用授权码（先校验 state 再换 token）。把这时地址栏里的网址交给命令行，命令行带着 oauth_state
 * 请求同一个回调，就拿到 session。授权码 10 分钟内有效、只能用一次。
 *   - 终端里：cloudssh login 打开浏览器后直接等你粘贴
 *   - 非交互（例如 AI 代为执行）：cloudssh login --start 打印授权地址；cloudssh login --callback "<地址>" 完成
 * 单管理员密码模式：在本机做与网页版相同的 PBKDF2 预拉伸，POST /api/auth/password/login（开了 Turnstile 时无法用命令行登录）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stretchAdminPassword } from '../../ui-web/upstream/frontend/src/password-stretch';
import { homeDir, loadConfig, normalizeOrigin, rememberInstance, saveConfig, saveCredential, UsageError } from './config';
import { ask, askSecret, interactive } from './prompt';

interface Pending {
  origin: string;
  state: string;
  createdAt: number;
}

const pendingPath = () => path.join(homeDir(), 'login-pending.json');

function cookieValue(headers: Headers, name: string): string | null {
  const all = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? ''];
  for (const line of all) {
    const match = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(line);
    if (match) return match[1];
  }
  return null;
}

export function openBrowser(url: string): void {
  try {
    const child =
      process.platform === 'win32'
        ? spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // 打不开就让用户自己复制
  }
}

async function finish(origin: string, session: string, source: 'login'): Promise<string> {
  const me = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: `session=${session}`, Origin: origin } });
  const user = me.ok ? ((await me.json().catch(() => null)) as { username?: string } | null)?.username : undefined;
  saveCredential(origin, { session, source, savedAt: new Date().toISOString(), user });
  const config = loadConfig();
  rememberInstance(config, origin);
  saveConfig(config);
  return user ?? '(未知用户)';
}

async function startGithub(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/auth/github`, { redirect: 'manual', headers: { Origin: origin } });
  const location = response.headers.get('location');
  const state = cookieValue(response.headers, 'oauth_state');
  if (response.status !== 302 || !location || !state) {
    throw new Error(`这个实例没有开启 GitHub 登录（HTTP ${response.status}）`);
  }
  const pending: Pending = { origin, state, createdAt: Date.now() };
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pendingPath(), JSON.stringify(pending), { mode: 0o600 });
  return location;
}

async function completeGithub(callback: string): Promise<{ origin: string; user: string }> {
  let pending: Pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingPath(), 'utf8')) as Pending;
  } catch {
    throw new UsageError('没有进行中的登录：先运行 cloudssh login（或 cloudssh login --start）');
  }
  if (Date.now() - pending.createdAt > 10 * 60_000) throw new UsageError('登录已超过 10 分钟，请重新运行 cloudssh login');
  let url: URL;
  try {
    url = new URL(callback.trim());
  } catch {
    throw new UsageError('请粘贴浏览器地址栏里完整的网址（以 https:// 开头，含 code= 和 state=）');
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new UsageError('网址里没有 code 或 state：请在 GitHub 授权后、跳回 CloudSSH 的页面上复制地址栏');
  if (state !== pending.state) throw new UsageError('state 对不上：这个网址不是这次登录的，请重新运行 cloudssh login');
  const response = await fetch(`${pending.origin}/api/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: { Cookie: `oauth_state=${pending.state}`, Origin: pending.origin },
  });
  const session = cookieValue(response.headers, 'session');
  if (!session) {
    const text = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`登录失败（HTTP ${response.status}）${text ? `：${text}` : ''}。授权码可能已被浏览器用掉或过期，请重新运行 cloudssh login`);
  }
  fs.rmSync(pendingPath(), { force: true });
  return { origin: pending.origin, user: await finish(pending.origin, session, 'login') };
}

async function passwordLogin(origin: string, params: { salt: string; iterations: number }, turnstile: boolean): Promise<string> {
  if (turnstile) throw new Error('这个实例开启了 Turnstile 人机验证，命令行无法登录；请在桌面客户端里打开“同步登录给命令行”');
  if (!interactive()) throw new UsageError('密码登录需要在终端里输入密码：请自己运行 cloudssh login');
  const password = await askSecret('管理员密码：');
  const key = await stretchAdminPassword(password, params.salt, params.iterations);
  const response = await fetch(`${origin}/api/auth/password/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ key }),
  });
  const session = cookieValue(response.headers, 'session');
  if (!response.ok || !session) {
    throw new Error(response.status === 401 ? '密码不对' : response.status === 429 ? '失败次数太多，稍后再试' : `登录失败（HTTP ${response.status}）`);
  }
  return finish(origin, session, 'login');
}

export interface LoginOptions {
  url?: string;
  start?: boolean;
  callback?: string;
  noBrowser?: boolean;
}

export async function login(options: LoginOptions, log: (text: string) => void): Promise<void> {
  if (options.callback) {
    const { origin, user } = await completeGithub(options.callback);
    log(`已登录 ${origin}（${user}）`);
    return;
  }
  const config = loadConfig();
  const target = options.url ?? config.defaultInstance;
  if (!target) throw new UsageError('用法：cloudssh login https://你的域名');
  const origin = normalizeOrigin(target);
  const info = (await (await fetch(`${origin}/api/config`)).json().catch(() => null)) as {
    authMode?: string;
    turnstileEnabled?: boolean;
    passwordAuth?: { salt: string; iterations: number } | null;
    githubAuthEnabled?: boolean;
  } | null;
  if (!info) throw new Error(`${origin} 不像 CloudSSH（/api/config 没有返回配置）`);
  if (info.authMode === 'password' && info.passwordAuth) {
    const user = await passwordLogin(origin, info.passwordAuth, !!info.turnstileEnabled);
    log(`已登录 ${origin}（${user}）`);
    return;
  }
  if (!info.githubAuthEnabled) throw new Error('这个实例没有开启登录（匿名模式），不需要也无法登录');
  const authorize = await startGithub(origin);
  const steps = [
    `1. 在浏览器里打开下面的地址，用 GitHub 授权：`,
    `   ${authorize}`,
    `2. 授权后浏览器会跳回 ${origin}，页面显示 “Invalid state parameter” 是正常的；`,
    `   把这时地址栏里的完整网址复制下来（含 code= 和 state=）。`,
  ];
  if (!options.noBrowser) openBrowser(authorize);
  if (options.start || !interactive()) {
    log([...steps, `3. 运行：cloudssh login --callback "<复制的网址>"（10 分钟内有效）`].join('\n'));
    return;
  }
  log(steps.join('\n'));
  const pasted = await ask('3. 粘贴网址后回车：');
  const { user } = await completeGithub(pasted);
  log(`已登录 ${origin}（${user}）`);
}
