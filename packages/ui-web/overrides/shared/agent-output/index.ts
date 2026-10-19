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
 */
import { installAiRemote } from '../ai-remote';
import { notifyAgentFrame, onAgentFrame } from './frames';
import { autoApprove, installFullAccess } from './full-access';
import { decorateOutbound, forgetSession } from './outbound';
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

/** 网页版流式输出时整段重写回复的 HTML：合并到下一帧统一处理 */
function watchReplies(): void {
  const pending = new Set<Element>();
  let frame = 0;
  const flush = () => {
    frame = 0;
    for (const root of pending) if (root.isConnected) highlight(root);
    pending.clear();
  };
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
    if (pending.size && !frame) frame = requestAnimationFrame(flush);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
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
    // 编辑更早的消息时 Worker 回到那之前的上下文，之前附过的内容可能已不在：重新附上
    const decorated = decorateOutbound(message, panel, { fresh: kind === 'edit' });
    return decorated === message ? undefined : { message: decorated };
  };
  (globalThis as { __cloudsshAgentFrame?: (panel: unknown, frame: Record<string, unknown>) => boolean }).__cloudsshAgentFrame = (
    panel,
    frame
  ) => {
    if (autoApprove(panel, frame)) return true;
    if (handleAgentFrame(panel, frame)) return true;
    notifyAgentFrame(panel, frame);
    return false;
  };
  // Worker 端会话重置或上下文被压缩后，服务器目录与完整的回复风格提示要重新附上
  onAgentFrame((panel, frame) => {
    if (frame.subType === 'reset_done' || (frame.subType === 'context_status' && frame.compacted === true)) forgetSession(panel);
  });
  installFullAccess();
  installAiRemote();
  const start = () => {
    watchReplies();
    addHeaderButtons();
    document.querySelectorAll('.agent-md-content').forEach((root) => highlight(root));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

export { openStyleEditor, at as agentOutputText };
