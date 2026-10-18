/**
 * 凭据预设的数据层：一套用户名 + 密码或私钥，起个名字存在本机，添加/编辑服务器时一键填入，
 * 或批量写进多台已保存的服务器。
 *
 * - 只存在本机，不上传 Worker。密码/私钥先用系统提供的加密再落盘：桌面为 Electron safeStorage
 *   （Windows DPAPI，绑定当前 Windows 账户），手机为 Android Keystore；在浏览器里调试界面时退回
 *   WebCrypto（不可导出的 AES 密钥存在 IndexedDB）。平台在启动时用 configurePresets 指定。
 * - Worker 给每台服务器各存一份凭据（加密存在用户数据库里），预设只是填表的来源：改了预设以后要“同步”
 *   一次，才会写进用过它的服务器。哪台服务器用过哪个预设记在本机（按实例分开，服务器 id 只在实例内有效）。
 */
import { refreshServerList } from '../../sidebar/hooks';

export type AuthMethod = 'password' | 'publickey';

export interface CredentialPreset {
  id: string;
  name: string;
  /** 应用时同时改成这个用户名；空串表示不改 */
  username: string;
  method: AuthMethod;
  /** 加密后的密码或私钥 */
  secret: string;
  updatedAt: number;
}

interface PresetData {
  version: 1;
  presets: CredentialPreset[];
  /** 实例 → 预设 id → 用过它的服务器 id */
  links: Record<string, Record<string, number[]>>;
}

export interface PresetVault {
  available(): Promise<boolean>;
  read(): Promise<string | null>;
  write(data: string): Promise<void>;
  encrypt(text: string): Promise<string>;
  decrypt(data: string): Promise<string>;
}

export const PRESETS_CHANGED_EVENT = 'cloudssh:presets-changed';
const STORAGE_KEY = 'cloudssh_credential_presets';
export const MAX_SECRET_LENGTH = 32 * 1024;
const MAX_PRESETS = 100;

// ---------- 本机存储与加密 ----------

function localRead(): Promise<string | null> {
  try {
    return Promise.resolve(localStorage.getItem(STORAGE_KEY));
  } catch {
    return Promise.resolve(null);
  }
}

function localWrite(data: string): Promise<void> {
  localStorage.setItem(STORAGE_KEY, data);
  return Promise.resolve();
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

let webKey: Promise<CryptoKey> | null = null;

/** 浏览器调试用：不可导出的 AES-GCM 密钥存在 IndexedDB（脚本拿不到密钥本身） */
function browserKey(): Promise<CryptoKey> {
  webKey ??= new Promise<CryptoKey>((resolve, reject) => {
    const request = indexedDB.open('cloudssh-presets', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('keys').objectStore('keys').get('aes');
      get.onerror = () => reject(get.error);
      get.onsuccess = async () => {
        if (get.result) {
          resolve(get.result as CryptoKey);
          return;
        }
        try {
          const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
          const put = db.transaction('keys', 'readwrite').objectStore('keys').put(key, 'aes');
          put.onerror = () => reject(put.error);
          put.onsuccess = () => resolve(key);
        } catch (error) {
          reject(error);
        }
      };
    };
  });
  return webKey;
}

const browserVault: PresetVault = {
  available: () => Promise.resolve(typeof indexedDB !== 'undefined' && !!crypto?.subtle),
  read: localRead,
  write: localWrite,
  async encrypt(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await browserKey(), new TextEncoder().encode(text));
    const out = new Uint8Array(12 + data.byteLength);
    out.set(iv);
    out.set(new Uint8Array(data), 12);
    return toBase64(out);
  },
  async decrypt(blob) {
    const bytes = fromBase64(blob);
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await browserKey(), bytes.slice(12));
    return new TextDecoder().decode(data);
  },
};

/** 只提供加解密的平台（手机）：数据照样存在 localStorage */
export function localVault(cipher: Pick<PresetVault, 'available' | 'encrypt' | 'decrypt'>): PresetVault {
  return { ...cipher, read: localRead, write: localWrite };
}

let vault: PresetVault = browserVault;
let scope = location.origin;

export function configurePresets(options: { vault?: PresetVault | null; scope?: string | null }): void {
  if (options.vault) vault = options.vault;
  if (options.scope) scope = options.scope;
}

export function presetsAvailable(): Promise<boolean> {
  return vault.available().catch(() => false);
}

// ---------- 读写 ----------

function emptyData(): PresetData {
  return { version: 1, presets: [], links: {} };
}

function parse(raw: string | null): PresetData {
  if (!raw) return emptyData();
  try {
    const value = JSON.parse(raw) as Partial<PresetData>;
    const presets = Array.isArray(value.presets)
      ? value.presets.filter(
          (item): item is CredentialPreset =>
            !!item &&
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            typeof item.secret === 'string' &&
            (item.method === 'password' || item.method === 'publickey')
        )
      : [];
    for (const preset of presets) if (typeof preset.username !== 'string') preset.username = '';
    const links = value.links && typeof value.links === 'object' ? value.links : {};
    return { version: 1, presets, links };
  } catch {
    return emptyData();
  }
}

let cache: PresetData | null = null;

async function load(): Promise<PresetData> {
  cache ??= parse(await vault.read());
  return cache;
}

async function save(data: PresetData): Promise<void> {
  cache = data;
  await vault.write(JSON.stringify(data));
  window.dispatchEvent(new Event(PRESETS_CHANGED_EVENT));
}

export async function listPresets(): Promise<CredentialPreset[]> {
  const data = await load();
  return [...data.presets].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPreset(id: string): Promise<CredentialPreset | null> {
  return (await load()).presets.find((item) => item.id === id) ?? null;
}

export interface PresetInput {
  id?: string;
  name: string;
  username: string;
  method: AuthMethod;
  /** 明文；编辑时不传表示不修改 */
  secret?: string;
}

export async function savePreset(input: PresetInput): Promise<CredentialPreset> {
  const data = await load();
  const existing = input.id ? data.presets.find((item) => item.id === input.id) : undefined;
  if (!existing && data.presets.length >= MAX_PRESETS) throw new Error(`最多 ${MAX_PRESETS} 个预设`);
  if (!existing && !input.secret) throw new Error('缺少密码或私钥');
  if (input.secret && input.secret.length > MAX_SECRET_LENGTH) throw new Error('凭据太长');
  const secret = input.secret ? await vault.encrypt(input.secret) : existing!.secret;
  const preset: CredentialPreset = {
    id: existing?.id ?? crypto.randomUUID(),
    name: input.name.trim().slice(0, 60) || 'preset',
    username: input.username.trim().slice(0, 128),
    method: input.method,
    secret,
    updatedAt: Date.now(),
  };
  const presets = existing ? data.presets.map((item) => (item.id === preset.id ? preset : item)) : [...data.presets, preset];
  await save({ ...data, presets });
  return preset;
}

export async function deletePreset(id: string): Promise<void> {
  const data = await load();
  const links = Object.fromEntries(
    Object.entries(data.links).map(([key, map]) => [key, Object.fromEntries(Object.entries(map).filter(([presetId]) => presetId !== id))])
  );
  await save({ ...data, presets: data.presets.filter((item) => item.id !== id), links });
}

export async function revealSecret(preset: CredentialPreset): Promise<string> {
  return vault.decrypt(preset.secret);
}

/** 当前实例里用过这个预设的服务器 */
export async function linkedServers(presetId: string): Promise<number[]> {
  return [...((await load()).links[scope]?.[presetId] ?? [])];
}

/** 记下这些服务器现在用的是这个预设（一台服务器只记一个预设） */
export async function linkServers(presetId: string, serverIds: number[]): Promise<void> {
  if (!serverIds.length) return;
  const data = await load();
  const map = { ...(data.links[scope] ?? {}) };
  const ids = new Set(serverIds);
  for (const key of Object.keys(map)) map[key] = map[key].filter((id) => !ids.has(id));
  map[presetId] = [...new Set([...(map[presetId] ?? []), ...serverIds])];
  await save({ ...data, links: { ...data.links, [scope]: map } });
}

// ---------- 扫码同步（电脑 → 手机） ----------

/** 明文的预设（只在同步时出现在内存里，传输时整体加密） */
export interface PlainPreset {
  id: string;
  name: string;
  username: string;
  method: AuthMethod;
  secret: string;
  updatedAt: number;
}

/** 导出全部预设（解密出密码 / 私钥）和当前实例里的服务器关联 */
export async function exportPresets(): Promise<{ items: PlainPreset[]; links: Record<string, number[]> }> {
  const data = await load();
  const items: PlainPreset[] = [];
  for (const preset of data.presets) {
    items.push({ ...preset, secret: await vault.decrypt(preset.secret) });
  }
  return { items, links: { ...(data.links[scope] ?? {}) } };
}

/**
 * 导入预设：按 id 新增或覆盖（保留 id，服务器关联才能对上），密码 / 私钥用本机的加密重新保存。
 * links 不为 null 时（同一个实例与账号）合并进当前实例的关联。
 */
export async function importPresets(items: PlainPreset[], links: Record<string, number[]> | null): Promise<{ added: number; updated: number }> {
  const data = await load();
  const presets = [...data.presets];
  let added = 0;
  let updated = 0;
  for (const item of items) {
    if (!item.secret || item.secret.length > MAX_SECRET_LENGTH) continue;
    const preset: CredentialPreset = {
      id: item.id,
      name: item.name.trim().slice(0, 60) || 'preset',
      username: (item.username ?? '').trim().slice(0, 128),
      method: item.method === 'publickey' ? 'publickey' : 'password',
      secret: await vault.encrypt(item.secret),
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
    };
    const index = presets.findIndex((existing) => existing.id === preset.id);
    if (index >= 0) {
      presets[index] = preset;
      updated++;
    } else if (presets.length < MAX_PRESETS) {
      presets.push(preset);
      added++;
    }
  }
  let nextLinks = data.links;
  if (links) {
    const known = new Set(presets.map((preset) => preset.id));
    const map = { ...(data.links[scope] ?? {}) };
    for (const [presetId, ids] of Object.entries(links)) {
      if (!known.has(presetId) || !Array.isArray(ids)) continue;
      const clean = ids.filter((id) => Number.isSafeInteger(id));
      const taken = new Set(clean);
      for (const key of Object.keys(map)) map[key] = map[key].filter((id) => !taken.has(id));
      map[presetId] = [...new Set([...(map[presetId] ?? []), ...clean])];
    }
    nextLinks = { ...data.links, [scope]: map };
  }
  await save({ ...data, presets, links: nextLinks });
  return { added, updated };
}

/** 本机已有的预设 id（同步预览里区分“新增 / 覆盖”） */
export async function presetIds(): Promise<Set<string>> {
  return new Set((await load()).presets.map((preset) => preset.id));
}

// ---------- 写进服务器 ----------

export interface ApplyResult {
  ok: number[];
  failed: { id: number; error: string }[];
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // 忽略
  }
  return `HTTP ${response.status}`;
}

/** 逐台 PUT /api/servers/:id（只改认证方式、凭据，以及预设里有的用户名），完成后刷新服务器列表 */
export async function applyPreset(preset: CredentialPreset, serverIds: number[], onProgress?: (done: number) => void): Promise<ApplyResult> {
  const secret = await revealSecret(preset);
  const body: Record<string, string> = { auth_method: preset.method, credential: secret };
  if (preset.username) body.username = preset.username;
  const payload = JSON.stringify(body);
  const result: ApplyResult = { ok: [], failed: [] };
  for (const [index, id] of serverIds.entries()) {
    try {
      const response = await fetch(`/api/servers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: payload,
      });
      if (response.ok) result.ok.push(id);
      else result.failed.push({ id, error: await errorText(response) });
    } catch (error) {
      result.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
    onProgress?.(index + 1);
  }
  await linkServers(preset.id, result.ok);
  try {
    await refreshServerList();
  } catch {
    // 列表刷新失败不影响结果
  }
  return result;
}
