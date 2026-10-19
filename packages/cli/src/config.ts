/**
 * 配置与登录凭据，都在 ~/.cloudssh/ 下（Windows 为 %USERPROFILE%\.cloudssh\）：
 * - config.json：实例列表、默认实例、别名、危险命令确认方式（完全权限）、批量执行并发数、默认超时、各 agent 的
 *   skill 开关、写进 skill 给 AI 的补充说明（可手改，也可以在桌面客户端的“命令行与 AI”设置里改）
 * - credentials.json：各实例的会话（CloudSSH 的 session Cookie，7 天有效），来源是 cloudssh login 或桌面客户端同步
 *   （桌面端“同步登录给命令行”打开时，客户端运行期间会写这个文件）。与 gh、wrangler 一样以文件存放、仅当前用户可读；
 *   不用 DPAPI：每条命令都要解密一次，PowerShell 解密要多花半秒以上
 * 环境变量 CLOUDSSH_HOME 可以换目录（测试用）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ConfirmMode = 'ask' | 'never';

export interface InstanceEntry {
  /** 显示名（默认是域名） */
  name: string;
  /** https://bash.al 这样的源 */
  url: string;
}

export interface CliConfig {
  defaultInstance?: string;
  instances: InstanceEntry[];
  /** 别名 → 目标（srv-12、名称、tag:标签、多个用逗号隔开） */
  aliases: Record<string, string>;
  /** ask：危险命令要 --yes（终端里会直接问）；never：不再确认（拦截级命令仍拒绝） */
  confirm: ConfirmMode;
  /** 批量执行时同时连几台 */
  concurrency: number;
  /** exec 默认超时（秒） */
  timeout: number;
  /** 各 agent 的 skill 开关（claude / codex / agents）；没写的算开 */
  skills: Record<string, boolean>;
  /** 写进 skill 给 AI 的补充说明（例如“tag:prod 只做只读操作”） */
  skillNotes: string;
}

export const MAX_SKILL_NOTES = 4000;

export interface Credential {
  session: string;
  source: 'login' | 'desktop';
  /** ISO 时间 */
  savedAt: string;
  user?: string;
}

interface CredentialFile {
  version: 1;
  instances: Record<string, Credential>;
}

export function homeDir(): string {
  return process.env.CLOUDSSH_HOME || path.join(os.homedir(), '.cloudssh');
}

const configPath = () => path.join(homeDir(), 'config.json');
const credentialsPath = () => path.join(homeDir(), 'credentials.json');

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${file} 不是有效的 JSON：${(error as Error).message}`);
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

/** 规范成源（协议 + 主机 + 端口）；只认 https，本机调试可以用 http */
export function normalizeOrigin(input: string): string {
  const text = input.trim();
  const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error(`只支持 https 地址：${input}`);
  return url.origin;
}

export function loadConfig(): CliConfig {
  const raw = readJson<Partial<CliConfig>>(configPath()) ?? {};
  const instances = Array.isArray(raw.instances)
    ? raw.instances.filter((item): item is InstanceEntry => typeof item?.url === 'string' && typeof item?.name === 'string')
    : [];
  return {
    defaultInstance: typeof raw.defaultInstance === 'string' ? raw.defaultInstance : undefined,
    instances,
    aliases: raw.aliases && typeof raw.aliases === 'object' ? { ...raw.aliases } : {},
    confirm: raw.confirm === 'never' ? 'never' : 'ask',
    concurrency: Number.isInteger(raw.concurrency) && raw.concurrency! >= 1 && raw.concurrency! <= 32 ? raw.concurrency! : 6,
    timeout: Number.isInteger(raw.timeout) && raw.timeout! >= 1 && raw.timeout! <= 3600 ? raw.timeout! : 60,
    skills:
      raw.skills && typeof raw.skills === 'object'
        ? Object.fromEntries(Object.entries(raw.skills).filter(([, value]) => typeof value === 'boolean'))
        : {},
    skillNotes: typeof raw.skillNotes === 'string' ? raw.skillNotes.slice(0, MAX_SKILL_NOTES) : '',
  };
}

export function saveConfig(config: CliConfig): void {
  writeJson(configPath(), config);
}

/** 记下实例（已有就不动）；还没有默认实例时设为默认 */
export function rememberInstance(config: CliConfig, origin: string, name?: string): void {
  if (!config.instances.some((item) => item.url === origin)) {
    config.instances.push({ name: name || new URL(origin).host, url: origin });
  }
  config.defaultInstance ??= origin;
}

function loadCredentialFile(): CredentialFile {
  const raw = readJson<Partial<CredentialFile>>(credentialsPath());
  return { version: 1, instances: raw?.instances && typeof raw.instances === 'object' ? { ...raw.instances } : {} };
}

export function loadCredentials(): Record<string, Credential> {
  return loadCredentialFile().instances;
}

export function saveCredential(origin: string, credential: Credential | null): void {
  const file = loadCredentialFile();
  if (credential) file.instances[origin] = credential;
  else delete file.instances[origin];
  writeJson(credentialsPath(), file);
}

/** 会话大约什么时候过期（服务端 Cookie 有效期 7 天，从保存时算） */
export function expiresAt(credential: Credential): Date {
  return new Date(new Date(credential.savedAt).getTime() + 7 * 24 * 3600_000);
}

export interface ActiveInstance {
  origin: string;
  name: string;
  credential: Credential | null;
}

/**
 * 这次用哪个实例：--instance（名称、域名或地址）→ 环境变量 CLOUDSSH_INSTANCE → 配置里的默认 → 唯一一个有登录的
 */
export function resolveInstance(config: CliConfig, requested?: string): ActiveInstance {
  const credentials = loadCredentials();
  const want = requested || process.env.CLOUDSSH_INSTANCE || config.defaultInstance;
  let origin: string | undefined;
  if (want) {
    const byName = config.instances.find((item) => item.name.toLowerCase() === want.toLowerCase());
    origin = byName?.url ?? normalizeOrigin(want);
  } else {
    const known = Object.keys(credentials);
    if (known.length === 1) origin = known[0];
  }
  if (!origin) throw new UsageError('还没有登录任何 CloudSSH 实例：运行 cloudssh login https://你的域名（或在桌面客户端里打开“同步登录给命令行”）');
  const name = config.instances.find((item) => item.url === origin)?.name ?? new URL(origin).host;
  return { origin, name, credential: credentials[origin] ?? null };
}

/** 用法错误（退出码 2） */
export class UsageError extends Error {}
