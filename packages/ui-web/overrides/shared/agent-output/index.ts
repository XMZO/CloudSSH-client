/**
 * AI 助手回复的可读性（电脑与手机共用，不改 Worker）：
 *
 * 1. 配色（agent-output.css）：网页版把回复里的正文、标题、表格、加粗全涂成同一个 AI 主题色，分不出层次。
 *    改为正文用普通文字颜色，标题分级，加粗（关键标签）和链接保留 AI 主题色，行内代码中性底色，表格表头弱化、数字等宽。
 * 2. 状态高亮：表格里很短的状态格（正常 / 偏高 / 异常……，开头是否定词的不算）按好、注意、有问题上绿 / 黄 / 红；
 *    以 ⚠️ ❌ 开头的列表项与段落加浅色底，问题一眼可见。
 * 3. 回复风格提示：发送时把一段简短的英文提示（可编辑、可关闭）附加在消息后面，让模型结论在前、简洁、用 ✅ ⚠️ ❌ 标状态。
 *    走构建钩子：网页版组 agent_start 请求时调用 __cloudsshAgentOutbound 换掉 message（网页版发送终端选区时也是这样
 *    扩展发出的内容）；对话里显示的仍是用户原话。
 */
import { openStyleEditor, styledMessage } from './style';
import { at } from './i18n';
import './agent-output.css';

type Tone = 'ok' | 'warn' | 'bad';

const OK = ['✅', '🟢', '正常', '健康', '良好', '充裕', '充足', '干净', '成功', '通过', '已启用', '运行中', '在线', '无异常', '无问题', '无告警', '无风险', '無異常', '正常運作', 'ok', 'healthy', 'normal', 'good', 'running', 'active', 'passed', 'online', 'enabled', 'success', 'no issues'];
const WARN = ['⚠️', '⚠', '🟡', '警告', '注意', '偏高', '较高', '偏低', '接近', '告警', '待处理', '較高', 'warning', 'warn', 'high', 'degraded', 'pending'];
const BAD = ['❌', '🔴', '⛔', '异常', '错误', '失败', '危险', '严重', '不足', '已满', '宕机', '离线', '拒绝', '不可用', '不正常', '未通过', '異常', '錯誤', '失敗', '嚴重', 'error', 'failed', 'fail', 'critical', 'down', 'offline', 'denied', 'full'];
const MAX_CELL = 16;

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
    const head = (block.textContent ?? '').trimStart();
    const tone = head.startsWith('❌') || head.startsWith('⛔') || head.startsWith('🔴') ? 'bad' : head.startsWith('⚠') || head.startsWith('🟡') ? 'warn' : null;
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
  (globalThis as { __cloudsshAgentOutbound?: (message: string) => { message: string } | undefined }).__cloudsshAgentOutbound = (message) => {
    const styled = styledMessage(message);
    return styled === message ? undefined : { message: styled };
  };
  const start = () => {
    watchReplies();
    addHeaderButtons();
    document.querySelectorAll('.agent-md-content').forEach((root) => highlight(root));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

export { openStyleEditor, at as agentOutputText };
