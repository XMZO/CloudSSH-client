/**
 * 扫码同步（电脑 → 手机）的数据格式，两端共用：
 *
 *   内容 JSON ──压缩（deflate-raw）──► AES-256-GCM 加密 ──► Base45 文本 ──► 切成多段，每段一张二维码
 *
 * - 密钥：PBKDF2-SHA256（60 万轮）从“内置固定密钥 + 本次的验证码”派生，每次另加 16 字节随机盐。
 *   内置密钥让其他扫码工具只看到乱码；验证码只显示在电脑屏幕上、每次生成都不同，手机要手动输入才能解开。
 * - 验证码：6 位字母数字，不区分大小写，去掉了容易看错的 0 O 1 I L（31 个字符，约 8.9 亿种组合）。
 *   不用 4 位：内置密钥写在应用里，4 位验证码只有约 92 万种，拿到二维码后几分钟就能穷举出来。
 * - 二维码用字母数字模式（Base45 正好落在它的 45 个字符里，比 Base64 + 字节模式多装约 30%）。
 *   每段：CS1:<会话>:<序号>/<总数>:<数据>。会话号让手机不会把两次生成的二维码混在一起。
 */

/** 内置固定密钥（不随版本变化：新旧版本之间也能互相同步） */
const BUILT_IN_KEY = '617de9c76677faf637d473d0ab72b57a693cc8b44648e78b2fb7311c5f816b23';
const PBKDF2_ROUNDS = 600_000;
const FORMAT_VERSION = 1;
const FLAG_DEFLATE = 1;

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;
/** 每张二维码装的数据字符数（约 15 版二维码，手机对着屏幕扫很轻松） */
export const CHUNK_CHARS = 620;
/** 一次最多这么多张（再多扫起来太久，提示少勾一些） */
export const MAX_FRAMES = 160;

const FRAME_PATTERN = /^CS1:([0-9A-Z]{4}):(\d{1,3})\/(\d{1,3}):([0-9A-Z $%*+\-./:]+)$/;

// ---------- 内容 ----------

export interface SyncOrder {
  /** 分组顺序（标签名；未分组为 __ungrouped__） */
  groups: string[];
  /** 分组 → 组内服务器 id 顺序 */
  servers: Record<string, number[]>;
  /** 电脑侧栏的排序方式：name / count / recent / custom */
  sort: string;
  /** 折叠着的分组 */
  collapsed: string[];
}

export interface SyncPreset {
  id: string;
  name: string;
  username: string;
  method: 'password' | 'publickey';
  secret: string;
  updatedAt: number;
}

export interface SyncPayload {
  v: 1;
  createdAt: number;
  /** 来源：Worker 地址与账号。分组排序、预设与服务器的关联只对同一个实例的同一个账号有意义 */
  source: { origin: string; userId: number | null; name: string };
  order?: SyncOrder;
  presets?: { items: SyncPreset[]; links: Record<string, number[]> };
}

// ---------- 验证码 ----------

export function newCode(): string {
  const out: string[] = [];
  const bytes = new Uint8Array(1);
  // 拒绝采样，避免取模带来的偏差
  while (out.length < CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    if (bytes[0] < 248) out.push(CODE_ALPHABET[bytes[0] % CODE_ALPHABET.length]);
  }
  return out.join('');
}

/** 用户输入 → 规范形式（大写、去掉空格与连字符）；含非法字符时返回 null */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const char of code) if (!CODE_ALPHABET.includes(char)) return null;
  return code;
}

/** 显示用：ABC-DEF */
export function formatCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

// ---------- Base45（RFC 9285） ----------

const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export function base45Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      const n = bytes[i] * 256 + bytes[i + 1];
      out += B45[n % 45] + B45[Math.floor(n / 45) % 45] + B45[Math.floor(n / 2025)];
    } else {
      const n = bytes[i];
      out += B45[n % 45] + B45[Math.floor(n / 45)];
    }
  }
  return out;
}

export function base45Decode(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor(text.length / 3) * 2 + (text.length % 3 === 2 ? 1 : 0));
  if (text.length % 3 === 1) throw new Error('base45: bad length');
  let o = 0;
  const value = (char: string) => {
    const v = B45.indexOf(char);
    if (v < 0) throw new Error('base45: bad char');
    return v;
  };
  for (let i = 0; i < text.length; i += 3) {
    if (i + 2 < text.length) {
      const n = value(text[i]) + value(text[i + 1]) * 45 + value(text[i + 2]) * 2025;
      if (n > 0xffff) throw new Error('base45: overflow');
      out[o++] = n >> 8;
      out[o++] = n & 0xff;
    } else {
      const n = value(text[i]) + value(text[i + 1]) * 45;
      if (n > 0xff) throw new Error('base45: overflow');
      out[o++] = n;
    }
  }
  return out;
}

// ---------- 压缩与加密 ----------

async function pipeBytes(bytes: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  const output = new Blob([bytes]).stream().pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

async function deriveKey(code: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${BUILT_IN_KEY}:${code}`), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ROUNDS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** 内容 → 加密后的 Base45 文本 */
export async function sealPayload(payload: SyncPayload, code: string): Promise<string> {
  let body = new TextEncoder().encode(JSON.stringify(payload));
  let flags = 0;
  if (typeof CompressionStream === 'function') {
    body = await pipeBytes(body, new CompressionStream('deflate-raw'));
    flags |= FLAG_DEFLATE;
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const head = new Uint8Array([FORMAT_VERSION, flags]);
  const key = await deriveKey(code, salt);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: head }, key, body));
  const blob = new Uint8Array(head.length + salt.length + iv.length + sealed.length);
  blob.set(head, 0);
  blob.set(salt, 2);
  blob.set(iv, 18);
  blob.set(sealed, 30);
  return base45Encode(blob);
}

export class WrongCodeError extends Error {}

/** 加密后的 Base45 文本 → 内容；验证码不对（或数据被改过）时抛 WrongCodeError */
export async function openPayload(text: string, code: string): Promise<SyncPayload> {
  const blob = base45Decode(text);
  if (blob.length < 30 + 16 || blob[0] !== FORMAT_VERSION) throw new Error('unsupported');
  const head = blob.slice(0, 2);
  const key = await deriveKey(code, blob.slice(2, 18));
  let body: Uint8Array;
  try {
    body = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(18, 30), additionalData: head }, key, blob.slice(30)));
  } catch {
    throw new WrongCodeError('wrong code');
  }
  if (head[1] & FLAG_DEFLATE) body = await pipeBytes(body, new DecompressionStream('deflate-raw'));
  const payload = JSON.parse(new TextDecoder().decode(body)) as SyncPayload;
  if (payload?.v !== 1 || typeof payload.source?.origin !== 'string') throw new Error('unsupported');
  return payload;
}

// ---------- 分段 ----------

function sessionId(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((byte) => chars[byte % chars.length]).join('');
}

/** 加密后的文本切成二维码内容；太长时返回 null */
export function toFrames(text: string): string[] | null {
  const total = Math.max(1, Math.ceil(text.length / CHUNK_CHARS));
  if (total > MAX_FRAMES) return null;
  const sid = sessionId();
  const frames: string[] = [];
  for (let i = 0; i < total; i++) frames.push(`CS1:${sid}:${i + 1}/${total}:${text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)}`);
  return frames;
}

/** 手机端收集扫到的各段；换了一组二维码（会话号变了）时从头收 */
export class FrameCollector {
  private sid = '';
  private total = 0;
  private parts = new Map<number, string>();

  /** 返回 true 表示这一段是新收到的 */
  add(text: string): boolean {
    const match = FRAME_PATTERN.exec(text);
    if (!match) return false;
    const [, sid, indexText, totalText, data] = match;
    const index = Number(indexText);
    const total = Number(totalText);
    if (!total || total > MAX_FRAMES || index < 1 || index > total) return false;
    if (sid !== this.sid || total !== this.total) {
      this.sid = sid;
      this.total = total;
      this.parts.clear();
    }
    if (this.parts.has(index)) return false;
    this.parts.set(index, data);
    return true;
  }

  get received(): number {
    return this.parts.size;
  }

  get expected(): number {
    return this.total;
  }

  get complete(): boolean {
    return this.total > 0 && this.parts.size === this.total;
  }

  has(index: number): boolean {
    return this.parts.has(index);
  }

  text(): string {
    let out = '';
    for (let i = 1; i <= this.total; i++) out += this.parts.get(i) ?? '';
    return out;
  }

  /** 看起来像我们的二维码（其他二维码不提示“已收到”） */
  static isFrame(text: string): boolean {
    return FRAME_PATTERN.test(text);
  }
}
