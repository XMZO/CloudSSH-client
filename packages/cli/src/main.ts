/**
 * cloudssh：CloudSSH 命令行。不开客户端，直接经 CloudSSH 服务端（Worker）操作已保存的服务器。
 * 入口：解析子命令，登录与配置之外的命令都先装好网络（net.ts）、取一次服务器列表。
 */
import type { ServerConfig } from '@cloudssh/core';
import { CLIENT_CODENAME, CLIENT_VERSION } from '@cloudssh/core';
import { closeAllRemoteSessions, remoteSession } from '../../ui-web/overrides/shared/ai-remote/session';
import { bool, COMMON, int, parseArgs, str, type FlagSpec, type Parsed } from './args';
import {
  expiresAt,
  loadConfig,
  loadCredentials,
  MAX_SKILL_NOTES,
  normalizeOrigin,
  resolveInstance,
  saveConfig,
  saveCredential,
  UsageError,
  type CliConfig,
} from './config';
import { checkCommand, commandVerdict, oneShot, printOutcomes, runExec } from './exec';
import { copyBetween, DEFAULT_MAX_BYTES, describeTransfer, download, localPath, progressText, splitRemote, upload, type Progress } from './files';
import { agentStatus, execViaAgent, runAgent, stopAgent } from './agent';
import { install, installStatus, mcpLaunch, refresh, skillTargets, syncSkills, uninstall } from './install';
import { login } from './login';
import { REMOTE_ACCESS, serveStdio, type RemoteAccess } from './mcp';
import { hashPassword, parsePasswordHash, serveHttp } from './mcp-http';
import { MCP_CLIENTS, mcpTargets, parseMcpClients, registerMcp, unregisterMcp, type McpClientTarget } from './mcp-clients';
import { api, ApiError, installNetwork, instanceOrigin, networkMessage } from './net';
import { askSecret, confirm, interactive, readCommandFile, readStdin } from './prompt';
import { activeInstance, connect as connectInstance, filterServers, formatServerRow, hostId, hostIdsOf, loadServers, resolveSingle, resolveTargets } from './targets';

const HELP = `cloudssh ${CLIENT_VERSION}（${CLIENT_CODENAME.zh} ${CLIENT_CODENAME.en}）— CloudSSH 命令行，不开客户端直接操作已保存的服务器

用法：cloudssh <命令> [参数]（别名 cssh）

登录
  login [https://域名]          登录（GitHub 授权或管理员密码）；--start / --callback "<网址>" 分两步完成
  logout                        退出登录
  status                        当前实例、用户、登录到期时间

服务器
  servers [-q 关键字] [--tag 标签]   列出服务器（主机 ID、名称、标签、系统、线路）
  exec <目标> "<命令>"          执行命令；--stdin 从标准输入读命令，--file <文件> 从 UTF-8 文件读命令，
                                --timeout 秒，--yes 确认危险命令；到同一台服务器的会话由后台进程复用
                                （空闲 3 分钟退出；CLOUDSSH_AGENT=0 不用，CLOUDSSH_AGENT_IDLE 改空闲秒数）
  agent [status | stop]         后台会话进程的状态、让它退出（关闭所有会话）
  upload <目标> <本机路径> <远程路径>      上传文件或目录
  download <目标> <远程路径> <本机路径>    下载文件或目录（--max-size MB，默认 2048）
  copy <目标:路径> <目标:路径>  服务器之间传文件或目录（能直连就直连）；覆盖已有的要 --yes

设置
  alias [set <名字> <目标> | rm <名字>]   目标的别名
  config [get | set <项> <值>]            confirm（ask / never 完全权限）、concurrency、timeout、notes（给 AI 的补充说明）、default
  skill [status | sync | enable <agent> | disable <agent>]   各 agent（claude、codex、agents）的 skill 开关
  install [--bin-dir 目录] [--no-skill] [--mcp 应用,…]   装成命令并安装 Claude Code skill（--status 查看安装状态；
                                        --refresh 按版本让命令与 skill 跟上这份程序，旧的才动，桌面客户端启动时用）；
                                        --mcp 同时把 MCP 服务器登记给 claude-desktop、cursor、vscode、windsurf、codex（或 all）
  uninstall [--keep-skill] [--purge]     卸载命令、skill 与 MCP 登记（--purge 连配置与登录一起删）
  version

MCP（给 Claude Desktop、Cursor、VS Code 等不支持 skill 的应用）
  mcp                           MCP 服务器（stdio）：list_servers、exec、upload、download、copy，规则与命令行一致
  mcp status | add <应用> | remove <应用>   查看、登记、移除各应用里的 MCP 服务器（改配置前先备份）
  mcp http --public-url <https 地址> [--listen 127.0.0.1:8790] [--access full|ask|read-only] [--exclude srv-1,…]
                                远程 MCP 服务器（给云端 AI，如 Muse 的自定义连接器）：OAuth 授权，口令哈希放在环境变量
                                CLOUDSSH_MCP_PASSWORD_HASH（mcp http --hash-password 生成）；权限默认 read-only

目标：srv-12（主机 ID，各设备一样）、名称、别名、tag:标签、all，多个用逗号隔开
通用选项：--instance/-i <名称或地址> 选实例，--json 输出 JSON，--help
配置在 ~/.cloudssh/（config.json、credentials.json）`;

function log(text: string): void {
  process.stderr.write(`${text}\n`);
}

function out(value: unknown, json: boolean, text: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text()}\n`);
}

function flagsWith(extra: FlagSpec): FlagSpec {
  return { ...COMMON, ...extra };
}

/** 传输进度：只在终端里、非 JSON 时显示在 stderr */
function progressPrinter(json: boolean): Progress & { end(): void } {
  const show = !json && !!process.stderr.isTTY;
  let last = '';
  const print = ((step: string, loaded?: number, total?: number) => {
    if (!show) return;
    const line = progressText(step, loaded, total);
    if (line === last) return;
    last = line;
    process.stderr.write(`\r\x1b[K${line}`);
  }) as Progress & { end(): void };
  print.end = () => {
    if (show && last) process.stderr.write('\r\x1b[K');
  };
  return print;
}

/** 装好网络、取服务器列表（--instance 选实例） */
function connect(parsed: Parsed): Promise<{ config: CliConfig; servers: ServerConfig[]; origin: string }> {
  return connectInstance(str(parsed, 'instance'));
}

async function cmdServers(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, flagsWith({ query: { type: 'string', short: 'q' }, tag: { type: 'string', short: 't' } }));
  const { servers } = await connect(parsed);
  const rows = filterServers(servers, str(parsed, 'query'), str(parsed, 'tag'));
  out(rows, bool(parsed, 'json'), () => (rows.length ? rows.map(formatServerRow).join('\n') : '（没有匹配的服务器）'));
  return 0;
}

async function cmdExec(argv: string[]): Promise<number> {
  const parsed = parseArgs(
    argv,
    flagsWith({
      stdin: { type: 'boolean' },
      file: { type: 'string' },
      timeout: { type: 'string', short: 't' },
      yes: { type: 'boolean', short: 'y' },
    }),
    1
  );
  const [spec] = parsed.positionals;
  if (!spec) throw new UsageError('用法：cloudssh exec <目标> "<命令>"（或 --stdin、--file <文件>）');
  let command = parsed.rest.join(' ');
  const file = str(parsed, 'file');
  if (file && bool(parsed, 'stdin')) throw new UsageError('--stdin 和 --file 只能用一个');
  if (file || bool(parsed, 'stdin')) {
    if (command) throw new UsageError(`用了 ${file ? '--file' : '--stdin'} 就不要再在参数里写命令`);
    command = (file ? readCommandFile(localPath(file)) : await readStdin()).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  }
  if (!command.trim()) throw new UsageError('没有要执行的命令');
  const { config, origin } = activeInstance(str(parsed, 'instance'));
  const timeout = int(parsed, 'timeout', 1, 3600) ?? config.timeout;
  const yes = bool(parsed, 'yes');
  const runnable = commandVerdict(command, yes, config.confirm).action === 'run';
  if (runnable) {
    // 交给后台会话进程（复用到服务器的会话）；用不了时往下在本进程执行
    const results = await execViaAgent(origin, { spec, command, timeout });
    if (results) return printOutcomes(results, bool(parsed, 'json'));
    // 目标都是主机 ID 时，先开始连服务器，同时取服务器列表（省掉“先取列表、再连接”的那一段）
    for (const id of hostIdsOf(spec, config)?.slice(0, config.concurrency) ?? []) remoteSession(id);
  }
  const servers = await loadServers();
  const targets = resolveTargets(spec, servers, config);
  await checkCommand(command, yes, config.confirm, targets.map((server) => `${hostId(server)} ${server.name}`).join('、'));
  const results = await runExec(targets, command, timeout, config.concurrency, oneShot);
  return printOutcomes(results, bool(parsed, 'json'));
}

async function cmdUpload(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, COMMON);
  const [spec, local, remote] = parsed.positionals;
  if (!spec || !local || !remote) throw new UsageError('用法：cloudssh upload <目标> <本机路径> <远程路径>');
  const { config, servers } = await connect(parsed);
  const server = resolveSingle(spec, servers, config);
  const progress = progressPrinter(bool(parsed, 'json'));
  const result = await upload(server, localPath(local), remote, progress).finally(() => progress.end());
  out({ server: hostId(server), ...result }, bool(parsed, 'json'), () => `已上传到 ${hostId(server)} ${server.name}：${describeTransfer(result)}`);
  return 0;
}

async function cmdDownload(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, flagsWith({ 'max-size': { type: 'string' } }));
  const [spec, remote, local] = parsed.positionals;
  if (!spec || !remote || !local) throw new UsageError('用法：cloudssh download <目标> <远程路径> <本机路径>');
  const maxMb = int(parsed, 'max-size', 1, 1024 * 1024);
  const { config, servers } = await connect(parsed);
  const server = resolveSingle(spec, servers, config);
  const progress = progressPrinter(bool(parsed, 'json'));
  const result = await download(server, remote, localPath(local), maxMb ? maxMb * 1024 * 1024 : DEFAULT_MAX_BYTES, progress).finally(() => progress.end());
  out({ server: hostId(server), ...result }, bool(parsed, 'json'), () => `已从 ${hostId(server)} ${server.name} 下载：${describeTransfer(result)}`);
  return 0;
}

async function cmdCopy(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, flagsWith({ yes: { type: 'boolean', short: 'y' } }));
  const [fromSpec, toSpec] = parsed.positionals;
  const from = fromSpec ? splitRemote(fromSpec) : null;
  const to = toSpec ? splitRemote(toSpec) : null;
  if (!from || !to) throw new UsageError('用法：cloudssh copy <目标:路径> <目标:路径>（例如 srv-12:/root/a.tgz srv-34:/tmp/）');
  const { config, servers } = await connect(parsed);
  const source = resolveSingle(from.target, servers, config);
  const target = resolveSingle(to.target, servers, config);
  const yes = bool(parsed, 'yes') || config.confirm === 'never';
  const overwrite = async (dest: string) => yes || (interactive() && (await confirm(`${target.name} 上已有 ${dest}，覆盖？`)));
  const progress = progressPrinter(bool(parsed, 'json'));
  const result = await copyBetween(source, from.path, target, to.path, overwrite, progress).finally(() => progress.end());
  out({ from: hostId(source), to: hostId(target), ...result }, bool(parsed, 'json'), () =>
    `已从 ${hostId(source)} ${source.name} 传到 ${hostId(target)} ${target.name}：${describeTransfer(result)}`
  );
  return 0;
}

async function cmdLogin(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, flagsWith({ start: { type: 'boolean' }, callback: { type: 'string' }, 'no-browser': { type: 'boolean' } }));
  await login(
    { url: parsed.positionals[0] ?? str(parsed, 'instance'), start: bool(parsed, 'start'), callback: str(parsed, 'callback'), noBrowser: bool(parsed, 'no-browser') },
    log
  );
  return 0;
}

/** cloudssh agent [status | stop]：后台会话进程的状态、让它退出 */
async function cmdAgent(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, COMMON);
  const [action = 'status'] = parsed.positionals;
  const { origin } = resolveInstance(loadConfig(), str(parsed, 'instance'));
  if (action === 'stop') {
    const stopped = await stopAgent(origin);
    out({ stopped }, bool(parsed, 'json'), () => (stopped ? '后台会话进程已退出，会话都已关闭' : '后台会话进程没有在运行'));
    return 0;
  }
  if (action !== 'status') throw new UsageError('用法：cloudssh agent [status | stop]');
  const status = await agentStatus(origin);
  out(status ?? { running: false }, bool(parsed, 'json'), () => {
    if (!status) return '后台会话进程没有在运行（下次 exec 时自动启动）';
    const sessions = status.sessions.length
      ? status.sessions.map((item) => `${item.server} ${item.open} 条${item.busy ? `（${item.busy} 条在执行）` : ''}`).join('，')
      : '没有';
    const idle = status.idleExitMs === null ? '有命令在执行' : `空闲 ${Math.ceil(status.idleExitMs / 1000)} 秒后自动退出`;
    return `后台会话进程在运行（进程 ${status.pid}，${idle}）\n会话：${sessions}`;
  });
  return 0;
}

async function cmdLogout(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, COMMON);
  const instance = resolveInstance(loadConfig(), str(parsed, 'instance'));
  // 退出登录时也关掉后台进程里用这个登录开的会话
  await stopAgent(instance.origin).catch(() => false);
  if (instance.credential) {
    installNetwork(instance.origin, instance.credential.session);
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  }
  saveCredential(instance.origin, null);
  log(`已退出 ${instance.origin}`);
  return 0;
}

async function cmdStatus(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, COMMON);
  const config = loadConfig();
  const instance = resolveInstance(config, str(parsed, 'instance'));
  const credential = instance.credential;
  let user: string | null = null;
  let valid = false;
  if (credential) {
    installNetwork(instance.origin, credential.session);
    try {
      const me = await api<{ username?: string }>('/api/auth/me');
      user = me?.username ?? null;
      valid = true;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
  }
  const info = {
    instance: instance.origin,
    name: instance.name,
    signedIn: valid,
    user,
    source: credential?.source ?? null,
    expiresAt: credential ? expiresAt(credential).toISOString() : null,
    instances: config.instances.map((item) => ({ ...item, default: item.url === config.defaultInstance, signedIn: !!loadCredentials()[item.url] })),
  };
  out(info, bool(parsed, 'json'), () =>
    [
      `实例：${instance.name}（${instance.origin}）`,
      valid
        ? `已登录：${user ?? '?'}（来自${credential!.source === 'desktop' ? '桌面客户端同步' : ' cloudssh login'}，约 ${expiresAt(credential!).toLocaleString()} 过期）`
        : credential
          ? '登录已失效：运行 cloudssh login'
          : '未登录：运行 cloudssh login',
    ].join('\n')
  );
  return valid ? 0 : 1;
}

async function cmdAlias(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, COMMON);
  const [action, name, ...rest] = parsed.positionals;
  const config = loadConfig();
  if (action === 'set') {
    if (!name || !rest.length) throw new UsageError('用法：cloudssh alias set <名字> <目标>');
    if (/^(all|srv-\d+|\d+|tag:.*)$/i.test(name) || name.includes(',')) throw new UsageError('别名不能是 all、主机 ID、tag: 开头或带逗号');
    config.aliases[name] = rest.join(' ');
    saveConfig(config);
    syncSkills(config);
    log(`${name} → ${config.aliases[name]}`);
    return 0;
  }
  if (action === 'rm' || action === 'remove') {
    if (!name || !(name in config.aliases)) throw new UsageError(`没有别名 ${name ?? ''}`);
    delete config.aliases[name];
    saveConfig(config);
    syncSkills(config);
    return 0;
  }
  if (action) throw new UsageError('用法：cloudssh alias [set <名字> <目标> | rm <名字>]');
  out(config.aliases, bool(parsed, 'json'), () =>
    Object.entries(config.aliases)
      .map(([key, value]) => `${key} → ${value}`)
      .join('\n') || '（还没有别名）'
  );
  return 0;
}

/** skill：status（默认）/ sync / enable <agent> / disable <agent>；agent 是 claude、codex、agents */
async function cmdSkill(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, COMMON);
  const [action = 'status', agent] = parsed.positionals;
  const config = loadConfig();
  if (action === 'enable' || action === 'disable') {
    const target = skillTargets(config).find((item) => item.id === agent);
    if (!agent || !target) {
      throw new UsageError(`用法：cloudssh skill ${action} <${skillTargets(config).map((item) => item.id).join('|')}>`);
    }
    config.skills[agent] = action === 'enable';
    saveConfig(config);
  } else if (action !== 'sync' && action !== 'status') {
    throw new UsageError('用法：cloudssh skill [status | sync | enable <agent> | disable <agent>]');
  }
  const lines = action === 'status' ? [] : syncSkills(config);
  const targets = skillTargets(config);
  out(targets, bool(parsed, 'json'), () =>
    [
      ...lines,
      ...targets.map(
        (item) =>
          `${item.id.padEnd(7)} ${item.name}：${item.enabled ? (item.installed ? (item.current ? '已装' : '已装（不是最新，cloudssh skill sync 更新）') : '开着但没装（cloudssh skill sync）') : item.installed ? '关着但还装着（cloudssh skill sync）' : '关'}`
      ),
    ].join('\n')
  );
  return 0;
}

async function cmdConfig(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, COMMON);
  const [action, key, value] = parsed.positionals;
  const config = loadConfig();
  if (action === 'set') {
    if (key === 'confirm' && (value === 'ask' || value === 'never')) config.confirm = value;
    else if (key === 'concurrency' && /^\d+$/.test(value ?? '') && Number(value) >= 1 && Number(value) <= 32) config.concurrency = Number(value);
    else if (key === 'timeout' && /^\d+$/.test(value ?? '') && Number(value) >= 1 && Number(value) <= 3600) config.timeout = Number(value);
    else if (key === 'notes' && value !== undefined) config.skillNotes = value.slice(0, MAX_SKILL_NOTES);
    else if (key === 'default' && value) {
      const hit = config.instances.find((item) => item.name === value);
      config.defaultInstance = hit?.url ?? normalizeOrigin(value);
    } else throw new UsageError('可设置：confirm ask|never、concurrency 1-32、timeout 1-3600、notes "<给 AI 的补充说明>"、default <实例名或地址>');
    saveConfig(config);
    // 完全权限、超时、并发、补充说明都写在 skill 里：跟着更新已装的
    for (const line of syncSkills(config)) log(line);
    return 0;
  }
  if (action && action !== 'get') throw new UsageError('用法：cloudssh config [get | set <项> <值>]');
  out(config, true, () => '');
  return 0;
}

function mcpState(item: McpClientTarget): string {
  if (item.error) return `读不了配置：${item.error}`;
  if (item.registered) return item.current ? '已登记' : `已登记（指向的不是现在这个程序，cloudssh mcp add ${item.id} 更新）`;
  return item.present ? '未登记' : '没装这个应用';
}

/** 主机 ID 列表（srv-12,srv-34 或 12,34）→ 编号 */
function hostIdSet(spec: string | undefined): Set<number> {
  const ids = new Set<number>();
  for (const part of (spec ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const match = /^(?:srv-)?(\d+)$/i.exec(part);
    if (!match) throw new UsageError(`--exclude 只认主机 ID（srv-12 或 12）：${part}`);
    ids.add(Number(match[1]));
  }
  return ids;
}

/** mcp http：远程 MCP 服务器（给云端 AI 用）；--hash-password 生成授权口令的哈希 */
async function cmdMcpHttp(parsed: Parsed): Promise<number> {
  if (bool(parsed, 'hash-password')) {
    let password: string;
    if (interactive()) {
      password = await askSecret('设置授权口令（至少 12 个字符）：');
      if ((await askSecret('再输入一次：')) !== password) throw new UsageError('两次输入的口令不一样');
    } else {
      password = (await readStdin()).replace(/\r?\n$/, '');
    }
    process.stdout.write(`${hashPassword(password)}\n`);
    return 0;
  }
  const publicUrl = str(parsed, 'public-url') ?? process.env.CLOUDSSH_MCP_PUBLIC_URL;
  if (!publicUrl) throw new UsageError('缺少对外地址：--public-url https://mcp.example.com（或环境变量 CLOUDSSH_MCP_PUBLIC_URL）');
  let origin: URL;
  try {
    origin = new URL(publicUrl);
  } catch {
    throw new UsageError(`对外地址不对：${publicUrl}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) || origin.search || origin.hash) {
    throw new UsageError('对外地址要是 https://…（本机测试可以用 http://127.0.0.1:端口），不带查询参数');
  }
  const passwordHash = process.env.CLOUDSSH_MCP_PASSWORD_HASH;
  if (!passwordHash) throw new UsageError('缺少授权口令：先用 cloudssh mcp http --hash-password 生成哈希，放进环境变量 CLOUDSSH_MCP_PASSWORD_HASH');
  parsePasswordHash(passwordHash);
  const access = (str(parsed, 'access') ?? process.env.CLOUDSSH_MCP_ACCESS ?? 'read-only') as RemoteAccess;
  if (!REMOTE_ACCESS.includes(access)) throw new UsageError(`--access 只能是 ${REMOTE_ACCESS.join('、')}`);
  await serveHttp({
    instance: str(parsed, 'instance'),
    listen: str(parsed, 'listen') ?? process.env.CLOUDSSH_MCP_LISTEN ?? '127.0.0.1:8790',
    publicUrl: origin.toString().replace(/\/+$/, ''),
    passwordHash,
    access,
    exclude: hostIdSet(str(parsed, 'exclude') ?? process.env.CLOUDSSH_MCP_EXCLUDE),
  });
  return 0;
}

/** mcp：不带参数（或 serve）是 stdio 服务器；http 是远程服务器；status / add <应用> / remove <应用> 管各应用里的登记 */
async function cmdMcp(argv: string[]): Promise<number> {
  const parsed = parseArgs(
    argv,
    flagsWith({
      'bin-dir': { type: 'string' },
      listen: { type: 'string' },
      'public-url': { type: 'string' },
      access: { type: 'string' },
      exclude: { type: 'string' },
      'hash-password': { type: 'boolean' },
    })
  );
  const [action = 'serve', spec] = parsed.positionals;
  if (action === 'serve') {
    await serveStdio(str(parsed, 'instance'));
    return 0;
  }
  if (action === 'http') return cmdMcpHttp(parsed);
  const binDir = str(parsed, 'bin-dir');
  let lines: string[] = [];
  if (action === 'add' || action === 'remove') {
    if (!spec) throw new UsageError(`用法：cloudssh mcp ${action} <${MCP_CLIENTS.map((item) => item.id).join('|')}|all>，多个用逗号隔开`);
    if (action === 'add') lines = registerMcp(parseMcpClients(spec), mcpLaunch(binDir));
    else lines = unregisterMcp(spec.trim().toLowerCase() === 'all' ? undefined : parseMcpClients(spec));
    if (!lines.length) lines = ['没有要移除的 MCP 登记'];
  } else if (action !== 'status') {
    throw new UsageError('用法：cloudssh mcp [serve | http | status | add <应用> | remove <应用>]');
  }
  if (bool(parsed, 'json')) {
    // add / remove 与 install 一样输出安装状态（桌面客户端用），status 输出各应用的登记
    out(action === 'status' ? mcpTargets(mcpLaunch(binDir)) : installStatus(binDir), true, () => '');
    return 0;
  }
  for (const line of lines) log(line);
  if (action === 'status') {
    const targets = mcpTargets(mcpLaunch(binDir)).filter((item) => item.present || item.registered);
    out(targets, false, () =>
      targets.length
        ? targets.map((item) => `${item.id.padEnd(15)} ${item.name}：${mcpState(item)}（${item.path}）`).join('\n')
        : '这台电脑上没有找到支持的 MCP 客户端（claude-desktop、cursor、vscode、windsurf、codex）'
    );
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${HELP}\n`);
    return command ? 0 : 2;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${CLIENT_VERSION}\n`);
    return 0;
  }
  // exec 的命令里可能有 --help / -h（ls --help、df -h）：只看紧跟在子命令后面的
  const execLike = command === 'exec' || command === 'run';
  if (rest[0] === '--help' || rest[0] === '-h' || (!execLike && rest.includes('--help'))) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  switch (command) {
    case '__agent':
      // 后台会话进程本体（由 exec 在后台启动，不在帮助里列出）
      if (!rest[0]) throw new UsageError('用法：cloudssh __agent <实例地址>');
      await runAgent(rest[0]);
      return 0;
    case 'agent':
      return cmdAgent(rest);
    case 'login':
      return cmdLogin(rest);
    case 'logout':
      return cmdLogout(rest);
    case 'status':
    case 'whoami':
      return cmdStatus(rest);
    case 'servers':
    case 'ls':
      return cmdServers(rest);
    case 'exec':
    case 'run':
      return cmdExec(rest);
    case 'upload':
    case 'put':
      return cmdUpload(rest);
    case 'download':
    case 'get':
      return cmdDownload(rest);
    case 'copy':
    case 'cp':
      return cmdCopy(rest);
    case 'alias':
      return cmdAlias(rest);
    case 'skill':
    case 'skills':
      return cmdSkill(rest);
    case 'config':
      return cmdConfig(rest);
    case 'mcp':
      return cmdMcp(rest);
    case 'install': {
      const parsed = parseArgs(
        rest,
        flagsWith({
          'bin-dir': { type: 'string' },
          'no-skill': { type: 'boolean' },
          'in-place': { type: 'boolean' },
          status: { type: 'boolean' },
          refresh: { type: 'boolean' },
          mcp: { type: 'string' },
        })
      );
      if (bool(parsed, 'refresh')) {
        const result = refresh(str(parsed, 'bin-dir'));
        if (bool(parsed, 'json')) out({ ...result, status: installStatus(str(parsed, 'bin-dir')) }, true, () => '');
        else for (const line of result.lines.length ? result.lines : ['命令与 skill 已是最新（或由更新的版本管理），没有改动']) log(line);
        return 0;
      }
      if (bool(parsed, 'status')) {
        const status = installStatus(str(parsed, 'bin-dir'));
        out(status, bool(parsed, 'json'), () =>
          [
            status.installed
              ? `命令：${status.binDir}（${status.exists ? '正常' : '指向的程序不在了，请重新安装'}${status.onPath ? '' : '，不在 PATH 里'}${status.launcher === 'cmd' ? '，旧版的 .cmd 启动脚本，重新安装可换成 .exe' : ''}）`
              : '命令：未安装',
            status.installed ? `程序：${status.program}，运行时：${status.appRuntime ? 'CloudSSH 客户端' : status.runtime}` : '',
            ...status.skills.map(
              (item) => `${item.name} skill：${item.installed ? (item.current ? '已装' : '已装（不是这个版本的，重新安装可更新）') : '未装'}`
            ),
            ...status.mcp.filter((item) => item.registered).map((item) => `${item.name} MCP：${mcpState(item)}`),
          ]
            .filter(Boolean)
            .join('\n')
        );
        return 0;
      }
      const lines = install({
        binDir: str(parsed, 'bin-dir'),
        skill: !bool(parsed, 'no-skill'),
        inPlace: bool(parsed, 'in-place'),
        mcp: str(parsed, 'mcp'),
      });
      if (bool(parsed, 'json')) out(installStatus(str(parsed, 'bin-dir')), true, () => '');
      else for (const line of lines) log(line);
      return 0;
    }
    case 'uninstall': {
      const parsed = parseArgs(rest, flagsWith({ 'bin-dir': { type: 'string' }, 'keep-skill': { type: 'boolean' }, purge: { type: 'boolean' } }));
      const lines = uninstall({ binDir: str(parsed, 'bin-dir'), keepSkill: bool(parsed, 'keep-skill'), purge: bool(parsed, 'purge') });
      if (bool(parsed, 'json')) out(installStatus(str(parsed, 'bin-dir')), true, () => '');
      else for (const line of lines) log(line);
      return 0;
    }
    default:
      throw new UsageError(`不认识的命令 ${command}（cloudssh --help 查看）`);
  }
}

main(process.argv.slice(2))
  .catch((error: unknown) => {
    // 漏网的网络错误（Node 只说 “fetch failed”）也说清楚原因
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw === 'fetch failed' ? networkMessage(instanceOrigin() || '服务器', error) : raw;
    process.stderr.write(`cloudssh: ${message}\n`);
    return error instanceof UsageError ? 2 : 1;
  })
  .then((code) => {
    closeAllRemoteSessions();
    // 让事件循环自然结束（Windows 上有句柄未关时直接 process.exit 会触发 libuv 断言、退出码变成 127）；
    // 还有东西挂着（连接保活等）就 3 秒后强制退出
    process.exitCode = code;
    setTimeout(() => process.exit(code), 3000).unref();
  });
