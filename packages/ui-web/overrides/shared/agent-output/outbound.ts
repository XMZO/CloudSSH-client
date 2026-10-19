/**
 * 发给 AI 的消息附加内容（只在发出的 message 里，对话里显示的仍是原话）：
 *   用户原话 + 服务器名称与标签（<server_context>）+ 需要时附服务器目录与跨服务器操作用法（<cloudssh_servers>，见 ai-remote）
 *   + 回复风格提示（<reply_style>，见 style.ts）
 *
 * Worker 只给 AI 系统主机名（hostname）、用户、内核等环境信息，不知道用户在 CloudSSH 里给服务器起的名字和标签。
 * 这里按 AI 面板的 serverId（网页版每个会话标签的面板都带着）从服务器列表里找：列表来自 sidebar/store，
 * 旁听网页版自己的 /api/servers 请求，电脑和手机共用。找不到（匿名连接、列表还没加载）时不附加。
 */
import { getServers } from '../../sidebar/store';
import { serversContext } from '../ai-remote/protocol';
import { hasOtherServers, mentionsOtherServers } from '../ai-remote/servers';
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
  const lines = ['(How the user labels the server you are working on in CloudSSH; reference only.)'];
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
}

/**
 * 这个面板对应的 Worker 端会话里已经发过什么：服务器目录、完整的回复风格提示（记下当时的内容，用户改了就重发）。
 * 面板与 Worker 会话一一对应（重连会新建面板）；新对话 / 出错接续重置会话（reset_done）、上下文被压缩
 * （context_status）后忘掉，下一条消息重新附上。不能看面板里显示了几条消息：网页版会把上次中断的对话恢复显示，
 * Worker 那边却是新会话
 */
const directorySent = new WeakSet<object>();
const styleSent = new WeakMap<object, string>();

export function forgetSession(panel: unknown): void {
  if (!panel || typeof panel !== 'object') return;
  directorySent.delete(panel);
  styleSent.delete(panel);
}

/**
 * 实际发给 AI 的内容。服务器目录与跨服务器操作的用法（ai-remote）只在需要时附上，免得每条消息都撑大上下文：
 * 这个会话还没发过、之前的已不在、消息里提到了别的服务器（名称或其片段、分类，或“传到”“所有服务器”这类说法）。
 * 回复风格提示同理：完整版每个会话一次，之后只附一句提醒
 */
export function decorateOutbound(message: string, panel: unknown, options: DecorateOptions = {}): string {
  const parts = [message];
  const context = serverContext(panel);
  if (context) parts.push(context);
  const currentId = (panel as { serverId?: unknown } | null)?.serverId;
  const current = typeof currentId === 'number' ? currentId : null;
  const tracked = !!panel && typeof panel === 'object';
  const known = tracked && directorySent.has(panel);
  if (!options.noDirectory && hasOtherServers(current) && (options.fresh || !known || mentionsOtherServers(message, current))) {
    parts.push(serversContext(current));
    if (tracked) directorySent.add(panel);
  }
  const style = activeStylePrompt();
  const reminder = tracked && !options.fresh && !!style && styleSent.get(panel) === style;
  if (tracked && style) styleSent.set(panel, style);
  return styledMessage(parts.join('\n\n'), reminder);
}
