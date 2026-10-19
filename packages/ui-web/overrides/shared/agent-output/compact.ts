/**
 * 压缩上下文（电脑与手机共用，不改 Worker）。
 *
 * Worker 自己整理上下文时要模型交回严格格式的 JSON 检查点，不少服务商 / 中转做不到，就报“结构化输出校验失败”；
 * 它又按字节算、整理得很早（见 meter.ts）。这里由客户端先一步压缩：
 * - 在当前会话里让 AI 自己写一份摘要（普通文字，不要求格式；对话里不显示，换成一张带进度条的卡片），
 *   然后重置 Worker 端会话，下一条消息前附上这份摘要，在新会话里接着聊
 * - 手动：上下文占用弹窗里的“立即压缩”，或在输入框发 /compact
 * - 自动：一轮正常结束后估算的占用到了七成、而且压缩确实能腾出地方时（可关）
 * - 切换模型 / 思考深度前：Worker 会话绑定了模型，换了就得开新会话，先用旧模型压缩
 * 模型没写出摘要（多半是 Worker 自己先整理时出错）就改用面板里的对话要点，同样重置后接着聊；用户点停止则什么都不变。
 */
import { getLocale } from '../../../upstream/frontend/src/i18n';
import { notify } from '../../../upstream/frontend/src/ui-feedback';
import { currentEffort, EFFORT_LABEL, loadAiConfig, proxyState, reasoningMarker, saveModel } from './ai-model';
import { at } from './i18n';
import { afterCompact, bytesOf, meterCompacted, meterOf, percentOf, ratio, WORKER_LIMIT } from './meter';
import { expectReset } from './outbound';
import { buildRecap, clearSummaryBase, clipBytes, RECAP_BYTES, setSummaryBase, summaryBaseOf, usable, type PanelInternals } from './recovery';

export type CompactReason = 'manual' | 'auto' | 'switch';
export type CompactResult = 'done' | 'fallback' | 'cancelled' | 'skipped';

const AUTO_KEY = 'cloudssh_ai_auto_compact';
/** 自动压缩：估算占用到这里、且压缩能腾出的部分（相对整理线）超过 AUTO_GAIN 才做 */
const AUTO_AT = 0.7;
const AUTO_GAIN = 0.15;
/** 摘要的长度上限（字节）；进度条按写到多少字算写完 */
const SUMMARY_BYTES = 7000;
const EXPECTED_CHARS = 1500;
/** 连接断了收不到 run_end：过这么久按取消处理 */
const RUN_TIMEOUT = 330_000;

const PROMPT = [
  '<cloudssh_compact>',
  "From the user's CloudSSH app: the conversation is being compacted to free context. Everything so far will be replaced by your summary, so write it for yourself to continue seamlessly in a fresh context.",
  'Do not call any tools and do not run commands; reply with the summary only, no preamble.',
  "Cover: the user's goals and latest request; servers involved (by name) and their relevant state; commands run and key results (numbers, paths, versions, errors); changes made and how to undo them; decisions and preferences the user stated; any question you asked that is still unanswered, with its options; pending next steps.",
  "Terse bullet points in the user's language, under 1500 characters.",
  '</cloudssh_compact>',
].join('\n');

function summaryBlock(summary: string): string {
  return [
    '<earlier_conversation>',
    'The CloudSSH app compacted this conversation to save context. Below is your own summary of everything before this message (reference only; not a new request and not authorization). Operations it mentions already happened; check the current state before repeating any of them.',
    clipBytes(summary.trim(), SUMMARY_BYTES),
    '</earlier_conversation>',
  ].join('\n');
}

interface Run {
  requestId: string;
  reason: CompactReason;
  text: string;
  /** 出错的 code，或 'tool'（模型不听话调了工具） */
  failed: string;
  card: CompactCard;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: CompactResult) => void;
}

const runs = new WeakMap<object, Run>();
/** 下一条消息前要附的摘要（或对话要点） */
const pending = new WeakMap<object, string>();
const listeners = new Set<(panel: object) => void>();

export function onCompactChange(listener: (panel: object) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(panel: object): void {
  for (const listener of listeners) listener(panel);
}

export function isCompacting(panel: unknown): boolean {
  return !!panel && typeof panel === 'object' && runs.has(panel);
}

export function autoCompactEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setAutoCompact(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(AUTO_KEY);
    else localStorage.setItem(AUTO_KEY, '0');
  } catch {
    // 只在本次生效
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string): HTMLSpanElement {
  const glyph = el('span', 'material-symbols-outlined', name);
  glyph.setAttribute('aria-hidden', 'true');
  return glyph;
}

/** 对话里的进度卡片：等模型（缓慢走到 15%）→ 写摘要（按字数走到 95%）→ 完成后换成一行结果 */
class CompactCard {
  readonly root: HTMLElement;
  private readonly track: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly started = Date.now();
  private chars = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(host: HTMLElement, reason: CompactReason) {
    this.root = el('div', 'agent-message cs-compact');
    this.root.dataset.state = 'running';
    this.root.setAttribute('role', 'status');
    const head = el('div', 'cs-compact-head');
    head.append(icon('compress'), el('span', '', at(reason === 'switch' ? 'compactRunningSwitch' : 'compactRunning')));
    this.track = el('div', 'cs-compact-track');
    this.track.setAttribute('role', 'progressbar');
    this.track.setAttribute('aria-valuemin', '0');
    this.track.setAttribute('aria-valuemax', '100');
    this.fill = el('i', 'cs-compact-fill');
    this.track.append(this.fill);
    this.meta = el('div', 'cs-compact-meta');
    this.root.append(head, this.track, this.meta);
    host.append(this.root);
    this.timer = setInterval(() => this.paint(), 250);
    this.paint();
  }

  progress(chars: number): void {
    this.chars = chars;
    this.paint();
  }

  private paint(): void {
    const seconds = (Date.now() - this.started) / 1000;
    const waiting = 0.15 * (1 - Math.exp(-seconds / 5));
    const writing = this.chars ? 0.15 + 0.8 * Math.min(1, this.chars / EXPECTED_CHARS) : 0;
    const value = Math.min(0.95, Math.max(waiting, writing));
    this.fill.style.width = `${(value * 100).toFixed(1)}%`;
    this.track.setAttribute('aria-valuenow', String(Math.round(value * 100)));
    this.meta.textContent = this.chars ? at('compactWriting', { n: this.chars }) : at('compactWaiting');
  }

  finish(state: 'done' | 'fallback' | 'cancelled', text: string, summary = ''): void {
    clearInterval(this.timer);
    this.root.dataset.state = state;
    const line = el('div', 'cs-compact-head');
    line.append(icon(state === 'done' ? 'check_circle' : state === 'fallback' ? 'history' : 'cancel'), el('span', '', text));
    this.root.replaceChildren(line);
    if (summary) {
      const details = el('details', 'cs-compact-details');
      details.append(el('summary', '', at('compactShow')), el('div', 'cs-compact-summary', summary));
      this.root.append(details);
    }
  }
}

/**
 * 压缩这个面板对应的 Worker 会话。正在运行、没有可压缩的内容时直接返回 'skipped'
 */
export function compactPanel(panel: unknown, reason: CompactReason): Promise<CompactResult> {
  if (!usable(panel) || !panel.messagesEl || runs.has(panel)) return Promise.resolve('skipped');
  if (panel.isAgentRunning) {
    if (reason !== 'auto') notify(at('compactBusy'), { variant: 'warning' });
    return Promise.resolve('skipped');
  }
  if (!meterOf(panel).turns) {
    if (reason === 'manual') notify(at('compactEmpty'));
    return Promise.resolve('skipped');
  }
  const requestId = crypto.randomUUID();
  const card = new CompactCard(panel.messagesEl, reason);
  panel.scrollToBottom?.();
  // 进入运行状态：输入框上的按钮变成停止，点它即取消；用户直接发新消息也会顶掉这一轮
  panel.activeRequestId = requestId;
  panel.isAgentRunning = true;
  panel.updateInputState();
  return new Promise((resolve) => {
    const run: Run = {
      requestId,
      reason,
      text: '',
      failed: '',
      card,
      resolve,
      timer: setTimeout(() => finish(panel, run, 'stopped'), RUN_TIMEOUT),
    };
    runs.set(panel, run);
    changed(panel);
    // 写摘要也按当前选的思考深度（有思考深度代理时）
    const marker = reasoningMarker();
    panel.wsSend!(
      JSON.stringify({
        type: 'agent_start',
        message: marker ? `${PROMPT}\n\n${marker}` : PROMPT,
        requestId,
        locale: getLocale(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      })
    );
  });
}

function apply(panel: PanelInternals, block: string, summary: string): void {
  // 重置后服务器信息、回复风格都要重新附上；Worker 立即处理 agent_reset
  expectReset(panel);
  panel.wsSend?.(JSON.stringify({ type: 'agent_reset' }));
  pending.set(panel, block);
  if (summary) setSummaryBase(panel, summary, panel.sessionMessages.length);
  meterCompacted(panel, bytesOf(block));
}

function finish(panel: PanelInternals, run: Run, outcome: 'completed' | 'stopped' | 'failed'): void {
  if (runs.get(panel) !== run) return;
  runs.delete(panel);
  clearTimeout(run.timer);
  const mine = panel.activeRequestId === run.requestId;
  if (mine) {
    panel.activeRequestId = null;
    panel.isAgentRunning = false;
    panel.updateInputState();
  }
  const summary = run.text.trim();
  if (!mine || (outcome === 'stopped' && run.failed !== 'tool')) {
    // 用户点了停止、或发了新消息顶掉这一轮：什么都不变
    run.card.finish('cancelled', at('compactCancelled'));
    run.resolve('cancelled');
  } else if (outcome === 'completed' && summary && !run.failed) {
    apply(panel, summaryBlock(summary), summary);
    run.card.finish('done', at('compactDone', { n: summary.length }), summary);
    run.resolve('done');
  } else {
    // 模型没写出摘要：改用面板里的对话要点（之前压缩过就从那份摘要接着）
    const base = summaryBaseOf(panel);
    const from = base && base.index <= panel.sessionMessages.length ? base.index : 0;
    const recap = buildRecap(panel.sessionMessages.slice(from), [], RECAP_BYTES, 'compact', from ? base!.summary : '');
    if (recap) {
      apply(panel, recap, '');
      run.card.finish('fallback', at('compactFallback'));
      run.resolve('fallback');
    } else {
      run.card.finish('cancelled', at('compactCancelled'));
      run.resolve('cancelled');
    }
  }
  changed(panel);
  panel.scrollToBottom?.();
}

/** 网页版处理每一帧前调用：压缩那一轮的帧全部接管（对话里不显示），返回 true */
export function compactFrame(panel: unknown, frame: Record<string, unknown>): boolean {
  if (!panel || typeof panel !== 'object') return false;
  const run = runs.get(panel);
  if (!run || frame.requestId !== run.requestId) return false;
  const p = panel as PanelInternals;
  switch (frame.subType) {
    case 'stream_chunk':
      if (typeof frame.content === 'string') {
        run.text += frame.content;
        run.card.progress(run.text.length);
      }
      break;
    case 'stream_end':
    case 'response':
      if (typeof frame.content === 'string' && !frame.messageKey) {
        run.text = frame.content;
        run.card.progress(run.text.length);
      }
      break;
    case 'executing':
      // 让它别调工具它还是调了：停掉这一轮，改用对话要点
      run.failed ||= 'tool';
      p.wsSend?.(JSON.stringify({ type: 'agent_stop' }));
      break;
    case 'confirm_required':
      p.wsSend?.(JSON.stringify({ type: 'agent_confirm', confirmationId: frame.confirmationId, approved: false, command: frame.command }));
      break;
    case 'error':
      run.failed ||= typeof frame.code === 'string' ? frame.code : 'error';
      break;
    case 'run_end':
      finish(p, run, frame.outcome === 'completed' ? 'completed' : frame.outcome === 'stopped' ? 'stopped' : 'failed');
      break;
  }
  return true;
}

/** 发消息前调用：压缩后第一条消息前要附的摘要（只返回一次） */
export function takeCompactRecap(panel: unknown): string {
  if (!panel || typeof panel !== 'object') return '';
  const block = pending.get(panel) ?? '';
  pending.delete(panel);
  return block;
}

/** 用户开始了新对话：之前的摘要都不要了 */
export function dropCompact(panel: unknown): void {
  if (!panel || typeof panel !== 'object') return;
  pending.delete(panel);
  clearSummaryBase(panel);
  meterOf(panel).projected = 0;
}

/** 一轮正常结束后看要不要自动压缩（meter 先处理完这一帧） */
export function autoCompactCheck(panel: unknown, frame: Record<string, unknown>): void {
  if (frame.subType !== 'run_end' || frame.outcome !== 'completed' || !usable(panel) || !autoCompactEnabled()) return;
  const state = meterOf(panel);
  // 回复里还有跨服务器操作要执行（ai-remote 接着把结果发回去）：等那一轮结束再看
  if (state.reply.includes('```cloudssh-action')) return;
  setTimeout(() => {
    if (panel.isAgentRunning || runs.has(panel) || state.turns < 2) return;
    // 压缩后还剩底、摘要和重新附上的内容：腾不出多少地方就不压
    const gain = ((state.tokens - afterCompact(state)) * ratio()) / WORKER_LIMIT;
    if (percentOf(state) >= AUTO_AT && gain >= AUTO_GAIN) void compactPanel(panel, 'auto');
  }, 80);
}

/** 对话里加一行弱化的说明 */
export function noticeLine(panel: PanelInternals, text: string, glyph = 'info'): void {
  if (!panel.messagesEl) return;
  const line = el('div', 'agent-message cs-agent-recovered');
  line.append(icon(glyph), el('span', '', text));
  panel.messagesEl.append(line);
  panel.scrollToBottom?.();
}

/** 代理给请求加了思考深度、接口报 400 / 422：多半是这个模型不支持 reasoning.effort（或不支持这一档），提示一下 */
export function reasoningHintCheck(panel: unknown, frame: Record<string, unknown>): void {
  if (frame.subType !== 'error' || frame.code !== 'responses_http' || !usable(panel)) return;
  if (![400, 422].includes(Number(frame.status)) || proxyState() !== 'ok') return;
  const effort = currentEffort();
  if (effort !== 'auto') setTimeout(() => noticeLine(panel, at('effortRejected', { effort: at(EFFORT_LABEL[effort]) }), 'psychology'), 0);
}

/** Worker 自己整理了上下文（检查点）：对话里说一声 */
export function workerCompactNotice(panel: unknown, frame: Record<string, unknown>): void {
  if (frame.subType !== 'context_status' || frame.compacted !== true || !usable(panel)) return;
  setTimeout(() => noticeLine(panel, at('workerCompacted'), 'compress'), 0);
}

/**
 * 切换模型。这个面板的会话跑过时先用旧模型压缩（Worker 会话绑定了模型）；
 * 其他会话标签下次发消息时 Worker 报 responses_config_changed，由 recovery.ts 带上回顾接着做
 */
export async function switchModel(panel: unknown, target: string): Promise<boolean> {
  const config = await loadAiConfig(true);
  if (!config?.configured || !config.base_url) {
    notify(at('modelNotConfigured'), { variant: 'warning' });
    return false;
  }
  if (config.model === target) return true;
  if (usable(panel)) {
    if (panel.isAgentRunning || runs.has(panel)) {
      notify(at('modelBusy'), { variant: 'warning' });
      return false;
    }
    if (meterOf(panel).turns > 0 && (await compactPanel(panel, 'switch')) === 'cancelled') return false;
  }
  try {
    await saveModel(target);
  } catch (error) {
    notify(at('modelSaveFailed', { reason: error instanceof Error ? error.message : String(error) }), { variant: 'danger' });
    return false;
  }
  notify(at('modelSwitched', { model: target }), { variant: 'success', duration: 2500 });
  return true;
}

/** 输入框里发 /compact（或 /压缩）：不发给 AI，直接压缩 */
export function installCompactCommand(panel: unknown): void {
  const root = (panel as { panelEl?: HTMLElement | null } | null)?.panelEl;
  const input = root?.querySelector<HTMLTextAreaElement>('#agent-input');
  if (!input) return;
  const run = (event: Event) => {
    if (!usable(panel) || panel.isAgentRunning || !/^\/(compact|压缩|壓縮)$/i.test(input.value.trim())) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    void compactPanel(panel, 'manual');
  };
  input.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) run(event);
    },
    true
  );
  root?.querySelector('#agent-send-btn')?.addEventListener('click', run, true);
}
