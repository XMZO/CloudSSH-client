/**
 * 平台适配层：从别的实例导入本地数据。
 *
 * 节点手动排序、分组折叠、命令片段顺序、关键词高亮、各种开关、AI 对话历史……都存在客户端本地，按实例分开
 * （每个实例一个分区，页面存储按地址隔离），不经过 Worker。换了实例地址（比如改走入口网关）后，新实例里是空的。
 * 这里把源实例的这些数据复制到目标实例：
 * - 本地存储里 cloudssh_ 开头的键：目标同名的被覆盖；排序里的服务器 / 命令片段编号换成目标那边的
 * - AI 对话历史（IndexedDB）：换成目标的实例与服务器编号后合并进去
 * - 凭据预设的“哪台服务器用哪个预设”：换编号后合并
 * 编号按内容对应（见 packages/core/src/instance-import.ts），所以两个实例都要登录着（要读两边的服务器和命令片段列表）。
 * 读写页面存储：在实例自己的分区里开一个隐藏窗口，打开起源桥提供的本地空白页（不启动界面、不碰 Worker）。
 */
import {
  type Conversation,
  type InstanceConfig,
  matchIds,
  mergePresetLinks,
  originOf,
  type PresetFile,
  type ServerLike,
  serverKey,
  type SnippetLike,
  snippetKey,
  translateConversations,
  translateLocalStorage,
} from '@cloudssh/core';
import { app, BrowserWindow, dialog, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { configStore } from '../config/store';
import { createLogger } from '../logger';
import { BLANK_PAGE_PATH } from './origin-bridge';
import { prepareInstanceSession } from './session';
import { readPresetFile, writePresetFile } from './vault';
import { reloadInstance } from './windows';

const log = createLogger('instance-import');

const HISTORY_DB = 'cloudssh-agent-history';
const HISTORY_STORE = 'conversations';

export interface ImportSummary {
  settings: number;
  conversations: number;
  presetLinks: number;
  servers: { matched: number; total: number };
}

async function fetchList<T>(instance: InstanceConfig, path: string): Promise<T[]> {
  const { session } = prepareInstanceSession(instance);
  const response = await session.fetch(new URL(path, instance.baseUrl).toString(), {
    credentials: 'include',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) throw new Error(`「${instance.name}」没有登录，先打开它登录一次`);
  if (!response.ok) throw new Error(`读「${instance.name}」的 ${path} 失败（HTTP ${response.status}）`);
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as T[]) : [];
}

/** 在实例分区里打开本地空白页，执行一段脚本，返回结果 */
async function inPage<T>(instance: InstanceConfig, script: string): Promise<T> {
  const { session, ui } = prepareInstanceSession(instance);
  if (ui.kind === 'remote') throw new Error(`「${instance.name}」用的是“跟随 Worker”界面，不支持导入本地数据`);
  const window = new BrowserWindow({
    show: false,
    webPreferences: { session, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  try {
    await window.loadURL(`${originOf(instance.baseUrl)}${BLANK_PAGE_PATH}`);
    return (await window.webContents.executeJavaScript(script, true)) as T;
  } finally {
    window.destroy();
  }
}

const READ_SCRIPT = `(async () => {
  const entries = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('cloudssh_')) entries[key] = localStorage.getItem(key);
  }
  const conversations = await new Promise((resolve) => {
    const request = indexedDB.open(${JSON.stringify(HISTORY_DB)});
    // 没有这个库时不要建出一个空库
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(${JSON.stringify(HISTORY_STORE)})) { db.close(); resolve([]); return; }
      const all = db.transaction(${JSON.stringify(HISTORY_STORE)}).objectStore(${JSON.stringify(HISTORY_STORE)}).getAll();
      all.onsuccess = () => { db.close(); resolve(all.result); };
      all.onerror = () => { db.close(); resolve([]); };
    };
  });
  return { entries, conversations };
})()`;

function writeScript(entries: Record<string, string>, conversations: Conversation[]): string {
  return `(async (entries, conversations) => {
  for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  if (conversations.length === 0) return 0;
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(${JSON.stringify(HISTORY_DB)}, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(${JSON.stringify(HISTORY_STORE)}, { keyPath: 'id' });
      store.createIndex('scope', 'scope');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(${JSON.stringify(HISTORY_STORE)}, 'readwrite');
      const store = tx.objectStore(${JSON.stringify(HISTORY_STORE)});
      for (const conversation of conversations) store.put(conversation);
      tx.oncomplete = () => { db.close(); resolve(conversations.length); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
})(${JSON.stringify(entries)}, ${JSON.stringify(conversations)})`;
}

export async function importInstanceData(sourceId: string, targetId: string): Promise<ImportSummary> {
  const source = configStore.getInstance(sourceId);
  const target = configStore.getInstance(targetId);
  if (!source || !target) throw new Error('实例不存在');
  if (source.id === target.id) throw new Error('源实例和目标实例是同一个');

  const [sourceServers, targetServers, sourceSnippets, targetSnippets] = await Promise.all([
    fetchList<ServerLike>(source, '/api/servers'),
    fetchList<ServerLike>(target, '/api/servers'),
    fetchList<SnippetLike>(source, '/api/snippets'),
    fetchList<SnippetLike>(target, '/api/snippets'),
  ]);
  const servers = matchIds(sourceServers, targetServers, serverKey);
  const snippets = matchIds(sourceSnippets, targetSnippets, snippetKey);

  const data = await inPage<{ entries: Record<string, string>; conversations: Conversation[] }>(source, READ_SCRIPT);
  const entries = translateLocalStorage(data.entries ?? {}, servers, snippets);
  const conversations = translateConversations(
    data.conversations ?? [],
    new URL(source.baseUrl).host,
    new URL(target.baseUrl).host,
    servers
  );
  const written = await inPage<number>(target, writeScript(entries, conversations));

  let presetLinks = 0;
  const raw = readPresetFile();
  if (raw) {
    const merged = mergePresetLinks(JSON.parse(raw) as PresetFile, `instance:${source.id}`, `instance:${target.id}`, servers);
    if (merged.links > 0) writePresetFile(JSON.stringify(merged.file));
    presetLinks = merged.links;
  }

  const summary: ImportSummary = {
    settings: Object.keys(entries).length,
    conversations: written,
    presetLinks,
    servers: { matched: servers.size, total: sourceServers.length },
  };
  log.info('已导入实例本地数据', source.name, '→', target.name, JSON.stringify(summary));
  return summary;
}

// ---------- 第一次打开时自动导入 ----------

/** 每个实例自动导入做过没有：imported（导过）、own（有自己的排序，不用导）、none（没有可导的） */
type Mark = { state: 'imported' | 'own' | 'none'; from?: string; at: number };

function marksPath(): string {
  return path.join(app.getPath('userData'), 'instance-import.json');
}

function readMarks(): Record<string, Mark> {
  try {
    return JSON.parse(fs.readFileSync(marksPath(), 'utf8')) as Record<string, Mark>;
  } catch {
    return {};
  }
}

function setMark(instanceId: string, mark: Omit<Mark, 'at'>): void {
  const marks = readMarks();
  marks[instanceId] = { ...mark, at: Date.now() };
  try {
    fs.writeFileSync(marksPath(), JSON.stringify(marks, null, 2));
  } catch (error) {
    log.warn('记录自动导入状态失败', (error as Error).message);
  }
}

const PROBE_SCRIPT = `(async () => ({
  hasOrder: !!localStorage.getItem('cloudssh_desktop_node_order'),
  conversations: await new Promise((resolve) => {
    const request = indexedDB.open(${JSON.stringify(HISTORY_DB)});
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => resolve(0);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(${JSON.stringify(HISTORY_STORE)})) { db.close(); resolve(0); return; }
      const count = db.transaction(${JSON.stringify(HISTORY_STORE)}).objectStore(${JSON.stringify(HISTORY_STORE)}).count();
      count.onsuccess = () => { db.close(); resolve(count.result); };
      count.onerror = () => { db.close(); resolve(0); };
    };
  }),
}))()`;

/** 服务器至少对上这么多台、且至少是较少那边的一半，才算“同一套数据” */
const MIN_MATCHED = 3;

async function autoImport(target: InstanceConfig): Promise<void> {
  if (readMarks()[target.id]) return;
  const others = configStore.instances.filter((instance) => instance.id !== target.id);
  if (others.length === 0) return setMark(target.id, { state: 'none' });
  // 还没登录（读不到列表）：这次不导，下次打开再试
  const targetServers = await fetchList<ServerLike>(target, '/api/servers').catch(() => null);
  if (!targetServers || targetServers.length < MIN_MATCHED) return;
  const own = await inPage<{ hasOrder: boolean; conversations: number }>(target, PROBE_SCRIPT);
  if (own.hasOrder) return setMark(target.id, { state: 'own' });

  let best: { source: InstanceConfig; score: number } | null = null;
  let unsure = false;
  for (const source of others) {
    try {
      const servers = await fetchList<ServerLike>(source, '/api/servers');
      const matched = matchIds(servers, targetServers, serverKey).size;
      if (matched < MIN_MATCHED || matched < Math.min(servers.length, targetServers.length) / 2) continue;
      const probe = await inPage<{ hasOrder: boolean; conversations: number }>(source, PROBE_SCRIPT);
      const score = (probe.hasOrder ? 1000 : 0) + probe.conversations;
      if (score > own.conversations && (!best || score > best.score)) best = { source, score };
    } catch (error) {
      // 那个实例没登录或连不上：说不准它有没有可导的，先不记“没有”
      log.info('自动导入：读不了', source.name, (error as Error).message);
      unsure = true;
    }
  }
  if (!best) {
    if (!unsure) setMark(target.id, { state: 'none' });
    return;
  }
  const summary = await importInstanceData(best.source.id, target.id);
  setMark(target.id, { state: 'imported', from: best.source.id });
  if (Notification.isSupported()) {
    new Notification({
      title: `已从「${best.source.name}」导入本地数据`,
      body: `节点排序等 ${summary.settings} 项设置、${summary.conversations} 段 AI 对话；以后在「${target.name}」里改的不会再同步回去`,
    }).show();
  }
}

/**
 * 实例第一次打开、页面加载之前调用：服务器和另一个实例是同一套、这个实例还没有自己的排序时，把那个实例的本地数据
 * 自动导进来（页面一打开就是原来的排序和对话）。每个实例只做一次；最多等 15 秒，出错就算了，不耽误打开
 */
const triedThisRun = new Set<string>();

export async function autoImportOnFirstOpen(target: InstanceConfig): Promise<void> {
  // 有标记就不再做；没登录等原因这次没做成的，本次运行里不再试（免得每开一个窗口都多等），下次启动再试
  if (readMarks()[target.id] || triedThisRun.has(target.id)) return;
  triedThisRun.add(target.id);
  // 超过 15 秒就先打开页面，导入在后台接着做；之后出的错也要记下来
  const running = autoImport(target).catch((error: Error) => log.warn('自动导入本地数据失败', target.name, error.message));
  await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 15_000))]);
}

/** 实例管理里点“导入”：先确认（目标实例的窗口会重新加载），再导入 */
export async function confirmAndImport(parent: BrowserWindow | null, sourceId: string, targetId: string): Promise<ImportSummary | null> {
  const source = configStore.getInstance(sourceId);
  const target = configStore.getInstance(targetId);
  if (!source || !target) throw new Error('实例不存在');
  const options = {
    type: 'question' as const,
    title: '导入本地数据',
    message: `把「${source.name}」的本地数据导入「${target.name}」？`,
    detail:
      '包括节点排序、分组折叠、命令片段顺序、关键词高亮与各项开关（同名的会被覆盖），以及 AI 对话历史、凭据预设的关联（合并）。' +
      '两个实例都要登录着。导入后「' + target.name + '」的窗口会重新加载，里面的终端会断开。',
    buttons: ['导入', '取消'],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (response !== 0) return null;
  const summary = await importInstanceData(sourceId, targetId);
  setMark(targetId, { state: 'imported', from: sourceId });
  reloadInstance(targetId);
  return summary;
}
