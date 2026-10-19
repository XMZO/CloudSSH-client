/**
 * AI 助手回复的可读性（电脑与手机共用，不改 Worker）：
 *
 * 1. 配色（agent-output.css）：网页版把回复里的正文、标题、表格、加粗全涂成同一个 AI 主题色，分不出层次。
 *    改为正文用普通文字颜色，标题分级，加粗（关键标签）和链接保留 AI 主题色，行内代码中性底色，表格表头弱化、数字等宽。
 * 2. 状态高亮：表格里很短的状态格、列表项开头的加粗状态词（正常 / 注意 / 异常……，开头是否定词的不算）按好、注意、
 *    有问题上绿 / 黄 / 红；以“异常：”“注意：”（或 ⚠️ ❌）开头的列表项与段落加浅色底，问题一眼可见。
 * 3. 发送时附加的内容（outbound.ts）：服务器名称与标签（Worker 只给 AI 系统主机名），以及一段英文回复风格提示
 *    （可编辑、可关闭），让模型结论在前、简洁、用文字标状态（Worker 禁止 emoji）。
 *    走构建钩子：网页版组 agent_start 请求时调用 __cloudsshAgentOutbound 换掉 message（网页版发送终端选区时也是这样
 *    扩展发出的内容）；对话里显示的仍是用户原话。
 * 4. 上下文出错时接着做（recovery.ts）：“结构化输出校验失败”“上下文超过预算”“该编辑位置不可用”时，
 *    重置会话并带上前文回顾重发这条请求，不用手动开新会话。
 * 5. AI 跨服务器操作（../ai-remote）：在 AI 的回复里识别操作请求，由客户端在其他服务器上执行命令、传文件，结果回传给 AI。
 * 6. “完全”权限模式（full-access.ts）：交互 / 自动之外的第三种，任何确认都不提示直接执行（含跨服务器操作）。
 * 7. 对话历史（history.ts）：按服务器保存对话，断线重连、重启后自动恢复最近一段，接着聊时附上前文回顾；“历史”里可切换。
 * 8. 提问卡片（ask.ts）：AI 用 cloudssh-ask 代码块提问，显示成可点的选项（单选 / 多选 / 其他 + 补充），答案作为下一条消息发出。
 * 9. 输入框下方一行（bar.ts）：模型（可切换）、思考深度（经思考深度代理加进请求，ai-model.ts）、上下文占用圆环（meter.ts 估算）。
 * 10. 压缩上下文（compact.ts）：让 AI 写摘要后重置会话、带着摘要接着聊，带进度条；手动、/compact、快满时自动、切换模型前。
 */
import { installAiRemote } from '../ai-remote';
import { enhanceAsk, installAsk } from './ask';
import { loadAiConfig } from './ai-model';
import { addComposerBar, installComposerBar } from './bar';
import { autoCompactCheck, compactFrame, dropCompact, installCompactCommand, reasoningHintCheck, takeCompactRecap, workerCompactNotice } from './compact';
import { notifyAgentFrame, onAgentFrame } from './frames';
import { autoApprove, installFullAccess, onPanelReady } from './full-access';
import { historyPanelReady, historyReset, saveConversation, takeHistoryRecap } from './history';
import { meterFrame, meterSent } from './meter';
import { consumeReset, decorateOutbound, forgetSession } from './outbound';
import { handleAgentFrame, rememberOutbound } from './recovery';
import { openStyleEditor } from './style';
import { at } from './i18n';
import './agent-output.css';

type Tone = 'ok' | 'warn' | 'bad';

const OK = ['✅', '🟢', '正常', '健康', '良好', '充裕', '充足', '干净', '成功', '通过', '已启用', '运行中', '在线', '无异常', '无问题', '无告警', '无风险', '無異常', '正常運作', 'ok', 'healthy', 'normal', 'good', 'running', 'active', 'passed', 'online', 'enabled', 'success', 'no issues'];
const WARN = ['⚠️', '⚠', '🟡', '警告', '注意', '偏高', '较高', '偏低', '接近', '告警', '待处理', '風險', '风险', '較高', 'warning', 'warn', 'caution', 'high', 'degraded', 'pending'];
const BAD = ['❌', '🔴', '⛔', '异常', '错误', '失败', '危险', '严重', '不足', '已满', '宕机', '离线', '拒绝', '不可用', '不正常', '未通过', '異常', '錯誤', '失敗', '嚴重', 'problem', 'error', 'failed', 'fail', 'critical', 'down', 'offline', 'denied', 'full'];
const MAX_CELL = 16;
/** 段落 / 列表项开头的状态标签（Worker 禁止 emoji，回复风格提示让模型这样写：“**异常**：/boot 只剩 3%”） */
const LEAD_LABEL = /^\s*([^\s:：]{1,12})\s*[:：]/;

/** 短文本开头的状态；按“有问题 → 注意 → 好”的顺序比，否定词开头的（不正常、未通过）先被判成有问题 */
export function toneOf(text: string): Tone | null {
  const value = text.trim().toLowerCase();
  if (!value) return null;
  // 英文词要整词匹配（down 不能匹配 download，full 不能匹配 fully）
  const starts = (words: string[]) =>
    words.some((word) => {
      const key = word.toLowerCase();
      if (!value.startsWith(key)) return false;
      return !/[a-z]$/.test(key) || !/[a-z]/.test(value.charAt(key.length));
    });
  if (starts(BAD)) return 'bad';
  if (starts(WARN)) return 'warn';
  if (starts(OK)) return 'ok';
  return null;
}

function highlight(root: Element): void {
  // AI 的提问代码块换成问题卡片（ask.ts）
  enhanceAsk(root);
  for (const cell of root.querySelectorAll<HTMLElement>('td')) {
    const text = cell.textContent ?? '';
    const tone = text.trim().length <= MAX_CELL ? toneOf(text) : null;
    if (tone) cell.dataset.csTone = tone;
    else delete cell.dataset.csTone;
  }
  for (const block of root.querySelectorAll<HTMLElement>('li, p')) {
    if (block.closest('td, th, blockquote')) continue;
    // 开头的加粗状态词按好 / 注意 / 有问题上色
    let lead = block.firstChild;
    while (lead && lead.nodeType === Node.TEXT_NODE && !lead.textContent?.trim()) lead = lead.nextSibling;
    if (lead instanceof HTMLElement && (lead.tagName === 'STRONG' || lead.tagName === 'B')) {
      const label = (lead.textContent ?? '').trim();
      const leadTone = label.length <= MAX_CELL ? toneOf(label) : null;
      if (leadTone) lead.dataset.csTone = leadTone;
      else delete lead.dataset.csTone;
    }
    // 松散列表里 li 内还套着 p：底色只加在 li 上，免得叠两层
    if (block.tagName === 'P' && block.parentElement?.tagName === 'LI') continue;
    // 开头的状态：emoji，或“异常：”“Warning:”这样的标签（加粗与否都算）
    const head = (block.textContent ?? '').trimStart();
    // 标签要整个是状态词（“错误日志：”这类不算）
    const label = LEAD_LABEL.exec(head)?.[1]?.toLowerCase();
    const labelTone = label && [...BAD, ...WARN].some((word) => word.toLowerCase() === label) ? toneOf(label) : null;
    const tone =
      head.startsWith('❌') || head.startsWith('⛔') || head.startsWith('🔴') ? 'bad'
      : head.startsWith('⚠') || head.startsWith('🟡') ? 'warn'
      : labelTone === 'bad' || labelTone === 'warn' ? labelTone
      : null;
    if (tone) block.dataset.csCallout = tone;
    else delete block.dataset.csCallout;
  }
}

/**
 * 网页版流式输出时整段重写回复的 HTML：合并到下一帧统一处理。
 * 只盯每个 AI 面板（面板渲染完时由构建钩子交过来），不盯整个页面：终端的高亮装饰、手机端的各种浮层
 * 一刻不停地增删元素，整页监听会让每次终端刷新都多跑一遍回调（手机上、小字号时尤其明显）
 */
const pendingReplies = new Set<Element>();
let replyFrame = 0;
const watchedPanels = new WeakSet<Element>();

function flushReplies(): void {
  replyFrame = 0;
  for (const root of pendingReplies) if (root.isConnected) highlight(root);
  pendingReplies.clear();
}

function watchReplies(panelRoot: Element): void {
  if (watchedPanels.has(panelRoot)) return;
  watchedPanels.add(panelRoot);
  const pending = pendingReplies;
  new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const root = target?.closest('.agent-md-content') ?? (target?.matches('.agent-md-content') ? target : null);
      if (root) pending.add(root);
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('.agent-md-content')) pending.add(node);
        node.querySelectorAll('.agent-md-content').forEach((child) => pending.add(child));
      }
    }
    if (pending.size && !replyFrame) replyFrame = requestAnimationFrame(flushReplies);
  }).observe(panelRoot, { childList: true, subtree: true, characterData: true });
  panelRoot.querySelectorAll('.agent-md-content').forEach((root) => highlight(root));
}

/** AI 面板标题栏里加“回复风格”按钮（每个会话标签各有一个 AI 面板，id 相同） */
function addHeaderButtons(): void {
  const attach = () => {
    for (const memory of document.querySelectorAll<HTMLElement>('[id="agent-memory-btn"]')) {
      if (memory.previousElementSibling?.classList.contains('cs-agent-style-btn')) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'agent-header-btn cs-agent-style-btn';
      button.title = at('button');
      button.setAttribute('aria-label', at('button'));
      const glyph = document.createElement('span');
      glyph.className = 'material-symbols-outlined';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = 'format_paint';
      glyph.style.fontSize = '18px';
      button.append(glyph);
      button.addEventListener('click', () => openStyleEditor());
      memory.before(button);
    }
  };
  attach();
  new MutationObserver(attach).observe(document.body, { childList: true });
}

let installed = false;

export function installAgentOutput(): void {
  if (installed) return;
  installed = true;
  (
    globalThis as {
      __cloudsshAgentOutbound?: (message: string, panel: unknown, kind?: string) => { message: string } | undefined;
    }
  ).__cloudsshAgentOutbound = (message, panel, kind) => {
    rememberOutbound(message);
    // 刚压缩过：附上摘要；面板里恢复 / 打开的历史对话 Worker 不知道：附上前文回顾（都只附一次）
    const compacted = takeCompactRecap(panel);
    const history = takeHistoryRecap(panel);
    const recap = compacted || history;
    // 编辑更早的消息、或接着历史对话时，Worker 端没有之前附过的内容：重新附上
    const decorated = decorateOutbound(recap ? `${recap}\n\n${message}` : message, panel, {
      fresh: kind === 'edit' || !!recap,
      about: message,
    });
    meterSent(panel, decorated);
    saveConversation(panel);
    return decorated === message ? undefined : { message: decorated };
  };
  (globalThis as { __cloudsshAgentPanelReady?: (panel: unknown) => void }).__cloudsshAgentPanelReady = (panel) => {
    onPanelReady(panel);
    historyPanelReady(panel);
    addComposerBar(panel);
    installCompactCommand(panel);
    const root = (panel as { panelEl?: HTMLElement | null } | null)?.panelEl;
    if (root) watchReplies(root);
  };
  (globalThis as { __cloudsshAgentFrame?: (panel: unknown, frame: Record<string, unknown>) => boolean }).__cloudsshAgentFrame = (
    panel,
    frame
  ) => {
    // 每轮开始、或 Worker 说模型配置变了（在别处改过）时重新读 AI 配置，输入框下方的模型名跟着更新
    if (frame.subType === 'run_start') void loadAiConfig();
    if (frame.subType === 'error' && frame.code === 'responses_config_changed') void loadAiConfig(true);
    // 压缩那一轮（compact.ts）的帧全部接管，确认请求一律拒绝
    if (compactFrame(panel, frame)) return true;
    if (autoApprove(panel, frame)) return true;
    if (handleAgentFrame(panel, frame)) return true;
    notifyAgentFrame(panel, frame);
    return false;
  };
  // Worker 端会话重置或上下文被压缩后，服务器目录与完整的回复风格提示要重新附上（客户端自己发的重置在发的时候就处理了）
  onAgentFrame((panel, frame) => {
    if (frame.subType === 'reset_done') {
      // 网页版的“新对话”：之前压缩的摘要也不要了
      if (!consumeReset(panel)) {
        forgetSession(panel);
        dropCompact(panel);
      }
      historyReset(panel);
    }
    if (frame.subType === 'context_status' && frame.compacted === true) forgetSession(panel);
    // 上下文占用估算，之后看要不要自动压缩、接口是不是拒绝了思考深度
    meterFrame(panel as object, frame);
    autoCompactCheck(panel, frame);
    reasoningHintCheck(panel, frame);
    workerCompactNotice(panel, frame);
    // 每轮结束、出错后把对话记进历史（防抖，网页版先处理完这一帧）
    if (frame.subType === 'run_end' || frame.subType === 'error' || frame.subType === 'stream_end' || frame.subType === 'response') saveConversation(panel);
  });
  installFullAccess();
  installAsk();
  installComposerBar();
  installAiRemote();
  const start = () => {
    addHeaderButtons();
    // 构建钩子之前就已经存在的面板（一般没有）
    document.querySelectorAll<HTMLElement>('[id="agent-panel"]').forEach((root) => watchReplies(root));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

export { openStyleEditor, at as agentOutputText };
