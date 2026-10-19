/**
 * AI 向用户提问（电脑与手机共用，不改 Worker）：AI 的工具里没有“提问”，只能用文字问。这里约定一种格式——
 * AI 在回复末尾写一个语言为 cloudssh-ask 的代码块（问题 + 选项），客户端把它换成问题卡片：
 * - 单个问题、单选：点选项就把答案作为你的下一条消息发出
 * - 多选或多个问题：选好后点“发送”
 * - 每个问题都有“其他”：选了出现补充框，填自己的答案
 * 回复里的代码块随时（流式输出、恢复历史对话）换成只读卡片；这一轮正常结束后最新的那张才可以作答。
 * 跨服务器操作里服务器名不确定时也用同一种卡片让用户选（见 ai-remote/runner.ts）。
 */
import { onAgentFrame } from './frames';
import { at } from './i18n';
import { usable, type PanelInternals } from './recovery';

export interface AskQuestion {
  question: string;
  options: string[];
  multiple: boolean;
}

export const ASK_LANGUAGE = 'cloudssh-ask';
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;

function clean(text: unknown, limit: number): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

/** 解析 cloudssh-ask 代码块的内容：一个问题对象或问题数组 */
export function parseAsk(body: string): AskQuestion[] | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const items = (Array.isArray(value) ? value : [value]).slice(0, MAX_QUESTIONS);
  const questions: AskQuestion[] = [];
  for (const item of items) {
    const raw = item as { question?: unknown; options?: unknown; multiple?: unknown } | null;
    const question = clean(raw?.question, 400);
    const options = Array.isArray(raw?.options)
      ? [...new Set(raw.options.map((option) => clean(option, 120)).filter(Boolean))].slice(0, MAX_OPTIONS)
      : [];
    if (question) questions.push({ question, options, multiple: raw?.multiple === true });
  }
  return questions.length ? questions : null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface QuestionCard {
  root: HTMLElement;
  /** 变成可作答；作答后调用 onAnswer（答案文字：一个问题时就是答案本身，多个问题时每行“问题 → 答案”） */
  activate(onAnswer: (answer: string) => void): void;
  /** 不再可作答（有了更新的消息） */
  expire(): void;
}

/** 问题卡片：一开始是只读的，activate 后才能点 */
export function questionCard(questions: AskQuestion[]): QuestionCard {
  const root = el('div', 'cs-ask');
  root.dataset.state = 'static';
  const picks = questions.map(() => new Set<string>());
  const others: HTMLTextAreaElement[] = [];
  const otherOn = questions.map(() => false);
  let onAnswer: ((answer: string) => void) | null = null;
  const send = el('button', 'cs-ask-send', at('askSend'));
  send.type = 'button';
  const instant = questions.length === 1 && !questions[0].multiple;

  const answers = () =>
    questions.map((_, index) => {
      const parts = [...picks[index]];
      const other = otherOn[index] ? others[index].value.trim() : '';
      if (other) parts.push(other);
      return parts.join('、');
    });
  const ready = () => answers().every(Boolean);
  const sync = () => {
    const needButton = !instant || otherOn[0];
    send.hidden = !needButton || root.dataset.state !== 'active';
    send.disabled = !ready();
  };
  const submit = () => {
    if (!onAnswer || root.dataset.state !== 'active' || !ready()) return;
    const list = answers();
    const text = questions.length === 1 ? list[0] : questions.map((q, index) => `${q.question} → ${list[index]}`).join('\n');
    root.dataset.state = 'answered';
    root.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button, textarea').forEach((node) => (node.disabled = true));
    send.hidden = true;
    const callback = onAnswer;
    onAnswer = null;
    callback(text);
  };

  questions.forEach((question, index) => {
    const block = el('div', 'cs-ask-q');
    block.append(el('div', 'cs-ask-title', question.question));
    if (question.multiple) block.append(el('div', 'cs-ask-hint', at('askMultiple')));
    const row = el('div', 'cs-ask-options');
    const buttons: HTMLButtonElement[] = [];
    for (const option of question.options) {
      const button = el('button', 'cs-ask-opt', option);
      button.type = 'button';
      button.disabled = true;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        if (root.dataset.state !== 'active') return;
        if (question.multiple) {
          if (picks[index].has(option)) picks[index].delete(option);
          else picks[index].add(option);
        } else {
          picks[index].clear();
          picks[index].add(option);
          otherOn[index] = false;
          other.setAttribute('aria-pressed', 'false');
          input.hidden = true;
        }
        for (const item of buttons) item.setAttribute('aria-pressed', String(picks[index].has(item.textContent ?? '')));
        if (instant) submit();
        else sync();
      });
      buttons.push(button);
      row.append(button);
    }
    const other = el('button', 'cs-ask-opt cs-ask-other', at('askOther'));
    other.type = 'button';
    other.disabled = true;
    other.setAttribute('aria-pressed', 'false');
    const input = el('textarea', 'cs-ask-input');
    input.rows = 2;
    input.placeholder = at('askOtherPlaceholder');
    input.hidden = true;
    input.disabled = true;
    others.push(input);
    other.addEventListener('click', () => {
      if (root.dataset.state !== 'active') return;
      otherOn[index] = !otherOn[index];
      if (otherOn[index] && !question.multiple) {
        picks[index].clear();
        for (const item of buttons) item.setAttribute('aria-pressed', 'false');
      }
      other.setAttribute('aria-pressed', String(otherOn[index]));
      input.hidden = !otherOn[index];
      if (otherOn[index]) input.focus();
      sync();
    });
    input.addEventListener('input', sync);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    row.append(other);
    block.append(row, input);
    root.append(block);
  });
  const foot = el('div', 'cs-ask-foot');
  foot.append(send);
  root.append(foot);
  send.addEventListener('click', submit);
  sync();

  return {
    root,
    activate(callback) {
      if (root.dataset.state !== 'static') return;
      root.dataset.state = 'active';
      onAnswer = callback;
      root.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button, textarea').forEach((node) => (node.disabled = false));
      sync();
    },
    expire() {
      if (root.dataset.state === 'answered') return;
      root.dataset.state = 'expired';
      onAnswer = null;
      root.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button, textarea').forEach((node) => (node.disabled = true));
      sync();
    },
  };
}

// ---------- AI 回复里的问题 ----------

const cards = new WeakMap<HTMLElement, QuestionCard>();

/** 回复里的 cloudssh-ask 代码块换成只读卡片（流式输出时整段重写，每次都重新换；JSON 还没写完就先不换） */
export function enhanceAsk(root: Element): void {
  for (const block of root.querySelectorAll<HTMLElement>(`.agent-md-code-block[data-code-language="${ASK_LANGUAGE}"]`)) {
    if (block.dataset.csAsk === 'done') continue;
    const questions = parseAsk(block.querySelector('code')?.textContent ?? '');
    if (!questions) continue;
    const card = questionCard(questions);
    cards.set(card.root, card);
    block.dataset.csAsk = 'done';
    block.after(card.root);
  }
}

function latestResponse(panel: PanelInternals): HTMLElement | null {
  const list = panel.messagesEl?.querySelectorAll<HTMLElement>('.agent-message.agent-response');
  return list && list.length ? list[list.length - 1] : null;
}

function expireAll(panel: PanelInternals): void {
  panel.messagesEl?.querySelectorAll<HTMLElement>('.cs-ask[data-state="active"]').forEach((node) => cards.get(node)?.expire());
}

function observe(panel: unknown, frame: Record<string, unknown>): void {
  if (!usable(panel)) return;
  if (frame.subType === 'run_start') expireAll(panel);
  if (frame.subType !== 'run_end' || frame.outcome !== 'completed') return;
  // 等网页版渲染完最终回复、退出运行状态
  setTimeout(() => {
    if (panel.isAgentRunning) return;
    const response = latestResponse(panel);
    if (!response) return;
    enhanceAsk(response);
    const node = response.querySelector<HTMLElement>('.cs-ask[data-state="static"]');
    const card = node ? cards.get(node) : undefined;
    if (!card) return;
    // 卡片必须是对话里最后的内容（之后又有消息就不再作答）
    if (panel.messagesEl?.lastElementChild !== response) return;
    card.activate((answer) => {
      const send = (panel as unknown as { sendMessage?: (text: string) => boolean }).sendMessage;
      if (typeof send === 'function') send.call(panel, answer);
    });
    node!.scrollIntoView({ block: 'nearest' });
  }, 0);
}

let installed = false;

export function installAsk(): void {
  if (installed) return;
  installed = true;
  onAgentFrame(observe);
}

/** 告诉 AI 可以这样提问（每个会话发一次，见 outbound.ts） */
export function askContext(): string {
  return [
    '<cloudssh_ask>',
    "From the user's CloudSSH app: when the user should choose or confirm something (which item first, which server, which option), end your reply with one short sentence and a fenced block in language " +
      `${ASK_LANGUAGE}, then stop; it shows as clickable choices:`,
    '```' + ASK_LANGUAGE,
    '{"question":"Which one first?","options":["Disk usage","Swap"],"multiple":false}',
    '```',
    'Up to 4 questions as a JSON array, 2-6 short options each, in the user\'s language. The app adds an "Other" choice with a text box and sends the answer as the user\'s next message. Never combine it with a cloudssh-action block; for risky commands keep using your confirmation tool.',
    '</cloudssh_ask>',
  ].join('\n');
}
