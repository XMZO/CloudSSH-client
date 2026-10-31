/**
 * 平台适配层：从别的实例导入本地数据。
 *
 * 节点手动排序、分组折叠、命令片段顺序、关键词高亮、各种开关、AI 对话历史……都存在客户端本地，按实例分开
 * （每个实例一个分区，页面存储按地址隔离），不经过 Worker。换了实例地址（比如改走入口网关）后，新实例里是空的。
 * 这里把源实例的这些数据复制到目标实例：
 * - 本地存储里 cloudssh_ 开头的键：目标同名的被覆盖；排序里的服务器 / 命令片段编号换成目标那边的
 * - AI 对话历史（IndexedDB）：换成目标的实例与服务器编号后合并进去
 * - 凭据预设的“哪台服务器用哪个预设”：换编号后合并
 * 编号按内容对应（见 ./instance-import-plan.ts），所以两个实例都要登录着（要读两边的服务器和命令片段列表）。
 * 读写页面存储：在实例自己的分区里开一个隐藏窗口，打开起源桥提供的本地空白页（不启动界面、不碰 Worker）。
 */
import { type InstanceConfig, originOf } from '@cloudssh/core';
import { BrowserWindow, dialog } from 'electron';
import { configStore } from '../config/store';
import { createLogger } from '../logger';
import {
  type Conversation,
  matchIds,
  mergePresetLinks,
  type PresetFile,
  type ServerLike,
  serverKey,
  type SnippetLike,
  snippetKey,
  translateConversations,
  translateLocalStorage,
} from './instance-import-plan';
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
  reloadInstance(targetId);
  return summary;
}
