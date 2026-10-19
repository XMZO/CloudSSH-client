/**
 * AI 模型与思考深度（电脑与手机共用，不改 CloudSSH 的 Worker）。
 *
 * 模型存在 Worker 的 AI 配置里（GET / PUT /api/ai/config，每个用户一份、所有服务器共用），这里读出来显示在 AI 面板
 * 输入框下方并可直接切换；模型列表来自 POST /api/ai/models（只传已保存的接口地址，Worker 用已存的密钥去取，
 * 换地址必须带新密钥，这里不碰密钥）。
 *
 * 思考深度：Worker 组请求体时只带 model / input / tools 等固定字段（responses-client.ts 明确不让调用方塞别的参数），
 * 不会带 reasoning.effort。客户端能影响请求的只有模型名、消息内容和接口地址，所以在 Worker 与模型接口之间加一层：
 * 思考深度代理（tools/reasoning-proxy，一个独立的小 Worker，AI 设置里的接口地址填它）。客户端在每条消息末尾附一个
 * 标记 [cloudssh-reasoning:high]，代理转发前删掉所有标记，按最后一个给请求加上 reasoning.effort。
 * 每条消息各自带标记，所以随时切换、不用开新会话；“自动”的标记表示不加，用服务商默认。
 * 只有检测到代理时才附标记（GET 接口地址/cloudssh-reasoning），没有代理时标记会被原样发给模型，所以不附。
 */
import { instanceKey } from './instance';

export interface AiConfig {
  configured: boolean;
  base_url?: string;
  model?: string;
  api_key_last4?: string;
}

export const EFFORTS = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type Effort = (typeof EFFORTS)[number];

/** 各档的界面文案（i18n.ts 的键） */
export const EFFORT_LABEL = {
  auto: 'effortAuto',
  minimal: 'effortMinimal',
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXhigh',
} as const satisfies Record<Effort, string>;

/** 代理状态：ok 已生效；no-upstream 代理在但没设 UPSTREAM；absent 接口地址不是代理；checking 检测中 */
export type ProxyState = 'ok' | 'no-upstream' | 'absent' | 'checking';

const EFFORT_KEY = 'cloudssh_ai_effort';
const CONFIG_TTL = 30_000;
const MODELS_TTL = 5 * 60_000;
const PROXY_TTL = 5 * 60_000;

let cache: { key: string; config: AiConfig | null; at: number } | null = null;
let loading: Promise<AiConfig | null> | null = null;
let models: { key: string; list: string[]; at: number } | null = null;
let proxy: { base: string; state: ProxyState; at: number } | null = null;
let probing: Promise<ProxyState> | null = null;
const listeners = new Set<() => void>();

/** 配置、代理状态、思考深度有变化时通知（输入框下方那一行重画） */
export function onAiConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyAll(): void {
  for (const listener of listeners) listener();
}

function store(key: string, config: AiConfig | null): void {
  const changed =
    cache?.key !== key ||
    cache.config?.model !== config?.model ||
    cache.config?.configured !== config?.configured ||
    cache.config?.base_url !== config?.base_url;
  cache = { key, config, at: Date.now() };
  if (changed) notifyAll();
  void detectProxy();
}

/** 已读到的配置（当前实例）；还没读过返回 null */
export function currentAiConfig(): AiConfig | null {
  return cache?.key === instanceKey() ? cache.config : null;
}

export function loadAiConfig(force = false): Promise<AiConfig | null> {
  const key = instanceKey();
  if (!force && cache?.key === key && Date.now() - cache.at < CONFIG_TTL) return Promise.resolve(cache.config);
  if (loading) return loading;
  loading = (async () => {
    try {
      const response = await fetch('/api/ai/config', { credentials: 'same-origin' });
      // 未登录（401）等：没有可用的配置
      const config = response.ok ? ((await response.json()) as AiConfig) : null;
      store(key, config && typeof config === 'object' ? config : null);
      return currentAiConfig();
    } catch {
      return currentAiConfig();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function errorOf(response: Response): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === 'string' && data.error ? data.error : `HTTP ${response.status}`;
}

/** 接口支持的模型（缓存 5 分钟）；接口不提供列表时返回空数组 */
export async function listModels(force = false): Promise<string[]> {
  const key = instanceKey();
  if (!force && models?.key === key && Date.now() - models.at < MODELS_TTL) return models.list;
  const config = await loadAiConfig();
  if (!config?.configured || !config.base_url) throw new Error('not configured');
  const response = await fetch('/api/ai/models', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_url: config.base_url }),
  });
  if (!response.ok) throw new Error(await errorOf(response));
  const data = (await response.json().catch(() => null)) as { models?: Array<{ id?: unknown }>; error?: unknown } | null;
  if (typeof data?.error === 'string') throw new Error(data.error);
  const list = [...new Set((data?.models ?? []).map((item) => item?.id).filter((id): id is string => typeof id === 'string' && !!id))];
  models = { key, list, at: Date.now() };
  return list;
}

/** 保存模型（接口地址不变，不带密钥：Worker 沿用已存的） */
export async function saveModel(model: string): Promise<void> {
  const key = instanceKey();
  const config = await loadAiConfig(true);
  if (!config?.configured || !config.base_url) throw new Error('not configured');
  const response = await fetch('/api/ai/config', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_url: config.base_url, model }),
  });
  if (!response.ok) throw new Error(await errorOf(response));
  store(key, { ...config, model });
}

// ---------- 思考深度 ----------

export function currentEffort(): Effort {
  try {
    const value = localStorage.getItem(EFFORT_KEY) as Effort | null;
    if (value && (EFFORTS as readonly string[]).includes(value)) return value;
  } catch {
    // 读不到按自动
  }
  return 'auto';
}

export function setEffort(effort: Effort): void {
  try {
    if (effort === 'auto') localStorage.removeItem(EFFORT_KEY);
    else localStorage.setItem(EFFORT_KEY, effort);
  } catch {
    // 存不下只在本次生效
  }
  notifyAll();
}

/** 代理的状态（当前接口地址）；还没检测过返回 checking */
export function proxyState(): ProxyState {
  const base = currentAiConfig()?.base_url;
  if (!base) return 'absent';
  return proxy?.base === base ? proxy.state : 'checking';
}

/** 检测接口地址是不是思考深度代理（结果缓存 5 分钟） */
export function detectProxy(force = false): Promise<ProxyState> {
  const base = currentAiConfig()?.base_url;
  if (!base) return Promise.resolve<ProxyState>('absent');
  if (!force && proxy?.base === base && Date.now() - proxy.at < PROXY_TTL) return Promise.resolve(proxy.state);
  if (probing) return probing;
  probing = (async () => {
    let state: ProxyState = 'absent';
    try {
      const response = await fetch(`${base.replace(/\/+$/, '')}/cloudssh-reasoning`, {
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(6000),
      });
      const data = response.ok ? ((await response.json().catch(() => null)) as { cloudsshReasoningProxy?: unknown; upstream?: unknown } | null) : null;
      if (data?.cloudsshReasoningProxy === 1) state = data.upstream === false ? 'no-upstream' : 'ok';
    } catch {
      // 不是代理、或访问不到
    }
    const changed = proxy?.base !== base || proxy.state !== state;
    proxy = { base, state, at: Date.now() };
    if (changed) notifyAll();
    return state;
  })().finally(() => {
    probing = null;
  });
  return probing;
}

/** 附在每条消息末尾的标记（代理没生效时为空串） */
export function reasoningMarker(): string {
  return proxyState() === 'ok' ? `[cloudssh-reasoning:${currentEffort()}]` : '';
}

// AI 设置弹窗（网页版 ai-config.ts）保存后重新读
document.addEventListener(
  'click',
  (event) => {
    if ((event.target as Element | null)?.closest?.('#ai-save-btn')) setTimeout(() => void loadAiConfig(true), 900);
  },
  true
);
