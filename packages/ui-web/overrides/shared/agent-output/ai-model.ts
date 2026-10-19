/**
 * AI 模型、思考深度与联网搜索（电脑与手机共用，不改 CloudSSH 的 Worker）。
 *
 * 模型存在 Worker 的 AI 配置里（GET / PUT /api/ai/config，每个用户一份、所有服务器共用），这里读出来显示在 AI 面板
 * 输入框下方并可直接切换；模型列表来自 POST /api/ai/models（只传已保存的接口地址，Worker 用已存的密钥去取，
 * 换地址必须带新密钥，这里不碰密钥）。
 *
 * 思考深度与联网搜索：Worker 组请求体时只带 model / input / tools 等固定字段（responses-client.ts 明确不让调用方塞
 * 别的参数），不会带 reasoning.effort，也不会加模型自己的搜索工具。客户端能影响请求的只有模型名、消息内容和接口地址，
 * 所以在 Worker 与模型接口之间加一层：AI 增强代理（tools/reasoning-proxy，一个独立的小 Worker，AI 设置里的接口地址
 * 填它）。客户端在每条消息末尾附指令标签 <cloudssh_reasoning effort="high"/> <cloudssh_web_search mode="on"/>，
 * 代理转发前删掉所有标签，按最后一个给请求加上 reasoning.effort、模型的原生搜索工具（并把 Worker 不认的搜索条目
 * 从结果里去掉）。每条消息各自带标签，所以随时切换、不用开新会话。
 * 只有检测到代理时才附标签（GET 接口地址/cloudssh-reasoning?model=…，返回版本、功能与模型窗口）：没有代理时标签会被
 * 原样发给模型。0.3.23 部署的版本 1 代理只认 [cloudssh-reasoning:high]；版本 3 起才有联网搜索；版本 4 起有长上下文
 * （代理接管 CloudSSH 服务端的上下文整理、保留完整对话，按模型自己的窗口放回，见 tools/reasoning-proxy/worker.js）。
 *
 * 模型上下文窗口：有代理时由代理查（接口的 /models 列表、代理变量、常见模型表），没有时按下面的常见模型表。
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

/** 模型的输入上下文窗口（token）与来源：upstream 接口的模型列表；setting 代理变量；table 常见模型表；default 认不出 */
export interface ModelWindow {
  tokens: number;
  source: 'upstream' | 'setting' | 'table' | 'default';
}

interface ProxyContext extends ModelWindow {
  model: string;
  storage: 'kv' | 'memory';
}

const EFFORT_KEY = 'cloudssh_ai_effort';
const SEARCH_KEY = 'cloudssh_ai_web_search';
const CONFIG_TTL = 30_000;
const MODELS_TTL = 5 * 60_000;
const PROXY_TTL = 5 * 60_000;

let cache: { key: string; config: AiConfig | null; at: number } | null = null;
let loading: Promise<AiConfig | null> | null = null;
let models: { key: string; list: string[]; at: number } | null = null;
let proxy: { base: string; model: string; state: ProxyState; version: number; features: string[]; context: ProxyContext | null; at: number } | null =
  null;
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

function contextOf(value: unknown, model: string): ProxyContext | null {
  const data = value as Partial<ProxyContext> | null;
  if (!data || typeof data !== 'object' || typeof data.tokens !== 'number' || !(data.tokens > 0)) return null;
  const source = (['upstream', 'setting', 'table', 'default'] as const).find((item) => item === data.source) ?? 'default';
  return { model, tokens: Math.round(data.tokens), source, storage: data.storage === 'kv' ? 'kv' : 'memory' };
}

/** 检测接口地址是不是 AI 增强代理（结果缓存 5 分钟；换模型时重新检测，顺便取模型窗口） */
export function detectProxy(force = false): Promise<ProxyState> {
  const base = currentAiConfig()?.base_url;
  const model = currentAiConfig()?.model ?? '';
  if (!base) return Promise.resolve<ProxyState>('absent');
  if (!force && proxy?.base === base && proxy.model === model && Date.now() - proxy.at < PROXY_TTL) return Promise.resolve(proxy.state);
  if (probing) return probing;
  probing = (async () => {
    let state: ProxyState = 'absent';
    let version = 0;
    let features: string[] = [];
    let context: ProxyContext | null = null;
    try {
      const query = model ? `?model=${encodeURIComponent(model)}` : '';
      const response = await fetch(`${base.replace(/\/+$/, '')}/cloudssh-reasoning${query}`, {
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(8000),
      });
      const data = response.ok
        ? ((await response.json().catch(() => null)) as {
            cloudsshReasoningProxy?: unknown;
            upstream?: unknown;
            features?: unknown;
            context?: unknown;
          } | null)
        : null;
      if (typeof data?.cloudsshReasoningProxy === 'number' && data.cloudsshReasoningProxy >= 1) {
        version = data.cloudsshReasoningProxy;
        state = data.upstream === false ? 'no-upstream' : 'ok';
        features = Array.isArray(data.features) ? data.features.filter((item): item is string => typeof item === 'string') : ['reasoning'];
        context = contextOf(data.context, model);
      }
    } catch {
      // 不是代理、或访问不到
    }
    const changed =
      proxy?.base !== base ||
      proxy.state !== state ||
      proxy.features.join() !== features.join() ||
      proxy.context?.tokens !== context?.tokens ||
      proxy.context?.model !== context?.model;
    proxy = { base, model, state, version, features, context, at: Date.now() };
    if (changed) notifyAll();
    return state;
  })().finally(() => {
    probing = null;
    // 检测期间换了模型：再取一次新模型的窗口
    if (currentAiConfig()?.base_url === proxy?.base && (currentAiConfig()?.model ?? '') !== proxy?.model) void detectProxy();
  });
  return probing;
}

/** 代理版本（没检测到为 0） */
export function proxyVersion(): number {
  return proxyState() === 'ok' ? (proxy?.version ?? 0) : 0;
}

/** 代理接管了 CloudSSH 服务端的上下文整理、保留完整对话（版本 4 起，没用 LONG_CONTEXT=off 关掉） */
export function longContextActive(): boolean {
  return proxyState() === 'ok' && !!proxy?.features.includes('long_context');
}

/** 代理把前文存在哪：kv（绑定了 KV，可靠）或 memory（只在内存里，长时间不用会丢）；没有代理为 null */
export function proxyStorage(): 'kv' | 'memory' | null {
  return longContextActive() ? (proxy?.context?.storage ?? null) : null;
}

/**
 * 常见模型的输入上下文窗口（token），按顺序匹配模型名（不分大小写）。
 * 与 tools/reasoning-proxy/worker.js 的 WINDOWS 保持一致
 */
const WINDOWS: Array<[RegExp, number]> = [
  [/gemini/, 1_048_576],
  [/gpt-4\.1/, 1_047_576],
  [/gpt-5[\d.]*-chat/, 128_000],
  [/gpt-(?:[5-9]|\d{2})/, 272_000],
  [/(?:^|\/)o[134](?:-|$)/, 200_000],
  [/claude/, 200_000],
  [/grok-4/, 256_000],
  [/grok/, 131_072],
  [/gpt-4o|gpt-4-turbo/, 128_000],
  [/gpt-oss|qwen|kimi|moonshot/, 131_072],
  [/deepseek|glm|llama|mistral|mixtral|codestral/, 128_000],
];
const DEFAULT_WINDOW = 128_000;

/** 模型的输入上下文窗口：代理查到的优先，其次常见模型表；认不出按 128K（source 为 default） */
export function modelWindow(model = currentAiConfig()?.model ?? ''): ModelWindow {
  const context = proxyState() === 'ok' ? proxy?.context : null;
  if (context && context.model === model) return { tokens: context.tokens, source: context.source };
  const name = model.toLowerCase();
  for (const [pattern, tokens] of WINDOWS) if (pattern.test(name)) return { tokens, source: 'table' };
  return { tokens: DEFAULT_WINDOW, source: 'default' };
}

// ---------- 联网搜索 ----------

export function webSearchEnabled(): boolean {
  try {
    return localStorage.getItem(SEARCH_KEY) === '1';
  } catch {
    return false;
  }
}

export function setWebSearch(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(SEARCH_KEY, '1');
    else localStorage.removeItem(SEARCH_KEY);
  } catch {
    // 存不下只在本次生效
  }
  notifyAll();
}

/** 代理支持联网搜索（版本 3 起，且没用 WEB_SEARCH=off 关掉） */
export function webSearchAvailable(): boolean {
  return proxyState() === 'ok' && !!proxy?.features.includes('web_search');
}

// ---------- 模型支持哪些 ----------

/** yes 已知支持；no 已知不支持（按钮变灰、消息里不带）；unknown 认不出的模型名（照常可选，接口不认时代理 / 提示兜底） */
export type Support = 'yes' | 'no' | 'unknown';

/** 去掉 OpenRouter 式的厂商前缀（deepseek/deepseek-chat）和 :online 之类的后缀 */
function modelKey(model: string): string {
  return model.trim().toLowerCase().replace(/^.*\//, '').replace(/:[a-z-]+$/, '');
}

/** 没有思考深度档位（reasoning.effort）的：DeepSeek、通义、智谱、Kimi 等国产模型，开源模型，GPT-4 系列等非推理模型 */
const NO_REASONING =
  /deepseek|^ds-|qwen|qwq|glm|kimi|moonshot|doubao|ernie|hunyuan|minimax|abab|baichuan|spark|yi-|llama|mistral|mixtral|codestral|gemma|phi-|command-r|gpt-4o|gpt-4\.1|^gpt-4(-|$)|gpt-3\.5|chatgpt|gemini-1\.|gemini-2\.0|claude-3-(5|haiku|opus|sonnet)|claude-3\.5/;
/** 有思考深度档位的：OpenAI 推理模型（o 系列、GPT-5、gpt-oss）、Grok 推理模型 */
const REASONING = /^o[1-9](-|$)|gpt-5|gpt-oss|grok-3-mini|grok-4/;
/** 没有原生联网搜索的：国产与开源模型、老的 GPT、o1 / o3-mini */
const NO_SEARCH =
  /deepseek|^ds-|qwen|qwq|glm|kimi|moonshot|doubao|ernie|hunyuan|minimax|abab|baichuan|spark|yi-|llama|mistral|mixtral|codestral|gemma|phi-|command-r|gpt-3\.5|^gpt-4(-|$)|^o1(-|$)|^o3-mini|gpt-oss/;
/** 有原生联网搜索的：GPT-4o / 4.1 / 5、o3、o4-mini、Claude、Gemini、Grok、Perplexity */
const SEARCH = /gpt-4o|gpt-4\.1|gpt-5|^o3(-|$)|^o4-mini|claude|gemini|grok|sonar|perplexity/;

export function modelSupport(model = currentAiConfig()?.model ?? ''): { reasoning: Support; search: Support } {
  const key = modelKey(model);
  if (!key) return { reasoning: 'unknown', search: 'unknown' };
  return {
    // gpt-5-chat 这类聊天版不是推理模型
    reasoning: /gpt-5[\d.]*-chat/.test(key) ? 'no' : REASONING.test(key) ? 'yes' : NO_REASONING.test(key) ? 'no' : 'unknown',
    search: NO_SEARCH.test(key) ? 'no' : SEARCH.test(key) ? 'yes' : 'unknown',
  };
}

/**
 * 附在每条消息末尾的指令标签（代理没生效时为空串）：思考深度（旧版代理用旧写法）+ 联网搜索开关（代理支持时）。
 * search 为 false 时这一条不搜索（压缩上下文写摘要时）
 */
export function proxyDirectives(options: { search?: boolean } = {}): string {
  if (proxyState() !== 'ok') return '';
  // 当前模型已知不支持的：思考深度按自动（不加参数）、不搜索
  const support = modelSupport();
  const effort = support.reasoning === 'no' ? 'auto' : currentEffort();
  const tags = [(proxy?.version ?? 0) >= 2 ? `<cloudssh_reasoning effort="${effort}"/>` : `[cloudssh-reasoning:${effort}]`];
  const search = support.search !== 'no' && (options.search ?? webSearchEnabled());
  if (webSearchAvailable()) tags.push(`<cloudssh_web_search mode="${search ? 'on' : 'off'}"/>`);
  return tags.join(' ');
}

// AI 设置弹窗（网页版 ai-config.ts）保存后重新读
document.addEventListener(
  'click',
  (event) => {
    if ((event.target as Element | null)?.closest?.('#ai-save-btn')) setTimeout(() => void loadAiConfig(true), 900);
  },
  true
);
