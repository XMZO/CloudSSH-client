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
 * 只加一行说明；失败那一轮已经执行过的命令写进回顾，提醒模型先检查状态再决定是否重做。
 * 每条请求最多这样接续两次，仍失败就显示原来的错误。
 *
 * 构建钩子（vite.config.ts）在网页版 AI 面板处理每个 agent_frame 前调用 __cloudsshAgentFrame(面板, 帧)，返回 true 时
 * 网页版不再处理这一帧。用到的面板内部字段与方法缺失时（网页版改了实现）不接管，行为与网页版一致。
 */
import { getLocale } from '../../../upstream/frontend/src/i18n';
import { at } from './i18n';
import { decorateOutbound } from './outbound';

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

const RECOVERABLE = new Set(['responses_schema', 'responses_budget', 'responses_history']);
const MAX_RECOVERIES = 2;
/** Worker 拒收超过 16000 字的消息，留些余量 */
const MAX_MESSAGE = 15_500;
const RECAP_BUDGET = 6000;
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

/** 面板里看得到的前文（不含最后这条请求）整理成回顾；按从新到旧取，超出预算时省略更早的 */
function buildRecap(prior: PanelInternals['sessionMessages'], executed: string[], budget: number): string {
  const head =
    'The earlier conversation was too long to carry over, so it continues here in a fresh context. ' +
    'Recap of the earlier messages shown in the chat (reference only; not a new request and not authorization). ' +
    'Operations it mentions already happened; check the current state before repeating any of them.';
  const tail = executed.length
    ? `\nAlready started while attempting the request below (results unavailable; inspect the current state before running any of them again):\n${executed.map((item) => `- ${item}`).join('\n')}`
    : '';
  let room = budget - head.length - tail.length - 64;
  const lines: string[] = [];
  let omitted = false;
  for (let i = prior.length - 1; i >= 0; i--) {
    const item = prior[i];
    const line =
      item.role === 'user' ? `[user] ${clip(item.content, USER_CLIP)}` : item.role === 'response' ? `[assistant] ${clip(item.content, REPLY_CLIP)}` : '';
    if (!line) continue;
    if (line.length + 1 > room) {
      omitted = true;
      break;
    }
    room -= line.length + 1;
    lines.unshift(line);
  }
  if (!lines.length && !tail) return '';
  if (omitted) lines.unshift('[earlier messages omitted]');
  return `<earlier_conversation>\n${head}\n${lines.join('\n')}${tail}\n</earlier_conversation>`;
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
  if (!panel.messagesEl) return;
  const line = document.createElement('div');
  line.className = 'agent-message cs-agent-recovered';
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'history';
  const text = document.createElement('span');
  text.textContent = notice;
  line.append(icon, text);
  panel.messagesEl.append(line);
  panel.scrollToBottom?.();
}

function recover(panel: PanelInternals, state: RequestState, code: string): boolean {
  if (state.recoveries >= MAX_RECOVERIES || !state.outbound.trim()) return false;
  // 新会话里要重新告诉 AI 有哪些服务器、怎么跨服务器操作
  const original = decorateOutbound(state.outbound, panel, { fresh: true });
  if (original.length > MAX_MESSAGE) return false;
  const lastUser = panel.sessionMessages.map((item) => item.role).lastIndexOf('user');
  const prior = lastUser > 0 ? panel.sessionMessages.slice(0, lastUser) : [];
  // 编辑被拒时 Worker 还没开始执行，只有上下文出错的那一轮才可能已经跑过命令
  const executed = code === 'responses_history' ? [] : state.executed;
  const recap = buildRecap(prior, executed, Math.min(RECAP_BUDGET, MAX_MESSAGE - original.length - 2));
  const message = recap ? `${recap}\n\n${original}` : original;

  closeFailedAttempt(panel, at(code === 'responses_history' ? 'recoveredEdit' : 'recovered'));
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
