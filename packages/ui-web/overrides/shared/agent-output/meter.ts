/**
 * AI 上下文占用估算（电脑与手机共用，不改 Worker）。
 *
 * Worker 什么时候整理上下文：每次调用模型前，系统提示 + 工具定义 + 历史 + 待发内容按 UTF-8 字节数计，
 * 达到 (64000 − 8192) × 0.75 − 4096 = 37760 就先压缩（core.ts DEFAULT_CONFIG、context.ts needsCheckpoint）。
 * 它把字节数当 token 比：中文一个字 3 字节，英文和终端输出一个 token 也有 3~4 字节，所以实际只放得下一万出头 token；
 * 系统提示与工具定义就占约 1.1 万字节，终端快照、服务器记忆、环境信息每轮还会进上下文。
 *
 * 客户端看不到工具输出和这些观察，只能用 run_end 带回的用量（这一轮各次调用的输入 / 输出 token 合计）推算：
 * 只调用一次时那次的输入就是合计；调用多次时按“每次增长差不多”估最后一次。再乘“每 token 多少字节”换成 Worker 的口径；
 * 这个比例按模型记在本机，Worker 实际压缩了 / 只调用一次而没压缩时自动修正。
 *
 * 长上下文（AI 增强代理版本 4 起）：代理接管 Worker 的整理、把完整前文放回给模型，Worker 的那条线就不再丢内容，
 * 真正的限制变成模型自己的上下文窗口。代理回给 Worker 的输入 token 改成了 Worker 自己那份的量（不然它每一步都整理），
 * 实际输入编进缓存 token（缓存 + 输入 × 2^26）。这里解开后按实际输入对比模型窗口（state.long）。
 */
import { currentAiConfig, modelWindow, webSearchAvailable, webSearchEnabled } from './ai-model';

/** Worker 开始整理时的字节数 */
export const WORKER_LIMIT = 37_760;
const DEFAULT_RATIO = 3.3;
const MIN_RATIO = 1.6;
const MAX_RATIO = 4.6;
/** 每轮新进上下文的终端快照、时间等观察（看不到，按常见量估） */
const OBS_BYTES = 1500;
/** 推下限时观察按偏大的量算（终端快照最多 4000 字） */
const OBS_MAX_BYTES = 4500;
/** 系统提示 + 工具定义 + 环境 / 终端观察的初始估计（token），第一轮只调用一次时按实际用量修正 */
const DEFAULT_BASE = 4200;
/** 新会话第一条消息自带的附加内容（服务器信息、提问格式、回复风格）大约多少字节 */
const DECORATION_BYTES = 2600;
const RATIO_KEY = 'cloudssh_ai_byte_ratio';
/** 代理把实际输入编进缓存 token 的倍数（tools/reasoning-proxy/worker.js USAGE_PACK） */
const USAGE_PACK = 2 ** 26;

export interface Usage {
  calls: number;
  reportedCalls: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  checkpointCalls: number;
  /** 经长上下文代理：input / cached 是解开后的实际值 */
  packed?: boolean;
}

export interface MeterState {
  /** Worker 端上下文估算（token）；0 表示会话是空的 */
  tokens: number;
  /** 客户端压缩后、下一条消息前的预计值（带上摘要）；0 表示没有 */
  projected: number;
  /** 不含任何消息的底：系统提示、工具定义、环境与终端观察（token）。新会话第一轮只调用一次时按实际用量修正 */
  base: number;
  /** 本会话跑过几轮 */
  turns: number;
  /**
   * 已发出、还没开始的那一轮的内容（字节）；run_start 时归到 runSent。出错接续时新消息比旧一轮的 run_end 先发出，
   * 所以不能在 run_end 时清零
   */
  sentBytes: number;
  /** 正在跑（刚结束）的这一轮发出的内容（字节） */
  runSent: number;
  runCompacted: boolean;
  runExecuted: boolean;
  /** 这一轮的最终回复 */
  reply: string;
  last: Usage | null;
  /** 服务商没回用量，纯按字节估的 */
  estimated: boolean;
  /** 客户端压缩次数、Worker 自己整理的次数（这个面板） */
  compactions: number;
  workerCompactions: number;
  /** 这个面板累计的输入 token 与其中缓存命中的部分（接口回报的） */
  totalInput: number;
  totalCached: number;
  /** 经长上下文代理：tokens 是模型实际看到的量，按模型窗口算占用 */
  long: boolean;
}

const meters = new WeakMap<object, MeterState>();
const listeners = new Set<(panel: object) => void>();
const encoder = new TextEncoder();

export const bytesOf = (text: string) => encoder.encode(text).length;

export function meterOf(panel: object): MeterState {
  let state = meters.get(panel);
  if (!state) {
    state = {
      tokens: 0,
      projected: 0,
      base: DEFAULT_BASE,
      turns: 0,
      sentBytes: 0,
      runSent: 0,
      runCompacted: false,
      runExecuted: false,
      reply: '',
      last: null,
      estimated: false,
      compactions: 0,
      workerCompactions: 0,
      totalInput: 0,
      totalCached: 0,
      long: false,
    };
    meters.set(panel, state);
  }
  return state;
}

export function onMeter(listener: (panel: object) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function meterChanged(panel: object): void {
  for (const listener of listeners) listener(panel);
}

// ---------- 字节 / token 比例（按模型记） ----------

function modelKey(): string {
  return currentAiConfig()?.model ?? '';
}

function ratios(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(RATIO_KEY) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function ratio(): number {
  const value = ratios()[modelKey()];
  return typeof value === 'number' && value >= MIN_RATIO && value <= MAX_RATIO ? value : DEFAULT_RATIO;
}

function setRatio(value: number): void {
  const all = ratios();
  all[modelKey()] = Math.round(Math.min(MAX_RATIO, Math.max(MIN_RATIO, value)) * 100) / 100;
  try {
    localStorage.setItem(RATIO_KEY, JSON.stringify(all));
  } catch {
    // 存不下只影响下次的估算
  }
}

/** 能放多少 token：长上下文时是模型窗口，否则估算到 Worker 整理线的量 */
export function capacity(state?: MeterState): number {
  return state?.long ? modelWindow().tokens : WORKER_LIMIT / ratio();
}

/** 占用比例（0~1+）：长上下文时占模型窗口，否则占 Worker 整理线；没有数据时为 0 */
export function percentOf(state: MeterState): number {
  const tokens = state.tokens || state.projected;
  if (!tokens) return 0;
  return state.long ? tokens / modelWindow().tokens : (tokens * ratio()) / WORKER_LIMIT;
}

// ---------- 帧 ----------

function usageOf(value: unknown): Usage | null {
  const u = value as Partial<Usage> | null;
  if (!u || typeof u !== 'object') return null;
  const num = (key: keyof Usage) => (typeof u[key] === 'number' && Number.isFinite(u[key]) && (u[key] as number) >= 0 ? (u[key] as number) : 0);
  const usage: Usage = {
    calls: num('calls'),
    reportedCalls: num('reportedCalls'),
    input: num('input'),
    cached: num('cached'),
    output: num('output'),
    reasoning: num('reasoning'),
    checkpointCalls: num('checkpointCalls'),
  };
  // 长上下文代理：缓存 token = 实际缓存 + 实际输入 × 2^26（普通的缓存量到不了这么大）
  if (usage.cached >= USAGE_PACK) {
    const input = Math.floor(usage.cached / USAGE_PACK);
    usage.cached = usage.cached - input * USAGE_PACK;
    usage.input = input;
    usage.packed = true;
  }
  return usage;
}

/** 调用多次时按每次增长差不多估最后一次的输入（加上平均输出） */
function lastCall(state: MeterState, usage: Usage, main: number, prev: number, r: number): number {
  const average = usage.input / main;
  const outPer = usage.output / main;
  // 第一次调用的输入：接着上一轮（加上这次发的和新的观察），或新会话从底算起（底里已含观察）
  const first = prev ? prev + (state.runSent + OBS_BYTES) / r : state.base + state.runSent / r;
  const step = Math.max(0, (2 * (usage.input - main * first)) / (main * (main - 1)));
  const last = first + (main - 1) * step;
  return Math.min(2 * average, Math.max(average, last)) + outPer;
}

function settle(state: MeterState, usage: Usage | null): void {
  const prev = state.tokens;
  const r = ratio();
  const main = usage ? usage.calls - usage.checkpointCalls : 0;
  const fresh = state.turns === 0;
  state.turns++;
  if (usage?.packed && usage.reportedCalls && main > 0) {
    // 长上下文：实际输入，Worker 整理不丢内容，不用换算比例
    state.long = true;
    if (main === 1) {
      state.tokens = usage.input + usage.output;
      state.estimated = usage.reportedCalls < usage.calls;
      if (fresh && !(webSearchAvailable() && webSearchEnabled())) state.base = Math.max(1500, usage.input - state.runSent / r);
    } else {
      state.tokens = lastCall(state, usage, main, prev, r);
      state.estimated = true;
    }
  } else if (!usage || !usage.reportedCalls || main <= 0) {
    // 服务商没回用量：按发出的、回复的字节估（新会话从底算起）
    state.tokens = (prev || state.base) + (state.runSent + bytesOf(state.reply) + OBS_BYTES) / r;
    state.estimated = true;
  } else if (state.runCompacted || usage.checkpointCalls) {
    // Worker 在这一轮里整理过：前文换成了检查点（最多约 8000 字），回到底再加上检查点和之后的内容
    state.tokens = state.base + 2500 + usage.output / main;
    state.estimated = true;
  } else if (main === 1) {
    state.long = false;
    state.tokens = usage.input + usage.output;
    state.estimated = usage.reportedCalls < usage.calls;
    // 联网搜索的结果也算进接口回报的输入（Worker 那份对话里没有），这时不拿它修正比例和底
    const searched = webSearchAvailable() && webSearchEnabled();
    // 只调用一次而没整理：那次检查时的字节数在整理线以下，比例不会超过 线 / token 数
    if (!searched && usage.input > 0 && r > WORKER_LIMIT / usage.input) setRatio((WORKER_LIMIT / usage.input) * 0.98);
    // 新会话第一轮：输入减去这条消息就是底
    if (fresh && !searched) state.base = Math.max(1500, usage.input - state.runSent / ratio());
  } else {
    // 调用多次：只知道合计，按每次增长差不多估最后一次的输入
    state.long = false;
    state.tokens = lastCall(state, usage, main, prev, r);
    state.estimated = true;
  }
  state.projected = 0;
  if (usage) {
    state.last = usage;
    if (usage.reportedCalls) {
      state.totalInput += usage.input;
      state.totalCached += Math.min(usage.cached, usage.input);
    }
  }
}

/** 现在压缩的话，下一条消息时大约剩多少（底 + 摘要 + 重新附上的内容；摘要按 summaryBytes 估） */
export function afterCompact(state: MeterState, summaryBytes = 3000): number {
  return state.base + (summaryBytes + DECORATION_BYTES) / ratio();
}

/** 面板收到的每一帧（客户端压缩那一轮的帧不经过这里） */
export function meterFrame(panel: object, frame: Record<string, unknown>): void {
  const state = meterOf(panel);
  switch (frame.subType) {
    case 'run_start':
      state.runSent = state.sentBytes;
      state.sentBytes = 0;
      state.runCompacted = false;
      state.runExecuted = false;
      state.reply = '';
      break;
    case 'executing':
      state.runExecuted = true;
      break;
    case 'context_status':
      // 长上下文：Worker 的整理由代理接管、不丢内容，不算压缩
      if (frame.compacted !== true || state.long) break;
      // 这一轮第一次调用前就整理了：上一轮的量加上这次发的内容已经到线，比例至少是这么多
      if (!state.runExecuted && state.tokens > 0) {
        const atLeast = (WORKER_LIMIT - state.runSent - OBS_MAX_BYTES) / state.tokens;
        if (atLeast > ratio()) setRatio(atLeast);
      }
      state.runCompacted = true;
      state.workerCompactions++;
      meterChanged(panel);
      break;
    case 'stream_end':
    case 'response':
      if (typeof frame.content === 'string') state.reply = frame.content;
      break;
    case 'run_end': {
      const usage = usageOf(frame.usage);
      // 还没调用模型就失败了（配置变了、输入被拒等）：Worker 不接收这一轮，上下文不变
      if (!(usage && usage.calls === 0 && frame.outcome !== 'completed')) settle(state, usage);
      state.runSent = 0;
      meterChanged(panel);
      break;
    }
    case 'reset_done':
      // 已经发出的下一条（出错接续时）还在 sentBytes 里，留给它的 run_start
      state.tokens = 0;
      state.turns = 0;
      meterChanged(panel);
      break;
  }
}

/** 发出去的内容（网页版发送、客户端接续 / 回传结果都算） */
export function meterSent(panel: unknown, message: string): void {
  if (!panel || typeof panel !== 'object') return;
  meterOf(panel).sentBytes += bytesOf(message);
}

/**
 * 新会话里除了底（系统提示、工具、观察）和这条消息，还能放多少字节（出错接续的回顾按这个裁）；
 * 留出新的终端快照等观察与一点余量
 */
export function roomFor(panel: object, messageBytes: number): number {
  return Math.floor(WORKER_LIMIT - meterOf(panel).base * ratio() - messageBytes - OBS_MAX_BYTES - 1500);
}

/**
 * Worker 报上下文超限、整理失败（responses_schema / responses_budget）时调用：要是新会话第一次调用就超了，
 * 说明底（系统提示、服务器记忆、终端快照等）加这条消息已经到线，把底的估计往上调
 */
export function meterOverflowed(panel: object): void {
  const state = meterOf(panel);
  if (state.turns || state.runExecuted) return;
  const atLeast = (WORKER_LIMIT - state.runSent) / ratio();
  if (atLeast > state.base) state.base = Math.round(atLeast);
}

// ---------- 写不出 Worker 检查点（严格 JSON）的模型 ----------

const WEAK_KEY = 'cloudssh_ai_weak_checkpoint';

function weakModels(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(WEAK_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 这个模型（默认当前模型）整理上下文时交不出 Worker 要的 JSON：上下文只能靠客户端提前压缩 */
export function isWeakCheckpoint(model = modelKey()): boolean {
  return !!model && weakModels().includes(model);
}

/** 记下来；第一次记下时返回 true（用来只提醒一次） */
export function markWeakCheckpoint(model = modelKey()): boolean {
  if (!model) return false;
  const list = weakModels();
  if (list.includes(model)) return false;
  try {
    localStorage.setItem(WEAK_KEY, JSON.stringify([...list, model].slice(-50)));
  } catch {
    // 存不下只影响这次
  }
  return true;
}

/** 客户端压缩后：Worker 端已重置，下一条消息会带上摘要（字节） */
export function meterCompacted(panel: object, summaryBytes: number): void {
  const state = meterOf(panel);
  state.compactions++;
  state.tokens = 0;
  state.turns = 0;
  state.projected = afterCompact(state, summaryBytes);
  meterChanged(panel);
}
