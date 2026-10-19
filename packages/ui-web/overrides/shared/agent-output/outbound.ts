/**
 * 发给 AI 的消息附加内容（只在发出的 message 里，对话里显示的仍是原话）：
 *   用户原话 + 服务器名称与标签（<server_context>）+ 跨服务器操作（<cloudssh_servers>，见 ai-remote）
 *   + 提问格式（<cloudssh_ask>）+ 回复风格提示（<reply_style>，见 style.ts）+ 指令标签（思考深度、联网搜索，有 AI 增强代理时；ai-model.ts）
 *
 * Worker 按字节算上下文、整理得很早（见 meter.ts），这些附加内容都尽量只发一次：跨服务器操作平时只附一句简介，
 * 用户提到别的服务器、或 AI 用 {"action":"list"} 要列表时才给完整的目录与用法。
 *
 * Worker 只给 AI 系统主机名（hostname）、用户、内核等环境信息，不知道用户在 CloudSSH 里给服务器起的名字和标签。
 * 这里按 AI 面板的 serverId（网页版每个会话标签的面板都带着）从服务器列表里找：列表来自 sidebar/store，
 * 旁听网页版自己的 /api/servers 请求，电脑和手机共用。找不到（匿名连接、列表还没加载）时不附加。
 */
import { getServers } from '../../sidebar/store';
import { serversContext, serversTeaser } from '../ai-remote/protocol';
import { hasOtherServers, mentionsOtherServers } from '../ai-remote/servers';
import { proxyDirectives } from './ai-model';
import { askContext } from './ask';
import { activeStylePrompt, styledMessage } from './style';

const MAX_NAME = 100;
const MAX_TAG = 40;
const MAX_TAGS = 12;

/** 一行纯文本：去掉换行与尖括号，免得和标记混在一起 */
function plain(text: string, limit: number): string {
  const value = text.replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 面板所属服务器的名称与标签；没有可附加的返回空串 */
export function serverContext(panel: unknown): string {
  const id = (panel as { serverId?: unknown } | null)?.serverId;
  if (typeof id !== 'number') return '';
  const server = getServers()?.find((item) => item.id === id);
  if (!server) return '';
  const name = plain(server.name ?? '', MAX_NAME);
  const tags = (server.tags ?? [])
    .map((tag) => plain(tag, MAX_TAG))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
  if (!name && !tags.length) return '';
  const lines = ['(How the user names and tags this server in CloudSSH; for reference.)'];
  if (name) lines.push(`Name: ${name}`);
  if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
  return `<server_context>\n${lines.join('\n')}\n</server_context>`;
}

export interface DecorateOptions {
  /**
   * 之前发过的内容在 Worker 端可能已经不在了（出错接续后的新会话、编辑更早的消息）：
   * 服务器目录与完整的回复风格提示都重新附上
   */
  fresh?: boolean;
  /** 不附服务器目录（跨服务器操作的结果回传，前面已经附过） */
  noDirectory?: boolean;
  /** 判断是否提到别的服务器时只看这段（用户原话；前面附的回顾 / 摘要里提到的不算） */
  about?: string;
  /**
   * 上下文很紧时（出错接续第二次、新会话里放不下）只附必要的：服务器名称与标签、指令标签；用户提到别的服务器时
   * 只附简介。提问格式、回复风格、服务器目录都不附，也不记为已发，之后有地方时再附
   */
  lean?: boolean;
}

/**
 * 这个面板对应的 Worker 端会话里已经发过什么：服务器目录、完整的回复风格提示（记下当时的内容，用户改了就重发）。
 * 面板与 Worker 会话一一对应（重连会新建面板）；新对话 / 出错接续重置会话（reset_done）、上下文被压缩
 * （context_status）后忘掉，下一条消息重新附上。不能看面板里显示了几条消息：网页版会把上次中断的对话恢复显示，
 * Worker 那边却是新会话
 */
const directorySent = new WeakSet<object>();
const teaserSent = new WeakSet<object>();
const styleSent = new WeakMap<object, string>();
const askSent = new WeakSet<object>();
/** 客户端自己发的 agent_reset 还有几个没回来（出错接续、压缩、打开历史对话） */
const pendingResets = new WeakMap<object, number>();

export function forgetSession(panel: unknown): void {
  if (!panel || typeof panel !== 'object') return;
  directorySent.delete(panel);
  teaserSent.delete(panel);
  styleSent.delete(panel);
  askSent.delete(panel);
}

/**
 * 客户端要发 agent_reset 了：先忘掉这个会话里发过的内容（keep 为 true 表示刚为新会话附过，保留），
 * 它的 reset_done 回来时就不再忘一次
 */
export function expectReset(panel: unknown, keep = false): void {
  if (!panel || typeof panel !== 'object') return;
  if (!keep) forgetSession(panel);
  pendingResets.set(panel, (pendingResets.get(panel) ?? 0) + 1);
}

/** 收到 reset_done：是客户端自己发的返回 true；否则（网页版的“新对话”）是用户开始了新对话 */
export function consumeReset(panel: unknown): boolean {
  if (!panel || typeof panel !== 'object') return false;
  const count = pendingResets.get(panel) ?? 0;
  if (!count) return false;
  pendingResets.set(panel, count - 1);
  return true;
}

/** 这个会话里 AI 已经拿到完整的服务器目录与用法 */
export function directoryKnown(panel: unknown): boolean {
  return !!panel && typeof panel === 'object' && directorySent.has(panel);
}

export function markDirectorySent(panel: unknown): void {
  if (panel && typeof panel === 'object') directorySent.add(panel);
}

/**
 * 实际发给 AI 的内容，免得每条消息都撑大上下文：
 * - 跨服务器操作（ai-remote）：消息里提到了别的服务器（名称或其片段、分类，或“传到”“所有服务器”这类说法）且这个会话
 *   还没给过完整的目录与用法时附完整版；否则每个会话只附一次简介（要用时 AI 先 {"action":"list"} 拿列表与用法）
 * - 提问格式：每个会话一次
 * - 回复风格提示：完整版每个会话一次，之后只附一句提醒
 */
export function decorateOutbound(message: string, panel: unknown, options: DecorateOptions = {}): string {
  const parts = [message];
  const context = serverContext(panel);
  if (context) parts.push(context);
  const currentId = (panel as { serverId?: unknown } | null)?.serverId;
  const current = typeof currentId === 'number' ? currentId : null;
  const tracked = !!panel && typeof panel === 'object';
  const known = tracked && !options.fresh && directorySent.has(panel);
  if (!options.noDirectory && !known && hasOtherServers(current)) {
    const mentioned = mentionsOtherServers(options.about ?? message, current);
    if (mentioned && !options.lean) {
      parts.push(serversContext(current));
      if (tracked) directorySent.add(panel);
    } else if (options.lean ? mentioned : options.fresh || !tracked || !teaserSent.has(panel)) {
      parts.push(serversTeaser(current));
      if (tracked) teaserSent.add(panel);
    }
  }
  // 提问格式（ask.ts）：每个会话说明一次
  if (!options.lean && tracked && (options.fresh || !askSent.has(panel))) {
    parts.push(askContext());
    askSent.add(panel);
  }
  // 指令标签放在最后（ai-model.ts）：AI 增强代理转发前删掉，给请求加上思考深度、原生联网搜索
  const marker = proxyDirectives();
  const withMarker = (text: string) => (marker ? `${text}\n\n${marker}` : text);
  if (options.lean) return withMarker(parts.join('\n\n'));
  const style = activeStylePrompt();
  const reminder = tracked && !options.fresh && !!style && styleSent.get(panel) === style;
  if (tracked && style) styleSent.set(panel, style);
  return withMarker(styledMessage(parts.join('\n\n'), reminder));
}
