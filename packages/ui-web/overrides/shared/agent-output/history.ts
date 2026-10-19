/**
 * AI 对话历史（电脑与手机共用，不改 Worker）。
 *
 * 网页版只在任务被中断时把对话暂存 30 分钟，正常完成就删掉（交给云端的服务器记忆）；而任何断线——自动重连、
 * 切后台回来、重启应用——都会丢掉 AI 面板，Worker 那边也是新会话，所以对话接不上。这里：
 * - 按“实例 + 服务器”把每段对话存进 IndexedDB（每台服务器最近 30 段，每段最近 80 条），只存提问与回复
 * - 面板新建时自动恢复这台服务器最近的一段（网页版已恢复了中断草稿就沿用它），加一行说明
 * - 恢复的对话 Worker 不记得：下一条消息前附上前文回顾（与出错接续同一套，见 recovery.ts），之后照常
 * - 输入框上方的“历史”：列出这台服务器的历史对话，打开（换到那段接着聊）或删除
 */
import { getLocale } from '../../../upstream/frontend/src/i18n';
import { notify } from '../../../upstream/frontend/src/ui-feedback';
import { at } from './i18n';
import { instanceKey } from './instance';
import { expectReset } from './outbound';
import { buildRecap, clearSummaryBase, RECAP_BYTES, type PanelInternals } from './recovery';

interface StoredMessage {
  role: 'user' | 'response';
  content: string;
  hasTerminalSelection?: boolean;
}

interface Conversation {
  id: string;
  /** 实例 + 服务器 */
  scope: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

interface HistoryPanel extends PanelInternals {
  panelEl: HTMLElement | null;
  hasConfirmedSession: boolean;
  appendMessage(role: string, content: string, options?: { hasTerminalSelection?: boolean; userIndex?: number }): void;
}

interface PanelState {
  scope: string;
  /** 当前对话在历史里的 id（还没发过消息时为 null） */
  id: string | null;
  createdAt: number;
  /** 面板显示的前文 Worker 不知道（恢复或打开了历史对话），下一条消息前要附回顾 */
  needsRecap: boolean;
  /** 打开历史对话时自己发了 agent_reset：它的 reset_done 回来时不要清掉 needsRecap */
  ownReset: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const DB_NAME = 'cloudssh-agent-history';
const STORE = 'conversations';
const PER_SERVER = 30;
const PER_CONVERSATION = 80;
const MESSAGE_CLIP = 30_000;

const states = new WeakMap<object, PanelState>();

// ---------- 存储 ----------

let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('scope', 'scope');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function list(scope: string): Promise<Conversation[]> {
  const database = await db();
  if (!database) return [];
  try {
    const items = await done(database.transaction(STORE).objectStore(STORE).index('scope').getAll(scope) as IDBRequest<Conversation[]>);
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

async function put(conversation: Conversation): Promise<void> {
  const database = await db();
  if (!database) return;
  try {
    await done(database.transaction(STORE, 'readwrite').objectStore(STORE).put(conversation));
    // 每台服务器只留最近的若干段
    const items = await list(conversation.scope);
    for (const old of items.slice(PER_SERVER)) await remove(old.id);
  } catch {
    // 存不下就算了，不影响对话
  }
}

async function remove(id: string): Promise<void> {
  const database = await db();
  if (!database) return;
  try {
    await done(database.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  } catch {
    // 忽略
  }
}


// ---------- 面板 ----------

function usablePanel(panel: unknown): panel is HistoryPanel {
  const p = panel as Partial<HistoryPanel> | null;
  return !!p && Array.isArray(p.sessionMessages) && typeof p.appendMessage === 'function' && typeof p.serverId === 'number';
}

function stored(panel: HistoryPanel): StoredMessage[] {
  return panel.sessionMessages
    .filter((item): item is StoredMessage => item.role === 'user' || item.role === 'response')
    .map((item) => ({
      role: item.role,
      content: item.content.length > MESSAGE_CLIP ? `${item.content.slice(0, MESSAGE_CLIP)}…` : item.content,
      ...((item as StoredMessage).hasTerminalSelection ? { hasTerminalSelection: true } : {}),
    }))
    .slice(-PER_CONVERSATION);
}

/** 记下当前对话（防抖）；面板清空了（新对话）就不再对应历史里的那段 */
export function saveConversation(panel: unknown): void {
  if (!usablePanel(panel)) return;
  const state = states.get(panel);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    const messages = stored(panel);
    const first = messages.find((item) => item.role === 'user');
    if (!first) {
      state.id = null;
      state.needsRecap = false;
      return;
    }
    if (!state.id) {
      state.id = crypto.randomUUID();
      state.createdAt = Date.now();
    }
    void put({
      id: state.id,
      scope: state.scope,
      title: first.content.replace(/\s+/g, ' ').trim().slice(0, 80),
      createdAt: state.createdAt,
      updatedAt: Date.now(),
      messages,
    });
  }, 400);
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(getLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(ts).toLocaleString();
  }
}

function noticeLine(panel: HistoryPanel, text: string): void {
  if (!panel.messagesEl) return;
  const line = document.createElement('div');
  line.className = 'agent-message cs-agent-recovered';
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'history';
  const span = document.createElement('span');
  span.textContent = text;
  line.append(icon, span);
  panel.messagesEl.prepend(line);
}

/** 把一段历史对话显示到面板里（与网页版恢复中断草稿的方式相同） */
function render(panel: HistoryPanel, conversation: Conversation, notice: string): void {
  if (!panel.messagesEl) return;
  panel.sessionMessages = conversation.messages.map((item) => ({ ...item }));
  panel.messagesEl.replaceChildren();
  let userIndex = 0;
  for (const item of conversation.messages) {
    panel.appendMessage(item.role, item.content, {
      hasTerminalSelection: item.hasTerminalSelection,
      userIndex: item.role === 'user' ? userIndex++ : undefined,
    });
  }
  noticeLine(panel, notice);
  panel.scrollToBottom?.();
}

/**
 * 发消息前调用：面板显示的前文 Worker 不知道时，返回要放在原话前面的回顾（只返回一次）
 */
export function takeHistoryRecap(panel: unknown): string {
  if (!usablePanel(panel)) return '';
  const state = states.get(panel);
  if (!state?.needsRecap) return '';
  state.needsRecap = false;
  const lastUser = panel.sessionMessages.map((item) => item.role).lastIndexOf('user');
  const prior = lastUser > 0 ? panel.sessionMessages.slice(0, lastUser) : [];
  return prior.length ? buildRecap(prior, [], RECAP_BYTES, 'history') : '';
}

/** Worker 端会话重置（新对话或出错接续）：回顾已经不需要了 */
export function historyReset(panel: unknown): void {
  const state = states.get(panel as object);
  if (!state) return;
  if (state.ownReset) state.ownReset = false;
  else state.needsRecap = false;
  saveConversation(panel);
}

// ---------- 历史列表 ----------

let openRoot: HTMLElement | null = null;

function closeList(): void {
  openRoot?.remove();
  openRoot = null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function openConversation(panel: HistoryPanel, conversation: Conversation): Promise<void> {
  const state = states.get(panel);
  if (!state) return;
  if (panel.isAgentRunning) {
    notify(at('historyBusy'), { variant: 'warning' });
    return;
  }
  // 换成另一段对话：Worker 端清空上下文，下一条消息带上这段的回顾
  state.ownReset = true;
  expectReset(panel);
  clearSummaryBase(panel);
  panel.wsSend?.(JSON.stringify({ type: 'agent_reset' }));
  panel.activeRequestId = null;
  panel.hasConfirmedSession = false;
  state.id = conversation.id;
  state.createdAt = conversation.createdAt;
  render(panel, conversation, at('historyOpened', { time: formatTime(conversation.updatedAt) }));
  state.needsRecap = true;
  panel.updateInputState();
}

async function showList(panel: HistoryPanel): Promise<void> {
  closeList();
  const state = states.get(panel);
  if (!state) return;
  const root = el('div', 'cs-as-root');
  const dialog = el('div', 'cs-as-dialog cs-history-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', at('historyTitle'));
  dialog.tabIndex = -1;
  const head = el('div', 'cs-as-head');
  head.append(el('h2', 'cs-as-title', at('historyTitle')));
  const close = el('button', 'cs-as-close');
  close.type = 'button';
  close.setAttribute('aria-label', at('cancel'));
  const closeIcon = el('span', 'material-symbols-outlined', 'close');
  closeIcon.setAttribute('aria-hidden', 'true');
  close.append(closeIcon);
  close.addEventListener('click', closeList);
  head.append(close);
  const body = el('div', 'cs-as-body cs-history-list');
  dialog.append(head, body);
  root.append(dialog);
  document.body.append(root);
  openRoot = root;
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) closeList();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    closeList();
  });
  dialog.focus();

  const fill = async () => {
    const items = await list(state.scope);
    body.replaceChildren();
    if (!items.length) {
      body.append(el('p', 'cs-history-empty', at('historyEmpty')));
      return;
    }
    for (const item of items) {
      const row = el('div', 'cs-history-row');
      if (item.id === state.id) row.classList.add('is-current');
      const info = el('button', 'cs-history-info');
      info.type = 'button';
      info.append(
        el('span', 'cs-history-name', item.title || '…'),
        el('span', 'cs-history-meta', `${formatTime(item.updatedAt)} · ${at('historyCount', { n: item.messages.length })}${item.id === state.id ? ` · ${at('historyCurrent')}` : ''}`)
      );
      info.addEventListener('click', () => {
        closeList();
        if (item.id !== state.id || !panel.sessionMessages.length) void openConversation(panel, item);
      });
      const del = el('button', 'cs-history-delete');
      del.type = 'button';
      del.title = at('historyDelete');
      del.setAttribute('aria-label', at('historyDelete'));
      const delIcon = el('span', 'material-symbols-outlined', 'delete');
      delIcon.setAttribute('aria-hidden', 'true');
      del.append(delIcon);
      del.addEventListener('click', async () => {
        await remove(item.id);
        // 删的是当前这段：面板里的对话照常保留，之后再发消息会作为新的一段记下
        if (item.id === state.id) state.id = null;
        await fill();
      });
      row.append(info, del);
      body.append(row);
    }
  };
  await fill();
}

/** 输入框上方快捷提问一行里加“历史” */
function addChip(panel: HistoryPanel): void {
  const chips = panel.panelEl?.querySelector('#agent-quick-chips');
  if (!chips || chips.querySelector('.cs-history-chip')) return;
  const chip = el('button', 'agent-quick-chip cs-history-chip shrink-0 text-[11px] px-2 py-0.5 rounded border border-outline-variant/60 hover:border-[var(--accent)] text-muted hover:text-primary transition-colors cursor-pointer flex items-center gap-1 bg-[var(--bg)]');
  chip.type = 'button';
  const icon = el('span', 'material-symbols-outlined text-[13px]', 'history');
  icon.setAttribute('aria-hidden', 'true');
  const label = el('span', '', at('historyChip'));
  chip.append(icon, label);
  chip.title = at('historyTitle');
  chip.addEventListener('click', () => void showList(panel));
  chips.prepend(chip);
}

/** 面板渲染完（构建钩子）：登记、加入口，等网页版恢复完中断草稿后再决定要不要恢复历史 */
export function historyPanelReady(panel: unknown): void {
  if (!usablePanel(panel)) return;
  const state: PanelState = {
    scope: `${instanceKey()}#${panel.serverId}`,
    id: null,
    createdAt: Date.now(),
    needsRecap: false,
    ownReset: false,
    timer: null,
  };
  states.set(panel, state);
  addChip(panel);
  // 网页版在绑定事件之后才恢复中断草稿：排到之后再看
  setTimeout(() => {
    void (async () => {
      if (panel.sessionMessages.length) {
        // 网页版恢复了中断的草稿：沿用它，接着聊时同样要附回顾
        state.needsRecap = true;
        saveConversation(panel);
        return;
      }
      const latest = (await list(state.scope))[0];
      // 等待期间用户已经开始了新对话就不打扰
      if (!latest || panel.sessionMessages.length || panel.isAgentRunning) return;
      state.id = latest.id;
      state.createdAt = latest.createdAt;
      render(panel, latest, at('historyRestored', { time: formatTime(latest.updatedAt) }));
      state.needsRecap = true;
    })();
  }, 0);
}
