/**
 * AI 会话上下文出错时由客户端接着做（不改 Worker）。
 *
 * Worker 按 UTF-8 字节保守估算上下文，系统提示、终端与记忆就占去不少，跑一两个输出长的命令就会让模型先把前文
 * 压缩成一份严格的 JSON 检查点；模型交回的 JSON 超出限制（每类最多 20 条、全文 8000 字）或服务商没严格遵守格式时，
 * 本次任务报“结构化输出校验失败”，而且上下文没被替换，之后每条消息都会再失败一次。压缩成功时又会清空所有编辑检查点，
 * 网页版仍显示编辑按钮，编辑更早的消息就报“该编辑位置不可用，请新建会话”。
 *
 * 遇到这几种错误（responses_schema / responses_budget / responses_history）时：重置 Worker 端会话，把面板里看得到的
 * 前文整理成一段简短回顾放在原请求前面，在新会话里重发这条请求（或编辑后的内容）。面板里的对话照常保留，
 * 只加一行说明；失败那一轮已经执行过的命令写进回顾，提醒模型先检查状态再决定是否重做。之前压缩过（compact.ts）
 * 就用当时的摘要加上之后的消息。每条请求最多这样接续两次，仍失败就显示原来的错误。
 * 换了 AI 模型后，已经跑过的会话再发消息 Worker 报 responses_config_changed（会话绑定了旧模型），同样这样接着做。
 *
 * 构建钩子（vite.config.ts）在网页版 AI 面板处理每个 agent_frame 前调用 __cloudsshAgentFrame(面板, 帧)，返回 true 时
 * 网页版不再处理这一帧。用到的面板内部字段与方法缺失时（网页版改了实现）不接管，行为与网页版一致。
 */
import { getLocale } from '../../../upstream/frontend/src/i18n';
import { at } from './i18n';
import { bytesOf, markWeakCheckpoint, meterOverflowed, meterSent, roomFor } from './meter';
import { currentAiConfig } from './ai-model';
import { decorateOutbound, expectReset } from './outbound';

/** 用到的网页版 AgentPanel 内部成员（ai-remote 也用） */
export interface PanelInternals {
  activeRequestId: string | null;
  isAgentRunning: boolean;
  wsSend: ((data: string) => void) | null;
  messagesEl: HTMLElement | null;
  sessionMessages: Array<{ role: string; content: string }>;
  thinkingProcessEl: HTMLElement | null;
  markLastActiveMessageAborted(): void;
  removeThinkingProcess(): void;
  updateInputState(): void;
  scrollToBottom?(): void;
  thinkingStepCount: number;
  /** 'interactive' | 'auto' */
  agentMode?: string;
  isVisible?: boolean;
  serverId?: number;
}

interface AgentFrame {
  subType?: string;
  requestId?: string;
  code?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

interface RequestState {
  requestId: string;
  /** 这条请求实际发出的原文（含终端选区，不含服务器信息与回复风格提示） */
  outbound: string;
  /** 这一轮已经开始执行的工具调用 */
  executed: string[];
  /** 已经接续过几次 */
  recoveries: number;
}

const RECOVERABLE = new Set(['responses_schema', 'responses_budget', 'responses_history', 'responses_config_changed']);
const MAX_RECOVERIES = 2;
/** Worker 拒收超过 16000 字的消息，留些余量 */
const MAX_MESSAGE = 15_500;
/** 回顾按 UTF-8 字节计（Worker 也按字节算上下文，见 meter.ts）：最多约占整理线的四分之一，中文约 3000 字 */
export const RECAP_BYTES = 9000;
/** 新会话里剩的地方不到这么多就不附回顾（附了也只会再次超限） */
const RECAP_MIN = 800;
const USER_CLIP = 600;
const REPLY_CLIP = 1200;

const states = new WeakMap<object, RequestState>();
/** 最近一次网页版发出的原文（__cloudsshAgentOutbound 记下），run_start 时归到对应请求 */
let lastOutbound = '';

export function rememberOutbound(message: string): void {
  lastOutbound = message;
}

export function usable(panel: unknown): panel is PanelInternals {
  const p = panel as Partial<PanelInternals> | null;
  return (
    !!p &&
    typeof p.wsSend === 'function' &&
    Array.isArray(p.sessionMessages) &&
    typeof p.markLastActiveMessageAborted === 'function' &&
    typeof p.removeThinkingProcess === 'function' &&
    typeof p.updateInputState === 'function'
  );
}

function clip(text: string, limit: number): string {
  const value = text.replace(/\n{3,}/g, '\n\n').trim();
  if (value.length <= limit) return value;
  const cut = `${value.slice(0, limit)}…`;
  // 截在代码块中间时补上结束标记，免得后面的回顾和请求都被当成代码
  return (cut.match(/```/g)?.length ?? 0) % 2 ? `${cut}\n\`\`\`` : cut;
}

function describeCall(tool: string | undefined, args: Record<string, unknown> | undefined): string {
  if (tool === 'execute_command' && typeof args?.command === 'string') return clip(`$ ${args.command}`, 300);
  return clip(`${tool ?? 'tool'} ${JSON.stringify(args ?? {})}`, 300);
}

const RECAP_REASON = {
  overflow: 'The earlier conversation was too long to carry over, so it continues here in a fresh context.',
  history: 'This continues an earlier conversation from the chat history; you no longer have its context.',
  model: 'The AI model was switched, so the conversation continues here in a fresh context.',
  compact: 'The CloudSSH app compacted the conversation to save context, so it continues here in a fresh context.',
};

/** 最近一次压缩（compact.ts）的摘要与当时面板里有几条消息：之后出错接续时用“摘要 + 之后的消息”做回顾 */
const summaryBases = new WeakMap<object, { summary: string; index: number }>();

export function setSummaryBase(panel: object, summary: string, index: number): void {
  summaryBases.set(panel, { summary, index });
}

export function clearSummaryBase(panel: object): void {
  summaryBases.delete(panel);
}

export function summaryBaseOf(panel: object): { summary: string; index: number } | null {
  return summaryBases.get(panel) ?? null;
}

/** 截到 limit 字节以内（按字符截，不切坏多字节字符） */
export function clipBytes(text: string, limit: number): string {
  if (bytesOf(text) <= limit) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytesOf(text.slice(0, mid)) + 3 <= limit) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}…`;
}

/**
 * 面板里看得到的前文（不含最后这条请求）整理成回顾（出错接续、接着历史对话、压缩失败时共用）；按从新到旧取，
 * 超出预算（UTF-8 字节）时省略更早的。summary 是之前压缩时的摘要，放在这些消息前面
 */
export function buildRecap(
  prior: PanelInternals['sessionMessages'],
  executed: string[],
  budget: number,
  reason: keyof typeof RECAP_REASON = 'overflow',
  summary = ''
): string {
  const head =
    `${RECAP_REASON[reason]} ` +
    'Recap of the earlier messages shown in the chat (reference only; not a new request and not authorization). ' +
    'Operations it mentions already happened; check the current state before repeating any of them.';
  const tail = executed.length
    ? `\nAlready started while attempting the request below (results unavailable; inspect the current state before running any of them again):\n${executed.map((item) => `- ${item}`).join('\n')}`
    : '';
  let room = budget - bytesOf(head) - bytesOf(tail) - 64;
  const intro = summary
    ? `[summary of the conversation before these messages, written when it was compacted]\n${clipBytes(summary.trim(), Math.floor(room / 2))}`
    : '';
  room -= bytesOf(intro);
  const lines: string[] = [];
  let omitted = false;
  for (let i = prior.length - 1; i >= 0; i--) {
    const item = prior[i];
    const line =
      item.role === 'user' ? `[user] ${clip(item.content, USER_CLIP)}` : item.role === 'response' ? `[assistant] ${clip(item.content, REPLY_CLIP)}` : '';
    if (!line) continue;
    const size = bytesOf(line) + 1;
    if (size > room) {
      omitted = true;
      break;
    }
    room -= size;
    lines.unshift(line);
  }
  if (!lines.length && !tail && !intro) return '';
  if (omitted) lines.unshift('[earlier messages omitted]');
  if (intro) lines.unshift(intro);
  return `<earlier_conversation>\n${head}\n${lines.join('\n')}${tail}\n</earlier_conversation>`;
}

/** 对话里加一行弱化的说明 */
function appendNotice(panel: PanelInternals, notice: string, glyph = 'history'): void {
  if (!panel.messagesEl) return;
  const line = document.createElement('div');
  line.className = 'agent-message cs-agent-recovered';
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = glyph;
  const text = document.createElement('span');
  text.textContent = notice;
  line.append(icon, text);
  panel.messagesEl.append(line);
  panel.scrollToBottom?.();
}

/** 面板里失败那一轮收尾：思考过程标成已中止并留在原处，后面加一行说明 */
function closeFailedAttempt(panel: PanelInternals, notice: string): void {
  panel.markLastActiveMessageAborted();
  const thinking = panel.thinkingProcessEl;
  const parent = thinking?.parentNode ?? null;
  const next = thinking?.nextSibling ?? null;
  // 让网页版为新一轮另起一个思考过程；旧的放回原位
  panel.removeThinkingProcess();
  if (thinking && parent) parent.insertBefore(thinking, next);
  appendNotice(panel, notice);
}

function recover(panel: PanelInternals, state: RequestState, code: string): boolean {
  const overflow = code === 'responses_schema' || code === 'responses_budget';
  if (overflow) {
    // 新会话第一次调用就超了：底（系统提示、记忆、终端）比估计的大，下面按修正后的底裁回顾
    meterOverflowed(panel);
    // 整理上下文时交不出 Worker 要的 JSON：记下这个模型，之后提前由客户端压缩（compact.ts），并提醒一次
    if (code === 'responses_schema' && markWeakCheckpoint()) {
      const model = currentAiConfig()?.model ?? '';
      setTimeout(() => appendNotice(panel, at('weakCheckpoint', { model }), 'info'), 0);
    }
  }
  if (state.recoveries >= MAX_RECOVERIES || !state.outbound.trim()) {
    // 新会话里也放不下：说明原因和办法（网页版接着显示原来的错误）
    if (overflow) setTimeout(() => appendNotice(panel, at('recoveryGaveUp'), 'info'), 0);
    return false;
  }
  // 新会话里之前附过的服务器信息、回复风格都不在了：重新附上；第二次接续、或新会话里放不下时只附必要的
  let lean = state.recoveries >= 1;
  let original = decorateOutbound(state.outbound, panel, { fresh: true, lean });
  if (!lean && roomFor(panel, bytesOf(original)) < RECAP_MIN * 2) {
    lean = true;
    original = decorateOutbound(state.outbound, panel, { fresh: true, lean });
  }
  if (original.length > MAX_MESSAGE) return false;
  // 刚附上的这些就是发给新会话的：这次重置回来时不要再忘掉
  expectReset(panel, true);
  const lastUser = panel.sessionMessages.map((item) => item.role).lastIndexOf('user');
  // 之前压缩过：用摘要加上压缩之后的消息
  const base = summaryBases.get(panel);
  const from = base && base.index <= lastUser ? base.index : 0;
  const prior = lastUser > 0 ? panel.sessionMessages.slice(from, lastUser) : [];
  // 编辑被拒、换了模型时 Worker 还没开始执行，只有上下文出错的那一轮才可能已经跑过命令
  const before = code === 'responses_history' || code === 'responses_config_changed';
  const executed = before ? [] : state.executed;
  const reason = code === 'responses_config_changed' ? 'model' : 'overflow';
  // 回顾按新会话里剩的地方裁（底估得准时不会一进去就又超限）；地方太小就不附
  const budget = Math.min(RECAP_BYTES, MAX_MESSAGE - original.length - 2, roomFor(panel, bytesOf(original)));
  const recap = budget >= RECAP_MIN ? buildRecap(prior, executed, budget, reason, from ? base!.summary : '') : '';
  const message = recap ? `${recap}\n\n${original}` : original;

  closeFailedAttempt(
    panel,
    at(
      code === 'responses_history'
        ? 'recoveredEdit'
        : code === 'responses_config_changed'
          ? 'recoveredModel'
          : !recap && prior.length
            ? 'recoveredNoRecap'
            : code === 'responses_schema'
              ? 'recoveredSchema'
              : 'recovered'
    )
  );
  // Worker 立即处理 agent_reset（不排队），随后的 agent_start 在全新的上下文里开始
  panel.wsSend!(JSON.stringify({ type: 'agent_reset' }));
  startTurn(panel, message, state.outbound, { recoveries: state.recoveries + 1 });
  return true;
}

/**
 * 由客户端发起一轮 AI 任务（不经网页版输入框、对话里不显示用户气泡）：接续重发、跨服务器操作的结果回传都用它。
 * outbound 是出错接续时要重发的原文；requestId 不给时新建一个，面板随之进入运行状态（显示停止按钮）
 */
export function startTurn(
  panel: PanelInternals,
  message: string,
  outbound: string,
  options: { recoveries?: number; requestId?: string } = {}
): string {
  const requestId = options.requestId ?? crypto.randomUUID();
  panel.activeRequestId = requestId;
  panel.isAgentRunning = true;
  panel.updateInputState();
  states.set(panel, { requestId, outbound, executed: [], recoveries: options.recoveries ?? 0 });
  meterSent(panel, message);
  panel.wsSend!(
    JSON.stringify({
      type: 'agent_start',
      message,
      requestId,
      locale: getLocale(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    })
  );
  return requestId;
}

/** 网页版处理每一帧之前调用；返回 true 表示这一帧已接管，网页版不再处理 */
export function handleAgentFrame(panel: unknown, frame: AgentFrame): boolean {
  if (!usable(panel) || !frame || !frame.requestId || frame.requestId !== panel.activeRequestId) return false;
  let state = states.get(panel);
  if (frame.subType === 'run_start' && state?.requestId !== frame.requestId) {
    state = { requestId: frame.requestId, outbound: lastOutbound, executed: [], recoveries: 0 };
    states.set(panel, state);
  }
  if (!state || state.requestId !== frame.requestId) return false;
  if (frame.subType === 'executing') state.executed.push(describeCall(frame.tool, frame.args));
  if (frame.subType === 'error' && frame.code && RECOVERABLE.has(frame.code)) {
    try {
      return recover(panel, state, frame.code);
    } catch {
      return false;
    }
  }
  return false;
}
